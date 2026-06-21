# ingest

Go workspace of 26 biomedical-source ingesters. Each fetches from a public API, archives the raw
payload to an S3-compatible store, and publishes a `RawDocEvent` to NATS JetStream
(`raw-docs.{source}`). One-shot containers — `ofelia` triggers them on cron
([infra/ofelia/config.ini](../infra/ofelia/config.ini)); run ad-hoc with
`npm run ingest:pubmed` (etc.).

## Layout

```
cmd/ingester-{source}/   thin main.go: wire Config + deps, call ingestcommon.RunCLI
internal/ingesters/      per-source fetch/parse logic (pubmed is the reference)
pkg/
  ingestcommon/          env helpers, Fetcher (rate-limited HTTP w/ retry), Runner, RunCLI
  natspub/               NATS publisher (RawDocEvent JSON envelope)
  objectstore/           S3/MinIO archiver (gzip)
  watermark/             per-source high-watermark + status in Postgres ingestion_state
  otel/                  optional tracing (no-op when OTEL endpoint blank)
```

## The 26 sources

`pubmed, preprint, trials, ictrp, fda, ema, openalex, crossref, unpaywall, nih-reporter,
open-payments, cochrane, guidelines, pmc-oa, chembl, drugbank, disgenet, omim, hpo, core,
cdc-wonder, health-canada, pmda, mhra, tga, nsf`.

**Wired into compose today:** `pubmed`, `trials`, `fda`, `preprint`. The other 22 have working
code + a `cmd/ingester-{source}/Dockerfile`; add a service block to `docker-compose.yml` (and an
ofelia job) to schedule them.

## RawDocEvent contract

Published to `raw-docs.{source}` as JSON:

```json
{ "source": "pubmed", "doc_id": "12345678", "object_key": "raw/pubmed/...", "ingested_at": "..." }
```

The processor consumes `raw-docs.>`, fetches `object_key` from S3, and parses per-source.

## Writing a new ingester

Copy `internal/ingesters/pubmed/` as the template: a `Config` struct + `New(...)` +
`Run(ctx) (ingestcommon.RunResult, error)`. The `cmd/` entrypoint just wires dependencies and
calls `ingestcommon.RunCLI`. Rate-limit via `ingestcommon.NewFetcher`. Advance the watermark only
after a batch is durably archived + published so reruns are idempotent.

## Run (needs the Go toolchain)

```bash
go work sync && go build ./...
# ad-hoc one source via compose:
npm run ingest:pubmed
```

> First PubMed run caps to a 7-day lookback unless `PUBMED_BULK_BASELINE=true` (avoids pulling
> 38M records by accident).
