"""Embedder client.

Two transports:
  - HTTP path (default): POST {url}/embed with {request_id, texts} →
    {request_id, embeddings: [{values, dim}], embedding_model}.
    Matches the embedder service's `/embed` HTTP shim, runs without
    proto stubs, and is what the local `make dev` smoke test uses.
  - Deterministic stub fallback: if the embedder is unreachable, the
    client emits a SHA-256-derived vector so the rest of the pipeline
    keeps working in pure-local dev. The stub model id ("stub-...")
    propagates to the IndexableDocEvent so consumers can filter.

When proto stubs land (post `buf generate`), we'll add a gRPC path that
prefers the bidirectional stream and falls through to HTTP / stub.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass

import httpx
import structlog

log = structlog.get_logger("processor.embedder_client")

_FAKE_DIM = int(os.getenv("EMBEDDING_DIM", "1024"))
_HTTP_TIMEOUT = float(os.getenv("EMBEDDER_HTTP_TIMEOUT_SEC", "10"))


@dataclass
class Embedding:
    vector: list[float]
    model: str


class EmbedderClient:
    def __init__(self, target: str) -> None:
        # `target` accepts either grpc-style "host:port" (used as host for
        # an HTTP base URL) or a full http(s)://... URL.
        if target.startswith("http://") or target.startswith("https://"):
            self.base = target.rstrip("/")
        else:
            # Default to plain HTTP on the embedder's HEALTH_PORT.
            host, _, _ = target.partition(":")
            self.base = f"http://{host}:8080"
        self._client = httpx.AsyncClient(timeout=_HTTP_TIMEOUT)
        self._stub_warned = False

    async def embed(self, request_id: str, texts: list[str]) -> list[Embedding]:
        if not texts:
            return []
        try:
            r = await self._client.post(
                f"{self.base}/embed",
                json={"request_id": request_id, "texts": texts},
            )
            r.raise_for_status()
            data = r.json()
            model = data.get("embedding_model", "unknown")
            return [Embedding(vector=e["values"], model=model) for e in data["embeddings"]]
        except (httpx.HTTPError, asyncio.TimeoutError, KeyError) as e:
            if not self._stub_warned:
                log.warning("embedder unreachable; using deterministic stub", err=str(e))
                self._stub_warned = True
            return [self._stub(t) for t in texts]

    @staticmethod
    def _stub(text: str) -> Embedding:
        h = hashlib.sha256(text.encode()).digest()
        stretched = (h * ((_FAKE_DIM // len(h)) + 1))[:_FAKE_DIM]
        vec = [(b / 127.5) - 1.0 for b in stretched]
        return Embedding(vector=vec, model="stub-deterministic")

    async def close(self) -> None:
        await self._client.aclose()
