"""Entity linker (spec §5.2 step 3).

Loads scispaCy `en_core_sci_lg` lazily on first use (the model is ~600MB
so we don't pay the cost in tests). Extracts entities, runs the UMLS
linker, and returns deduplicated MeSH-like canonical forms.

When scispaCy can't be imported or the model isn't downloaded, falls
back to a regex-based extractor over a small biomedical glossary so
the pipeline still flows without breaking.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

import structlog

log = structlog.get_logger("processor.entity_linker")


def _umls_enabled() -> bool:
    """The scispaCy UMLS linker loads ~3-4GB (model + tfidf + nmslib index).
    Under the processor's memory cap this OOM-kills the container and wedges
    the whole pipeline. It's therefore OFF by default; set ENABLE_UMLS_LINKER=1
    (and give the processor enough RAM) to opt back in. When off, link() uses
    the low-memory regex fallback below."""
    return os.getenv("ENABLE_UMLS_LINKER", "").lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class LinkedEntity:
    text: str
    canonical: str  # canonical preferred term (MeSH preferred name when available)
    cui: str        # UMLS Concept Unique Identifier; empty when not linked


@lru_cache(maxsize=1)
def _load_pipeline():
    """Returns (nlp, linker) or (None, None) on failure / when disabled."""
    if not _umls_enabled():
        log.info("UMLS linker disabled (ENABLE_UMLS_LINKER unset); using regex fallback")
        return None, None
    try:
        import scispacy  # noqa: F401  -- triggers extension registration
        import spacy
        from scispacy.linking import EntityLinker  # noqa: F401
        nlp = spacy.load("en_core_sci_lg")
        nlp.add_pipe("scispacy_linker", config={
            "resolve_abbreviations": True,
            "linker_name": "umls",
            "max_entities_per_mention": 1,
        })
        linker = nlp.get_pipe("scispacy_linker")
        log.info("scispacy entity linker loaded")
        return nlp, linker
    except Exception as e:  # noqa: BLE001
        log.warning("scispacy unavailable; using fallback extractor", err=str(e))
        return None, None


# Tiny seed glossary for the fallback path. Keys are display forms;
# values are canonical preferred terms.
_FALLBACK_TERMS: dict[str, str] = {
    "heart failure": "Heart Failure",
    "myocardial infarction": "Myocardial Infarction",
    "atrial fibrillation": "Atrial Fibrillation",
    "coronary artery disease": "Coronary Artery Disease",
    "type 2 diabetes": "Diabetes Mellitus, Type 2",
    "diabetes": "Diabetes Mellitus",
    "hypertension": "Hypertension",
    "chronic kidney disease": "Renal Insufficiency, Chronic",
    "chronic obstructive pulmonary disease": "Pulmonary Disease, Chronic Obstructive",
    "stroke": "Stroke",
    "cancer": "Neoplasms",
    "lung cancer": "Lung Neoplasms",
    "breast cancer": "Breast Neoplasms",
    "colorectal cancer": "Colorectal Neoplasms",
    "covid-19": "COVID-19",
    "sars-cov-2": "SARS-CoV-2",
    "alzheimer": "Alzheimer Disease",
    "parkinson": "Parkinson Disease",
    "obesity": "Obesity",
    "depression": "Depressive Disorder",
}

_FALLBACK_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in _FALLBACK_TERMS) + r")\b",
    re.IGNORECASE,
)


def link(text: str, max_entities: int = 50) -> list[LinkedEntity]:
    """Extract + link entities from `text`. Returns at most `max_entities`."""
    if not text:
        return []
    nlp, linker = _load_pipeline()
    out: list[LinkedEntity] = []
    seen: set[str] = set()

    if nlp is None:
        for m in _FALLBACK_PATTERN.finditer(text):
            disp = m.group(1)
            canon = _FALLBACK_TERMS[disp.lower()]
            if canon in seen:
                continue
            seen.add(canon)
            out.append(LinkedEntity(text=disp, canonical=canon, cui=""))
            if len(out) >= max_entities:
                break
        return out

    doc = nlp(text[:50_000])
    kb = linker.kb
    for ent in doc.ents:
        if not ent._.kb_ents:
            continue
        cui, score = ent._.kb_ents[0]
        if score < 0.85:
            continue
        kb_entity = kb.cui_to_entity[cui]
        canon = kb_entity.canonical_name
        if canon in seen:
            continue
        seen.add(canon)
        out.append(LinkedEntity(text=ent.text, canonical=canon, cui=cui))
        if len(out) >= max_entities:
            break
    return out


def merge_into_mesh(existing: Iterable[str], extracted: Iterable[LinkedEntity]) -> list[str]:
    """De-dup canonicals into the existing mesh_terms list, preserving
    upstream order so trusted source-provided MeSH stays first."""
    out = list(existing)
    seen = {x.lower() for x in out}
    for e in extracted:
        c = e.canonical
        if c.lower() not in seen:
            out.append(c)
            seen.add(c.lower())
    return out
