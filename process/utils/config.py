"""Centralized env-var config for the processor (mirrors Moogle pattern).

Pure-functional: no global state, every service reads via this module so
mocking in tests is trivial.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    pg_dsn: str
    nats_url: str
    nats_stream: str
    redis_url: str
    nats_subject_raw_docs: str
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    embedder_grpc_url: str
    open_payments_lookup_url: str
    max_concurrent_pipelines: int
    chunk_tokens: int
    chunk_overlap: int
    fuzzy_min_confidence: float
    cache_ttl_days: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            pg_dsn=_must("DATABASE_URL"),
            nats_url=os.getenv("NATS_URL", "nats://localhost:4222"),
            nats_stream=os.getenv("NATS_STREAM", "EVIDENCELENS"),
            redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
            nats_subject_raw_docs=os.getenv("NATS_SUBJECT_RAW_DOCS", "raw-docs"),
            s3_endpoint=_must("S3_ENDPOINT"),
            s3_access_key=_must("S3_ACCESS_KEY_ID"),
            s3_secret_key=_must("S3_SECRET_ACCESS_KEY"),
            s3_bucket=_must("S3_BUCKET"),
            embedder_grpc_url=os.getenv("EMBEDDER_GRPC_URL", "embedder:50051"),
            open_payments_lookup_url=os.getenv(
                "OPEN_PAYMENTS_LOOKUP_URL",
                "http://ingester-open-payments:8080/lookup",
            ),
            max_concurrent_pipelines=int(os.getenv("MAX_CONCURRENT_PIPELINES", "50")),
            chunk_tokens=int(os.getenv("CHUNK_TOKENS", "512")),
            chunk_overlap=int(os.getenv("CHUNK_OVERLAP", "64")),
            fuzzy_min_confidence=float(os.getenv("FUZZY_MIN_CONFIDENCE", "0.90")),
            cache_ttl_days=int(os.getenv("AUTHOR_PAYMENT_CACHE_TTL_DAYS", "30")),
        )


def _must(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        raise RuntimeError(f"required env var not set: {name}")
    return v
