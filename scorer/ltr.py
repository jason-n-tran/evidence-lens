"""LTR head — XGBoost LambdaMART rerank of RRF top 50 (spec §6.4).

Features: bm25_score_normalized, vector_score, citation_pagerank_log,
recency_decay, study_type_{rct,meta,systematic,observational,other},
has_full_text, log1p_citation_count, has_coi_authors, journal_predatory,
query_length_tokens, query_has_drug_entity.

Bootstrapped from synthetic relevance set with weak labels (RCT > obs,
recent > old, high-cite > low). Replaced with click-trained model after
30d traffic.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any

try:
    import xgboost as xgb
except ImportError:  # tests / dev without xgboost
    xgb = None  # type: ignore


_STUDY_ONEHOTS = ["RCT", "META_ANALYSIS", "SYSTEMATIC_REVIEW", "OBSERVATIONAL", "OTHER"]


@dataclass
class CandidateFeatures:
    bm25: float
    vector: float
    pagerank: float
    recency: float
    study_type: str
    has_full_text: bool
    citation_count: int
    has_coi_authors: bool
    journal_predatory: bool


def featurize(c: CandidateFeatures, query: str) -> list[float]:
    toks = max(1, len(query.split()))
    drug_entity = 1.0 if any(t.lower() in {"drug", "mg", "inhibitor", "agonist", "antagonist"} for t in query.split()) else 0.0
    onehots = [1.0 if c.study_type == s else 0.0 for s in _STUDY_ONEHOTS]
    return [
        c.bm25,
        c.vector,
        math.log1p(max(0.0, c.pagerank)),
        c.recency,
        *onehots,
        1.0 if c.has_full_text else 0.0,
        math.log1p(max(0, c.citation_count)),
        1.0 if c.has_coi_authors else 0.0,
        1.0 if c.journal_predatory else 0.0,
        float(toks),
        drug_entity,
    ]


class LTRReranker:
    def __init__(self, model_path: str | None = None) -> None:
        self.model_version = "ltr_synthetic_v0"
        self.model = None
        path = model_path or os.getenv("LTR_MODEL_PATH", "")
        if path and xgb is not None and os.path.exists(path):
            booster = xgb.Booster()
            booster.load_model(path)
            self.model = booster
            self.model_version = os.path.basename(path).replace(".json", "")

    def score(self, candidates: list[tuple[str, CandidateFeatures]], query: str) -> dict[str, float]:
        """Return {doc_id: ltr_score}. If no model loaded, returns
        weighted-sum fallback so the pipeline still ranks."""
        if not candidates:
            return {}
        feats = [featurize(c, query) for _, c in candidates]
        if self.model is None or xgb is None:
            # Synthetic-label fallback weights.
            return {
                cid: 1.5 * f[0] + 0.8 * f[1] + 0.3 * f[2] + 0.2 * f[3]
                + 0.6 * f[4] + 0.5 * f[5] + 0.4 * f[6]   # RCT/meta/systematic
                - 0.5 * f[12]                              # journal_predatory
                for (cid, _), f in zip(candidates, feats)
            }
        dmat = xgb.DMatrix(feats)
        scores = self.model.predict(dmat)
        return {cid: float(s) for (cid, _), s in zip(candidates, scores)}
