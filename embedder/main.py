"""
EvidenceLens embedder — vLLM-backed BGE-M3 gRPC server (spec §5.3).

Bidirectional streaming gRPC. Dynamic batching (batch=32, max-wait=25ms)
for GPU throughput. Runs BGE-M3 (1024-d) on GPU when available, else the SAME
model on CPU (slower, identical vectors) — the model/dim never changes with
hardware so index-time and query-time vectors share one Milvus collection.

Health probe via /healthz (FastAPI sidecar on a separate port for
Kubernetes-style liveness checks; gRPC Healthz also exposed via the
standard grpc.health.v1 service).
"""
from __future__ import annotations

import asyncio
import os
import signal
import time
from concurrent import futures
from contextlib import suppress
from dataclasses import dataclass

import grpc
import structlog
import uvicorn
from fastapi import FastAPI
from grpc_health.v1 import health, health_pb2, health_pb2_grpc
from grpc_reflection.v1alpha import reflection
from sentence_transformers import SentenceTransformer

# Generated stubs from proto/gen/python — committed at proto generate time.
# from evidencelens.v1 import embedder_pb2, embedder_pb2_grpc

log = structlog.get_logger("embedder")

# ---- Config ----

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
GRPC_PORT = int(os.getenv("GRPC_PORT", "50051"))
HEALTH_PORT = int(os.getenv("HEALTH_PORT", "8080"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "32"))
MAX_WAIT_MS = int(os.getenv("MAX_WAIT_MS", "25"))


@dataclass
class ModelState:
    """Captures the loaded model + which device it's on."""
    name: str
    dim: int
    degraded: bool   # True = running on CPU (slower, but SAME model/dim)
    detail: str


class EmbedEngine:
    """Owns the model + its CUDA context on ONE dedicated thread for the whole
    process lifetime, and runs EVERY encode on that same thread.

    Why a dedicated thread instead of asyncio.to_thread / a thread pool: under
    WSL2 a torch CUDA context created on one thread throws `CUDA error: unknown
    error` when a tensor is later moved to the device from a DIFFERENT thread.
    asyncio.to_thread dispatches to the event loop's default ThreadPoolExecutor,
    whose worker threads rotate — so the model (loaded on the main/startup thread)
    was being used from foreign threads, and every /embed 500'd. A standalone
    script never hit this because it created+used the context on one short-lived
    thread. Pinning load + all encodes to a single persistent thread is the
    canonical fix for 'CUDA works in a script but fails in the server'.

    The thread also DECIDES the device: it tries cuda (with a real self-test
    encode on this very thread) and falls back to CPU if anything fails — so a
    broken GPU degrades instead of wedging. EMBEDDER_FORCE_CPU=1 skips GPU.
    """

    def __init__(self) -> None:
        import queue
        import threading
        self._jobs: "queue.Queue[tuple]" = queue.Queue()
        self._ready = threading.Event()
        self.state: ModelState | None = None
        self._thread = threading.Thread(target=self._run, name="embed-cuda", daemon=True)

    def start(self) -> ModelState:
        """Start the worker thread and block until the model is loaded. Returns
        the ModelState (which device it settled on)."""
        self._thread.start()
        self._ready.wait()
        assert self.state is not None
        return self.state

    def _load(self) -> SentenceTransformer:
        """Runs ON the dedicated thread: load on cuda + self-test, else CPU."""
        if os.getenv("EMBEDDER_FORCE_CPU", "").lower() in ("1", "true", "yes"):
            log.info("EMBEDDER_FORCE_CPU set; loading on CPU", model=MODEL_NAME)
        else:
            try:
                import torch
                if torch.cuda.is_available():
                    log.info("loading model on GPU (dedicated thread)", model=MODEL_NAME)
                    m = SentenceTransformer(MODEL_NAME, device="cuda")
                    # Self-test on THIS thread — the one that will serve every
                    # request — so a bad GPU is caught here, not per-request.
                    m.encode(["cuda self-test"], normalize_embeddings=True, convert_to_numpy=True)
                    self.state = ModelState(MODEL_NAME, m.get_sentence_embedding_dimension(), False, "")
                    log.info("GPU self-test passed", model=MODEL_NAME)
                    return m
            except Exception as e:  # noqa: BLE001
                log.warning("GPU unusable; falling back to CPU (same model, slower)", error=str(e))

        log.info("loading model on CPU (slower, identical vectors)", model=MODEL_NAME)
        m = SentenceTransformer(MODEL_NAME, device="cpu")
        self.state = ModelState(MODEL_NAME, m.get_sentence_embedding_dimension(),
                                True, "running on CPU (same model; slower)")
        return m

    def _run(self) -> None:
        model = self._load()
        self._ready.set()
        while True:
            texts, fut, loop = self._jobs.get()
            if fut is None:  # shutdown sentinel
                return
            try:
                vecs = model.encode(texts, batch_size=BATCH_SIZE,
                                    normalize_embeddings=True, convert_to_numpy=True)
                loop.call_soon_threadsafe(fut.set_result, vecs)
            except BaseException as e:  # noqa: BLE001
                loop.call_soon_threadsafe(fut.set_exception, e)

    async def encode(self, texts: list[str]):
        """Async API: hand the batch to the dedicated thread and await the result."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._jobs.put((texts, fut, loop))
        return await fut

    def stop(self) -> None:
        self._jobs.put((None, None, None))


# ---- Dynamic batching queue ----

@dataclass
class _Pending:
    request_id: str
    texts: list[str]
    future: asyncio.Future


class BatchedEmbedder:
    """Coalesces concurrent EmbedRequest calls into batched inferences, all run
    on the EmbedEngine's single dedicated CUDA thread."""

    def __init__(self, engine: "EmbedEngine", state: ModelState) -> None:
        self.engine = engine
        self.state = state
        self.queue: asyncio.Queue[_Pending] = asyncio.Queue()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

    async def embed(self, request_id: str, texts: list[str]) -> list[list[float]]:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        await self.queue.put(_Pending(request_id, texts, fut))
        return await fut

    async def _loop(self) -> None:
        while True:
            batch: list[_Pending] = []
            try:
                first = await self.queue.get()
            except asyncio.CancelledError:
                return
            batch.append(first)
            deadline = time.monotonic() + MAX_WAIT_MS / 1000.0
            while sum(len(p.texts) for p in batch) < BATCH_SIZE:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    p = await asyncio.wait_for(self.queue.get(), timeout=remaining)
                    batch.append(p)
                except asyncio.TimeoutError:
                    break

            flat = [t for p in batch for t in p.texts]
            try:
                # All encodes run on the engine's single dedicated CUDA thread.
                vectors = await self.engine.encode(flat)
            except Exception as e:  # noqa: BLE001
                for p in batch:
                    p.future.set_exception(e)
                continue

            cursor = 0
            for p in batch:
                count = len(p.texts)
                p.future.set_result([v.tolist() for v in vectors[cursor:cursor + count]])
                cursor += count



# ---- gRPC servicer wired against the internal evidencelens package ----

from evidencelens.v1 import (  # type: ignore[import]
    EmbedRequest, EmbedResponse, EmbeddingVector,
    EmbedderHealthzRequest, EmbedderHealthzResponse,
)
from evidencelens.v1.embedder_grpc import (  # type: ignore[import]
    EmbedderServiceServicer,
    add_EmbedderServiceServicer_to_server,
)


class EmbedderServicer(EmbedderServiceServicer):
    def __init__(self, batcher: "BatchedEmbedder") -> None:
        self.batcher = batcher

    async def Embed(self, request_iterator, context):  # type: ignore[override]
        async for req in request_iterator:
            vecs = await self.batcher.embed(req.request_id, list(req.texts))
            yield EmbedResponse(
                request_id=req.request_id,
                embeddings=[EmbeddingVector(values=v, dim=len(v)) for v in vecs],
                embedding_model=self.batcher.state.name,
            )

    async def EmbedOnce(self, request, context):  # type: ignore[override]
        vecs = await self.batcher.embed(request.request_id, list(request.texts))
        return EmbedResponse(
            request_id=request.request_id,
            embeddings=[EmbeddingVector(values=v, dim=len(v)) for v in vecs],
            embedding_model=self.batcher.state.name,
        )

    async def Healthz(self, request, context):  # type: ignore[override]
        return EmbedderHealthzResponse(
            status="degraded" if self.batcher.state.degraded else "ok",
            embedding_model=self.batcher.state.name,
            detail=self.batcher.state.detail,
        )


async def serve_grpc(engine: "EmbedEngine", state: ModelState) -> grpc.aio.Server:
    server = grpc.aio.server(futures.ThreadPoolExecutor(max_workers=8))
    global _GLOBAL_BATCHER
    _GLOBAL_BATCHER = BatchedEmbedder(engine, state)
    await _GLOBAL_BATCHER.start()
    add_EmbedderServiceServicer_to_server(EmbedderServicer(_GLOBAL_BATCHER), server)

    health_servicer = health.aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    await health_servicer.set("evidencelens.v1.EmbedderService",
                                health_pb2.HealthCheckResponse.SERVING if not state.degraded
                                else health_pb2.HealthCheckResponse.SERVING)

    server.add_insecure_port(f"[::]:{GRPC_PORT}")
    await server.start()
    log.info("grpc serving", port=GRPC_PORT, model=state.name, dim=state.dim, degraded=state.degraded)
    return server


# ---- HTTP shim (healthz + /embed for clients without proto stubs) ----

_GLOBAL_BATCHER: BatchedEmbedder | None = None


def make_app(state: ModelState) -> FastAPI:
    app = FastAPI()

    @app.get("/healthz")
    def healthz() -> dict:
        return {
            "status": "degraded" if state.degraded else "ok",
            "model": state.name,
            "dim": state.dim,
            "detail": state.detail,
        }

    @app.post("/embed")
    async def embed(body: dict) -> dict:
        request_id = str(body.get("request_id", "anon"))
        texts = list(body.get("texts", []))
        if _GLOBAL_BATCHER is None:
            return {"error": "batcher not ready"}
        vectors = await _GLOBAL_BATCHER.embed(request_id, texts)
        return {
            "request_id": request_id,
            "embeddings": [{"values": v, "dim": len(v)} for v in vectors],
            "embedding_model": state.name,
        }

    return app


# ---- Entry point ----

async def main() -> None:
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ]
    )
    engine = EmbedEngine()
    state = engine.start()  # blocks until the model is loaded on its thread
    grpc_server = await serve_grpc(engine, state)

    config = uvicorn.Config(make_app(state), host="0.0.0.0", port=HEALTH_PORT, log_level="info")
    http_server = uvicorn.Server(config)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    try:
        await asyncio.gather(http_server.serve(), stop.wait())
    finally:
        log.info("shutting down")
        await grpc_server.stop(grace=10)
        engine.stop()


if __name__ == "__main__":
    asyncio.run(main())
