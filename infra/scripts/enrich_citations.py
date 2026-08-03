"""
Compute inbound citation counts and PageRank from the Neo4j citation graph,
then push the results back to Neo4j and Meilisearch so that "most_cited"
and "most_influential" sort modes return meaningful rankings.

Run this after every fresh ingest that includes PubMed (or any source that
produces CITES edges in Neo4j).

Dependencies:
    pip install neo4j meilisearch networkx
    (networkx is optional — falls back to in-degree if unavailable)

Usage:
    python enrich_citations.py [--dry-run]

    NEO4J_URL=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=changeme-dev-only \\
    MEILI_URL=http://localhost:7700 MEILI_KEY=masterKey \\
    python enrich_citations.py
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict

from neo4j import GraphDatabase
import meilisearch

NEO4J_URL      = os.getenv("NEO4J_URL",      "bolt://localhost:7687")
NEO4J_USER     = os.getenv("NEO4J_USER",     "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "changeme-dev-only")
MEILI_URL      = os.getenv("MEILI_URL",      "http://localhost:7700")
MEILI_KEY      = os.getenv("MEILI_KEY",      "")
INDEX_NAME     = os.getenv("MEILI_INDEX",    "documents")

MEILI_BATCH    = 500   # partial-update batch size
NEO4J_BATCH    = 500   # SET batch size


def compute_scores(driver) -> tuple[dict[str, tuple[int, float]], set[str]]:
    """
    Returns ({doc_id: (inbound_citation_count, pagerank_score)}, real_ids).

    `real_ids` is the subset of nodes that are actually-ingested documents
    (title AND source present). The citation graph also contains "ghost"
    nodes — bare :Document stubs the indexer MERGEs for every cited id that
    was never ingested (see index/pkg/batchers/neo4jb). Scores are computed
    over the FULL graph (ghosts are legitimate citation targets), but callers
    must only write scores back for `real_ids`: pushing a ghost id to
    Meilisearch would upsert a brand-new, content-less document.

    Step 1: pull all CITES edges.
    Step 2: compute in-degree counts.
    Step 3: compute PageRank (networkx if available, else normalised in-degree).
    """
    print("Fetching citation edges from Neo4j…")
    edges: list[tuple[str, str]] = []
    all_nodes: set[str] = set()
    real_ids: set[str] = set()

    with driver.session() as ses:
        res = ses.run(
            "MATCH (src:Document)-[:CITES]->(dst:Document) "
            "RETURN src.id AS src, dst.id AS dst"
        )
        for row in res:
            src, dst = row["src"], row["dst"]
            if src and dst:
                edges.append((src, dst))
                all_nodes.add(src)
                all_nodes.add(dst)

        # Collect all document IDs (so uncited docs get explicit zeros) and
        # track which are real (ingested) vs ghost stubs. A node is real only
        # if it has both a title and a source — the same predicate the
        # diagnostics use to detect ghosts.
        node_res = ses.run(
            "MATCH (d:Document) "
            "RETURN d.id AS id, d.title AS title, d.source AS source"
        )
        for row in node_res:
            nid = row["id"]
            if not nid:
                continue
            all_nodes.add(nid)
            if row["title"] is not None and row["source"] is not None:
                real_ids.add(nid)

    ghost_count = len(all_nodes) - len(real_ids)
    print(
        f"  {len(all_nodes):,} graph nodes "
        f"({len(real_ids):,} real, {ghost_count:,} ghost), "
        f"{len(edges):,} citation edges"
    )

    # In-degree counts (inbound citations).
    in_degree: dict[str, int] = defaultdict(int)
    for _, dst in edges:
        in_degree[dst] += 1

    # PageRank via networkx; falls back to numpy power iteration; then normalised in-degree.
    pagerank: dict[str, float] = {}
    try:
        import networkx as nx  # type: ignore[import]
        print("Computing PageRank with networkx…")
        G = nx.DiGraph()
        G.add_nodes_from(all_nodes)
        G.add_edges_from(edges)
        raw_pr = nx.pagerank(G, alpha=0.85, max_iter=200)
        max_pr = max(raw_pr.values()) if raw_pr else 1.0
        pagerank = {nid: v / max_pr for nid, v in raw_pr.items()}
        print(f"  PageRank computed for {len(pagerank):,} nodes")
    except ImportError:
        try:
            import numpy as np  # type: ignore[import]
            print("  networkx not available — computing PageRank via numpy power iteration…")
            node_list = list(all_nodes)
            node_idx = {n: i for i, n in enumerate(node_list)}
            N = len(node_list)
            alpha = 0.85

            out_deg = np.zeros(N, dtype=np.float64)
            for src, _ in edges:
                si = node_idx.get(src)
                if si is not None:
                    out_deg[si] += 1.0

            r_idx, c_idx, vals = [], [], []
            for src, dst in edges:
                si, di = node_idx.get(src), node_idx.get(dst)
                if si is not None and di is not None and out_deg[si] > 0:
                    r_idx.append(di)
                    c_idx.append(si)
                    vals.append(1.0 / out_deg[si])

            r_arr = np.array(r_idx, dtype=np.int32)
            c_arr = np.array(c_idx, dtype=np.int32)
            v_arr = np.array(vals, dtype=np.float64)
            dangling = (out_deg == 0)

            pr = np.ones(N, dtype=np.float64) / N
            for _ in range(100):
                dangling_sum = pr[dangling].sum()
                new_pr = np.zeros(N, dtype=np.float64)
                if len(r_arr):
                    np.add.at(new_pr, r_arr, alpha * pr[c_arr] * v_arr)
                new_pr += alpha * dangling_sum / N + (1.0 - alpha) / N
                total = new_pr.sum()
                pr = new_pr / total if total > 0 else new_pr

            max_pr = float(pr.max()) if pr.max() > 0 else 1.0
            pagerank = {node_list[i]: float(pr[i]) / max_pr for i in range(N)}
            print(f"  PageRank computed for {len(pagerank):,} nodes (numpy fallback)")
        except ImportError:
            print("  networkx and numpy not available — using normalised in-degree as PageRank proxy")
            max_deg = max(in_degree.values(), default=1)
            pagerank = {nid: in_degree.get(nid, 0) / max_deg for nid in all_nodes}

    scores = {
        nid: (in_degree.get(nid, 0), pagerank.get(nid, 0.0))
        for nid in all_nodes
    }
    return scores, real_ids


def update_neo4j(driver, scores: dict[str, tuple[int, float]], dry_run: bool) -> None:
    ids = list(scores.keys())
    print(f"\nUpdating Neo4j citation_count + pagerank for {len(ids):,} nodes…")
    if dry_run:
        print("  [dry run — skipped]")
        return

    updated = 0
    for i in range(0, len(ids), NEO4J_BATCH):
        batch_ids = ids[i : i + NEO4J_BATCH]
        params = [
            {"id": nid, "cnt": scores[nid][0], "pr": scores[nid][1]}
            for nid in batch_ids
        ]
        with driver.session() as ses:
            ses.run(
                # citation_count: never REDUCE an existing (upstream-provided)
                # count — sources like OpenAlex/S2 give a real, much larger count
                # at ingest time that our small in-corpus graph must not clobber.
                # Take the max. pagerank is graph-derived, so always set it.
                "UNWIND $rows AS row "
                "MATCH (d:Document {id: row.id}) "
                "SET d.citation_count = "
                "      CASE WHEN coalesce(d.citation_count, 0) > row.cnt "
                "           THEN d.citation_count ELSE row.cnt END, "
                "    d.pagerank = row.pr",
                rows=params,
            )
        updated += len(batch_ids)
        print(f"  Neo4j: {updated:,}/{len(ids):,}", end="\r", flush=True)
    print(f"  Neo4j: {updated:,}/{len(ids):,} done")
