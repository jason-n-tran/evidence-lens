"""Train XGBoost LambdaMART on click data; emit ltr_v{date}.json.

Feature extraction matches scorer/ltr.py:featurize() so the trained
model is drop-in compatible with the LTRReranker at runtime. Input
parquet is expected to come from scorer/scripts/pull_clicks.py joined
with per-document features (BM25 score, vector score, pagerank, etc.)
materialized in BigQuery analytics.click_features.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import pandas as pd
import xgboost as xgb

# Match the order in scorer/ltr.py:featurize() exactly.
NUMERIC_FEATURES = ["bm25", "vector", "pagerank_log", "recency"]
STUDY_TYPES = ["RCT", "META_ANALYSIS", "SYSTEMATIC_REVIEW", "OBSERVATIONAL", "OTHER"]
BOOL_FEATURES = ["has_full_text", "log1p_citation_count", "has_coi_authors", "journal_predatory"]
QUERY_FEATURES = ["query_length_tokens", "query_has_drug_entity"]

ALL_FEATURES = (
    NUMERIC_FEATURES
    + [f"study_type_{s}" for s in STUDY_TYPES]
    + BOOL_FEATURES
    + QUERY_FEATURES
)


def featurize_row(row) -> list[float]:
    """Mirrors scorer/ltr.py:featurize()."""
    pr = max(0.0, float(row.get("pagerank", 0.0)))
    cc = max(0, int(row.get("citation_count", 0)))
    study = str(row.get("study_type", "OTHER"))
    onehots = [1.0 if study == s else 0.0 for s in STUDY_TYPES]
    return [
        float(row.get("bm25", 0.0)),
        float(row.get("vector", 0.0)),
        math.log1p(pr),
        float(row.get("recency", 0.0)),
        *onehots,
        1.0 if row.get("has_full_text") else 0.0,
        math.log1p(cc),
        1.0 if row.get("has_coi_authors") else 0.0,
        1.0 if row.get("journal_predatory") else 0.0,
        float(row.get("query_length_tokens", 1)),
        1.0 if row.get("query_has_drug_entity") else 0.0,
    ]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--rounds", type=int, default=300)
    p.add_argument("--max-depth", type=int, default=6)
    p.add_argument("--eta", type=float, default=0.1)
    args = p.parse_args()

    df = pd.read_parquet(args.inp)
    if df.empty:
        print("no clicks; skipping train", file=sys.stderr)
        sys.exit(0)

    # Group by query_id for pairwise / lambdaMART grouping.
    df = df.sort_values(["query_id"])
    groups = df.groupby("query_id").size().to_list()

    # Label: clicked (1) vs not-clicked (0). Click position can be used
    # as a graded relevance label: lower position = higher relevance.
    df["label"] = df["clicked_position"].apply(lambda p: max(0, 10 - int(p)))

    feats = df.apply(featurize_row, axis=1, result_type="expand")
    feats.columns = ALL_FEATURES

    dmat = xgb.DMatrix(feats.values, label=df["label"].values)
    dmat.set_group(groups)

    booster = xgb.train(
        {
            "objective": "rank:ndcg",
            "eval_metric": "ndcg@10",
            "eta": args.eta,
            "max_depth": args.max_depth,
            "min_child_weight": 1,
            "lambda": 1.0,
            "alpha": 0.0,
        },
        dmat,
        num_boost_round=args.rounds,
        evals=[(dmat, "train")],
        verbose_eval=50,
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(out_path))

    feature_names_path = out_path.with_suffix(".features.json")
    feature_names_path.write_text(__import__("json").dumps(ALL_FEATURES))
    print(f"saved {out_path} ({len(ALL_FEATURES)} features, {args.rounds} rounds)")


if __name__ == "__main__":
    main()
