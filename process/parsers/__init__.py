"""Per-source parser modules. Each returns a normalized Document dict.

Dispatch by `source` field on the RawDocEvent. Adding a source = drop a
new module here and add a key to `PARSERS`. Sources without a bespoke
parser fall through to `generic.make_parser`, which extracts a best-
effort id/title/abstract using per-source field-name overrides.
"""
from __future__ import annotations

from typing import Callable

from . import pubmed as _pubmed
from . import trials as _trials
from . import fda as _fda
from . import preprint as _preprint
from . import openalex as _openalex
from . import crossref as _crossref
from . import nih_reporter as _nih_reporter
from . import chembl as _chembl
from . import nsf as _nsf
from . import hpo as _hpo
from . import core as _core
from . import unpaywall as _unpaywall
from . import europepmc as _europepmc
from . import semanticscholar as _semanticscholar
from . import clinvar as _clinvar
from . import generic as _generic

PARSERS: dict[str, Callable[[bytes], dict]] = {
    "pubmed":   _pubmed.parse,
    "ctgov":    _trials.parse,
    "biorxiv":  _preprint.parse,
    "medrxiv":  _preprint.parse,
    # openFDA sub-endpoints share the same parser shape:
    "openfda-drug-drugsfda":    _fda.parse,
    "openfda-drug-enforcement": _fda.parse,
    "openfda-device-event":     _fda.parse,
    "openfda-device-510k":      _fda.parse,
    # Round-2 sources (spec §2 rows 5, 16-20, 23-29) — each delegates to
    # the generic parser with a per-source mapping in generic._OVERRIDES.
    "core":          _core.parse,
    "chembl":        _chembl.parse,
    "omim":          _generic.make_parser("omim",          source_label="omim"),
    "hpo":           _hpo.parse,
    "disgenet":      _generic.make_parser("disgenet",      source_label="disgenet"),
    "cdc-wonder":    _generic.make_parser("cdc-wonder",    source_label="cdc-wonder"),
    "ema":           _generic.make_parser("ema",           source_label="ema",
                                            study_type="REGULATORY"),
    "mhra":          _generic.make_parser("mhra",          source_label="mhra",
                                            study_type="REGULATORY"),
    "health-canada": _generic.make_parser("health-canada", source_label="health-canada",
                                            study_type="REGULATORY"),
    "tga":           _generic.make_parser("tga",           source_label="tga",
                                            study_type="REGULATORY"),
    "pmda":          _generic.make_parser("pmda",          source_label="pmda",
                                            study_type="REGULATORY"),
    "nsf":           _nsf.parse,
    "drugbank":      _generic.make_parser("drugbank",      source_label="drugbank"),
    "pmc-oa":        _generic.make_parser("pmc-oa",        source_label="pmc-oa"),
    # Already-real ingesters whose processor side stays generic:
    "nih-reporter":  _nih_reporter.parse,
    "crossref":      _crossref.parse,
    "cochrane":      _generic.make_parser("cochrane",      source_label="cochrane",
                                            study_type="SYSTEMATIC_REVIEW"),
    "unpaywall":     _unpaywall.parse,
    "open-payments": _generic.make_parser("open-payments", source_label="open-payments"),
    "ictrp":         _generic.make_parser("ictrp",         source_label="ictrp",
                                            study_type="TRIAL_REGISTRY"),
    "openalex":      _openalex.parse,
    "europepmc":     _europepmc.parse,
    "semanticscholar": _semanticscholar.parse,
    "clinvar":       _clinvar.parse,
    "guideline-uspstf": _generic.make_parser("guideline-uspstf", source_label="uspstf",
                                                study_type="GUIDELINE"),
    "guideline-nice":   _generic.make_parser("guideline-nice", source_label="nice",
                                                study_type="GUIDELINE"),
    "guideline-ahrq":   _generic.make_parser("guideline-ahrq", source_label="ahrq",
                                                study_type="GUIDELINE"),
}


def parse(source: str, raw: bytes) -> dict:
    fn = PARSERS.get(source)
    if not fn:
        # Unknown source -> generic fallback so the pipeline never fails
        # hard. Operator should add to PARSERS for first-class handling.
        return _generic.make_parser(source, source_label=source)(raw)
    return fn(raw)
