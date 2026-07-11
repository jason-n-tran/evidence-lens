"""NIH RePORTER funding-record parser.

Bespoke (not generic) because the rich grant structure — principal
investigators (authors), award amount + agency (funding), organization,
project dates, and indexable terms — is lost by the generic id/title/abstract
picker.

Input: one NIH RePORTER project object (JSON), archived by ingester-nih-reporter.
Output: canonical Document dict.
"""
from __future__ import annotations

import json
from typing import Any


def _date(s: Any) -> str | None:
    """RePORTER dates look like '2022-05-01T00:00:00'. Normalize to UTC Z."""
    if not isinstance(s, str) or len(s) < 10:
        return None
    return f"{s[:10]}T00:00:00Z"


def _authors(p: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    org = p.get("organization") or {}
    affil = org.get("org_name") if isinstance(org, dict) else None
    for pi in p.get("principal_investigators") or []:
        if not isinstance(pi, dict):
            continue
        name = (pi.get("full_name") or "").strip()
        first = (pi.get("first_name") or "").strip() or None
        last = (pi.get("last_name") or "").strip() or None
        if not name:
            name = " ".join(x for x in (first, last) if x)
        if not name:
            continue
        out.append({
            "display_name": name,
            "given_name": first,
            "family_name": last,
            "orcid": None,
            "affiliation": affil,
            "payments": [],
        })
    return out


def _keywords(p: dict) -> list[str]:
    """RePORTER exposes terms as a ';'-joined string (pref_terms) and an
    angle-bracket-wrapped string (terms). Prefer the cleaner pref_terms."""
    pref = p.get("pref_terms")
    if isinstance(pref, str) and pref:
        return [t.strip() for t in pref.split(";") if t.strip()]
    return []


def _funding(p: dict) -> list[dict[str, Any]]:
    agency = p.get("agency_ic_admin") or {}
    funder = agency.get("name") if isinstance(agency, dict) else None
    amount = p.get("award_amount")
    fy = p.get("fiscal_year")
    entry: dict[str, Any] = {"funder": funder or "NIH"}
    if isinstance(amount, (int, float)):
        entry["amount_usd"] = float(amount)
    if p.get("project_num"):
        entry["grant_id"] = p.get("project_num")
    if fy is not None:
        entry["fiscal_year"] = str(fy)
    return [entry]


def parse(raw: bytes) -> dict[str, Any]:
    p = json.loads(raw)
    if not isinstance(p, dict):
        p = {}

    appl_id = p.get("appl_id")
    native = str(appl_id) if appl_id is not None else ""
    title = p.get("project_title") or ""
    abstract = p.get("abstract_text") or p.get("phr_text") or ""
    url = p.get("project_detail_url") or (
        f"https://reporter.nih.gov/project-details/{native}" if native else ""
    )
    org = p.get("organization") or {}

    return {
        "id": f"nih-reporter:{native}",
        "source": "nih-reporter",
        "source_native_id": native,
        "title": str(title)[:1000],
        "abstract": str(abstract)[:50_000],
        "canonical_url": str(url),
        "published_at": _date(p.get("project_start_date")),
        "license": "public-domain",
        "study_type": "OTHER",
        "authors": _authors(p),
        "mesh_terms": [],
        "keywords": _keywords(p),
        "funding": _funding(p),
    }
