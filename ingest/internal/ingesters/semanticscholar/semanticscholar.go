// Package semanticscholar ingests papers from the Semantic Scholar Graph API
// bulk search endpoint (api.semanticscholar.org/graph/v1/paper/search/bulk).
//
// An API key (SEMANTIC_SCHOLAR_API_KEY, sent as x-api-key) raises the rate
// limit; the endpoint also works unauthenticated but is aggressively throttled.
// Pagination is via the continuation `token`.
package semanticscholar

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

const fields = "title,abstract,year,publicationDate,authors,externalIds," +
	"journal,citationCount,referenceCount,publicationTypes,openAccessPdf"

type Config struct {
	MaxPerRun int
	Query     string
}

type Ingester struct {
	cfg      Config
	logger   *slog.Logger
	wm       *watermark.Store
	archiver *objectstore.Archiver
	pub      *natspub.Publisher
	fetcher  *ingestcommon.Fetcher
	apiKey   string
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	return &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(1, 2, "EvidenceLens-S2/0.1 (mailto:contact@example.com)"),
		apiKey:  os.Getenv("SEMANTIC_SCHOLAR_API_KEY"),
	}
}

type bulkResp struct {
	Total int               `json:"total"`
	Token string            `json:"token"`
	Data  []json.RawMessage `json:"data"`
}

type paperMeta struct {
	PaperID string `json:"paperId"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "semanticscholar"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	query := i.cfg.Query
	if query == "" {
		query = "medicine"
	}
	var counters ingestcommon.Counters
	headers := map[string]string{}
	if i.apiKey != "" {
		headers["x-api-key"] = i.apiKey
	}

	token := ""
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		u := "https://api.semanticscholar.org/graph/v1/paper/search/bulk?query=" +
			url.QueryEscape(query) + "&fields=" + url.QueryEscape(fields)
		if token != "" {
			u += "&token=" + url.QueryEscape(token)
		}
		body, err := i.fetcher.Get(ctx, u, headers)
		if err != nil {
			// A bad/inactive API key returns 403 where keyless returns 200.
			// Fall back to keyless mode (slower, rate-limited) so the run still
			// succeeds instead of failing outright on a key problem.
			if len(headers) > 0 && strings.Contains(err.Error(), "403") {
				i.logger.Warn("s2 403 with api key; retrying keyless", "err", err)
				headers = map[string]string{}
				body, err = i.fetcher.Get(ctx, u, headers)
			}
			if err != nil {
				i.logger.Error("s2 fetch failed", "err", err)
				_ = i.wm.Set(ctx, "semanticscholar", "", "failed", err.Error())
				return i.result(counters), err
			}
		}
		var resp bulkResp
		if err := json.Unmarshal(body, &resp); err != nil {
			i.logger.Error("s2 decode failed", "err", err)
			_ = i.wm.Set(ctx, "semanticscholar", "", "failed", "decode: "+err.Error())
			return i.result(counters), err
		}
		if len(resp.Data) == 0 {
			break
		}
		for _, raw := range resp.Data {
			counters.Fetched.Add(1)
			var meta paperMeta
			if err := json.Unmarshal(raw, &meta); err != nil || meta.PaperID == "" {
				counters.Failed.Add(1)
				continue
			}
			docID := "semanticscholar:" + meta.PaperID
			key, err := i.archiver.Put(ctx, "semanticscholar", docID, raw)
			if err != nil {
				counters.Failed.Add(1)
				continue
			}
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "semanticscholar", docID, key); err == nil {
				counters.Published.Add(1)
			}
		}
		if resp.Token == "" {
			break
		}
		token = resp.Token
	}

	_ = i.wm.Set(ctx, "semanticscholar", time.Now().UTC().Format("2006-01-02"), "idle", "")
	return i.result(counters), nil
}

func (i *Ingester) result(c ingestcommon.Counters) ingestcommon.RunResult {
	return ingestcommon.RunResult{
		DocsFetched:   c.Fetched.Load(),
		DocsArchived:  c.Archived.Load(),
		DocsPublished: c.Published.Load(),
		HighWatermark: fmt.Sprintf("%d", time.Now().Year()),
	}
}
