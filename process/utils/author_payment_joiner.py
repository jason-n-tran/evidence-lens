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


def normalize_name_key(display_name: str, state: str | None) -> str:
    """Case-folded, accent-stripped 'lastname:firstinitial:state' key.

    The pipeline's canonical author form is "Lastname Initials" (e.g. the
    PubMed parser emits "Smith JA"), so for the space form the first token
    is the surname: 'Smith JA' + CA -> 'smith:j:ca'. For the comma form
    ("Smith, John") the surname trails after the comma swap.
    """
    nfkd = unicodedata.normalize("NFKD", display_name)
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c)).lower().strip()
    has_comma = "," in display_name
    parts = ascii_only.replace(",", " ").split()
    if not parts:
        last, first_init = "", ""
    elif has_comma:
        last = parts[-1]
        first_init = parts[0][0] if len(parts) > 1 else ""
    else:
        last = parts[0]
        first_init = parts[1][0] if len(parts) > 1 else ""
    st = (state or "").lower().strip()
    return f"{last}:{first_init}:{st}"


class AuthorPaymentJoiner:
    def __init__(
        self,
        pool: asyncpg.Pool,
        lookup_url: str,
        cache_ttl_days: int = 30,
        min_confidence: float = 0.90,
    ) -> None:
        self.pool = pool
        self.lookup_url = lookup_url
        self.cache_ttl_days = cache_ttl_days
        self.min_confidence = min_confidence
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(connect=0.5, read=5.0, write=5.0, pool=5.0))
        self._lookup_available = True  # circuit breaker: disabled after first connect failure

    async def close(self) -> None:
        await self._http.aclose()

    async def lookup(
        self,
        author_display_name: str,
        affiliation_state: str | None,
        published_year: int | None,
    ) -> tuple[list[PaymentMatch], AuthorBadge]:
        """Fetch and cache one author's matched payments + computed badge."""
        # No name = nothing to look up (the service 400s on an empty name).
        if not author_display_name or not author_display_name.strip():
            return [], AuthorBadge(False, 0.0, None, None, 0, [])

        cache_key = normalize_name_key(author_display_name, affiliation_state)
        year = (published_year or 0) - 1  # payments from year preceding publication

        cached = await self._cache_get(cache_key, year)
        if cached is not None:
            return cached

        # Authors with only initials and no state are too ambiguous to match
        # safely (high false-positive risk). Skip the lookup.
        first_token = author_display_name.split()[0] if author_display_name else ""
        if _INITIAL_RE.match(first_token) and not affiliation_state:
            empty: list[PaymentMatch] = []
            badge = AuthorBadge(False, 0.0, None, None, 0, [])
            await self._cache_put(cache_key, year, empty, badge)
            return empty, badge

        # Circuit breaker: skip all lookups if we already know the service is down.
        if not self._lookup_available:
            return [], AuthorBadge(False, 0.0, None, None, 0, [])

        try:
            resp = await self._http.get(
                self.lookup_url,
                params={
                    "name": author_display_name,
                    "state": affiliation_state or "",
                    "year": str(year) if year > 0 else "",
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            log.warning("open-payments lookup failed", err=str(e), name=author_display_name)
            # Trip the circuit breaker on connect failures so subsequent
            # authors in this batch don't each wait for a timeout.
            if isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout)):
                self._lookup_available = False
            return [], AuthorBadge(False, 0.0, None, None, 0, [])

        if data.get("confidence", 0.0) < self.min_confidence:
            empty = []
            badge = AuthorBadge(False, 0.0, None, None, 0, [])
            await self._cache_put(cache_key, year, empty, badge)
            return empty, badge

        matches = [
            PaymentMatch(
                sponsor_name=p["sponsor_name"],
                year=int(p["year"]),
                amount_usd=float(p["amount_usd"]),
                payment_type=p.get("payment_type", "other"),
                source_record_id=p["source_record_id"],
            )
            for p in data.get("payments", [])
        ]
        badge = self._make_badge(matches)
        await self._cache_put(cache_key, year, matches, badge)
        return matches, badge

    @staticmethod
    def _make_badge(matches: list[PaymentMatch]) -> AuthorBadge:
        if not matches:
            return AuthorBadge(False, 0.0, None, None, 0, [])
        total = sum(m.amount_usd for m in matches)
        by_sponsor: dict[str, float] = {}
        years: set[str] = set()
        for m in matches:
            by_sponsor[m.sponsor_name] = by_sponsor.get(m.sponsor_name, 0.0) + m.amount_usd
            years.add(str(m.year))
        top_sponsor = max(by_sponsor, key=lambda k: by_sponsor[k])
        max_year = max(int(y) for y in years)
        last_year_count = sum(1 for m in matches if m.year == max_year)
        return AuthorBadge(
            has_payments=True,
            total_payments_usd=total,
            top_sponsor=top_sponsor,
            top_sponsor_amount_usd=by_sponsor[top_sponsor],
            payments_last_year=last_year_count,
            years_covered=sorted(years),
        )

    async def _cache_get(self, key: str, year: int) -> tuple[list[PaymentMatch], AuthorBadge] | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT payments_jsonb FROM author_payment_cache
                   WHERE author_key = $1 AND year = $2 AND expires_at > NOW()""",
                key, year,
            )
            if not row:
                return None
            payload = row["payments_jsonb"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            matches = [PaymentMatch(**m) for m in payload.get("matches", [])]
            badge_data = payload.get("badge", {})
            badge = AuthorBadge(**badge_data) if badge_data else AuthorBadge(False, 0.0, None, None, 0, [])
            return matches, badge

    async def _cache_put(
        self, key: str, year: int, matches: list[PaymentMatch], badge: AuthorBadge,
    ) -> None:
        payload = json.dumps({
            "matches": [m.__dict__ for m in matches],
            "badge": badge.__dict__,
        })
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO author_payment_cache (author_key, year, payments_jsonb, cached_at, expires_at)
                   VALUES ($1, $2, $3::jsonb, NOW(), NOW() + ($4 || ' days')::interval)
                   ON CONFLICT (author_key, year) DO UPDATE
                   SET payments_jsonb = EXCLUDED.payments_jsonb,
                       cached_at = EXCLUDED.cached_at,
                       expires_at = EXCLUDED.expires_at""",
                key, year, payload, str(self.cache_ttl_days),
            )
