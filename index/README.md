# indexer

Per spec §5.4. Consumes NATS `indexable-docs.>` and fans out to three batchers.

| Batcher | Trigger | Path |
|---|---|---|
| Meilisearch | 1000 docs OR 5s | [pkg/batchers/meili/](pkg/batchers/meili/) |
| Milvus | 100 vectors OR 5s | [pkg/batchers/milvus/](pkg/batchers/milvus/) |
| Neo4j | 500 MERGE per tx OR 5s | [pkg/batchers/neo4jb/](pkg/batchers/neo4jb/) |

DLQ: after consumer's `MaxDeliver=5` failures, NATS publishes to `dlq.indexer`. See [docs/runbooks/indexer-dlq.md](../docs/runbooks/indexer-dlq.md).

## Idempotency

- Meilisearch: keyed by `id` (addOrReplace = upsert).
- Milvus: keyed by `doc_id` (VARCHAR primary key; RESTful API v2 upsert).
- Neo4j: `MERGE (d:Document {id: $id})` — first-write-wins for properties (use SET to update).

## SLO

Spec §14.1: a record going `ingester → processor → indexer → searchable in all three indexes` within **5 minutes p95** over 24h. Alert at `IndexerLagAbove5Min` (see [infra/grafana/alerts/slo.yaml](../infra/grafana/alerts/slo.yaml)).

## Notes

- Milvus batcher upserts via Milvus RESTful API v2 (`POST /v2/vectordb/entities/upsert`);
  no Go client dependency, string `doc_id` primary key. The collection is created at startup
  by `pkg/initdata` with HNSW+COSINE index and source-based partition key, sized from
  `EMBEDDING_DIM` (default 1024; set to 384 if running the CPU embedder fallback).
- Meilisearch writes go through `flatten()`, which denormalizes nested fields into flat facets
  (`journal.is_predatory` → `journal_predatory`, plus `authors_display`, `published_year`) — this
  is the shape the scorer's bm25 sub-scorer reads back.
- Neo4j Cypher uses ORCID as the author key when present, else display_name.
