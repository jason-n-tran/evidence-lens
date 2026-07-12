"""Tests for the generic per-source parser."""
from __future__ import annotations

import json
import unittest

from parsers.generic import make_parser


class GenericParserTest(unittest.TestCase):
    def test_chembl_pulls_pref_name(self):
        raw = json.dumps({"molecule_chembl_id": "CHEMBL25", "pref_name": "Aspirin"}).encode()
        parsed = make_parser("chembl")(raw)
        self.assertEqual(parsed["id"], "chembl:CHEMBL25")
        self.assertEqual(parsed["title"], "Aspirin")
        self.assertEqual(parsed["source"], "chembl")

    def test_omim_uses_mim_number(self):
        raw = json.dumps({"mimNumber": 100100, "titles": {"preferredTitle": "Test"}}).encode()
        parsed = make_parser("omim")(raw)
        self.assertEqual(parsed["id"], "omim:100100")

    def test_unknown_source_falls_back_to_default_picks(self):
        raw = json.dumps({"id": "X", "title": "Y", "abstract": "Z"}).encode()
        parsed = make_parser("madeup")(raw)
        self.assertEqual(parsed["id"], "madeup:X")
        self.assertEqual(parsed["title"], "Y")

    def test_no_id_yields_hash_id(self):
        raw = json.dumps({"name": "anonymous"}).encode()
        parsed = make_parser("ema")(raw)
        self.assertTrue(parsed["id"].startswith("ema:"))
        # Hash-based id is 16 hex chars after the prefix.
        self.assertGreaterEqual(len(parsed["id"]), len("ema:") + 16)

    def test_study_type_default(self):
        parsed = make_parser("cochrane", study_type="SYSTEMATIC_REVIEW")(b'{"doi":"10.1/x"}')
        self.assertEqual(parsed["study_type"], "SYSTEMATIC_REVIEW")

    def test_malformed_json_doesnt_crash(self):
        parsed = make_parser("core")(b"not json at all")
        self.assertIn("source", parsed)
        self.assertEqual(parsed["source"], "core")


if __name__ == "__main__":
    unittest.main()
