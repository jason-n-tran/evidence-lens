"""Shadow-deploy a candidate LTR model for 24h before promotion.

Workflow:
  1. Upload candidate model to R2 at models/shadow/ltr_{date}.json.
  2. Update Postgres key/value setting `ltr_shadow_model_path` so scorer
     pods pick it up on next reload (every 5 min).
  3. Wait `duration-hours` while the scorer runs scoring twice (once
     production, once shadow) and logs both scores side-by-side to the
     `byok_proxy_telemetry`-adjacent `ltr_shadow_log` table.
  4. Compare nDCG@10 from the shadow log vs the production log; if no
     >1% regression, copy candidate over `ltr_production_model_path`
     and notify scorer pods to reload.

This script is invoked by `.github/workflows/scheduled-ltr-train.yml`.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REGRESSION_THRESHOLD = 0.01  # 1%
PRODUCTION_PATH_KEY  = "ltr_production_model_path"
SHADOW_PATH_KEY      = "ltr_shadow_model_path"


def upload_to_object_store(local: Path, key: str) -> str:
    import boto3
    from botocore.config import Config as BotoConfig
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )
    bucket = os.environ.get("S3_MODEL_BUCKET", os.environ["S3_BUCKET"])
    s3.upload_file(str(local), bucket, key)
    return f"s3://{bucket}/{key}"


async def set_setting(key: str, value: str) -> None:
    import asyncpg
    pool = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """CREATE TABLE IF NOT EXISTS app_settings (
                     key TEXT PRIMARY KEY,
                     value TEXT NOT NULL,
                     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                   )""",
            )
            await conn.execute(
                """INSERT INTO app_settings(key, value) VALUES ($1, $2)
                   ON CONFLICT (key) DO UPDATE
                   SET value = EXCLUDED.value, updated_at = NOW()""",
                key, value,
            )
    finally:
        await pool.close()


async def shadow_ndcg() -> tuple[float, float]:
    """Return (production_ndcg, shadow_ndcg) over the past 24h's logged
    pairwise scores. Skip if either has too few samples."""
    import asyncpg
    pool = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT
                     coalesce(avg(production_ndcg), 0) AS prod,
                     coalesce(avg(shadow_ndcg), 0)     AS shad,
                     count(*) AS n
                   FROM ltr_shadow_log
                   WHERE created_at > NOW() - INTERVAL '24 hours'""",
            )
            if not row or row["n"] < 100:
                return 0.0, 0.0
            return float(row["prod"]), float(row["shad"])
    finally:
        await pool.close()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--duration-hours", type=int, default=24)
    p.add_argument("--no-wait", action="store_true", help="Skip the wait window (CI smoke)")
    args = p.parse_args()

    local = Path(args.model)
    if not local.exists():
        sys.exit(f"model {local} not found")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    shadow_key = f"models/shadow/ltr_{stamp}.json"
    print(f"[1/4] uploading {local} -> s3://{shadow_key}")
    shadow_url = upload_to_object_store(local, shadow_key)

    print(f"[2/4] flipping {SHADOW_PATH_KEY}={shadow_url}")
    asyncio.run(set_setting(SHADOW_PATH_KEY, shadow_url))

    if args.no_wait:
        print("[3/4] skipped wait (--no-wait)"); return

    print(f"[3/4] waiting {args.duration_hours}h for shadow data")
    time.sleep(args.duration_hours * 3600)

    print("[4/4] comparing nDCG")
    prod, shad = asyncio.run(shadow_ndcg())
    print(f"  production nDCG@10: {prod:.4f}")
    print(f"  shadow nDCG@10:     {shad:.4f}")
    if shad < prod - REGRESSION_THRESHOLD:
        sys.exit(f"shadow regressed by > {REGRESSION_THRESHOLD * 100}%; aborting promotion")
    if shad <= 0:
        sys.exit("insufficient shadow data; aborting promotion")

    promo_key = f"models/production/ltr_{stamp}.json"
    print(f"[promote] uploading -> s3://{promo_key}")
    promo_url = upload_to_object_store(local, promo_key)
    asyncio.run(set_setting(PRODUCTION_PATH_KEY, promo_url))
    print(f"[promote] {PRODUCTION_PATH_KEY}={promo_url}")


if __name__ == "__main__":
    main()
