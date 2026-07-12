# processor

Per spec §5.2. Consumes `raw-docs.>` from NATS (published directly by the ingester containers),
runs the pipeline, publishes the canonical document as `{"document": {...}}` to
`indexable-docs.{source}`.

## Pipeline (all stages implemented)

1. Parse — dispatch to per-source parser (`parsers/*.py`).
2. Entity link — scispaCy `en_core_sci_lg` + UMLS, with a regex glossary fallback when scispaCy
   isn't installed (`utils/entity_linker.py`). Merged into MeSH terms.
3. Salience — regex/heuristic one-line summary (`utils/salience.py`), precomputed so result
   cards don't round-trip an LLM.
4. Chunk — sliding window 512 tokens / 64 overlap (`utils/chunker.py`), with a whitespace-token
   fallback if tiktoken's vocab is unavailable.
5. Embed — HTTP to the embedder's `/embed` (`utils/embedder_client.py`); falls back to a
   deterministic SHA-256 stub vector tagged `stub-deterministic` if the embedder is unreachable.
6. **Author × Open Payments fuzzy join** (`utils/author_payment_joiner.py`) — flagship logic.
   Conservative threshold ≥ 0.90; state-restricted when affiliation is known. Cached 30 days in
   Postgres `author_payment_cache`.
7. Predatory-journal flag — ISSN membership against `config/predatory_issns.txt` (empty set if
   the file is absent).
8. Publish to NATS `indexable-docs.{source}`.

## Concurrency

`MAX_CONCURRENT_PIPELINES=50` caps in-flight work. Backpressure is implemented: a loop polls the
indexer's JetStream consumer lag and drains (pauses) this consumer when pending exceeds the cap,
resuming when it drops.

## Run

```bash
uv sync
DATABASE_URL=... NATS_URL=nats://truenas.lan:4222 S3_ENDPOINT=http://truenas.lan:9000 \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_BUCKET=evidencelens-raw \
EMBEDDER_GRPC_URL=embedder:50051 \
OPEN_PAYMENTS_LOOKUP_URL=http://ingester-open-payments:8080/lookup \
uv run python main.py
```

## Notes

- Chunker uses tiktoken (cl100k_base) as a tokenization proxy — close to BGE-M3 within ±10% for
  budgeting. The real tokenizer in `embedder` does the actual cut. If tiktoken can't load its
  vocab, the chunker falls back to whitespace tokenization so the pipeline never blocks.
- Author × Open Payments lookup defends against false positives by skipping initials-only authors
  when state is unknown. The cache key is `lastname:firstinitial:state`.
