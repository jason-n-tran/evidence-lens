"""
Delete ghost documents from Meilisearch — records that have no usable title
or (for paper sources) no abstract/full_text. These are artifacts of ingestion
runs before the processor quality gate was added.

Usage:
    # dry run first — see what would be deleted
    python cleanup_ghost_docs.py --dry-run

    # then for real
    python cleanup_ghost_docs.py

    # override connection (defaults match docker-compose service names)
    MEILI_URL=http://localhost:7700 MEILI_KEY=masterKey python cleanup_ghost_docs.py
"""
from __future__ import annotations

import argparse
import os
import sys

import meilisearch

MEILI_URL = os.getenv("MEILI_URL", "http://localhost:7700")
MEILI_KEY = os.getenv("MEILI_KEY", "")
INDEX_NAME = os.getenv("MEILI_INDEX", "documents")
BATCH_SIZE = 1000
PAGE_SIZE = 1000

# Mirror of _PAPER_SOURCES in process/main.py — sources where missing
# abstract also qualifies a doc as a ghost.
PAPER_SOURCES = {
    "pubmed", "biorxiv", "medrxiv", "openalex", "crossref",
    "core", "cochrane", "pmc-oa", "unpaywall", "nih-reporter",
}


def is_ghost(doc: dict) -> bool:
    title = (doc.get("title") or "").strip()
    if not title:
        return True
    source = (doc.get("source") or "").lower()
    if source in PAPER_SOURCES:
        abstract = (doc.get("abstract") or "").strip()
        full_text = (doc.get("full_text") or "").strip()
        if not abstract and not full_text:
            return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Remove ghost docs from Meilisearch.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be deleted without deleting.")
    parser.add_argument("--index", default=INDEX_NAME,
                        help=f"Meilisearch index name (default: {INDEX_NAME})")
    args = parser.parse_args()

    client = meilisearch.Client(MEILI_URL, MEILI_KEY)
    index = client.index(args.index)

    try:
        stats = index.get_stats()
        total_docs = stats.number_of_documents
    except Exception as e:
        print(f"ERROR: cannot reach Meilisearch at {MEILI_URL}: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Index '{args.index}': {total_docs:,} total documents")
    print(f"Mode: {'DRY RUN (no deletions)' if args.dry_run else 'LIVE — will delete'}\n")

    ghost_ids: list[str] = []
    offset = 0
    pages = 0

    while True:
        result = index.get_documents({
            "limit": PAGE_SIZE,
            "offset": offset,
            "fields": ["id", "title", "abstract", "source"],
        })
        docs = result.results
        if not docs:
            break

        for doc in docs:
            if is_ghost(doc):
                ghost_ids.append(doc["id"])

        pages += 1
        offset += len(docs)
        scanned = min(offset, total_docs)
        print(f"\r  Scanned {scanned:,}/{total_docs:,} ({100*scanned//total_docs}%)  "
              f"found {len(ghost_ids):,} ghosts", end="", flush=True)

        if len(docs) < PAGE_SIZE:
            break

    print(f"\n\nFound {len(ghost_ids):,} ghost documents across {pages} page(s).")

    if not ghost_ids:
        print("Nothing to do.")
        return

    # Show a sample.
    sample = ghost_ids[:20]
    print(f"\nSample IDs (up to 20):")
    for gid in sample:
        print(f"  {gid}")
    if len(ghost_ids) > 20:
        print(f"  … and {len(ghost_ids) - 20} more")

    if args.dry_run:
        print("\nDry run complete. Re-run without --dry-run to delete.")
        return

    # Batch delete.
    print(f"\nDeleting in batches of {BATCH_SIZE}…")
    deleted = 0
    for i in range(0, len(ghost_ids), BATCH_SIZE):
        batch = ghost_ids[i : i + BATCH_SIZE]
        task = index.delete_documents(batch)
        client.wait_for_task(task.task_uid, timeout_in_ms=120_000)
        deleted += len(batch)
        print(f"  Deleted {deleted:,}/{len(ghost_ids):,}", flush=True)

    print(f"\nDone. Removed {deleted:,} ghost documents from '{args.index}'.")
    print("Note: orphaned Milvus vectors for these doc IDs are now unreachable")
    print("from search (no BM25 candidate → no join). They waste ~few MB of")
    print("RAM but are harmless. Run a Milvus collection compaction or recreate")
    print("if you want to reclaim the space.")


if __name__ == "__main__":
    main()
