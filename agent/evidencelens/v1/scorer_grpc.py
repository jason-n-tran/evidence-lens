"""gRPC service stub for ScorerService. Same hand-written transitional
shim as embedder_grpc.py."""
from __future__ import annotations

from typing import AsyncIterator

import grpc

from . import (
    SearchRequest, PartialResults,
    ScorerHealthzRequest, ScorerHealthzResponse,
    to_json_bytes, from_json_bytes,
)


def _req_de(cls):
    return lambda data: from_json_bytes(cls, data)


class ScorerServiceServicer:
    async def Search(self, request: SearchRequest, context) -> AsyncIterator[PartialResults]:
        raise NotImplementedError

    async def Healthz(self, request: ScorerHealthzRequest, context) -> ScorerHealthzResponse:
        return ScorerHealthzResponse(status="ok")


def add_ScorerServiceServicer_to_server(servicer: ScorerServiceServicer, server: grpc.aio.Server) -> None:
    handlers = {
        "Search": grpc.unary_stream_rpc_method_handler(
            servicer.Search,
            request_deserializer=_req_de(SearchRequest),
            response_serializer=to_json_bytes,
        ),
        "Healthz": grpc.unary_unary_rpc_method_handler(
            servicer.Healthz,
            request_deserializer=_req_de(ScorerHealthzRequest),
            response_serializer=to_json_bytes,
        ),
    }
    generic_handler = grpc.method_handlers_generic_handler(
        "evidencelens.v1.ScorerService", handlers
    )
    server.add_generic_rpc_handlers((generic_handler,))


class ScorerServiceStub:
    def __init__(self, channel: grpc.aio.Channel) -> None:
        self.Search = channel.unary_stream(
            "/evidencelens.v1.ScorerService/Search",
            request_serializer=to_json_bytes,
            response_deserializer=_req_de(PartialResults),
        )
        self.Healthz = channel.unary_unary(
            "/evidencelens.v1.ScorerService/Healthz",
            request_serializer=to_json_bytes,
            response_deserializer=_req_de(ScorerHealthzResponse),
        )
