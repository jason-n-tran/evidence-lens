"""Anthropic adapter — uses prompt caching."""
from __future__ import annotations

from typing import AsyncIterator

import anthropic


class AnthropicProvider:
    name = "anthropic"
    api_shape = "anthropic"

    def __init__(self, api_key: str, model: str = "claude-opus-4-7") -> None:
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self.model = model

    async def validate(self) -> bool:
        try:
            await self.client.messages.create(
                model=self.model, max_tokens=1, messages=[{"role": "user", "content": "ping"}],
            )
            return True
        except Exception:  # noqa: BLE001
            return False

    async def stream(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> AsyncIterator[dict]:
        # Cache the long system prompt across requests (Anthropic prompt caching).
        cached_system = [{
            "type": "text",
            "text": system,
            "cache_control": {"type": "ephemeral"},
        }]
        async with self.client.messages.stream(
            model=self.model,
            max_tokens=4096,
            system=cached_system,
            messages=messages,
            tools=tools or [],
        ) as stream:
            async for ev in stream:
                yield {"type": ev.type, "data": ev.model_dump() if hasattr(ev, "model_dump") else str(ev)}
