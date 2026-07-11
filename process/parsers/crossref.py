"""Crossref works JSON parser.

Crossref needs a bespoke parser (not the generic one) because:
  1. The API wraps the work in a `message` envelope: {status, message-type,
     message: {...}}. The generic parser reads top-level keys and would find
     nothing.
  2. title / container-title / ISSN are ARRAYS (take first).
  3. abstract, when present, is JATS XML (<jats:p>...</jats:p>) that must be
     stripped to plain text.
  4. authors are structured objects (given/family/affiliation), not a string.
  5. dates are date-parts arrays ([[YYYY, MM, DD]], possibly partial).
  6. outbound citations live under `reference[].DOI` (not all entries have one).

Input: a Crossref /works response, archived verbatim by ingester-crossref
(includes the message envelope). Output: canonical Document dict.
"""
from __future__ import annotations

import html
import json
import re
from typing import Any

_JATS_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _unwrap(obj: Any) -> dict:
    """Crossref archives the full response; unwrap the `message` envelope.
    Tolerate an already-unwrapped work object too."""
    if isinstance(obj, dict) and isinstance(obj.get("message"), dict):
        return obj["message"]
    return obj if isinstance(obj, dict) else {}


def _first(v: Any) -> Any:
    if isinstance(v, list):
        return v[0] if v else None
    return v


def _clean_abstract(jats: Any) -> str:
    if not isinstance(jats, str) or not jats:
        return ""
    # Strip JATS/XML tags, unescape HTML entities (&gt; etc.), collapse ws.
    text = _JATS_TAG.sub(" ", jats)
    text = html.unescape(text)
    text = _WS.sub(" ", text).strip()
    if text.lower().startswith("abstract "):
        text = text[len("abstract "):].strip()
    return text


def _date_from_parts(node: Any) -> str | None:
    """Crossref dates: {"date-parts": [[YYYY, MM, DD]]} (MM/DD optional)."""
    if not isinstance(node, dict):
        return None
    dp = node.get("date-parts")
    if not (isinstance(dp, list) and dp and isinstance(dp[0], list) and dp[0]):
        return None
    parts = dp[0]
    try:
        year = int(parts[0])
    except (ValueError, TypeError):
        return None
    month = int(parts[1]) if len(parts) > 1 and parts[1] else 1
    day = int(parts[2]) if len(parts) > 2 and parts[2] else 1
    return f"{year:04d}-{month:02d}-{day:02d}T00:00:00Z"


def _published_at(m: dict) -> str | None:
    for key in ("issued", "published", "published-print", "published-online", "created"):
        d = _date_from_parts(m.get(key))
        if d:
            return d
    return None


def _authors(m: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in m.get("author") or []:
        if not isinstance(a, dict):
            continue
        given = (a.get("given") or "").strip() or None
        family = (a.get("family") or "").strip() or None
        if given and family:
            display = f"{given} {family}"
        else:
            display = family or given or (a.get("name") or "").strip()
        if not display:
            continue
        orcid = a.get("ORCID")
        if isinstance(orcid, str) and orcid:
            orcid = orcid.rsplit("/", 1)[-1]
        else:
            orcid = None
        affil = None
        affils = a.get("affiliation") or []
        if affils and isinstance(affils[0], dict):
            affil = affils[0].get("name") or None
        out.append({
            "display_name": display,
            "given_name": given,
            "family_name": family,
            "orcid": orcid,
            "affiliation": affil,
            "payments": [],
        })
    return out


def _citations(m: dict) -> list[str]:
    out: list[str] = []
    for ref in m.get("reference") or []:
        if isinstance(ref, dict):
            doi = ref.get("DOI")
            if isinstance(doi, str) and doi:
                out.append(f"doi:{doi.lower()}")
    return out


def _journal(m: dict) -> dict[str, Any] | None:
    name = _first(m.get("container-title"))
    if not name:
        return None
    issn = _first(m.get("ISSN"))
    publisher = m.get("publisher")
    j: dict[str, Any] = {"name": name, "issn": issn or None, "is_predatory": False}
    if publisher:
        j["publisher"] = publisher
    return j


# Crossref `type` -> canonical study_type (best-effort; full classifier runs later).
_TYPE_MAP = {
    "journal-article": "OTHER",
    "proceedings-article": "OTHER",
    "posted-content": "PREPRINT",
    "book": "OTHER",
    "book-chapter": "OTHER",
    "review": "REVIEW",
    "dataset": "OTHER",
}


def parse(raw: bytes) -> dict[str, Any]:
    obj = json.loads(raw)
    m = _unwrap(obj)

    doi = m.get("DOI")
    doi = doi.lower() if isinstance(doi, str) and doi else None
    short = doi or ""

    title = html.unescape(_first(m.get("title")) or "")
    abstract = _clean_abstract(m.get("abstract"))
    url = m.get("URL") or (f"https://doi.org/{doi}" if doi else "")
    license_str = "unknown"
    lic = m.get("license")
    if isinstance(lic, list) and lic and isinstance(lic[0], dict):
        license_str = lic[0].get("URL") or "unknown"

    ctype = m.get("type") or ""

    return {
        "id": f"doi:{short}" if short else f"crossref:{_first(m.get('alternative-id')) or ''}",
        "source": "crossref",
        "source_native_id": short,
        "doi": doi,
        "title": str(title)[:1000],
        "abstract": abstract[:50_000],
        "canonical_url": str(url),
        "published_at": _published_at(m),
        "license": str(license_str),
        "study_type": _TYPE_MAP.get(ctype, "OTHER"),
        # Crossref's inbound citation count. enrich_citations won't zero it.
        "citation_count": int(m["is-referenced-by-count"]) if isinstance(m.get("is-referenced-by-count"), (int, float)) else 0,
        "authors": _authors(m),
        "mesh_terms": [],
        "keywords": [s for s in (m.get("subject") or []) if isinstance(s, str)],
        "citations": _citations(m),
        "journal": _journal(m),
    }
