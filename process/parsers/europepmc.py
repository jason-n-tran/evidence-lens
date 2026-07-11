"""Europe PMC literature-record parser.

Bespoke parser for the Europe PMC `core` result shape: title, abstractText
(contains light HTML like <h4>/<i>), authorList.author[].fullName, journalInfo,
keywordList.keyword[], cross-ids (pmid/pmcid/doi), firstPublicationDate.

Input: one Europe PMC result object (JSON, archived by ingester-europepmc).
Output: canonical Document dict.
"""
from __future__ import annotations

import json
import re
from typing import Any

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _clean(text: Any) -> str:
    if not isinstance(text, str) or not text:
        return ""
    return _WS.sub(" ", _TAG.sub(" ", text)).strip()


def _date(r: dict) -> str | None:
    for key in ("firstPublicationDate", "electronicPublicationDate"):
        v = r.get(key)
        if isinstance(v, str) and len(v) >= 10:
            return f"{v[:10]}T00:00:00Z"
    yr = r.get("pubYear")
    if isinstance(yr, str) and yr.isdigit():
        return f"{int(yr):04d}-01-01T00:00:00Z"
    return None


def _authors(r: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    alist = (r.get("authorList") or {}).get("author") or []
    for a in alist:
        if not isinstance(a, dict):
            continue
        name = (a.get("fullName") or "").strip()
        first = (a.get("firstName") or "").strip() or None
        last = (a.get("lastName") or "").strip() or None
        if not name:
            name = " ".join(x for x in (first, last) if x)
        if not name:
            continue
        affil = None
        det = (a.get("authorAffiliationDetailsList") or {}).get("authorAffiliation") or []
        if det and isinstance(det[0], dict):
            affil = det[0].get("affiliation") or None
        orcid = None
        aid = a.get("authorId")
        if isinstance(aid, dict) and aid.get("type") == "ORCID":
            orcid = aid.get("value")
        out.append({
            "display_name": name,
            "given_name": first,
            "family_name": last,
            "orcid": orcid,
            "affiliation": affil,
            "payments": [],
        })
    return out


def _journal(r: dict) -> dict[str, Any] | None:
    ji = r.get("journalInfo") or {}
    j = ji.get("journal") or {}
    name = j.get("title")
    if not name:
        return None
    return {
        "name": name,
        "issn": j.get("issn") or j.get("essn") or None,
        "is_predatory": False,
    }


def _keywords(r: dict) -> list[str]:
    kw = (r.get("keywordList") or {}).get("keyword") or []
    return [k for k in kw if isinstance(k, str)]


# EuropePMC pubTypeList.pubType strings -> canonical StudyType. Matched
# case-insensitively against substrings since EPMC uses varied phrasings
# (e.g. "Journal Article", "Randomized Controlled Trial", "review").
_PUBTYPE_RULES = [
    ("randomized controlled trial", "RCT"),
    ("meta-analysis", "META_ANALYSIS"),
    ("systematic review", "SYSTEMATIC_REVIEW"),
    ("case reports", "CASE_REPORT"),
    ("case report", "CASE_REPORT"),
    ("review", "REVIEW"),
    ("editorial", "EDITORIAL"),
    ("letter", "EDITORIAL"),
    ("comment", "EDITORIAL"),
    ("practice guideline", "GUIDELINE"),
    ("guideline", "GUIDELINE"),
    ("observational study", "OBSERVATIONAL"),
    ("preprint", "PREPRINT"),
]


def _study_type(r: dict) -> str:
    types = (r.get("pubTypeList") or {}).get("pubType") or []
    if isinstance(types, str):
        types = [types]
    joined = " ".join(t for t in types if isinstance(t, str)).lower()
    for needle, canon in _PUBTYPE_RULES:
        if needle in joined:
            return canon
    return "OTHER"


def parse(raw: bytes) -> dict[str, Any]:
    r = json.loads(raw)
    if not isinstance(r, dict):
        r = {}

    epmc_id = r.get("id") or ""
    pmid = r.get("pmid") or None
    pmcid = r.get("pmcid") or None
    doi = r.get("doi")
    doi = doi.lower() if isinstance(doi, str) and doi else None

    # Canonical URL: prefer a stable external identifier.
    if pmid:
        url = f"https://europepmc.org/article/MED/{pmid}"
    elif doi:
        url = f"https://doi.org/{doi}"
    else:
        url = f"https://europepmc.org/article/{r.get('source', 'MED')}/{epmc_id}"

    return {
        "id": f"europepmc:{epmc_id}",
        "source": "europepmc",
        "source_native_id": epmc_id,
        "doi": doi,
        "pmid": pmid,
        "pmcid": pmcid,
        "title": _clean(r.get("title"))[:1000],
        "abstract": _clean(r.get("abstractText"))[:50_000],
        "canonical_url": url,
        "published_at": _date(r),
        "license": r.get("license") or "unknown",
        "study_type": _study_type(r),
        # Upstream-provided inbound citation count (authoritative; far larger
        # than our graph-derived count). enrich_citations won't zero it.
        "citation_count": int(r["citedByCount"]) if isinstance(r.get("citedByCount"), (int, float)) else 0,
        "authors": _authors(r),
        "mesh_terms": [],
        "keywords": _keywords(r),
        "journal": _journal(r),
    }
