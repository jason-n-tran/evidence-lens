"""BM25 sub-scorer — Meilisearch (spec §5.5).

Loads `config/synonyms.json` at startup and pushes the bidirectional
synonym map into Meilisearch via `updateSynonyms`. Adds a small
MeSH-expansion pass to the query string (spec §6.1) before submission.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import meilisearch
import structlog

log = structlog.get_logger("scorer.bm25")


@dataclass
class BM25Hit:
    doc_id: str
    score: float
    document: dict[str, Any]


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, list)}
