"""Tests for the hand-written proto shim. These run without `buf
generate` having been invoked. After buf-generate runs the shim is
replaced and these tests are removed."""
from __future__ import annotations

import unittest
from dataclasses import asdict

from evidencelens.v1 import (
    Document, Author, AuthorPayment, EmbedRequest, EmbedResponse,
    EmbeddingVector, SearchRequest, SearchFilters, ScoredResult,
    ScoreBreakdown, PartialResults, to_json_bytes, from_json_bytes,
)


class ProtoShimTest(unittest.TestCase):
    def test_document_round_trip(self):
        d = Document(id="pubmed:1", title="x", source="pubmed",
                     authors=[Author(display_name="Smith J",
                                     payments=[AuthorPayment(sponsor_name="Pfizer", amount_usd=100)])])
        bs = to_json_bytes(d)
        d2 = from_json_bytes(Document, bs)
        self.assertEqual(d2.id, "pubmed:1")
        # Nested dataclasses round-trip as nested dicts; the shim doesn't
        # rehydrate types, which is fine for HTTP/JSON wire format.
        self.assertIn("display_name", d2.authors[0])

    def test_embed_request(self):
        r = EmbedRequest(request_id="r1", texts=["hello", "world"])
        bs = to_json_bytes(r)
        r2 = from_json_bytes(EmbedRequest, bs)
        self.assertEqual(r2.request_id, "r1")
        self.assertEqual(r2.texts, ["hello", "world"])

    def test_search_request_with_filters(self):
        sr = SearchRequest(query="x", top_k=10,
                           filters=SearchFilters(study_types=["RCT"], only_with_coi=True))
        bs = to_json_bytes(sr)
        sr2 = from_json_bytes(SearchRequest, bs)
        self.assertEqual(sr2.query, "x")
        self.assertEqual(sr2.top_k, 10)


if __name__ == "__main__":
    unittest.main()
