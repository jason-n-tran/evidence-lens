"""CORE (open-access aggregator) works parser.

Bespoke (not generic) so authors, journal, publication date, full text, and
citations are captured from CORE's v3 `works` shape, where:
  - authors    is [{"name": "..."}]
  - journals   is [{"title": "...", "identifiers": [...]}]
  - references is [{"id", "doi", "title", ...}]
  - dates      are ISO strings (publishedDate) or a bare year (yearPublished)

Input: one CORE v3 work object (JSON, full record archived by ingester-core).
Output: canonical Document dict.
"""
from __future__ import annotations

import json
from typing import Any


def _date(w: dict) -> str | None:
    for key in ("publishedDate", "acceptedDate", "depositedDate", "createdDate"):
        v = w.get(key)
        if isinstance(v, str) and len(v) >= 10:
            return f"{v[:10]}T00:00:00Z"
    yr = w.get("yearPublished")
    if isinstance(yr, int) and 1000 <= yr <= 2100:
        return f"{yr:04d}-01-01T00:00:00Z"
    if isinstance(yr, str) and yr.isdigit():
        return f"{int(yr):04d}-01-01T00:00:00Z"
    return None


def _authors(w: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in w.get("authors") or []:
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


def _journal(w: dict) -> dict[str, Any] | None:
    journals = w.get("journals") or []
    if not journals or not isinstance(journals[0], dict):
        return None
    j = journals[0]
    name = j.get("title")
    if not name:
        return None
    issn = None
    for ident in j.get("identifiers") or []:
        if isinstance(ident, str) and ident.lower().startswith("issn:"):
            issn = ident.split(":", 1)[1].strip()
            break
    return {"name": name, "issn": issn, "is_predatory": False}


def _citations(w: dict) -> list[str]:
    out: list[str] = []
    for ref in w.get("references") or []:
        if isinstance(ref, dict):
            doi = ref.get("doi")
            if isinstance(doi, str) and doi:
                out.append(f"doi:{doi.lower()}")
    return out


# CORE documentType is free-ish; match known values, else OTHER.
_DOCTYPE_RULES = [
    ("review", "REVIEW"),
    ("thesis", "OTHER"),
    ("preprint", "PREPRINT"),
    ("conference", "OTHER"),
    ("dataset", "OTHER"),
    ("book", "OTHER"),
]


def _study_type(w: dict) -> str:
    dt = (w.get("documentType") or "").lower()
    for needle, canon in _DOCTYPE_RULES:
        if needle in dt:
            return canon
    return "OTHER"


def parse(raw: bytes) -> dict[str, Any]:
    w = json.loads(raw)
    if not isinstance(w, dict):
        w = {}

    native = str(w.get("id") or "")
    doi = w.get("doi")
    doi = doi.lower() if isinstance(doi, str) and doi else None
    url = w.get("downloadUrl") or (f"https://doi.org/{doi}" if doi else "")

    return {
        "id": f"core:{native}",
        "source": "core",
        "source_native_id": native,
        "doi": doi,
        "title": str(w.get("title") or "")[:1000],
        "abstract": str(w.get("abstract") or "")[:50_000],
        "full_text": (w.get("fullText") or None),
        "canonical_url": str(url),
        "published_at": _date(w),
        "license": "unknown",
        "study_type": _study_type(w),
        "authors": _authors(w),
        "mesh_terms": [],
        "keywords": [s for s in [w.get("fieldOfStudy")] if isinstance(s, str) and s],
        "citations": _citations(w),
        "journal": _journal(w),
    }
