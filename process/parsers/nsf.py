"""NSF Award Search parser.

NSF awards are research-funding records. Bespoke (not generic) so the PI
(author), award amount (funding), and MM/DD/YYYY dates are captured. NSF only
returns the fields named in the ingester's printFields, so this reads exactly
those keys.

Input: one NSF award object (JSON, full record archived by ingester-nsf).
Output: canonical Document dict.
"""
from __future__ import annotations

import json
import re
from typing import Any

_MDY = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")


def _date(s: Any) -> str | None:
    """NSF dates are MM/DD/YYYY."""
    if not isinstance(s, str):
        return None
    m = _MDY.match(s.strip())
    if not m:
        return None
    mm, dd, yyyy = m.groups()
    return f"{yyyy}-{mm}-{dd}T00:00:00Z"


def _authors(a: dict) -> list[dict[str, Any]]:
    affil = a.get("awardeeName") or None
    first = (a.get("piFirstName") or "").strip() or None
    last = (a.get("piLastName") or "").strip() or None
    name = (a.get("pdPIName") or "").strip() or " ".join(x for x in (first, last) if x)
    if not name:
        return []
    return [{
        "display_name": name,
        "given_name": first,
        "family_name": last,
        "orcid": None,
        "affiliation": affil,
        "payments": [],
    }]


def _funding(a: dict) -> list[dict[str, Any]]:
    amt = a.get("fundsObligatedAmt") or a.get("estimatedTotalAmt")
    entry: dict[str, Any] = {"funder": a.get("agency") or "NSF"}
    if amt is not None:
        try:
            entry["amount_usd"] = float(amt)
        except (ValueError, TypeError):
            pass
    if a.get("id"):
        entry["grant_id"] = str(a["id"])
    return [entry]


def parse(raw: bytes) -> dict[str, Any]:
    a = json.loads(raw)
    if not isinstance(a, dict):
        a = {}

    native = str(a.get("id") or "")
    return {
        "id": f"nsf:{native}",
        "source": "nsf",
        "source_native_id": native,
        "title": str(a.get("title") or "")[:1000],
        "abstract": str(a.get("abstractText") or "")[:50_000],
        "canonical_url": f"https://www.nsf.gov/awardsearch/showAward?AWD_ID={native}" if native else "",
        "published_at": _date(a.get("startDate")) or _date(a.get("date")),
        "license": "public-domain",
        "study_type": "OTHER",
        "authors": _authors(a),
        "mesh_terms": [],
        "keywords": [],
        "funding": _funding(a),
    }
