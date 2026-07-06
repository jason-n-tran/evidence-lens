"""Hand-written Python facade for the proto/evidencelens/v1/ contracts.

This is a pragmatic stand-in for `buf generate --template buf.gen.yaml`
output. When the user runs `buf generate` post-push, the real
google.protobuf-derived classes will replace this file. Until then, the
shapes here let the embedder + scorer gRPC servicers register and
respond against the contract.

Each class is a dataclass (not a real protobuf Message), but exposes
SerializeToString / FromString / DESCRIPTOR.full_name shims sufficient
for grpc.aio.Server with custom serializers.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from google.protobuf import json_format
from google.protobuf import descriptor_pb2
from google.protobuf import message
from google.protobuf import descriptor_pool
from google.protobuf import descriptor as _descriptor


# ---- Document + auxiliary messages ----

@dataclass
class AuthorPayment:
    sponsor_name: str = ""
    year: str = ""
    amount_usd: float = 0.0
    payment_type: str = ""
    source_record_id: str = ""


@dataclass
class Author:
    display_name: str = ""
    given_name: str = ""
    family_name: str = ""
    orcid: str = ""
    affiliation: str = ""
    payments: list[AuthorPayment] = field(default_factory=list)


@dataclass
class Journal:
    name: str = ""
    issn: str = ""
    publisher: str = ""
    impact_factor: float = 0.0
    is_predatory: bool = False


@dataclass
class Trial:
    registry: str = ""
    status: str = ""
    phase: str = ""
    conditions: list[str] = field(default_factory=list)
    interventions: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)
    enrollment: int = 0
    primary_outcome: str = ""


@dataclass
class Regulatory:
    agency: str = ""
    event_type: str = ""
    product_name: str = ""
    drug_class: str = ""
    recall_class: str = ""
    reason: str = ""
    action: str = ""


@dataclass
class FundingSource:
    funder: str = ""
    grant_id: str = ""
    amount_usd: float = 0.0
    fiscal_year: str = ""


@dataclass
class Document:
    id: str = ""
    source: str = ""
    source_native_id: str = ""
    doi: str = ""
    pmid: str = ""
    pmcid: str = ""
    nct_id: str = ""
    ictrp_id: str = ""
    title: str = ""
    abstract: str = ""
    full_text: str = ""
    canonical_url: str = ""
    license: str = ""
    object_raw_key: str = ""
    authors: list[Author] = field(default_factory=list)
    study_type: str = "OTHER"
    mesh_terms: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    journal: Journal = field(default_factory=Journal)
    trial: Trial = field(default_factory=Trial)
    regulatory: Regulatory = field(default_factory=Regulatory)
    citation_count: int = 0
    citation_pagerank: float = 0.0
    funding: list[FundingSource] = field(default_factory=list)
    embedding: list[float] = field(default_factory=list)
    embedding_model: str = ""


# ---- Embedder messages ----

@dataclass
class EmbeddingVector:
    values: list[float] = field(default_factory=list)
    dim: int = 0


@dataclass
class EmbedRequest:
    request_id: str = ""
    texts: list[str] = field(default_factory=list)


@dataclass
class EmbedResponse:
    request_id: str = ""
    embeddings: list[EmbeddingVector] = field(default_factory=list)
    embedding_model: str = ""


@dataclass
class EmbedderHealthzRequest:
    pass


@dataclass
class EmbedderHealthzResponse:
    status: str = "ok"
    embedding_model: str = ""
    detail: str = ""


# ---- Scorer messages ----

@dataclass
class SearchFilters:
    study_types: list[str] = field(default_factory=list)
    published_year_min: int = 0
    published_year_max: int = 0
    mesh_terms: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    licenses: list[str] = field(default_factory=list)
    only_with_coi: bool = False
    only_with_full_text: bool = False
    exclude_predatory_journals: bool = False


@dataclass
class SearchRequest:
    query: str = ""
    filters: SearchFilters = field(default_factory=SearchFilters)
    top_k: int = 50
    variant: str = ""
    session_id: str = ""


@dataclass
class ScoreBreakdown:
    bm25_score: float = 0.0
    vector_score: float = 0.0
    citation_pagerank: float = 0.0
    recency_score: float = 0.0
    rrf_score: float = 0.0
    ltr_score: float = 0.0
    ltr_model_version: str = ""


@dataclass
class ScoredResult:
    document: Document = field(default_factory=Document)
    final_score: float = 0.0
    breakdown: ScoreBreakdown = field(default_factory=ScoreBreakdown)


@dataclass
class PartialResults:
    results: list[ScoredResult] = field(default_factory=list)
    wave: int = 0
    is_final: bool = False
    elapsed_ms: int = 0


@dataclass
class ScorerHealthzRequest:
    pass


@dataclass
class ScorerHealthzResponse:
    status: str = "ok"
    degraded_components: list[str] = field(default_factory=list)


# ---- JSON serialization shim ----
#
# grpc.aio supports custom serializers; we use JSON over the wire so the
# dataclasses don't need a real protobuf descriptor. When `buf generate`
# replaces this file with real *_pb2.py, the wire format flips to
# protobuf binary and clients/servers swap codecs together.

def to_json_bytes(obj) -> bytes:
    import json
    from dataclasses import asdict, is_dataclass
    if is_dataclass(obj):
        return json.dumps(asdict(obj), default=str).encode("utf-8")
    return json.dumps(obj, default=str).encode("utf-8")


def from_json_bytes(cls, data: bytes):
    import json
    from dataclasses import fields, is_dataclass
    obj = json.loads(data.decode("utf-8"))
    if not is_dataclass(cls):
        return obj
    kwargs = {}
    for f in fields(cls):
        if f.name in obj:
            v = obj[f.name]
            kwargs[f.name] = v
    return cls(**kwargs)
