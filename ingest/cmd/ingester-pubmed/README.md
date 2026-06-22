# ingester-pubmed

PubMed ingester (spec §5.1.1). Reference implementation — every other ingester mirrors this shape.

## Source

[NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/) (`esearch` + `efetch`). Free, public. API key recommended (raises rate limit from 3/s to 10/s, free at <https://www.ncbi.nlm.nih.gov/account/settings/>).

## Watermark

PubMed `EDAT` (entry date), ISO-8601 string `YYYY/MM/DD`. Stored in Postgres `ingestion_state.last_high_watermark`.

## Run

```bash
# Local
DATABASE_URL=postgres://evidencelens:changeme-dev-only@localhost:5432/evidencelens \
S3_ENDPOINT=http://truenas.lan:9000 S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_BUCKET=evidencelens-raw \
NATS_URL=nats://truenas.lan:4222 \
NCBI_API_KEY=... NCBI_EMAIL=you@example.com \
go run ./cmd/ingester-pubmed
# Runs once and exits; no HTTP server.
```

## Deploy

Built + pushed to GHCR by `.github/workflows/deploy-dokploy.yml` on push to `main`. A Dokploy schedule (see [`infra/dokploy/schedules.yaml`](../../../infra/dokploy/schedules.yaml)) starts the container every 6 hours.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | required | Postgres DSN for ingestion_state + watermark |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_ENDPOINT` | required | MinIO (or any S3-compatible) raw archive |
| `NATS_URL` | required | NATS server URL (e.g. `nats://truenas.lan:4222`) |
| `NATS_SUBJECT_RAW_DOCS` | `raw-docs` | Subject prefix; full subject is `{prefix}.pubmed` |
| `NCBI_API_KEY` | empty | Recommended; raises rate limit |
| `NCBI_TOOL` | `evidencelens` | Tool identifier sent to NCBI |
| `NCBI_EMAIL` | `contact@example.com` | Required by NCBI ToS |
| `PUBMED_MAX_PER_RUN` | `5000` | Cap PMIDs per invocation |
| `INGESTER_TIMEOUT` | `14m` | Wall-clock cap per run |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | If set, traces emitted via OTLP HTTP |

## Tests

```bash
cd ingest && go test ./internal/ingesters/pubmed/...
```

Network calls in tests are recorded with [go-vcr](https://github.com/dnaeon/go-vcr) under `testdata/cassettes/` (TODO: add cassettes).

## TODO

- Bulk baseline FTP fetch from `ftp.ncbi.nlm.nih.gov/pubmed/baseline/` for first-run seed (currently uses 7-day lookback).
- go-vcr cassette for esearch + efetch round-trips.
