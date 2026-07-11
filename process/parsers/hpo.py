"""Human Phenotype Ontology (HPO) term parser.

The HPO ingester pre-parses the OBO file into {id, name, def, synonyms} before
archiving, where:
  - def     is the raw OBO definition: '"text..." [refs]'
  - synonyms are raw OBO lines: '"Synonym name" EXACT layperson []'

This parser cleans those OBO artifacts into a plain title/abstract/keywords so
phenotype terms are searchable. Bespoke (not generic) because the generic picker
would store the quote-and-bracket-wrapped raw strings verbatim.

Input: one HPO term object (JSON) archived by ingester-hpo.
Output: canonical Document dict.
"""
from __future__ import annotations

import json
import re
from typing import Any

# Pull the quoted text out of an OBO def/synonym line: "the text" [refs...]
_QUOTED = re.compile(r'"((?:[^"\\]|\\.)*)"')


def _clean_quoted(s: Any) -> str:
    """Extract the quoted portion of an OBO def/synonym; fall back to the
    bracket-stripped string."""
    if not isinstance(s, str) or not s:
        return ""
    m = _QUOTED.search(s)
    if m:
        return m.group(1).replace('\\"', '"').strip()
    # No quotes: drop any trailing [refs] block.
    return re.sub(r"\s*\[.*\]\s*$", "", s).strip()


def parse(raw: bytes) -> dict[str, Any]:
    t = json.loads(raw)
    if not isinstance(t, dict):
        t = {}

    hid = t.get("id") or ""              # e.g. "HP:0000002"
    name = t.get("name") or ""
    definition = _clean_quoted(t.get("def"))
    synonyms = [_clean_quoted(s) for s in (t.get("synonyms") or [])]
    synonyms = [s for s in synonyms if s and s != name]

    # Abstract: the definition, enriched with synonyms so the term is findable
    # by its lay names even when the definition is terse.
    abstract = definition
    if synonyms:
        also = "Also known as: " + ", ".join(dict.fromkeys(synonyms)) + "."
        abstract = f"{definition} {also}".strip() if definition else also

    url = f"https://hpo.jax.org/browse/term/{hid}" if hid else ""

    return {
        "id": f"hpo:{hid}",
        "source": "hpo",
        "source_native_id": hid,
        "title": str(name)[:1000],
        "abstract": abstract[:50_000],
        "canonical_url": url,
        "published_at": None,  # ontology terms have no publication date
        "license": "hpo",  # HPO is freely available under its own terms
        "study_type": "OTHER",
        "authors": [],
        "mesh_terms": [],
        "keywords": list(dict.fromkeys(synonyms))[:50],
    }
