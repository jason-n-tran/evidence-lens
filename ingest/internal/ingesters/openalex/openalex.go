// Package openalex ingests OpenAlex works + emits citation edges
// (spec §5.1.6).
//
// Two paths:
//   - Bulk snapshot via S3 stream-process (no disk staging) for first run.
//   - Per-doc REST updates via api.openalex.org/works for daily delta.
//
// Citation edges (citing_doc_id, cited_doc_id) emit to a separate
// Pub/Sub topic citation-edges for the indexer's Neo4j batcher.
package openalex

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

const (
	openalexBucket = "openalex"
	openalexPrefix = "data/works/"
)

type Config struct {
	MaxPerRun int
	UseBulk   bool // true = S3 bulk; false = REST delta
}

type Ingester struct {
	cfg          Config
	logger       *slog.Logger
	wm           *watermark.Store
	archiver     *objectstore.Archiver
	pub          *natspub.Publisher
	citationsPub *natspub.Publisher
	fetcher      *ingestcommon.Fetcher
	s3           *s3.Client
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub, citationsPub *natspub.Publisher) *Ingester {
	awsCfg, err := config.LoadDefaultConfig(context.Background(), config.WithRegion("us-east-1"))
	if err != nil {
		logger.Warn("openalex: aws config", "err", err)
	}
	s3c := s3.NewFromConfig(awsCfg)
	return &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub, citationsPub: citationsPub,
		fetcher: ingestcommon.NewFetcher(10, 20, "EvidenceLens-OpenAlex/0.1 (mailto:contact@example.com)"),
		s3:      s3c,
	}
}

// openalexWork — subset of the OpenAlex schema we map into the canonical
// Document. Full schema is huge; we keep only what the processor needs.
type openalexWork struct {
	ID              string   `json:"id"`
	DOI             string   `json:"doi"`
	Title           string   `json:"display_name"`
	PublicationDate string   `json:"publication_date"` // ISO YYYY-MM-DD (for backfill march)
	PublicationYear int      `json:"publication_year"`
	CitedByCount    int64    `json:"cited_by_count"`
	ReferencedWorks []string `json:"referenced_works"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "openalex"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	if i.cfg.UseBulk {
		return i.runBulk(ctx)
	}
	return i.runREST(ctx)
}

// runBulk streams .gz JSONL files directly from the public openalex S3
// bucket WITHOUT disk staging (per spec §19.4 risk mitigation).
func (i *Ingester) runBulk(ctx context.Context) (ingestcommon.RunResult, error) {
	hwm, _ := i.wm.Get(ctx, "openalex")
	var counters ingestcommon.Counters

	pager := s3.NewListObjectsV2Paginator(i.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(openalexBucket),
		Prefix: aws.String(openalexPrefix),
	})
	for pager.HasMorePages() && int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return ingestcommon.RunResult{}, fmt.Errorf("list bulk: %w", err)
		}
		for _, obj := range page.Contents {
			key := aws.ToString(obj.Key)
			if hwm != "" && key <= hwm {
				continue
			}
			if err := i.streamPart(ctx, key, &counters); err != nil {
				i.logger.Warn("part failed", "key", key, "err", err)
			}
			hwm = key
			if int(counters.Fetched.Load()) >= i.cfg.MaxPerRun {
				break
			}
		}
	}
	_ = i.wm.Set(ctx, "openalex", hwm, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
		HighWatermark: hwm,
	}, nil
}

func (i *Ingester) streamPart(ctx context.Context, key string, c *ingestcommon.Counters) error {
	resp, err := i.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(openalexBucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	defer gz.Close()

	scanner := bufio.NewScanner(gz)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		c.Fetched.Add(1)
		var w openalexWork
		line := scanner.Bytes()
		if err := json.Unmarshal(line, &w); err != nil {
			c.Failed.Add(1)
			continue
		}
		i.publishWork(ctx, &w, line, c)
		if int(c.Fetched.Load()) >= i.cfg.MaxPerRun {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return scanner.Err()
}
