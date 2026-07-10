"""Embedder client (HTTP).

Calls the embedder service's `/embed` HTTP shim:
  POST {base}/embed {request_id, texts}
    -> {request_id, embeddings: [{values, dim}], embedding_model}

Endpoint resolution (in priority order):
  1. EMBEDDER_HTTP_URL — explicit full URL, e.g. http://100.117.36.115:8091.
     REQUIRED when the embedder runs on a different host than the processor,
     because the published HTTP port differs from the in-container 8080 (TrueNAS
     maps 8091:8080). Use this on the working PC / VPS.
  2. Else derive from EMBEDDER_GRPC_URL ("host:port") as http://host:8080 —
     correct ONLY when co-located on the same Docker network (dev/compose),
     where the container's internal 8080 is directly reachable.

Failure behavior: FAIL LOUD. If the embedder is unreachable or errors, raise so
the caller naks the message and NATS retries — instead of silently indexing a
fake vector. A deterministic SHA-256 stub remains ONLY for pure-local dev and is
opt-in via EMBEDDER_ALLOW_STUB=1 (never set in production); otherwise unreachable
embedder => exception => doc is retried, surfacing the outage instead of filling
Milvus with garbage vectors.
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
_HTTP_TIMEOUT = float(os.getenv("EMBEDDER_HTTP_TIMEOUT_SEC", "30"))
# Opt-in stub for local dev only. Unset/0 in prod => unreachable embedder raises.
_ALLOW_STUB = os.getenv("EMBEDDER_ALLOW_STUB", "").lower() in ("1", "true", "yes")


class EmbedderUnavailable(RuntimeError):
    """Raised when the embedder can't be reached and stubbing is disabled."""


@dataclass
class Embedding:
    vector: list[float]
    model: str


def _resolve_base() -> str:
    """Pick the embedder HTTP base URL. EMBEDDER_HTTP_URL wins; else derive from
    EMBEDDER_GRPC_URL host on the in-container port 8080 (co-located only)."""
    explicit = os.getenv("EMBEDDER_HTTP_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    target = os.getenv("EMBEDDER_GRPC_URL", "embedder:50051")
    if target.startswith("http://") or target.startswith("https://"):
        return target.rstrip("/")
    host, _, _ = target.partition(":")
    # NOTE: 8080 is the embedder's IN-CONTAINER HTTP port. Works only when the
    # processor shares the Docker network with the embedder. Cross-host MUST set
    # EMBEDDER_HTTP_URL (e.g. TrueNAS publishes 8091:8080).
    return f"http://{host}:8080"


class EmbedderClient:
    def __init__(self, target: str | None = None) -> None:
        # `target` kept for backwards compatibility; resolution prefers env.
        if target and (target.startswith("http://") or target.startswith("https://")):
            self.base = target.rstrip("/")
        else:
            self.base = _resolve_base()
        self._client = httpx.AsyncClient(timeout=_HTTP_TIMEOUT)
        log.info("embedder client configured", base=self.base, allow_stub=_ALLOW_STUB)

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
            if _ALLOW_STUB:
                log.warning("embedder unreachable; using deterministic stub (DEV ONLY)",
                            base=self.base, err=str(e))
                return [self._stub(t) for t in texts]
            # Fail loud: caller naks -> NATS retries -> outage is visible and no
            # fake vectors reach Milvus.
            raise EmbedderUnavailable(f"embedder {self.base} unreachable: {e}") from e

    @staticmethod
    def _stub(text: str) -> Embedding:
        h = hashlib.sha256(text.encode()).digest()
        stretched = (h * ((_FAKE_DIM // len(h)) + 1))[:_FAKE_DIM]
        vec = [(b / 127.5) - 1.0 for b in stretched]
        return Embedding(vector=vec, model="stub-deterministic")

    async def close(self) -> None:
        await self._client.aclose()
