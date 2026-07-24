# gateway

Per spec §5.6. NestJS 11. Public API surface (REST + GraphQL + WebSocket + BYOK proxy).

## Modules

| Module | Routes |
|---|---|
| SearchModule | `GET /api/search?q=`, `Query.search`, WS `search` |
| DocumentModule | `GET /api/document/:id`, `Query.document` |
| TrialsModule | `GET /api/trials` |
| RecallsModule | `GET /api/recalls/recent` |
| ToolModule | `POST /api/tool/:name` — the 8 MCP tools |
| LlmProxyModule | `GET /llm/status`, `GET /llm/models`, `POST /llm/synthesize` (SSE) |
| AdminModule | `GET /admin/status` |
| ExperimentsModule / ClicksModule | A/B config + click logging (Postgres) |
| GatewayWebSocketModule | `/ws` upgrade endpoint |

## Rate limits

Set via `@nestjs/throttler`:
- `rest`: 60/min
- `llm`: 30/min

## BYOK proxy

`POST /llm/synthesize` requires `Authorization: Bearer <visitor-key>` and `X-Provider`.
`X-Turnstile-Token` is only enforced when `TURNSTILE_SECRET` is set (otherwise the check is
skipped). Forwards SSE to `agent-service`. Key is **never logged**.

## Talking to the scorer

Search fans out to the scorer-pool over **HTTP/SSE** at `scorer:8090/search` (the scorer's
`http_server.py` shim), draining SSE wave frames and forwarding them downstream over `/ws`.

## Dev

```bash
npm install                                       # at the repo root
npm run start:dev --workspace gateway
```

GraphQL playground at `http://localhost:8080/graphql`.

## Notes

- All modules are fully implemented and wired into `app.module.ts`. The scorer connection is
  live (HTTP/SSE, see above), not a scaffold.
- WebSocket `subscribe topic=recalls` bridges a NATS subscription on `recall-fanout`.
- Port mapping: gateway listens on `8080` in-container, published to host `:8088` by compose.
