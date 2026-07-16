"""
HTTP/SSE shim for the scorer pool.

The frozen contract is gRPC (proto/evidencelens/v1/scorer.proto). Until
`buf generate` runs in CI, this HTTP shim gives the gateway a working
streamed transport so the pipeline is testable end-to-end. Once the gRPC
servicer is generated, both transports run side-by-side; the gateway can
switch over with one config flip.

  POST /search   - SSE stream of {wave, isFinal, results, elapsedMs}
  GET  /healthz  - liveness probe
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator

import structlog
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from main import Config, ScorerCore   # type: ignore[import]

log = structlog.get_logger("scorer.http")

app = FastAPI()
_core: ScorerCore | None = None


@app.on_event("startup")
async def _startup() -> None:
    global _core
    _core = ScorerCore(Config.from_env())
    log.info("scorer http shim ready")


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@app.post("/search")
async def search(req: Request):
    body = await req.json()
    query = body.get("query", "")
    filters = body.get("filters")
    top_k = int(body.get("top_k", 50))
    log.info("scorer.http.search", query=query[:80], filters=filters, top_k=top_k)
    if not query:
        return {"error": "query required"}

    async def gen() -> AsyncIterator[bytes]:
        assert _core is not None
        try:
            async for wave_no, is_final, results in _core.search(query, filters, top_k):
                payload = {
                    "type": "search.partial" if not is_final else "search.final",
                    "wave": wave_no,
                    "isFinal": is_final,
                    "results": results,
                }
                yield f"data: {json.dumps(payload)}\n\n".encode()
        except Exception as e:  # noqa: BLE001
            err = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(err)}\n\n".encode()
        finally:
            yield b"event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def main() -> None:
    structlog.configure(processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ])
    port = int(os.getenv("SCORER_HTTP_PORT", "8090"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
