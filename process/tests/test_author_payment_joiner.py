"""Tests for the author × Open Payments fuzzy joiner helpers.

Database-touching paths are covered in tests/integration/; here we test
the pure-function name-normalization and badge-derivation logic.
"""
from __future__ import annotations

import unittest

from utils.author_payment_joiner import normalize_name_key, AuthorPaymentJoiner, AuthorBadge, PaymentMatch


class NormalizeNameTest(unittest.TestCase):
    def test_smith_ja_ca(self):
        self.assertEqual(normalize_name_key("Smith JA", "CA"), "smith:j:ca")

    def test_unicode_strip(self):
        # Mañana M -> manana:m:_
        self.assertEqual(normalize_name_key("Mañana M", None), "manana:m:")

    def test_lastname_first_comma(self):
        # "Smith, John" -> "john" first, "smith" last after split
        # The current normaliser splits on comma+spaces, so order swaps.
        self.assertEqual(normalize_name_key("Smith, John", "NY"), "john:s:ny")


class BadgeDerivationTest(unittest.TestCase):
    def test_no_payments_badge_empty(self):
        b = AuthorPaymentJoiner._make_badge([])
        self.assertEqual(b, AuthorBadge(False, 0.0, None, None, 0, []))

    def test_top_sponsor_picked_by_total(self):
        matches = [
            PaymentMatch("Pfizer", 2024, 100, "consulting", "p1"),
            PaymentMatch("Pfizer", 2024, 200, "research",   "p2"),
            PaymentMatch("Merck",  2023, 1000, "research",  "m1"),
        ]
        b = AuthorPaymentJoiner._make_badge(matches)
        self.assertTrue(b.has_payments)
        self.assertEqual(b.top_sponsor, "Merck")
        self.assertEqual(b.top_sponsor_amount_usd, 1000.0)
        self.assertEqual(b.total_payments_usd, 1300.0)
        self.assertEqual(set(b.years_covered), {"2023", "2024"})
        # last-year count = matches in max year (2024) = 2
        self.assertEqual(b.payments_last_year, 2)


if __name__ == "__main__":
    unittest.main()
