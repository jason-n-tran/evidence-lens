"""Semantic Scholar (S2) Graph API paper parser.

Bespoke parser for the S2 bulk-search result shape: title, abstract, authors
[{authorId, name}], externalIds {DOI, PubMed, PubMedCentral, ...}, journal
{name, ...}, publicationDate/year, citation/reference counts, publicationTypes.

Input: one S2 paper object (JSON, archived by ingester-semanticscholar).
Output: canonical Document dict.
"""
from __future__ import annotations

import json
from typing import Any

# S2 publicationTypes -> canonical study_type (best-effort).
_TYPE_MAP = {
    "Review": "REVIEW",
    "JournalArticle": "OTHER",
    "ClinicalTrial": "RCT",
    "CaseReport": "CASE_REPORT",
    "MetaAnalysis": "META_ANALYSIS",
    "Editorial": "EDITORIAL",
    "Book": "OTHER",
    "Dataset": "OTHER",
}


def _study_type(p: dict) -> str:
    for t in p.get("publicationTypes") or []:
        if t in _TYPE_MAP:
            return _TYPE_MAP[t]
    return "OTHER"


def _date(p: dict) -> str | None:
    pd = p.get("publicationDate")
    if isinstance(pd, str) and len(pd) >= 10:
        return f"{pd[:10]}T00:00:00Z"
    yr = p.get("year")
    if isinstance(yr, int) and 1000 <= yr <= 2100:
        return f"{yr:04d}-01-01T00:00:00Z"
    return None


def _authors(p: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in p.get("authors") or []:
        if isinstance(a, dict):
            name = (a.get("name") or "").strip()
        elif isinstance(a, str):
            name = a.strip()
        else:
            name = ""
        if name:
            out.append({
                "display_name": name,
                "given_name": None,
                "family_name": None,
                "orcid": None,
                "affiliation": None,
                "payments": [],
            })
    return out


def _journal(p: dict) -> dict[str, Any] | None:
    j = p.get("journal") or {}
    name = j.get("name") if isinstance(j, dict) else None
    if not name:
        return None
    return {"name": name, "issn": None, "is_predatory": False}


def parse(raw: bytes) -> dict[str, Any]:
    p = json.loads(raw)
    if not isinstance(p, dict):
        p = {}

    pid = p.get("paperId") or ""
    ext = p.get("externalIds") or {}
    doi = ext.get("DOI")
    doi = doi.lower() if isinstance(doi, str) and doi else None
    pmid = str(ext["PubMed"]) if ext.get("PubMed") else None
    pmcid = ext.get("PubMedCentral")
    pmcid = f"PMC{pmcid}" if pmcid and not str(pmcid).startswith("PMC") else (pmcid or None)

    url = f"https://www.semanticscholar.org/paper/{pid}" if pid else (
        f"https://doi.org/{doi}" if doi else "")

    return {
        "id": f"semanticscholar:{pid}",
        "source": "semanticscholar",
        "source_native_id": pid,
        "doi": doi,
        "pmid": pmid,
        "pmcid": pmcid,
        "title": str(p.get("title") or "")[:1000],
        "abstract": str(p.get("abstract") or "")[:50_000],
        "canonical_url": url,
        "published_at": _date(p),
        "license": "unknown",
        "study_type": _study_type(p),
        # Upstream inbound citation count (authoritative). enrich won't zero it.
        "citation_count": int(p["citationCount"]) if isinstance(p.get("citationCount"), (int, float)) else 0,
        "authors": _authors(p),
        "mesh_terms": [],
        "keywords": [],
        "journal": _journal(p),
    }
