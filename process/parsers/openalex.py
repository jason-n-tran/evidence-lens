"""OpenAlex works JSON parser.

OpenAlex needs a bespoke parser (not the generic one) for two reasons:
  1. The abstract ships as an inverted index (`abstract_inverted_index`:
     {token: [positions]}) that must be reconstructed into running text.
  2. Authors live under `authorships[].author.display_name`, and outbound
     citations under `referenced_works` (OpenAlex work URLs) — neither is a
     plain top-level field the generic parser can pick.

Input: one OpenAlex work object (JSON), archived verbatim by ingester-openalex.
Output: canonical Document dict (proto/evidencelens/v1/document.proto).
"""
from __future__ import annotations

import html
import json
from typing import Any


# OpenAlex `type` (Crossref-derived work types) -> canonical StudyType.
_TYPE_MAP = {
    "article": "OTHER",
    "review": "REVIEW",
    "preprint": "PREPRINT",
    "book": "OTHER",
    "book-chapter": "OTHER",
    "dataset": "OTHER",
    "dissertation": "OTHER",
    "editorial": "EDITORIAL",
    "letter": "EDITORIAL",
    "report": "OTHER",
    "standard": "GUIDELINE",
    "peer-review": "OTHER",
    "paratext": "OTHER",
}


def _study_type(work: dict) -> str:
    return _TYPE_MAP.get((work.get("type") or "").lower(), "OTHER")


def _short_id(url_or_id: str) -> str:
    """https://openalex.org/W123 -> W123 ; passthrough if no slash."""
    if not url_or_id:
        return ""
    return url_or_id.rsplit("/", 1)[-1]


def _reconstruct_abstract(inv: dict | None) -> str:
    """Rebuild text from OpenAlex abstract_inverted_index {token: [positions]}."""
    if not isinstance(inv, dict) or not inv:
        return ""
    positioned: list[tuple[int, str]] = []
    for token, positions in inv.items():
        if isinstance(positions, list):
            for p in positions:
                if isinstance(p, int):
                    positioned.append((p, token))
    if not positioned:
        return ""
    positioned.sort(key=lambda t: t[0])
    return " ".join(tok for _, tok in positioned)


def _published_at(work: dict) -> str | None:
    date = work.get("publication_date")
    if isinstance(date, str) and len(date) >= 10:
        return f"{date[:10]}T00:00:00Z"
    year = work.get("publication_year")
    if isinstance(year, int) and 1000 <= year <= 2100:
        return f"{year:04d}-01-01T00:00:00Z"
    return None


def _authors(work: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in work.get("authorships") or []:
        if not isinstance(a, dict):
            continue
        author = a.get("author") or {}
        name = (author.get("display_name") or "").strip()
        if not name:
            continue
        orcid = author.get("orcid")
        if isinstance(orcid, str) and orcid:
            orcid = _short_id(orcid)  # strip https://orcid.org/ prefix
        else:
            orcid = None
        # First affiliation string, if any.
        affil = None
        insts = a.get("institutions") or []
        if insts and isinstance(insts[0], dict):
            affil = insts[0].get("display_name") or None
        out.append({
            "display_name": name,
            "given_name": None,
            "family_name": None,
            "orcid": orcid,
            "affiliation": affil,
            "payments": [],
        })
    return out


def _citations(work: dict) -> list[str]:
    out: list[str] = []
    for ref in work.get("referenced_works") or []:
        if isinstance(ref, str):
            sid = _short_id(ref)
            if sid:
                out.append(f"openalex:{sid}")
    return out


def _journal(work: dict) -> dict[str, Any] | None:
    loc = work.get("primary_location") or {}
    src = loc.get("source") or {} if isinstance(loc, dict) else {}
    name = src.get("display_name") if isinstance(src, dict) else None
    if not name:
        return None
    issn = None
    issn_l = src.get("issn_l") if isinstance(src, dict) else None
    if isinstance(issn_l, str):
        issn = issn_l
    return {"name": name, "issn": issn, "is_predatory": False}


def parse(raw: bytes) -> dict[str, Any]:
    work = json.loads(raw)
    if not isinstance(work, dict):
        work = {}

    short = _short_id(work.get("id") or "")
    doi = work.get("doi")
    if isinstance(doi, str) and doi:
        # OpenAlex DOIs are full URLs (https://doi.org/10.x/y). DOIs contain
        # slashes, so strip the known host prefix rather than splitting on "/".
        low = doi.lower()
        for pfx in ("https://doi.org/", "http://doi.org/", "doi.org/"):
            if low.startswith(pfx):
                low = low[len(pfx):]
                break
        doi = low or None
    else:
        doi = None

    # display_name may contain HTML entities (e.g. "&amp;"); unescape to text.
    title = html.unescape(work.get("display_name") or work.get("title") or "")
    abstract = html.unescape(_reconstruct_abstract(work.get("abstract_inverted_index")))
    journal = _journal(work)

    # Cross-ids for linkage/dedup (ids = {openalex, doi, pmid, pmcid, mag}).
    ids = work.get("ids") or {}
    pmid = _short_id(ids.get("pmid")) if isinstance(ids.get("pmid"), str) else None
    pmcid = _short_id(ids.get("pmcid")) if isinstance(ids.get("pmcid"), str) else None

    # OpenAlex provides a real (large) citation count; prefer it over our
    # graph-derived one. The enrich_citations job won't zero it (it only writes
    # non-zero scores).
    cby = work.get("cited_by_count")
    citation_count = int(cby) if isinstance(cby, (int, float)) else 0

    # concepts[] are ready-made topical keywords (our keywords were always empty).
    keywords = [
        c["display_name"] for c in (work.get("concepts") or [])
        if isinstance(c, dict) and c.get("display_name")
    ][:20]

    return {
        "id": f"openalex:{short}",
        "source": "openalex",
        "source_native_id": short,
        "doi": doi,
        "pmid": pmid,
        "pmcid": pmcid,
        "title": title,
        "abstract": abstract,
        "canonical_url": work.get("id") or (f"https://openalex.org/{short}" if short else ""),
        "published_at": _published_at(work),
        "license": work.get("license") or "unknown",
        "study_type": _study_type(work),
        "authors": _authors(work),
        "mesh_terms": [],
        "keywords": keywords,
        "citations": _citations(work),
        "citation_count": citation_count,
        "journal": journal,
    }
