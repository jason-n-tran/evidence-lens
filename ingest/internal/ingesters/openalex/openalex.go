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

// runREST fetches works via the REST API, filtered by publication date.
//
// NOTE: from_updated_date / from_created_date are paywalled (HTTP 429 "Plan
// upgrade required") on the free tier. from_publication_date is free. The
// tradeoff is that we filter by publication date, not update date, so edits to
// older works are not picked up — acceptable for a free, self-hosted deployment.
func (i *Ingester) runREST(ctx context.Context) (ingestcommon.RunResult, error) {
	hwm, _ := i.wm.Get(ctx, "openalex")
	if hwm == "" {
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			hwm = time.Now().AddDate(0, 0, -2).Format("2006-01-02")
		}
	}
	var counters ingestcommon.Counters
	latestSeen := "" // max publication_date this run (ISO sorts chronologically)

	cursor := "*"
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		q := url.Values{}
		// type:article excludes non-article entities (e.g. type "paratext" —
		// journal front-matter/descriptions — which otherwise show up with a
		// journal name as the title and no real article content).
		q.Set("filter", "from_publication_date:"+hwm+",type:article")
		q.Set("per-page", "200")
		q.Set("cursor", cursor)
		// referenced_works is omitted from the default response (citations would
		// be empty); an explicit select pulls it back (verified free). The list
		// must include every field the processor's openalex parser reads.
		q.Set("select", "id,ids,doi,display_name,type,publication_date,publication_year,"+
			"authorships,abstract_inverted_index,referenced_works,cited_by_count,"+
			"primary_location,open_access,concepts")
		body, err := i.fetcher.Get(ctx, "https://api.openalex.org/works?"+q.Encode(), nil)
		if err != nil {
			// Do NOT advance the watermark on a failed fetch: record the error
			// and return it so ingestion_state shows status=failed. The previous
			// code swallowed errors and still wrote today's watermark, which
			// silently poisoned every subsequent run's window.
			i.logger.Error("openalex REST fetch failed", "err", err, "hwm", hwm)
			_ = i.wm.Set(ctx, "openalex", hwm, "failed", err.Error())
			return ingestcommon.RunResult{
				DocsFetched:   counters.Fetched.Load(),
				DocsArchived:  counters.Archived.Load(),
				DocsPublished: counters.Published.Load(),
				HighWatermark: hwm,
			}, err
		}
		// Decode results as raw JSON so the FULL upstream work (abstract_inverted_index,
		// authorships, publication_date, etc.) is archived verbatim. Decoding straight
		// into openalexWork and re-marshaling would strip every field not in that
		// struct, leaving the parser almost nothing (same class of bug as the old
		// preprint ingester).
		var resp struct {
			Results []json.RawMessage `json:"results"`
			Meta    struct {
				NextCursor string `json:"next_cursor"`
			} `json:"meta"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			i.logger.Error("openalex REST decode failed", "err", err)
			_ = i.wm.Set(ctx, "openalex", hwm, "failed", "decode: "+err.Error())
			return ingestcommon.RunResult{
				DocsFetched:   counters.Fetched.Load(),
				DocsArchived:  counters.Archived.Load(),
				DocsPublished: counters.Published.Load(),
				HighWatermark: hwm,
			}, err
		}
		if len(resp.Results) == 0 {
			break
		}
		for _, raw := range resp.Results {
			counters.Fetched.Add(1)
			var w openalexWork
			if err := json.Unmarshal(raw, &w); err != nil {
				counters.Failed.Add(1)
				continue
			}
			if w.PublicationDate != "" {
				latestSeen = ingestcommon.MaxDate(latestSeen, w.PublicationDate)
			}
			i.publishWork(ctx, &w, raw, &counters)
		}
		if resp.Meta.NextCursor == "" {
			break
		}
		cursor = resp.Meta.NextCursor
	}

	// Empty -> keep; backfill + hit cap -> resume at latest pub date; else today.
	newHWM := ingestcommon.NextWatermark(hwm, time.Now().Format("2006-01-02"),
		int(counters.Fetched.Load()), i.cfg.MaxPerRun, latestSeen)
	_ = i.wm.Set(ctx, "openalex", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
		HighWatermark: newHWM,
	}, nil
}

func (i *Ingester) publishWork(ctx context.Context, w *openalexWork, raw []byte, c *ingestcommon.Counters) {
	id := openalexShortID(w.ID)
	if id == "" {
		c.Failed.Add(1)
		return
	}
	docID := "openalex:" + id

	key, err := i.archiver.Put(ctx, "openalex", docID, raw)
	if err != nil {
		c.Failed.Add(1)
		return
	}
	c.Archived.Add(1)

	if _, err := i.pub.PublishRaw(ctx, "openalex", docID, key); err == nil {
		c.Published.Add(1)
	}

	if i.citationsPub != nil {
		for _, cited := range w.ReferencedWorks {
			cidShort := openalexShortID(cited)
			if cidShort == "" {
				continue
			}
			edgeKey := fmt.Sprintf("edge:%s:%s", id, cidShort)
			_, _ = i.citationsPub.PublishRaw(ctx, "openalex", edgeKey, "")
		}
	}
}

// openalexShortID strips the URL prefix to yield "W12345678".
func openalexShortID(s string) string {
	if s == "" {
		return ""
	}
	idx := strings.LastIndex(s, "/")
	if idx < 0 {
		return s
	}
	return s[idx+1:]
}
