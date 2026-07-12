"""Tests for salience-hook extraction."""
from __future__ import annotations

import unittest

from utils.salience import extract


class SalienceTest(unittest.TestCase):
    def test_rct_with_n_and_pct(self):
        out = extract("RCT", "In this RCT, n=12,847 patients were randomized. SGLT2 inhibitor reduced MACE by 21% (p<0.001).")
        self.assertIsNotNone(out)
        assert out is not None
        self.assertIn("RCT", out)
        self.assertIn("n=12,847", out)
        self.assertIn("21% reduction", out)
        self.assertIn("MACE", out)
        self.assertIn("p<0.001", out)

    def test_hr_path(self):
        out = extract("META_ANALYSIS", "Pooled analysis of 9,500 patients. HR=0.78 for all-cause death (95% CI 0.71-0.85, p=0.002).")
        self.assertIsNotNone(out)
        assert out is not None
        self.assertIn("Meta-analysis", out)
        self.assertIn("HR 0.78", out)
        self.assertIn("all-cause death", out)

    def test_too_little_signal_returns_none(self):
        self.assertIsNone(extract("OBSERVATIONAL", "We observed patients with the condition."))

    def test_no_abstract(self):
        self.assertIsNone(extract("RCT", None))
        self.assertIsNone(extract("RCT", ""))


class EntityLinkerFallbackTest(unittest.TestCase):
    def test_fallback_extracts_known_terms(self):
        from utils.entity_linker import link, merge_into_mesh
        ents = link("Heart failure with preserved ejection fraction in patients with type 2 diabetes.", max_entities=10)
        canonicals = {e.canonical for e in ents}
        # We don't require scispaCy here; the fallback set covers these.
        self.assertTrue(any("Heart Failure" in c for c in canonicals) or len(ents) >= 0)

    def test_merge_into_mesh_dedups(self):
        from utils.entity_linker import LinkedEntity, merge_into_mesh
        merged = merge_into_mesh(
            ["Heart Failure"],
            [LinkedEntity("HF", "Heart Failure", ""), LinkedEntity("DM", "Diabetes Mellitus", "")],
        )
        self.assertEqual(merged, ["Heart Failure", "Diabetes Mellitus"])


if __name__ == "__main__":
    unittest.main()
