"""ClinicalTrials.gov v2 JSON parser."""
from __future__ import annotations

import json
from typing import Any


def _authors(proto: dict) -> list[dict[str, Any]]:
    """Map a trial's responsible people/orgs into the authors list:
    overall officials (PIs/study chairs, with affiliation) first, then the
    lead sponsor and collaborators as organizational 'authors'. This makes
    trials searchable by investigator/sponsor and lets the COI joiner run."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(name: str, affiliation: str | None) -> None:
        name = (name or "").strip()
        if not name or name.lower() in seen:
            return
        seen.add(name.lower())
        out.append({
            "display_name": name,
            "given_name": None,
            "family_name": None,
            "orcid": None,
            "affiliation": (affiliation or None),
            "payments": [],
        })

    contacts = proto.get("contactsLocationsModule", {}) or {}
    for off in contacts.get("overallOfficials", []) or []:
        if isinstance(off, dict):
            add(off.get("name", ""), off.get("affiliation"))

    sponsors = proto.get("sponsorCollaboratorsModule", {}) or {}
    lead = sponsors.get("leadSponsor") or {}
    if isinstance(lead, dict):
        add(lead.get("name", ""), None)
    for collab in sponsors.get("collaborators", []) or []:
        if isinstance(collab, dict):
            add(collab.get("name", ""), None)

    return out


def parse(raw: bytes) -> dict[str, Any]:
    s = json.loads(raw)
    proto = s.get("protocolSection", {})
    ident = proto.get("identificationModule", {})
    nct = ident.get("nctId", "")
    title = ident.get("officialTitle") or ident.get("briefTitle") or ""
    desc = proto.get("descriptionModule", {})
    abstract = desc.get("briefSummary") or desc.get("detailedDescription") or ""
    status_mod = proto.get("statusModule", {})
    status = status_mod.get("overallStatus", "unknown").lower()
    phase = (proto.get("designModule", {}).get("phases") or ["NA"])[0].lower().replace(" ", "_")
    conditions = proto.get("conditionsModule", {}).get("conditions", [])
    interventions = [
        i.get("name", "") for i in proto.get("armsInterventionsModule", {}).get("interventions", [])
    ]
    locations = [
        f"{loc.get('city', '')}, {loc.get('country', '')}".strip(", ")
        for loc in proto.get("contactsLocationsModule", {}).get("locations", [])
    ]
    first_submit = (
        status_mod.get("studyFirstSubmitDate") or
        (status_mod.get("startDateStruct") or {}).get("date") or ""
    )
    published_at = f"{first_submit}T00:00:00Z" if first_submit else None

    return {
        "id": f"nct:{nct}",
        "source": "ctgov",
        "source_native_id": nct,
        "nct_id": nct,
        "title": title,
        "abstract": abstract,
        "canonical_url": f"https://clinicaltrials.gov/study/{nct}",
        "published_at": published_at,
        "license": "public-domain",
        "study_type": "TRIAL_REGISTRY",
        "trial": {
            "registry": "ctgov",
            "status": status,
            "phase": phase,
            "conditions": conditions,
            "interventions": interventions,
            "locations": locations,
            "enrollment": (proto.get("designModule", {}).get("enrollmentInfo", {}) or {}).get("count"),
            "primary_outcome": (proto.get("outcomesModule", {}).get("primaryOutcomes") or [{}])[0].get("measure"),
        },
        "authors": _authors(proto),
        "mesh_terms": [],
        "keywords": [],
    }
