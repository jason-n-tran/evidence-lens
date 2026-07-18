"""Tests for Reciprocal Rank Fusion."""
from __future__ import annotations

import math
import unittest

from fusion import rrf


class RRFTest(unittest.TestCase):
    def test_higher_rank_higher_score(self):
        out = rrf({"bm25": ["a", "b", "c"]}, k=60)
        self.assertEqual(out[0].doc_id, "a")
        self.assertGreater(out[0].rrf_score, out[1].rrf_score)

    def test_two_lists_merge(self):
        out = rrf({
            "bm25":   ["a", "b", "c"],
            "vector": ["b", "c", "a"],
        }, k=60)
        self.assertEqual({i.doc_id for i in out}, {"a", "b", "c"})
        # 'b' is rank 2 in BM25 + rank 1 in vector; 'a' is rank 1 + rank 3.
        # Both should be very close in score; either could win depending on k.
        self.assertEqual(len(out), 3)

    def test_empty_input(self):
        self.assertEqual(rrf({}), [])

    def test_score_decreasing(self):
        out = rrf({"x": [str(i) for i in range(20)]}, k=60)
        scores = [r.rrf_score for r in out]
        for a, b in zip(scores, scores[1:]):
            self.assertGreaterEqual(a, b)
        # First score should equal 1/(60+1)
        self.assertAlmostEqual(out[0].rrf_score, 1 / 61, places=6)


if __name__ == "__main__":
    unittest.main()
