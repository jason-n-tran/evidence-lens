"""Citation sub-scorer — Neo4j PageRank-biased reranker (spec §5.5).

Takes the union of BM25+vector top 500 and biases by precomputed
pagerank from the offline `scheduled-pagerank.yml` job.
"""
from __future__ import annotations

from dataclasses import dataclass

from neo4j import GraphDatabase


@dataclass
class CitationScore:
    doc_id: str
    pagerank: float


class CitationScorer:
    def __init__(self, url: str, user: str, password: str) -> None:
        self.driver = GraphDatabase.driver(url, auth=(user, password))

    def score(self, doc_ids: list[str]) -> list[CitationScore]:
        if not doc_ids:
            return []
        with self.driver.session() as ses:
            recs = ses.run(
                "MATCH (d:Document) WHERE d.id IN $ids RETURN d.id AS id, coalesce(d.pagerank, 0.0) AS pr",
                ids=doc_ids,
            )
            return [CitationScore(r["id"], float(r["pr"])) for r in recs]

    def close(self) -> None:
        self.driver.close()
