"""bioRxiv / medRxiv API JSON parser."""
from __future__ import annotations

import json
import re
from typing import Any

# bioRxiv/medRxiv DOIs encode the ORIGINAL posting date:
#   10.1101/2024.06.28.24309663  ->  2024-06-28
#   10.64898/2026.01.25.26344780 ->  2026-01-25
# The API's own `date` field reflects the CURRENT version's posting date (e.g.
# today for a revision fetched in a delta run), so prefer the DOI-derived date
# for a stable publication date; fall back to the `date` field.
_DOI_DATE = re.compile(r"/(\d{4})\.(\d{2})\.(\d{2})\.")


def _published_at(doi: str, date_field: str) -> str | None:
    m = _DOI_DATE.search(doi or "")
    if m:
        y, mo, d = m.groups()
        return f"{y}-{mo}-{d}T00:00:00Z"
    if date_field:
        return f"{date_field}T00:00:00Z"
    return None


def parse(raw: bytes) -> dict[str, Any]:
    r = json.loads(raw)
    # The bioRxiv API returns `server` as "bioRxiv"/"medRxiv" (camelCase), but
    # the ingester archives under and the rest of the system keys on the
    # lowercase source ("biorxiv"/"medrxiv"). Normalize so the doc's source
    # matches its NATS subject / S3 prefix / parser-dispatch key.
    server = (r.get("server") or "biorxiv").lower()
    doi = r.get("doi", "")
    published_at = _published_at(doi, r.get("date") or r.get("version_date") or "")
    return {
        "id": f"{server}:{doi}",
        "source": server,
        "source_native_id": doi,
        "doi": doi.lower() if doi else None,
        "title": r.get("title", ""),
        "abstract": r.get("abstract", ""),
        "canonical_url": f"https://www.{server}.org/content/{doi}",
        "published_at": published_at,
        "license": r.get("license") or ("CC-BY-4.0" if server == "biorxiv" else "CC-BY-NC-ND-4.0"),
        "study_type": "PREPRINT",
        "authors": [
            {"display_name": a, "payments": []}
            for a in (r.get("authors", "") or "").split("; ") if a
        ],
        "mesh_terms": [],
        "keywords": [],
        "journal": {"name": server, "is_predatory": False},
    }
