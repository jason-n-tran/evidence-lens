"""gRPC service stub for EmbedderService.

Hand-written transitional shim. Uses JSON wire format via custom grpc
serializers so it works without `buf generate` having run. When the
real codegen lands, this file is replaced by `embedder_pb2_grpc.py`
with identical class names; the embedder/main.py import keeps working.
"""
from __future__ import annotations

from typing import AsyncIterator

import grpc

from . import (
    EmbedRequest, EmbedResponse,
    EmbedderHealthzRequest, EmbedderHealthzResponse,
    to_json_bytes, from_json_bytes,
)


def _request_deserializer(cls):
    return lambda data: from_json_bytes(cls, data)


def _response_serializer(_cls):
    return to_json_bytes


class EmbedderServiceServicer:
    """Override these methods in your subclass."""

    async def Embed(self, request_iterator: AsyncIterator[EmbedRequest], context) -> AsyncIterator[EmbedResponse]:
        raise NotImplementedError

    async def EmbedOnce(self, request: EmbedRequest, context) -> EmbedResponse:
        raise NotImplementedError

    async def Healthz(self, request: EmbedderHealthzRequest, context) -> EmbedderHealthzResponse:
        return EmbedderHealthzResponse(status="ok")


def add_EmbedderServiceServicer_to_server(servicer: EmbedderServiceServicer, server: grpc.aio.Server) -> None:
    handlers = {
        "Embed": grpc.stream_stream_rpc_method_handler(
            servicer.Embed,
            request_deserializer=_request_deserializer(EmbedRequest),
            response_serializer=_response_serializer(EmbedResponse),
        ),
        "EmbedOnce": grpc.unary_unary_rpc_method_handler(
            servicer.EmbedOnce,
            request_deserializer=_request_deserializer(EmbedRequest),
            response_serializer=_response_serializer(EmbedResponse),
        ),
        "Healthz": grpc.unary_unary_rpc_method_handler(
            servicer.Healthz,
            request_deserializer=_request_deserializer(EmbedderHealthzRequest),
            response_serializer=_response_serializer(EmbedderHealthzResponse),
        ),
    }
    generic_handler = grpc.method_handlers_generic_handler(
        "evidencelens.v1.EmbedderService", handlers
    )
    server.add_generic_rpc_handlers((generic_handler,))


class EmbedderServiceStub:
    """Client stub. Use with grpc.aio.insecure_channel(target)."""
    def __init__(self, channel: grpc.aio.Channel) -> None:
        self.Embed = channel.stream_stream(
            "/evidencelens.v1.EmbedderService/Embed",
            request_serializer=to_json_bytes,
            response_deserializer=_request_deserializer(EmbedResponse),
        )
        self.EmbedOnce = channel.unary_unary(
            "/evidencelens.v1.EmbedderService/EmbedOnce",
            request_serializer=to_json_bytes,
            response_deserializer=_request_deserializer(EmbedResponse),
        )
        self.Healthz = channel.unary_unary(
            "/evidencelens.v1.EmbedderService/Healthz",
            request_serializer=to_json_bytes,
            response_deserializer=_request_deserializer(EmbedderHealthzResponse),
        )
