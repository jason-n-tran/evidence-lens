"""Ollama adapter — visitor's local Ollama server."""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx


class OllamaProvider:
    name = "ollama"
    api_shape = "ollama"

    def __init__(self, base_url: str = "http://localhost:11434", model: str = "llama3.2") -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.http = httpx.AsyncClient(timeout=300.0)

    async def validate(self) -> bool:
        try:
            r = await self.http.get(f"{self.base_url}/api/tags")
            return r.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def stream(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> AsyncIterator[dict]:
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "stream": True,
        }
        async with self.http.stream("POST", f"{self.base_url}/api/chat", json=body) as r:
            async for line in r.aiter_lines():
                if line.strip():
                    yield {"type": "chunk", "data": json.loads(line)}
