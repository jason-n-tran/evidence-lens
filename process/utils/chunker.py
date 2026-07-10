"""Sliding-window chunker for vector embedding inputs (spec §5.2 step 4).

Uses tiktoken (cl100k_base) as a tokenization proxy — close enough to
BGE-M3's tokenizer for chunk-size budgeting without adding a heavy
transformer dependency to the chunker hot path.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable


@dataclass
class Chunk:
    index: int
    text: str
    token_count: int


@lru_cache(maxsize=1)
def _encoder():
    """Lazily load tiktoken's cl100k_base. Returns None if tiktoken is
    unavailable or its vocab can't be fetched (offline first run) — the
    chunker then falls back to whitespace tokenization so the pipeline
    never crashes on a missing network/cache."""
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except Exception:  # noqa: BLE001 — import error, network failure, etc.
        return None


def chunk(text: str, target_tokens: int = 512, overlap: int = 64) -> list[Chunk]:
    """Sliding window. Returns at least one chunk even for empty input."""
    if not text:
        return [Chunk(0, "", 0)]

    enc = _encoder()
    if enc is None:
        return _chunk_words(text, target_tokens, overlap)

    ids = enc.encode(text)
    if len(ids) <= target_tokens:
        return [Chunk(0, text, len(ids))]
    out: list[Chunk] = []
    step = target_tokens - overlap
    if step <= 0:
        step = target_tokens
    idx = 0
    cursor = 0
    while cursor < len(ids):
        window = ids[cursor:cursor + target_tokens]
        out.append(Chunk(idx, enc.decode(window), len(window)))
        idx += 1
        cursor += step
    return out


def _chunk_words(text: str, target_tokens: int, overlap: int) -> list[Chunk]:
    """Whitespace-token fallback when tiktoken is unavailable. Word count
    approximates token count closely enough for chunk-size budgeting."""
    words = text.split()
    if len(words) <= target_tokens:
        return [Chunk(0, text, len(words))]
    step = target_tokens - overlap
    if step <= 0:
        step = target_tokens
    out: list[Chunk] = []
    idx = 0
    cursor = 0
    while cursor < len(words):
        window = words[cursor:cursor + target_tokens]
        out.append(Chunk(idx, " ".join(window), len(window)))
        idx += 1
        cursor += step
    return out


def mean_pool(vectors: Iterable[list[float]]) -> list[float]:
    """Per-document vector = mean of per-chunk vectors."""
    arr = list(vectors)
    if not arr:
        return []
    dim = len(arr[0])
    out = [0.0] * dim
    for v in arr:
        for i, x in enumerate(v):
            out[i] += x
    n = float(len(arr))
    return [x / n for x in out]
