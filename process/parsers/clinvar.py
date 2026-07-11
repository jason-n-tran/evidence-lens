"""NCBI ClinVar variant parser.

ClinVar records are gene/variant-disease clinical-significance entries, not
papers. Bespoke parser: title is the variant name, and a searchable abstract is
synthesized from classification + gene + molecular consequence + conditions.

Input: one ClinVar esummary record object (JSON, archived by ingester-clinvar).
Output: canonical Document dict.
"""
from __future__ import annotations

import json
from typing import Any


def _genes(r: dict) -> list[str]:
    out: list[str] = []
    for g in r.get("genes") or []:
        if isinstance(g, dict) and g.get("symbol"):
            out.append(g["symbol"])
    return out


def _conditions(r: dict) -> list[str]:
    """Associated conditions from germline_classification trait set."""
    out: list[str] = []
    gc = r.get("germline_classification") or {}
    for tset in gc.get("trait_set") or []:
        if isinstance(tset, dict) and tset.get("trait_name"):
            out.append(tset["trait_name"])
    return out


def _date(r: dict) -> str | None:
    gc = r.get("germline_classification") or {}
    le = gc.get("last_evaluated")
    # Format like "2026/06/05 00:00"
    if isinstance(le, str) and len(le) >= 10:
        d = le[:10].replace("/", "-")
        return f"{d}T00:00:00Z"
    return None


def _synth_abstract(r: dict, title: str, genes: list[str], conditions: list[str]) -> str:
    gc = r.get("germline_classification") or {}
    sig = gc.get("description") or "Pathogenic"
    parts = [f"{title or 'This variant'} is classified as {sig} in ClinVar."]
    if genes:
        parts.append("Gene(s): " + ", ".join(genes) + ".")
    mcl = r.get("molecular_consequence_list") or []
    if mcl:
        parts.append("Molecular consequence: " + ", ".join(str(m) for m in mcl) + ".")
    if r.get("protein_change"):
        parts.append(f"Protein change: {r['protein_change']}.")
    if conditions:
        parts.append("Associated condition(s): " + ", ".join(conditions) + ".")
    rs = gc.get("review_status")
    if rs:
        parts.append(f"Review status: {rs}.")
    return " ".join(parts)


def parse(raw: bytes) -> dict[str, Any]:
    r = json.loads(raw)
    if not isinstance(r, dict):
        r = {}

    uid = str(r.get("uid") or "")
    accession = r.get("accession") or ""
    title = r.get("title") or ""
    genes = _genes(r)
    conditions = _conditions(r)

    keywords = list(genes)
    for m in r.get("molecular_consequence_list") or []:
        if isinstance(m, str):
            keywords.append(m)
    keywords.extend(conditions)

    url = f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{r.get('variation_set_id') or uid}/"

    return {
        "id": f"clinvar:{uid}",
        "source": "clinvar",
        "source_native_id": accession or uid,
        "title": str(title)[:1000],
        "abstract": _synth_abstract(r, title, genes, conditions)[:50_000],
        "canonical_url": url,
        "published_at": _date(r),
        "license": "public-domain",
        "study_type": "OTHER",
        "authors": [],
        "mesh_terms": [],
        "keywords": list(dict.fromkeys(k for k in keywords if k))[:50],
    }
