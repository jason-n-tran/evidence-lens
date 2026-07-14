"""Recency sub-scorer — exponential decay (spec §5.5).

score = 0.5 ** ((now - published_at) / half_life), half_life=730 days.
A document exactly one half-life old scores 0.5; brand-new ~1.0.
"""
from __future__ import annotations

from datetime import datetime, timezone


HALF_LIFE_DAYS = 730


def recency_score(published_at_iso: str | None, half_life_days: int = HALF_LIFE_DAYS) -> float:
    if not published_at_iso:
        return 0.0
    try:
        # Tolerate both with and without 'Z'
        s = published_at_iso.replace("Z", "+00:00")
        ts = datetime.fromisoformat(s)
    except ValueError:
        return 0.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - ts).total_seconds() / 86400.0
    if age_days < 0:
        age_days = 0.0
    return 0.5 ** (age_days / float(half_life_days))
