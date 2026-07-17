"""
scorer-pool entry point (spec §5.5).

ScorerService.Search streams PartialResults waves:
  wave 1 @ 200ms (top 5)
  wave 2 @ 500ms (next 10)
  wave 3 @ 1000ms (final)

Internal sub-scorers run as concurrent asyncio tasks. RRF k=60 fuses.
LTR rerank + the gRPC servicer come next; for now the final wave is the
RRF order directly.
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

import structlog

from bm25 import BM25Scorer
from citation import CitationScorer
from fusion import rrf
from recency import recency_score
from vector import VectorScorer

log = structlog.get_logger("scorer")


@dataclass
class Config:
    grpc_port: int
    meili_url: str
    meili_key: str
    milvus_uri: str
    milvus_token: str
    milvus_dim: int
    neo4j_url: str
    neo4j_user: str
    neo4j_password: str
    embedder_url: str

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            grpc_port=int(os.getenv("GRPC_PORT", "50052")),
            meili_url=os.getenv("MEILI_URL", "http://localhost:7700"),
            meili_key=os.getenv("MEILI_KEY", ""),
            milvus_uri=os.getenv("MILVUS_URI", "http://localhost:19530"),
            milvus_token=os.getenv("MILVUS_TOKEN", ""),
            milvus_dim=int(os.getenv("EMBEDDING_DIM", "1024")),
            neo4j_url=os.getenv("NEO4J_URL", "bolt://localhost:7687"),
            neo4j_user=os.getenv("NEO4J_USER", "neo4j"),
            neo4j_password=os.getenv("NEO4J_PASSWORD", "changeme-dev-only"),
            embedder_url=os.getenv("EMBEDDER_GRPC_URL", "embedder:50051"),
        )


class ScorerCore:
    """Search orchestration logic."""

    def __init__(self, cfg: Config) -> None:
        from utils.embedder_client import EmbedderClient  # type: ignore[import]
        self.cfg = cfg
        self.bm25 = BM25Scorer(cfg.meili_url, cfg.meili_key)
        self.vector = VectorScorer(cfg.milvus_uri, cfg.milvus_token, dim=cfg.milvus_dim)
        self.citation = CitationScorer(cfg.neo4j_url, cfg.neo4j_user, cfg.neo4j_password)
        self.emb = EmbedderClient(cfg.embedder_url)

    async def search(self, query: str, filters: dict | None, top_k: int = 50):
        """Yields (wave_no, is_final, results) tuples."""
        log.info("scorer.search", query=query[:80])
        loop = asyncio.get_running_loop()

        async def _bm25():
            return await loop.run_in_executor(None, self.bm25.search, query, filters, 200)

        async def _vector():
            qvecs = await self.emb.embed("query", [query])
            qv = qvecs[0].vector
            return await loop.run_in_executor(None, self.vector.search, qv, filters, 200)

        bm25_task = asyncio.create_task(_bm25())
        vec_task = asyncio.create_task(_vector())

        # First wave at 200ms: emit BM25 top 5 if ready.
        await asyncio.sleep(0.2)
        first_results: list[dict] = []
        if bm25_task.done() and not bm25_task.exception():
            first_results = [self._to_result(h.document, bm25=h.score) for h in bm25_task.result()[:5]]
        yield 1, False, first_results

        await asyncio.wait({bm25_task, vec_task}, timeout=0.3, return_when=asyncio.ALL_COMPLETED)
        bm25_hits = bm25_task.result() if bm25_task.done() else []
        vec_hits = vec_task.result() if vec_task.done() else []

        # Citation + recency over the union top 500.
        union_ids = list({h.doc_id for h in bm25_hits} | {h.doc_id for h in vec_hits})[:500]
        cite_scores = {c.doc_id: c.pagerank for c in await loop.run_in_executor(None, self.citation.score, union_ids)}

        merged_payloads: dict[str, dict] = {}
        for h in bm25_hits:
            merged_payloads[h.doc_id] = h.document
        for h in vec_hits:
            merged_payloads.setdefault(h.doc_id, h.payload)
        rec_scores = {did: recency_score(p.get("published_at")) for did, p in merged_payloads.items()}

        # RRF fusion over four sub-scorer rankings.
        rankings = {
            "bm25":     [h.doc_id for h in bm25_hits],
            "vector":   [h.doc_id for h in vec_hits],
            "citation": sorted(cite_scores, key=lambda i: cite_scores[i], reverse=True),
            "recency":  sorted(rec_scores, key=lambda i: rec_scores[i], reverse=True),
        }
        fused = rrf(rankings, k=60)

        wave2 = []
        for item in fused[:15]:
            p = merged_payloads.get(item.doc_id, {})
            wave2.append(self._to_result(p, final_score=item.rrf_score))
        yield 2, False, wave2

        wave3 = []
        for item in fused[15:top_k]:
            p = merged_payloads.get(item.doc_id, {})
            wave3.append(self._to_result(p, final_score=item.rrf_score))
        yield 3, True, wave3

    @staticmethod
    def _to_result(payload: dict, **scores) -> dict:
        return {
            "document": payload,
            "final_score": scores.get("final_score", 0.0),
            "breakdown": {
                "bm25": scores.get("bm25", 0.0),
                "vector": scores.get("vector", 0.0),
                "citation_pagerank": scores.get("pagerank", 0.0),
                "recency": scores.get("recency", 0.0),
                "rrf": scores.get("final_score", 0.0),
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
    async for wave, final, results in core.search("statins", None):
        log.info("wave", wave=wave, final=final, n=len(results))


if __name__ == "__main__":
    asyncio.run(main())
