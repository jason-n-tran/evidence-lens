"""
agent-service entry (spec §5.7).

POST /synthesize — BYOK proxy that:
  1. Validates the API key cheaply (probe + 10min cache by SHA256(key)).
  2. Loads the system prompt from prompts/agent_system.md.
  3. Streams the response back to the gateway via Server-Sent Events.
  4. Logs telemetry (provider, model, tokens, duration) to Postgres
     `byok_proxy_telemetry` — never the key.
  5. Tool-use callbacks proxy to gateway endpoints (/api/tool/{name}).

Sessions are anonymous (no PII, no accounts).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import time
from contextlib import suppress
from pathlib import Path

import asyncpg
import structlog
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from providers.anthropic import AnthropicProvider
from providers.openai_compatible import OpenAICompatibleProvider
from providers.ollama import OllamaProvider

log = structlog.get_logger("agent")

SYSTEM_PROMPT = Path(os.getenv("AGENT_PROMPT_PATH", "/prompts/agent_system.md")).read_text(encoding="utf-8")
KEY_CACHE_TTL = int(os.getenv("AGENT_KEY_VALIDATION_CACHE_TTL_SEC", "600"))
PG_DSN = os.getenv("DATABASE_URL", "")

app = FastAPI()
_pool: asyncpg.Pool | None = None
_key_cache: dict[str, float] = {}
_key_cache_lock = asyncio.Lock()


@app.on_event("startup")
async def _startup() -> None:
    global _pool
    if PG_DSN:
        _pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=10)


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _pool:
        await _pool.close()


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


def _make_provider(provider_id: str, key: str, model: str | None) -> object:
    if provider_id == "anthropic":
        return AnthropicProvider(key, model or "claude-opus-4-7")
    if provider_id == "ollama":
        # For ollama the "key" is actually a base URL.
        return OllamaProvider(key, model or "llama3.2")
    return OpenAICompatibleProvider(
        provider_id, key,
        model or {"openai": "gpt-4o-mini", "groq": "llama-3.3-70b-versatile"}.get(provider_id, ""),
    )


async def _key_valid(provider_id: str, key: str, provider_obj) -> bool:
    cache_key = hashlib.sha256(f"{provider_id}::{key}".encode()).hexdigest()
    now = time.time()
    async with _key_cache_lock:
        exp = _key_cache.get(cache_key)
        if exp and exp > now:
            return True
    ok = await provider_obj.validate()
    if ok:
        async with _key_cache_lock:
            _key_cache[cache_key] = now + KEY_CACHE_TTL
    return ok


async def _log_telemetry(session_id: str, provider: str, model: str,
                          duration_ms: int, error: str | None = None) -> None:
    if not _pool:
        return
    async with _pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO byok_proxy_telemetry
               (session_id, provider, model, duration_ms, error)
               VALUES ($1, $2, $3, $4, $5)""",
            session_id, provider, model, duration_ms, error,
        )


@app.post("/synthesize")
async def synthesize(
    req: Request,
    authorization: str = Header(...),
    x_provider: str = Header(...),
    x_model: str | None = Header(None),
):
    if not authorization.startswith("Bearer "):
        raise HTTPException(400, "Authorization: Bearer <key> required")
    key = authorization.removeprefix("Bearer ").strip()
    body = await req.json()
    session_id = body.get("sessionId", "anon")
    messages = body.get("messages", [])
    tools = body.get("tools", [])
    if not messages:
        raise HTTPException(400, "messages required")

    provider = _make_provider(x_provider, key, x_model)
    if not await _key_valid(x_provider, key, provider):
        raise HTTPException(401, "invalid api key")

    async def gen():
        start = time.time()
        err: str | None = None
        try:
            async for ev in provider.stream(SYSTEM_PROMPT, messages, tools):
                yield f"data: {json.dumps(ev)}\n\n".encode()
        except Exception as e:  # noqa: BLE001
            err = str(e)
            yield f"event: error\ndata: {json.dumps({'message': err})}\n\n".encode()
        finally:
            ms = int((time.time() - start) * 1000)
            with suppress(Exception):
                await _log_telemetry(session_id, x_provider, x_model or "", ms, err)
            yield b"event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def main() -> None:
    structlog.configure(processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ])
    port = int(os.getenv("AGENT_PORT", "8081"))
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    loop.run_until_complete(asyncio.gather(server.serve(), stop.wait()))


if __name__ == "__main__":
    main()
