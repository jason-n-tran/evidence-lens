"""BM25 sub-scorer — Meilisearch (spec §5.5).

Loads `config/synonyms.json` at startup and pushes the bidirectional
synonym map into Meilisearch via `updateSynonyms`. Adds a small
MeSH-expansion pass to the query string (spec §6.1) before submission.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import meilisearch
import structlog

log = structlog.get_logger("scorer.bm25")


@dataclass
class BM25Hit:
    doc_id: str
    score: float
    document: dict[str, Any]


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, list)}


class BM25Scorer:
    def __init__(self, url: str, api_key: str, index_name: str = "documents") -> None:
        self.client = meilisearch.Client(url, api_key)
        self.index = self.client.index(index_name)
        self.synonyms = _load_json(Path(os.getenv(
            "SYNONYMS_PATH",
            str(Path(__file__).resolve().parent.parent / "config" / "synonyms.json"),
        )))
        self._mesh_lookup = self._build_mesh_lookup()
        self._push_synonyms_to_meili()
        self._configure_index()

    def _build_mesh_lookup(self) -> dict[str, list[str]]:
        """Reverse-index synonyms so query `MI` -> [`myocardial infarction`,
        `heart attack`] AND `myocardial infarction` -> [`MI`, `heart attack`]."""
        lookup: dict[str, list[str]] = {}
        for term, syns in self.synonyms.items():
            lower = term.lower()
            lookup.setdefault(lower, []).extend(s.lower() for s in syns if s.lower() != lower)
            for s in syns:
                lower_s = s.lower()
                lookup.setdefault(lower_s, []).append(lower)
                for s2 in syns:
                    if s2.lower() != lower_s:
                        lookup[lower_s].append(s2.lower())
        return {k: list(dict.fromkeys(v)) for k, v in lookup.items()}

    def _push_synonyms_to_meili(self) -> None:
        if not self.synonyms:
            return
        try:
            payload = {k: v for k, v in self.synonyms.items()}
            self.index.update_synonyms(payload)
            log.info("meilisearch synonyms pushed", n=len(payload))
        except Exception as e:  # noqa: BLE001
            log.warning("meilisearch synonyms push failed", err=str(e))

    def _configure_index(self) -> None:
        # Faceting defaults (maxValuesPerFacet=100, sortFacetValuesBy=alpha)
        # break the mesh_terms facet: with thousands of distinct terms Meili
        # returns only the alphabetically-first 100 (all "A" terms), so the
        # sidebar never shows the most common topics. PATCH the settings
        # endpoint directly (version-independent) and log explicitly so a
        # failure here is visible instead of silently swallowed below.
        self._configure_faceting()
        try:
            self.index.update_filterable_attributes([
                "id",  # needed for fetch_documents (id IN [...]) to hydrate vector hits
                "study_type",
                "published_year",
                "mesh_terms",
                "source",
                "license",
                "has_coi_authors",
                "has_full_text",
                "journal_predatory",
            ])
            self.index.update_sortable_attributes([
                "published_at",
                "citation_count",
                "citation_pagerank",
            ])
            log.info("meilisearch index settings applied")
        except Exception as e:  # noqa: BLE001
            log.warning("meilisearch index settings update failed", err=str(e))

    def _configure_faceting(self) -> None:
        """PATCH /indexes/{index}/settings/faceting directly. Done over HTTP
        rather than the client helper so it's robust across client versions
        and so the outcome is logged explicitly (the mesh facet was stuck at
        the default 100-alpha cap, surfacing only 'A' terms in the sidebar)."""
        import httpx
        url = f"{self.client.config.url}/indexes/{self.index.uid}/settings/faceting"
        headers = {"content-type": "application/json"}
        key = getattr(self.client.config, "api_key", None)
        if key:
            headers["authorization"] = f"Bearer {key}"
        body = {"maxValuesPerFacet": 1000, "sortFacetValuesBy": {"*": "count"}}
        try:
            r = httpx.patch(url, json=body, headers=headers, timeout=10.0)
            log.info("meilisearch faceting configured",
                     status=r.status_code, body=r.text[:200])
        except Exception as e:  # noqa: BLE001
            log.warning("meilisearch faceting update failed", err=str(e))

    def expand_query(self, q: str, max_added: int = 3) -> str:
        """Spec §6.1 MeSH expansion: when a query token matches a
        preferred term, append up to `max_added` entry-term synonyms.
        Bounded so the BM25 query doesn't balloon."""
        if not q or not self._mesh_lookup:
            return q
        tokens = re.findall(r"[A-Za-z][A-Za-z0-9-]*", q)
        added: list[str] = []
        for tok in tokens:
            for syn in self._mesh_lookup.get(tok.lower(), []):
                if syn not in q.lower() and syn not in added:
                    added.append(syn)
                    if len(added) >= max_added:
                        break
            if len(added) >= max_added:
                break
        return q if not added else f'{q} {" ".join(added)}'

    # Display fields needed by the result card + detail hydration. Kept in sync
    # with what ResultCard.tsx / the document page read.
    _DISPLAY_FIELDS = [
        "id", "canonical_id", "title", "abstract", "study_type", "published_at",
        "published_year", "citation_count", "citation_pagerank", "has_coi_authors",
        "max_author_payment_usd", "license", "source", "authors_display", "authors",
        "journal", "journal_name", "journal_predatory", "doi", "pmid", "pmcid",
        "nct_id", "trial", "salience", "has_full_text", "canonical_url",
    ]

    def fetch_documents(self, ids: list[str]) -> dict[str, dict]:
        """Fetch full display payloads for the given Meili ids. Used to hydrate
        vector-only hits, which otherwise carry just Milvus scalars (no title)
        and render as '[Untitled]' in the result list."""
        if not ids:
            return {}
        out: dict[str, dict] = {}
        # Meili has no native multi-get; a filtered search on id IN [...] is the
        # documented way and respects attributesToRetrieve.
        quoted = ", ".join(f'"{i}"' for i in ids)
        try:
            res = self.index.search("", {
                "filter": f"id IN [{quoted}]",
                "limit": len(ids),
                "attributesToRetrieve": self._DISPLAY_FIELDS,
            })
            for h in res.get("hits", []):
                out[h["id"]] = h
        except Exception as e:  # noqa: BLE001
            log.warning("fetch_documents failed", err=str(e), n=len(ids))
        return out

    def search(self, query: str, filters: dict | None = None, top_k: int = 200) -> list[BM25Hit]:
        expanded = self.expand_query(query)
        params: dict[str, Any] = {
            "limit": top_k,
            "showRankingScore": True,
            "attributesToRetrieve": [
                "id", "title", "abstract", "study_type", "published_at", "published_year",
                "citation_count", "citation_pagerank", "has_coi_authors",
                "max_author_payment_usd", "license", "source", "authors_display",
                "journal_name", "journal_predatory", "salience", "has_full_text",
            ],
        }
        if filters:
            built = self._build_filter(filters)
            if built:
                params["filter"] = built
        sort = self._sort_for(filters)
        if sort:
            params["sort"] = sort
        log.info("bm25.search", query=expanded, filter=params.get("filter"), sort=params.get("sort"))
        res = self.index.search(expanded, params)
        hits: list[BM25Hit] = []
        for h in res.get("hits", []):
            hits.append(BM25Hit(
                doc_id=h["id"],
                score=float(h.get("_rankingScore", 0.0)),
                document=h,
            ))
        return hits

    @staticmethod
    def _build_filter(f: dict) -> list[str]:
        out: list[str] = []
        if f.get("study_types"):
            out.append("study_type IN " + str(list(f["study_types"])))
        if f.get("published_year_min"):
            out.append(f"published_year >= {int(f['published_year_min'])}")
        if f.get("published_year_max"):
            out.append(f"published_year <= {int(f['published_year_max'])}")
        if f.get("mesh_terms"):
            out.append("mesh_terms IN " + str(list(f["mesh_terms"])))
        if f.get("sources"):
            out.append("source IN " + str(list(f["sources"])))
        if f.get("licenses"):
            out.append("license IN " + str(list(f["licenses"])))
        if f.get("only_with_coi"):
            out.append("has_coi_authors = true")
        if f.get("only_with_full_text"):
            out.append("has_full_text = true")
        if f.get("exclude_predatory_journals"):
            out.append("journal_predatory = false")
        return out

    @staticmethod
    def _sort_for(f: dict | None) -> list[str] | None:
        """Spec §6.8 sort modes: relevance | most_recent | most_cited |
        most_influential."""
        if not f:
            return None
        mode = f.get("sort_mode")
        if mode == "most_recent":
            return ["published_at:desc"]
        if mode == "most_cited":
            return ["citation_count:desc"]
        if mode == "most_influential":
            return ["citation_pagerank:desc"]
        return None
