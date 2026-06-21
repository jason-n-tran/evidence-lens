// Package objectstore archives raw upstream responses to an S3-compatible
// object store (self-hosted MinIO) at `raw/{source}/{YYYY-MM-DD}/{id}.json.gz`.
// Used by every ingester so re-processing doesn't require re-fetching from
// upstream.
package objectstore

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Archiver wraps an S3-compatible client (MinIO).
type Archiver struct {
	client *s3.Client
	bucket string
}

// New constructs an Archiver from S3-compatible credentials. endpoint is
// the MinIO base URL (e.g. http://minio:9000).
func New(accessKey, secretKey, bucket, endpoint string) (*Archiver, error) {
	cfg := aws.Config{
		Region:      "auto",
		Credentials: credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = true
	})
	return &Archiver{client: client, bucket: bucket}, nil
}

// Key returns the canonical object key for a given source and id.
func Key(source, id string) string {
	return fmt.Sprintf("raw/%s/%s/%s.json.gz", source, time.Now().UTC().Format("2006-01-02"), id)
}

// Put uploads gzipped data and returns the object key written.
func (a *Archiver) Put(ctx context.Context, source, id string, data []byte) (string, error) {
	key := Key(source, id)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(data); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	_, err := a.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:          aws.String(a.bucket),
		Key:             aws.String(key),
		Body:            bytes.NewReader(buf.Bytes()),
		ContentType:     aws.String("application/json"),
		ContentEncoding: aws.String("gzip"),
	})
	if err != nil {
		return "", fmt.Errorf("objectstore put %s: %w", key, err)
	}
	return key, nil
}

// Get downloads and decompresses an object.
func (a *Archiver) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := a.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(a.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()

	gz, err := gzip.NewReader(obj.Body)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	return io.ReadAll(gz)
}
