"""ChEMBL molecule parser (scoped to named/approved drugs).

ChEMBL records are chemical compounds, not papers: no abstract, authors, or
citations. The ingester is scoped to named drugs (pref_name set), so a record
has a real drug name we use as the title. The "abstract" is synthesized from
chemical identity (type, formula, max clinical phase, synonyms) so the record is
searchable and the result card shows something meaningful.

Input: one ChEMBL molecule object (JSON, full record archived by
ingester-chembl). Output: canonical Document dict.
"""
from __future__ import annotations

import json
from typing import Any

_PHASE_LABEL = {
    "4": "approved",
    "4.0": "approved",
    "3": "phase 3",
    "3.0": "phase 3",
    "2": "phase 2",
    "2.0": "phase 2",
    "1": "phase 1",
    "1.0": "phase 1",
    "0": "preclinical",
    "0.0": "preclinical",
    "-1": "unknown phase",
}


def _synonyms(m: dict) -> list[str]:
    out: list[str] = []
    for s in m.get("molecule_synonyms") or []:
        if isinstance(s, dict):
            name = s.get("molecule_synonym")
            if name and name not in out:
                out.append(name)
    return out


def _synthesize_abstract(m: dict, name: str, synonyms: list[str]) -> str:
    props = m.get("molecule_properties") or {}
    mtype = m.get("molecule_type") or "compound"
    phase = m.get("max_phase")
    phase_label = _PHASE_LABEL.get(str(phase)) if phase is not None else None
    parts: list[str] = []
    lead = name or m.get("molecule_chembl_id") or "This compound"
    desc = f"{lead} is a {mtype.lower()}"
    if phase_label:
        desc += f" ({phase_label})"
    parts.append(desc + ".")
    formula = props.get("full_molformula") if isinstance(props, dict) else None
    mwt = props.get("full_mwt") if isinstance(props, dict) else None
    if formula:
        chem = f"Molecular formula {formula}"
        if mwt:
            chem += f", molecular weight {mwt}"
        parts.append(chem + ".")
    if m.get("indication_class"):
        parts.append(f"Indication class: {m['indication_class']}.")
    if synonyms:
        parts.append("Also known as: " + ", ".join(synonyms[:10]) + ".")
    return " ".join(parts)


def parse(raw: bytes) -> dict[str, Any]:
    m = json.loads(raw)
    if not isinstance(m, dict):
        m = {}

    cid = m.get("molecule_chembl_id") or ""
    name = (m.get("pref_name") or "").strip()
    synonyms = _synonyms(m)
    # Title: prefer the drug name; fall back to a synonym, then the ChEMBL id.
    title = name or (synonyms[0] if synonyms else cid)

    keywords = list(synonyms)
    if m.get("molecule_type"):
        keywords.append(m["molecule_type"])

    return {
        "id": f"chembl:{cid}",
        "source": "chembl",
        "source_native_id": cid,
        "title": str(title)[:1000],
        "abstract": _synthesize_abstract(m, name, synonyms)[:50_000],
        "canonical_url": f"https://www.ebi.ac.uk/chembl/explore/compound/{cid}" if cid else "",
        "published_at": None,  # compounds have no publication date
        "license": "CC-BY-SA-3.0",  # ChEMBL data license
        "study_type": "OTHER",
        "authors": [],
        "mesh_terms": [],
        "keywords": keywords[:50],
    }
