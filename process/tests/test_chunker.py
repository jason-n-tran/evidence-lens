"""Tests for the sliding-window chunker + mean-pool."""
from __future__ import annotations

import unittest

from utils.chunker import chunk, mean_pool


class ChunkerTest(unittest.TestCase):
    def test_empty_input_returns_one_chunk(self):
        out = chunk("", target_tokens=128, overlap=16)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].text, "")
        self.assertEqual(out[0].token_count, 0)

    def test_short_text_single_chunk(self):
        out = chunk("Hello world.", target_tokens=128, overlap=16)
        self.assertEqual(len(out), 1)
        self.assertGreater(out[0].token_count, 0)

    def test_long_text_multiple_chunks_with_overlap(self):
        text = "word " * 600
        out = chunk(text, target_tokens=128, overlap=16)
        self.assertGreater(len(out), 1)
        for c in out:
            self.assertLessEqual(c.token_count, 128)

    def test_indices_monotonic(self):
        out = chunk("word " * 400, target_tokens=64, overlap=8)
        for i, c in enumerate(out):
            self.assertEqual(c.index, i)

    def test_mean_pool_dim_preserved(self):
        v = mean_pool([[1.0, 2.0, 3.0], [3.0, 2.0, 1.0]])
        self.assertEqual(v, [2.0, 2.0, 2.0])

    def test_mean_pool_empty(self):
        self.assertEqual(mean_pool([]), [])


if __name__ == "__main__":
    unittest.main()
