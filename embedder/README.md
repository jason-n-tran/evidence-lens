# embedder

vLLM-backed BGE-M3 gRPC embedder per spec §5.3.

## Surface

- gRPC `EmbedderService.Embed(stream)` — bidirectional streaming, batched 32 / 25ms.
- gRPC `EmbedderService.EmbedOnce` — single-shot for tests/CLI.
- gRPC `EmbedderService.Healthz` + standard `grpc.health.v1`.
- HTTP `GET /healthz` on a sidecar port (Kubernetes-style liveness).

## Models

| Path | Model | Dim | Notes |
|---|---|---|---|
| Primary (GPU) | `BAAI/bge-m3` | 1024 | First choice; spec default |
| Fallback (CPU) | `BAAI/bge-small-en-v1.5` | 384 | Auto-engaged when GPU unavailable; emits `degraded_mode` gauge |

The active model identity is embedded in every `EmbedResponse.embedding_model` so consumers can validate vector compatibility before writing to Milvus (`evidence_v1` collection assumes 1024-d).

## Run

```bash
# Local CPU
uv sync && uv run python main.py
# Local GPU (TrueNAS)
docker compose up --build
```

## Env

| Var | Default | Notes |
|---|---|---|
| `EMBEDDING_MODEL` | `BAAI/bge-m3` | HuggingFace ID for primary |
| `EMBEDDING_FALLBACK_MODEL` | `BAAI/bge-small-en-v1.5` | CPU fallback |
| `GRPC_PORT` | `50051` | gRPC bind |
| `HEALTH_PORT` | `8080` | FastAPI healthz bind |
| `BATCH_SIZE` | `32` | Dynamic batch size |
| `MAX_WAIT_MS` | `25` | Max coalescing wait |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | OTLP HTTP collector URL |

## Notes

- The gRPC servicer is wired against a hand-written `evidencelens.v1` dataclass facade, so the
  service runs without a `buf generate` step. The processor calls the HTTP `/embed` shim by
  default, not gRPC.
- **CPU is the default** (`EMBEDDING_DEVICE=cpu` in compose) → BGE-small, **384-d**. GPU/BGE-M3
  (1024-d) is opt-in; if you enable it, also set `EMBEDDING_DIM=1024` so the Milvus collection
  dimension matches. Every `EmbedResponse` carries `embedding_model` so consumers can detect the active
  model.
- Throughput target ~200 chunks/sec on RTX 3060 (spec §15.1).
