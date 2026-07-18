"""Tests for the exp-decay recency sub-scorer."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from recency import recency_score, HALF_LIFE_DAYS


class RecencyTest(unittest.TestCase):
    def test_now_close_to_one(self):
        now_iso = datetime.now(timezone.utc).isoformat()
        s = recency_score(now_iso)
        self.assertAlmostEqual(s, 1.0, places=2)

    def test_one_half_life_close_to_half(self):
        ts = datetime.now(timezone.utc) - timedelta(days=HALF_LIFE_DAYS)
        s = recency_score(ts.isoformat())
        self.assertAlmostEqual(s, 0.5, places=2)

    def test_none_returns_zero(self):
        self.assertEqual(recency_score(None), 0.0)
        self.assertEqual(recency_score(""), 0.0)

    def test_z_suffix_supported(self):
        ts = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat().replace("+00:00", "Z")
        s = recency_score(ts)
        self.assertGreater(s, 0.5)
        self.assertLess(s, 1.0)


if __name__ == "__main__":
    unittest.main()
