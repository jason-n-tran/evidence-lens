"""Author × CMS Open Payments fuzzy joiner (spec §5.2 step 6, §19.4).

Calls the open-payments-ingester /lookup endpoint per author, caches
results in Postgres `author_payment_cache` for 30 days. Conservative
bias: false positives are worse than false negatives. Threshold ≥ 0.90
(configurable). State-restricted lookup when affiliation is known
dramatically reduces false-positive risk.

Documented matching policy: docs/sources/open-payments.md.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass

import asyncpg
import httpx
import structlog

log = structlog.get_logger("processor.author_payment_joiner")

_INITIAL_RE = re.compile(r"^[A-Z]\.?$")


@dataclass
class PaymentMatch:
    sponsor_name: str
    year: int
    amount_usd: float
    payment_type: str
    source_record_id: str


@dataclass
class AuthorBadge:
    has_payments: bool
    total_payments_usd: float
    top_sponsor: str | None
    top_sponsor_amount_usd: float | None
    payments_last_year: int
    years_covered: list[str]
