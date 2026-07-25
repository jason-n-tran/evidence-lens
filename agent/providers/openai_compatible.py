"""Adapter for OpenAI-compatible providers (OpenAI, Groq, OpenRouter,
Together, DeepInfra). Configurable base_url."""
from __future__ import annotations

from typing import AsyncIterator

import openai


_BASE_URLS = {
    "openai":     "https://api.openai.com/v1",
    "groq":       "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "together":   "https://api.together.xyz/v1",
    "deepinfra":  "https://api.deepinfra.com/v1/openai",
}


class OpenAICompatibleProvider:
    api_shape = "openai_compatible"

    def __init__(self, provider_id: str, api_key: str, model: str) -> None:
        self.name = provider_id
        base_url = _BASE_URLS.get(provider_id)
        if not base_url:
            raise ValueError(f"unknown openai-compatible provider: {provider_id}")
        self.client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url)
        self.model = model

    async def validate(self) -> bool:
        try:
            await self.client.models.list()
            return True
        except Exception:  # noqa: BLE001
            return False

    async def stream(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> AsyncIterator[dict]:
        full_messages = [{"role": "system", "content": system}, *messages]
        async for chunk in await self.client.chat.completions.create(
            model=self.model, messages=full_messages, tools=tools or [],
            stream=True, max_tokens=4096,
        ):
            yield {"type": "chunk", "data": chunk.model_dump()}
