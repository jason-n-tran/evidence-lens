"""
Processor entry point (spec §5.2).

Subscribes to NATS `raw-docs.>` (published directly by the ingester
containers running on Dokploy), runs each event through the pipeline:

  parse → normalize → entity-link → chunk → embed → COI-join → publish

50 concurrent pipelines. Backpressure: if NATS publish lag exceeds a
threshold, pause Pub/Sub pull (mirrors Moogle spider backpressure).

Lifts service-skeleton pattern from Moogle indexer/main.py: signal
handlers + handle_exit + structured slog (here structlog).
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
from contextlib import suppress

import asyncpg
import nats
import structlog
import uvicorn
from fastapi import FastAPI
from nats.js.api import ConsumerConfig

from utils.author_payment_joiner import AuthorPaymentJoiner
from utils.chunker import chunk, mean_pool
from utils.config import Config
from utils.embedder_client import EmbedderClient
from utils.entity_linker import link as link_entities, merge_into_mesh
from utils.object_store import ObjectStore
from utils.salience import extract as extract_salience
from parsers import parse as parse_source

log = structlog.get_logger("processor")


class Pipeline:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.nc: nats.NATS | None = None
        self.pool: asyncpg.Pool | None = None
        self.store = ObjectStore(cfg.s3_endpoint, cfg.s3_access_key, cfg.s3_secret_key, cfg.s3_bucket)
        self.embedder = EmbedderClient(cfg.embedder_grpc_url)
        self.joiner: AuthorPaymentJoiner | None = None
        self._sem = asyncio.Semaphore(cfg.max_concurrent_pipelines)
        self._sub = None

    async def setup(self) -> None:
        self.nc = await nats.connect(self.cfg.nats_url)
        self.pool = await asyncpg.create_pool(self.cfg.pg_dsn, min_size=2, max_size=20)
        self.joiner = AuthorPaymentJoiner(
            self.pool,
            self.cfg.open_payments_lookup_url,
            self.cfg.cache_ttl_days,
            self.cfg.fuzzy_min_confidence,
        )

        # Ensure the JetStream stream exists (idempotent). The indexer also
        # does this, but we may start before or in parallel with it.
        js = self.nc.jetstream()
        stream_name = self.cfg.nats_stream
        for attempt in range(10):
            try:
                await js.find_stream(stream_name)
                log.info("nats stream found", stream=stream_name)
                break
            except Exception:  # stream not yet created
                if attempt == 9:
                    # Last resort: create it ourselves
                    try:
                        await js.add_stream(name=stream_name,
                                            subjects=["raw-docs.>", "indexable-docs.>", "dlq.>"])
                        log.info("nats stream created", stream=stream_name)
                    except Exception as e:
                        log.warning("nats stream create failed", err=str(e))
                else:
                    log.info("waiting for nats stream", stream=stream_name, attempt=attempt)
                    await asyncio.sleep(3)

        # Bound redelivery. Without max_deliver, any doc that fails processing
        # (bad parse, embedder error, etc.) is redelivered FOREVER — inflating
        # the consumer's deliv_seq/redelivered counters. Cap at 5 attempts
        # (matches the indexer consumer); after that NATS stops redelivering.
        # NOTE: the config only takes effect when the durable is first created.
        # An existing durable with different config makes js.subscribe raise; in
        # that case fall back to a plain bind so startup never breaks. To apply
        # the new cap to an already-running consumer, delete it once (orchestrator
        # ResetProcessorConsumer step) and let it be recreated here.
        # ack_wait: how long NATS waits for an ack before redelivering. The old
        # 60s was far too short under high concurrency — with N pipelines sharing
        # one embedder, a doc routinely takes >60s to finish, so it got
        # redelivered WHILE still processing, exploding the redelivered counter
        # and pinning the ack floor (a redelivery storm, not real progress).
        # max_ack_pending: cap on in-flight (unacked) messages — must be >=
        # MAX_CONCURRENT_PIPELINES or the extra pipelines starve (default 1000
        # was throttling a 200-wide processor to 1000 in flight regardless).
        ack_wait = int(os.getenv("PROCESSOR_ACK_WAIT_SEC", "300"))
        max_ack_pending = int(os.getenv("PROCESSOR_MAX_ACK_PENDING",
                                        str(max(1000, self.cfg.max_concurrent_pipelines * 2))))
        try:
            self._sub = await js.subscribe(
                "raw-docs.>",
                cb=self._on_message,
                durable="processor",
                manual_ack=True,
                config=ConsumerConfig(max_deliver=5, ack_wait=ack_wait,
                                      max_ack_pending=max_ack_pending),
            )
            log.info("processor subscribed", subject="raw-docs.>", max_deliver=5,
                     ack_wait=ack_wait, max_ack_pending=max_ack_pending)
        except Exception as e:  # noqa: BLE001 — existing durable w/ different config
            log.warning("subscribe with bounded config failed; binding existing consumer",
                        err=str(e))
            self._sub = await js.subscribe(
                "raw-docs.>", cb=self._on_message, durable="processor", manual_ack=True,
            )
            log.info("processor subscribed (existing consumer config)", subject="raw-docs.>")
        # Backpressure watcher: when the indexer's lag exceeds threshold,
        # pause delivery from this subscription. Mirrors the spider
        # backpressure pattern at services/spider/cmd/spider/main.go in
        # the Moogle reference repo.
        asyncio.create_task(self._backpressure_loop())

    async def _backpressure_loop(self) -> None:
        """Poll JetStream consumer info for `indexer`. If pending > cap,
        drain (pause) our own delivery; resume when it drops."""
        if not self.nc:
            return
        js = self.nc.jetstream()
        max_pending = int(self.cfg.max_concurrent_pipelines * 4)
        paused = False
        while True:
            await asyncio.sleep(5)
            try:
                info = await js.consumer_info("EVIDENCELENS", "indexer")
                pending = info.num_pending
                if pending > max_pending and not paused:
                    log.warning("backpressure: pausing", indexer_pending=pending)
                    if self._sub:
                        await self._sub.drain()
                    paused = True
                elif pending <= max_pending // 2 and paused:
                    log.info("backpressure: resuming", indexer_pending=pending)
                    self._sub = await js.subscribe(
                        "raw-docs.>", cb=self._on_message,
                        durable="processor", manual_ack=True,
                    )
                    paused = False
            except Exception as e:  # noqa: BLE001
                log.debug("backpressure check skipped", err=str(e))

    async def teardown(self) -> None:
        if self.joiner:
            await self.joiner.close()
        if self.nc:
            await self.nc.close()
        if self.pool:
            await self.pool.close()
        await self.embedder.close()

    async def _on_message(self, msg) -> None:
        async with self._sem:
            try:
                payload = json.loads(msg.data)
                await self._process(payload)
                await msg.ack()
            except Exception as e:  # noqa: BLE001
                log.error("processor.error", err=str(e))
                # NATS will redeliver up to consumer's max_deliver; after
                # that the message lands on dlq.indexer (handled by indexer).
                await msg.nak()

    async def _process(self, ev: dict) -> None:
        source = ev["source"]
        doc_id = ev["doc_id"]
        object_key = ev["object_key"]
        log.debug("process.begin", source=source, doc_id=doc_id)

        # 1. Fetch raw bytes from the object store (MinIO).
        # A missing object (e.g. the raw was purged after the NATS message was
        # enqueued) is unrecoverable — skip it (ack) rather than nak-ing into an
        # infinite redelivery loop that would wedge the consumer.
        try:
            raw = await asyncio.to_thread(self.store.get, object_key)
        except Exception as e:  # noqa: BLE001
            if "NoSuchKey" in str(e) or "Not Found" in str(e) or "404" in str(e):
                log.warning("process.skip_missing_object",
                            source=source, doc_id=doc_id, object_key=object_key)
                return
            raise

        # 2. Parse → normalize.
        doc = parse_source(source, raw)

        # Quality gate: drop structurally incomplete documents before
        # expensive downstream steps. Returning normally causes _on_message
        # to ack the message, avoiding infinite redelivery of records that
        # will always fail this check.
        if not _validate_document(doc, source):
            log.warning("processor.skip_incomplete",
                        source=source, doc_id=doc_id,
                        title_len=len(doc.get("title") or ""),
                        has_abstract=bool(doc.get("abstract")))
            return

        # 3. Entity-link (scispaCy + UMLS, fallback regex). Merge into MeSH.
        text_for_linking = f"{doc.get('title', '')}\n\n{doc.get('abstract', '')}"
        entities = await asyncio.to_thread(link_entities, text_for_linking, 50)
        doc["mesh_terms"] = merge_into_mesh(doc.get("mesh_terms", []), entities)

        # 4. Salience hook (cheap, regex-based). Pre-computed at index
        # time so result cards don't round-trip through an LLM.
        salience = extract_salience(doc.get("study_type"), doc.get("abstract"))
        if salience:
            doc["salience"] = salience

        # 5. Chunk + embed.
        chunks = chunk(
            f"{doc.get('title', '')}\n\n{doc.get('abstract', '')}",
            self.cfg.chunk_tokens,
            self.cfg.chunk_overlap,
        )
        embeddings = await self.embedder.embed(doc_id, [c.text for c in chunks])
        if embeddings:
            doc["embedding"] = mean_pool([e.vector for e in embeddings])
            doc["embedding_model"] = embeddings[0].model

        # 6. Author × Open Payments fuzzy join.
        if self.joiner:
            year = _published_year(doc.get("published_at"))
            max_payment = 0.0
            has_coi = False
            for author in doc.get("authors", []):
                affil = author.get("affiliation") or ""
                state = _extract_state(affil)
                matches, badge = await self.joiner.lookup(author.get("display_name", ""), state, year)
                author["payments"] = [m.__dict__ for m in matches]
                author["badge"] = badge.__dict__
                if badge.has_payments:
                    has_coi = True
                    max_payment = max(max_payment, badge.total_payments_usd)
            doc["has_coi_authors"] = has_coi
            doc["max_author_payment_usd"] = max_payment

        # 7. Predatory-journal flag (Beall list snapshot). Loaded lazily.
        if doc.get("journal", {}).get("issn"):
            doc["journal"]["is_predatory"] = _is_predatory(doc["journal"]["issn"])

        # 8. Publish IndexableDocEvent to indexer.
        if self.nc:
            await self.nc.jetstream().publish(
                f"indexable-docs.{source}",
                json.dumps({"document": doc}).encode(),
            )
        log.debug("process.complete", source=source, doc_id=doc_id)


# ---- Document quality gate ----

# Sources where meaningful title AND (abstract OR full_text) are required.
# Regulatory/ontology sources (FDA, EMA, OMIM, etc.) are excluded because
# they have legitimate use cases with no traditional abstract.
_PAPER_SOURCES = frozenset({
    "pubmed", "biorxiv", "medrxiv", "openalex", "crossref",
    "core", "cochrane", "pmc-oa", "unpaywall", "nih-reporter",
})


def _validate_document(doc: dict, source: str) -> bool:
    title = (doc.get("title") or "").strip()
    if not title:
        return False
    if source in _PAPER_SOURCES:
        abstract = (doc.get("abstract") or "").strip()
        full_text = (doc.get("full_text") or "").strip()
        if not abstract and not full_text:
            return False
    return True


# ---- Predatory-journal flag ----

_PREDATORY_ISSNS: set[str] | None = None


def _norm_issn(s: str) -> str:
    """Canonicalize an ISSN for set membership: drop hyphens/whitespace and
    uppercase (the check digit can be 'X'). This makes matching tolerant of
    format differences between the curated list (e.g. '1234-5678') and what a
    parser stored (e.g. '12345678' or '1234-567x')."""
    return s.replace("-", "").replace(" ", "").strip().upper()


def _load_predatory_issns() -> set[str]:
    """Lazy-load a snapshot of predatory-journal ISSNs (one per line). Lives at
    config/predatory_issns.txt. ISSNs are normalized (hyphen/case-insensitive)
    so the source list's formatting doesn't have to match the parsers'."""
    global _PREDATORY_ISSNS
    if _PREDATORY_ISSNS is not None:
        return _PREDATORY_ISSNS
    from pathlib import Path
    p = Path(__file__).resolve().parent.parent / "config" / "predatory_issns.txt"
    if not p.exists():
        _PREDATORY_ISSNS = set()
        return _PREDATORY_ISSNS
    _PREDATORY_ISSNS = {
        _norm_issn(line) for line in p.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    return _PREDATORY_ISSNS


def _is_predatory(issn: str) -> bool:
    return _norm_issn(issn) in _load_predatory_issns()


def _published_year(s: str | None) -> int | None:
    if not s or len(s) < 4 or not s[:4].isdigit():
        return None
    return int(s[:4])


_US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH",
    "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN",
    "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}


def _extract_state(affiliation: str) -> str | None:
    """Best-effort US state extraction from affiliation. Cheap heuristic."""
    if not affiliation:
        return None
    lower = affiliation.lower()
    for name, code in _US_STATES.items():
        if name in lower:
            return code
        if f", {code.lower()}" in lower or f" {code.lower()} " in lower:
            return code
    return None


# ---- HTTP healthz ----

def make_app(pipeline: Pipeline) -> FastAPI:
    app = FastAPI()

    @app.get("/healthz")
    async def healthz() -> dict:
        ok = pipeline.nc is not None and pipeline.nc.is_connected
        return {"status": "ok" if ok else "down", "nats": ok}

    return app


async def main() -> None:
    structlog.configure(processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ])
    cfg = Config.from_env()
    pipeline = Pipeline(cfg)
    await pipeline.setup()

    config = uvicorn.Config(make_app(pipeline), host="0.0.0.0", port=8080, log_level="info")
    server = uvicorn.Server(config)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    try:
        await asyncio.gather(server.serve(), stop.wait())
    finally:
        log.info("processor shutting down")
        await pipeline.teardown()


if __name__ == "__main__":
    with suppress(KeyboardInterrupt):
        asyncio.run(main())
