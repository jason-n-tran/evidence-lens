# agent-service

Per spec §5.7. BYOK proxy. Visitor pastes their own LLM key in the frontend; we proxy the request and stream back. **Never store keys.**

## Providers

| Provider | Adapter | Notes |
|---|---|---|
| Anthropic | [providers/anthropic.py](providers/anthropic.py) | Prompt caching enabled |
| OpenAI / Groq / OpenRouter / Together / DeepInfra | [providers/openai_compatible.py](providers/openai_compatible.py) | Same client, configurable `base_url` |
| Ollama (visitor's local) | [providers/ollama.py](providers/ollama.py) | "key" carries `OLLAMA_BASE_URL` |

## Key validation cache

10-minute TTL on SHA-256(key+provider). Avoids burning the visitor's quota on every page load.

## Telemetry

Tokens / duration / error logged to Postgres `byok_proxy_telemetry`. **Keys are never persisted.**

## System prompt

Loaded at startup from [prompts/agent_system.md](../prompts/agent_system.md). Edit there, redeploy.

## Run

```bash
uv sync
DATABASE_URL=... AGENT_PROMPT_PATH=../prompts/agent_system.md uv run python main.py
```
