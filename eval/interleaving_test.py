"""Unit tests for the team-draft interleaving evaluator."""
from __future__ import annotations

import unittest

from interleaving import team_draft, evaluate_from_clicks, t_test_paired


class TeamDraftTest(unittest.TestCase):
    def test_alternates_pick(self):
        a = ["1", "2", "3", "4"]
        b = ["3", "5", "6", "7"]
        out, owner = team_draft(a, b, k=4)
        self.assertEqual(len(out), 4)
        self.assertEqual(owner["1"], "A")
        self.assertEqual(owner["3"], "B")  # B's 3 was picked because A's 1 already there
        self.assertNotIn("3", out[:1])

    def test_dedup(self):
        a = ["1", "2"]
        b = ["1", "3"]
        out, _ = team_draft(a, b, k=4)
        self.assertEqual(out, ["1", "3", "2"])

    def test_evaluate_clear_winner_a(self):
        a = {"q": ["1", "2", "3"]}
        b = {"q": ["10", "11", "12"]}
        clicks = {"q": ["1", "2"]}
        r = evaluate_from_clicks(a, b, clicks)
        self.assertEqual(r.a_wins, 1)
        self.assertEqual(r.b_wins, 0)
        self.assertGreater(r.confidence, 0.5)

    def test_t_test_zero_when_no_data(self):
        self.assertEqual(t_test_paired(0, 0, 0), 0.0)


if __name__ == "__main__":
    unittest.main()
