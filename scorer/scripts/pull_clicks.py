"""Pull last N days of clicks from Postgres for LTR training.

Replaces the previous BigQuery `analytics.clicks` query now that
analytics live in the operational Postgres on TrueNAS. Connect string
comes from $DATABASE_URL.
"""
from __future__ import annotations

import argparse
import os

import pandas as pd
import psycopg


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    dsn = os.environ["DATABASE_URL"]
    sql = """
        SELECT session_id, query_text, clicked_doc_id, clicked_position, variant, server_ts
        FROM clicks
        WHERE server_ts >= NOW() - %s::interval
    """
    with psycopg.connect(dsn) as conn:
        df = pd.read_sql_query(sql, conn, params=(f"{args.days} days",))
    df.to_parquet(args.out)
    print(f"wrote {len(df)} rows -> {args.out}")


if __name__ == "__main__":
    main()
