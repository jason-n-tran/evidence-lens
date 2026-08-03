"""
Nightly nDCG@10 ranking eval against staging.

Reads queries.jsonl, runs each query through the gateway, computes
nDCG@10 against the `relevant_pmids` ground truth, and writes
`latest.json` for compare.py to threshold against `baseline.json`.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import httpx


GATEWAY = os.getenv("GATEWAY_URL", "http://localhost:8080")
HERE = Path(__file__).parent


def dcg(rels: list[float]) -> float:
    return sum(r / math.log2(i + 2) for i, r in enumerate(rels))


def ndcg_at(retrieved_pmids: list[str], relevant_pmids: list[str], k: int = 10) -> float:
    rel_set = set(relevant_pmids)
    rels = [1.0 if p in rel_set else 0.0 for p in retrieved_pmids[:k]]
    ideal = [1.0] * min(len(rel_set), k)
    if not ideal:
        return 0.0
    return dcg(rels) / dcg(ideal)


def main() -> int:
    queries = [json.loads(l) for l in (HERE / "queries.jsonl").read_text().splitlines() if l.strip()]
    results = []
    fail = False
    with httpx.Client(timeout=10.0) as client:
        for q in queries:
            r = client.get(f"{GATEWAY}/api/search", params={"q": q["query"], "top_k": 10})
            if r.status_code != 200:
                results.append({"id": q["id"], "ndcg_at_10": 0.0, "error": f"http {r.status_code}"})
                fail = True
                continue
            hits = r.json().get("results", [])
            pmids = [h["document"].get("pmid", "") for h in hits if h.get("document")]
            score = ndcg_at(pmids, q["relevant_pmids"])
            ok = score >= q["min_ndcg"]
            if not ok:
                fail = True
            results.append({"id": q["id"], "ndcg_at_10": round(score, 4), "min_required": q["min_ndcg"], "ok": ok})

    out = HERE / "latest.json"
    out.write_text(json.dumps({"queries": results}, indent=2))
    print(json.dumps({"queries": results}, indent=2))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
