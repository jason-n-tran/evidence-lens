import boto3
import os
from botocore.config import Config as BotoConfig

def list_corrupted_files():
    endpoint = os.getenv("S3_ENDPOINT")
    access_key = os.getenv("S3_ACCESS_KEY_ID")
    secret_key = os.getenv("S3_SECRET_ACCESS_KEY")
    bucket = os.getenv("S3_BUCKET")
    
    print(f"Connecting to {endpoint} bucket {bucket}")

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )

    paginator = client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix='raw/pubmed/'):
        for obj in page.get('Contents', []):
            print(obj['Key'])

if __name__ == "__main__":
    list_corrupted_files()
