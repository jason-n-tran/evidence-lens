# scorer-pool

Per spec §5.5. gRPC server orchestrating four sub-scorers + RRF fusion + XGBoost LTR rerank.

## Sub-scorers

| Module | What | Where |
|---|---|---|
| [bm25.py](bm25.py) | Meilisearch top 200 | text + facets |
| [vector.py](vector.py) | Milvus COSINE sim top 200 (BGE-M3 1024-d) | semantic |
| [citation.py](citation.py) | Neo4j PageRank lookup | influence |
| [recency.py](recency.py) | Exp decay (half-life 730d) | freshness |

## Fusion

[fusion.py](fusion.py) — Reciprocal Rank Fusion (k=60). Robust to score-scale differences without calibration.

## LTR

[ltr.py](ltr.py) — XGBoost LambdaMART. 12 features per spec §6.4. Synthetic-label fallback when no trained model is loaded so the system ranks before any clicks land.

## Wave streaming

`ScorerService.Search` emits three waves over the same gRPC stream:
- 200ms: best-effort first 5 from whichever sub-scorer finished first.
- 500ms: top 15 after RRF over BM25 + vector.
- 1000ms: top 50 after LTR rerank.

## Run

The container runs **two** transports side by side (see `Dockerfile`): the gRPC server
(`main.py`, `:50052`) and an HTTP/SSE shim (`http_server.py`, `:8090`). The gateway uses the
HTTP/SSE shim today (`POST /search`, `GET /healthz`).

```bash
uv sync
# gRPC server
MEILI_URL=... MILVUS_URI=... NEO4J_URL=... EMBEDDER_GRPC_URL=embedder:50051 \
uv run python main.py
# HTTP/SSE shim (separate process, what the gateway calls)
SCORER_HTTP_PORT=8090 uv run python http_server.py
```

The gRPC servicer is wired against a hand-written `evidencelens.v1` dataclass facade so the
service runs end-to-end without a `buf generate` step.
