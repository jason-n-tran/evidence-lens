"""S3-compatible client for fetching raw archives from MinIO."""
from __future__ import annotations

import gzip

import boto3
from botocore.config import Config as BotoConfig


class ObjectStore:
    def __init__(self, endpoint: str, access_key: str, secret_key: str, bucket: str) -> None:
        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="auto",
            config=BotoConfig(signature_version="s3v4"),
        )

    def get(self, key: str) -> bytes:
        """Download and gunzip an object stored by an ingester."""
        obj = self._client.get_object(Bucket=self.bucket, Key=key)
        body = obj["Body"].read()
        # Ingesters write gzipped content; tolerate non-gzipped just in case.
        try:
            return gzip.decompress(body)
        except OSError:
            return body
