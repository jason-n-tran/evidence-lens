"""Vector sub-scorer — Milvus + embedder gRPC (spec §5.5)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pymilvus import DataType, MilvusClient


@dataclass
class VectorHit:
    doc_id: str
    score: float
    payload: dict[str, Any]


def _ensure_collection(client: MilvusClient, collection: str, dim: int) -> None:
    """Create the collection + indexes if they don't exist, then load it."""
    if not client.has_collection(collection):
        schema = client.create_schema(auto_id=False, enable_dynamic_field=True)
        schema.add_field("doc_id", DataType.VARCHAR, is_primary=True, max_length=256)
        schema.add_field("embedding", DataType.FLOAT_VECTOR, dim=dim)
        schema.add_field("source", DataType.VARCHAR, is_partition_key=True, max_length=64)
        schema.add_field("study_type", DataType.VARCHAR, max_length=64)
        schema.add_field("published_year", DataType.INT32)
        schema.add_field("has_coi_authors", DataType.BOOL)
        schema.add_field("license", DataType.VARCHAR, max_length=64)

        idx = client.prepare_index_params()
        idx.add_index("embedding", metric_type="COSINE", index_type="HNSW",
                      params={"M": 32, "efConstruction": 200})
        idx.add_index("doc_id", index_type="INVERTED")
        idx.add_index("study_type", index_type="INVERTED")
        idx.add_index("published_year", index_type="STL_SORT")
        idx.add_index("has_coi_authors", index_type="INVERTED")
        idx.add_index("license", index_type="INVERTED")

        client.create_collection(collection, schema=schema, index_params=idx)

    client.load_collection(collection)


class VectorScorer:
    def __init__(
        self,
        uri: str,
        token: str = "",
        collection: str = "evidence_v1",
        dim: int = 1024,
    ) -> None:
        kwargs = {"token": token} if token else {}
        self.client = MilvusClient(uri=uri, **kwargs)
        self.collection = collection
        _ensure_collection(self.client, collection, dim)

    def search(
        self,
        query_vector: list[float],
        filters: dict | None = None,
        top_k: int = 200,
    ) -> list[VectorHit]:
        expr = self._build_filter(filters or {})
        results = self.client.search(
            collection_name=self.collection,
            data=[query_vector],
            anns_field="embedding",
            search_params={"metric_type": "COSINE", "params": {"ef": 200}},
            limit=top_k,
            filter=expr,
            output_fields=[
                "doc_id", "source", "study_type", "published_year",
                "has_coi_authors", "has_full_text", "journal_predatory", "license",
            ],
        )
        hits = []
        for r in (results[0] if results else []):
            # Milvus stores canonical IDs (pubmed:12345678); Meilisearch uses
            # underscore (pubmed_12345678). Normalize to underscore so BM25 and
            # vector hits deduplicate correctly on the same key. Replace ALL
            # colons: ids like hpo:HP:0000001 have two, and a single-colon
            # replace left "hpo_HP:0000001" -> %3A in document links.
            meili_id = r["entity"]["doc_id"].replace(":", "_")
            payload = {**r["entity"], "id": meili_id, "doc_id": meili_id}
            hits.append(VectorHit(doc_id=meili_id, score=float(r["distance"]), payload=payload))
        return hits

    @staticmethod
    def _build_filter(f: dict) -> str:
        parts: list[str] = []
        if f.get("study_types"):
            quoted = ", ".join(f'"{s}"' for s in f["study_types"])
            parts.append(f"study_type in [{quoted}]")
        if f.get("only_with_coi"):
            parts.append("has_coi_authors == true")
        if f.get("only_with_full_text"):
            parts.append("has_full_text == true")
        if f.get("exclude_predatory_journals"):
            parts.append("journal_predatory == false")
        if f.get("published_year_min"):
            parts.append(f"published_year >= {f['published_year_min']}")
        if f.get("published_year_max"):
            parts.append(f"published_year <= {f['published_year_max']}")
        return " and ".join(parts)
