"""
scorer-pool entry point (spec §5.5).

For now this is a thin BM25-only orchestrator so we can exercise the
Meilisearch path end-to-end before the vector / citation / recency
sub-scorers and the gRPC servicer land. Proto stubs are not generated
yet, so search() just returns plain dicts.
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

import structlog

from bm25 import BM25Scorer

log = structlog.get_logger("scorer")


@dataclass
class Config:
    grpc_port: int
    meili_url: str
    meili_key: str

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            grpc_port=int(os.getenv("GRPC_PORT", "50052")),
            meili_url=os.getenv("MEILI_URL", "http://localhost:7700"),
            meili_key=os.getenv("MEILI_KEY", ""),
        )


class ScorerCore:
    """Search orchestration logic. BM25 only for now."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.bm25 = BM25Scorer(cfg.meili_url, cfg.meili_key)

    async def search(self, query: str, filters: dict | None, top_k: int = 50):
        """Yields (wave_no, is_final, results) tuples."""
        log.info("scorer.search", query=query[:80])
        loop = asyncio.get_running_loop()
        hits = await loop.run_in_executor(None, self.bm25.search, query, filters, top_k)
        results = [self._to_result(h.document, bm25=h.score) for h in hits[:top_k]]
        yield 1, True, results

    @staticmethod
    def _to_result(payload: dict, **scores) -> dict:
        return {
            "document": payload,
            "final_score": scores.get("bm25", 0.0),
            "breakdown": {
                "bm25": scores.get("bm25", 0.0),
            },
        }


async def main() -> None:
    structlog.configure(processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ])
    cfg = Config.from_env()
    core = ScorerCore(cfg)
    # Smoke a single query until the gRPC servicer is wired up.
    async for wave, final, results in core.search("statins", None):
        log.info("wave", wave=wave, final=final, n=len(results))


if __name__ == "__main__":
    asyncio.run(main())
