"""Unpaywall parser (open-access location metadata for a DOI).

Unpaywall is primarily an OA-enrichment source: given a DOI it returns
bibliographic metadata + open-access locations. It has NO abstract. Bespoke
(not generic) so authors (z_authors), journal, and the OA link are captured and
a minimal descriptive abstract is synthesized so the record is non-empty.

Input: one Unpaywall /v2/{doi} response (JSON). Output: canonical Document dict.
"""
from __future__ import annotations

import json
from typing import Any


def _date(d: dict) -> str | None:
    pd = d.get("published_date")
    if isinstance(pd, str) and len(pd) >= 10:
        return f"{pd[:10]}T00:00:00Z"
    yr = d.get("year")
    if isinstance(yr, int) and 1000 <= yr <= 2100:
        return f"{yr:04d}-01-01T00:00:00Z"
    if isinstance(yr, str) and yr.isdigit():
        return f"{int(yr):04d}-01-01T00:00:00Z"
    return None


def _authors(d: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for za in d.get("z_authors") or []:
        if not isinstance(za, dict):
            continue
        given = (za.get("given") or "").strip() or None
        family = (za.get("family") or "").strip() or None
        name = (za.get("raw_author_name") or "").strip() or " ".join(
            x for x in (given, family) if x
        )
        if not name:
            continue
        affils = za.get("raw_affiliation_strings") or []
        affil = affils[0] if affils and isinstance(affils[0], str) else None
        out.append({
            "display_name": name,
            "given_name": given,
            "family_name": family,
            "orcid": None,
            "affiliation": affil,
            "payments": [],
        })
    return out


def _synth_abstract(d: dict, title: str) -> str:
    bits = []
    journal = d.get("journal_name")
    year = d.get("year")
    lead = title or d.get("doi") or "This work"
    s = lead
    if journal:
        s += f" (published in {journal}"
        if year:
            s += f", {year}"
        s += ")"
    elif year:
        s += f" ({year})"
    bits.append(s + ".")
    if d.get("is_oa"):
        status = d.get("oa_status") or "open"
        loc = d.get("best_oa_location") or {}
        url = loc.get("url") if isinstance(loc, dict) else None
        bits.append(f"Open access ({status}).")
        if url:
            bits.append(f"Full text: {url}")
    else:
        bits.append("No open-access copy located.")
    return " ".join(bits)


def parse(raw: bytes) -> dict[str, Any]:
    d = json.loads(raw)
    if not isinstance(d, dict):
        d = {}

    doi = d.get("doi")
    doi = doi.lower() if isinstance(doi, str) and doi else None
    title = d.get("title") or ""
    loc = d.get("best_oa_location") or {}
    oa_url = loc.get("url") if isinstance(loc, dict) else None
    url = oa_url or d.get("doi_url") or (f"https://doi.org/{doi}" if doi else "")

    journal = None
    if d.get("journal_name"):
        journal = {
            "name": d["journal_name"],
            "issn": d.get("journal_issn_l") or None,
            "is_predatory": False,
        }
        if d.get("publisher"):
            journal["publisher"] = d["publisher"]

    return {
        "id": f"doi:{doi}" if doi else "unpaywall:",
        "source": "unpaywall",
        "source_native_id": doi or "",
        "doi": doi,
        "title": str(title)[:1000],
        "abstract": _synth_abstract(d, title)[:50_000],
        "canonical_url": str(url),
        "published_at": _date(d),
        "license": "unknown",
        "study_type": "OTHER",
        "authors": _authors(d),
        "mesh_terms": [],
        "keywords": [],
        "journal": journal,
    }
