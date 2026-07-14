"""Reciprocal Rank Fusion (k=60) over four sub-scorer rankings (spec §5.5).

RRF score = sum_i 1 / (k + rank_i). Robust to score-scale differences
between scorers — much better than weighted-sum without calibration.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass


@dataclass
class FusedItem:
    doc_id: str
    rrf_score: float = 0.0
    bm25_score: float = 0.0
    vector_score: float = 0.0
    citation_pagerank: float = 0.0
    recency_score: float = 0.0


def rrf(rankings: dict[str, list[str]], k: int = 60) -> list[FusedItem]:
    """rankings: {scorer_name: [doc_id_in_rank_order]}.
    Returns descending by rrf_score."""
    accum: dict[str, FusedItem] = defaultdict(lambda: FusedItem(doc_id=""))
    for _scorer, ids in rankings.items():
        for rank, doc_id in enumerate(ids):
            item = accum[doc_id]
            item.doc_id = doc_id
            item.rrf_score += 1.0 / (k + rank + 1)
    return sorted(accum.values(), key=lambda x: x.rrf_score, reverse=True)
