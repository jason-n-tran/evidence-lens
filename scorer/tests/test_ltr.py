"""Tests for LTR feature extraction + synthetic-label fallback ranking."""
from __future__ import annotations

import unittest

from ltr import featurize, CandidateFeatures, LTRReranker


def _make(study_type: str = "OBSERVATIONAL", **overrides) -> CandidateFeatures:
    base = dict(
        bm25=1.0, vector=0.5, pagerank=0.001, recency=0.5,
        study_type=study_type, has_full_text=False, citation_count=10,
        has_coi_authors=False, journal_predatory=False,
    )
    base.update(overrides)
    return CandidateFeatures(**base)


class FeaturesTest(unittest.TestCase):
    def test_feature_vector_length(self):
        v = featurize(_make(), "sglt2 inhibitors")
        # 4 numeric + 5 study one-hots + 4 booleans/numerics + 2 query feats
        self.assertGreaterEqual(len(v), 14)

    def test_drug_entity_query(self):
        v_with = featurize(_make(), "metformin mg")
        v_without = featurize(_make(), "lifestyle interventions")
        self.assertEqual(v_with[-1], 1.0)
        self.assertEqual(v_without[-1], 0.0)


class FallbackRankingTest(unittest.TestCase):
    def test_rct_scores_higher_than_observational(self):
        ltr = LTRReranker()
        cands = [
            ("doc-rct", _make(study_type="RCT", citation_count=100)),
            ("doc-obs", _make(study_type="OBSERVATIONAL", citation_count=100)),
        ]
        scores = ltr.score(cands, "heart failure")
        self.assertGreater(scores["doc-rct"], scores["doc-obs"])

    def test_predatory_journal_demoted(self):
        ltr = LTRReranker()
        cands = [
            ("doc-good", _make(journal_predatory=False)),
            ("doc-bad",  _make(journal_predatory=True)),
        ]
        scores = ltr.score(cands, "x")
        self.assertGreater(scores["doc-good"], scores["doc-bad"])


if __name__ == "__main__":
    unittest.main()
