"""Compare current eval to baseline; exit non-zero on >threshold regression."""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--baseline", required=True)
    p.add_argument("--current", required=True)
    p.add_argument("--threshold", type=float, default=0.01)
    a = p.parse_args()

    base = {q["id"]: q["ndcg_at_10"] for q in json.loads(open(a.baseline).read())["queries"]}
    cur = {q["id"]: q["ndcg_at_10"] for q in json.loads(open(a.current).read())["queries"]}

    regressions = []
    for qid, cur_score in cur.items():
        base_score = base.get(qid)
        if base_score is None:
            continue
        delta = cur_score - base_score
        if delta < -a.threshold:
            regressions.append({"id": qid, "baseline": base_score, "current": cur_score, "delta": round(delta, 4)})

    if regressions:
        print(json.dumps({"regressions": regressions}, indent=2))
        return 1
    print(json.dumps({"status": "ok", "queries": len(cur)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
