#!/usr/bin/env bash
# One-time setup against an existing MinIO instance (e.g. TrueNAS Scale).
# Creates the two buckets EvidenceLens needs and applies anonymous read +
# CORS on the webllm bucket so browsers can stream model shards directly.
#
# Requires the `mc` MinIO client: https://min.io/docs/minio/linux/reference/minio-mc.html
# Reads S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY from env (or infra/.env).

set -euo pipefail

if [[ -f "$(dirname "$0")/../.env" ]]; then
  set -a; . "$(dirname "$0")/../.env"; set +a
fi

: "${S3_ENDPOINT:?set S3_ENDPOINT (e.g. http://truenas.lan:9000)}"
: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY}"
: "${S3_BUCKET:=evidencelens-raw}"
: "${S3_BUCKET_WEBLLM:=evidencelens-webllm}"

mc alias set evidencelens "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"

mc mb --ignore-existing "evidencelens/$S3_BUCKET"
mc mb --ignore-existing "evidencelens/$S3_BUCKET_WEBLLM"

mc anonymous set download "evidencelens/$S3_BUCKET_WEBLLM"

cors_json="$(mktemp)"
cat > "$cors_json" <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["range"],
      "ExposeHeaders": ["content-length", "content-range", "etag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
JSON
mc cors set "$cors_json" "evidencelens/$S3_BUCKET_WEBLLM"
rm -f "$cors_json"

echo "minio-bootstrap: done"
echo "  raw bucket:    $S3_BUCKET    (private)"
echo "  webllm bucket: $S3_BUCKET_WEBLLM    (anonymous read + CORS)"
