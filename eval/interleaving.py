"""
Team Draft Interleaving evaluator (spec §11.4).

Compares two ranked lists (e.g. control vs candidate variant) by
weaving them into a single interleaved list and counting per-variant
clicks. Run nightly against the Postgres `clicks` table; emit a paired
t-test result so we can promote / reject candidate rankings.

Run:
  python eval/interleaving.py --variant control --candidate vector_heavy --days 7
"""
from __future__ import annotations

import argparse
import math
import os
import statistics
import sys
from dataclasses import dataclass


@dataclass
class TeamDraftResult:
    a_wins: int
    b_wins: int
    ties: int
    confidence: float


def team_draft(rank_a: list[str], rank_b: list[str], k: int = 10) -> tuple[list[str], dict[str, str]]:
    """Return (interleaved, owner_map) where owner_map[doc_id] is 'A' or 'B'."""
    interleaved: list[str] = []
    owner: dict[str, str] = {}
    ai = bi = 0
    pickA = True
    while len(interleaved) < k and (ai < len(rank_a) or bi < len(rank_b)):
        if pickA:
            while ai < len(rank_a) and rank_a[ai] in owner:
                ai += 1
            if ai < len(rank_a):
                interleaved.append(rank_a[ai])
                owner[rank_a[ai]] = "A"
                ai += 1
        else:
            while bi < len(rank_b) and rank_b[bi] in owner:
                bi += 1
            if bi < len(rank_b):
                interleaved.append(rank_b[bi])
                owner[rank_b[bi]] = "B"
                bi += 1
        pickA = not pickA
    return interleaved, owner


def t_test_paired(a_wins: int, b_wins: int, ties: int) -> float:
    """Approximate paired t-test for win/loss/tie counts."""
    n = a_wins + b_wins + ties
    if n == 0:
        return 0.0
    diffs = [1.0] * a_wins + [-1.0] * b_wins + [0.0] * ties
    mean = statistics.fmean(diffs)
    if len(diffs) < 2:
        return 0.0
    sd = statistics.pstdev(diffs)
    if sd == 0:
        return 0.0
    t = mean / (sd / math.sqrt(n))
    # one-tailed p approximation for large n via normal cdf
    p = 0.5 * math.erfc(t / math.sqrt(2))
    return 1.0 - p  # confidence A > B


def evaluate_from_clicks(
    rankings_a: dict[str, list[str]],
    rankings_b: dict[str, list[str]],
    clicks_by_query: dict[str, list[str]],
) -> TeamDraftResult:
    a_wins = b_wins = ties = 0
    for q, a_rank in rankings_a.items():
        b_rank = rankings_b.get(q)
        clicks = clicks_by_query.get(q, [])
        if not b_rank or not clicks:
            continue
        _, owner = team_draft(a_rank, b_rank, k=10)
        a_clicks = sum(1 for c in clicks if owner.get(c) == "A")
        b_clicks = sum(1 for c in clicks if owner.get(c) == "B")
        if a_clicks > b_clicks:
            a_wins += 1
        elif b_clicks > a_clicks:
            b_wins += 1
        else:
            ties += 1
    return TeamDraftResult(a_wins, b_wins, ties, t_test_paired(a_wins, b_wins, ties))


def _fetch_from_postgres(variant: str, days: int) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Pull rankings + clicks for one variant from the Postgres
    `clicks` table. Reads $DATABASE_URL."""
    try:
        import psycopg  # type: ignore
    except ImportError:
        print("psycopg not installed; cannot pull live data", file=sys.stderr)
        return {}, {}
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return {}, {}
    sql = """
        SELECT query_id, variant, clicked_doc_id, clicked_position
        FROM clicks
        WHERE server_ts >= NOW() - %s::interval
          AND variant = %s
        ORDER BY query_id, clicked_position
    """
    rankings: dict[str, list[str]] = {}
    clicks: dict[str, list[str]] = {}
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(sql, (f"{days} days", variant))
        for query_id, _variant, clicked_doc_id, _pos in cur.fetchall():
            clicks.setdefault(query_id, []).append(clicked_doc_id)
            rankings.setdefault(query_id, []).append(clicked_doc_id)
    return rankings, clicks


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--variant", default="control")
    p.add_argument("--candidate", default="vector_heavy")
    p.add_argument("--days", type=int, default=7)
    args = p.parse_args()

    a_rank, a_clicks = _fetch_from_postgres(args.variant, args.days)
    b_rank, _ = _fetch_from_postgres(args.candidate, args.days)
    if not a_rank or not b_rank:
        print('{"status":"insufficient_data"}')
        return 0

    res = evaluate_from_clicks(a_rank, b_rank, a_clicks)
    import json
    print(json.dumps({
        "variant_a": args.variant,
        "variant_b": args.candidate,
        "a_wins": res.a_wins,
        "b_wins": res.b_wins,
        "ties": res.ties,
        "confidence_a_better": round(res.confidence, 4),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
