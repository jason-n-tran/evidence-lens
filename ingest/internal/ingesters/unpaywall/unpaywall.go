// Package unpaywall resolves a DOI to free OA-location metadata via
// api.unpaywall.org/v2/{doi}?email=... (spec §5.1.8).
//
// Per-DOI enrichment (like Crossref): single-DOI mode via UNPAYWALL_DOI, or
// batch-drain of unpaywall_enrich_queue (DOIs the processor flagged). The full
// upstream JSON is archived verbatim for the processor's unpaywall parser.
package unpaywall

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

type Config struct{ Email string }

type Ingester struct {
	cfg      Config
	logger   *slog.Logger
	wm       *watermark.Store
	archiver *objectstore.Archiver
	pub      *natspub.Publisher
	fetcher  *ingestcommon.Fetcher
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	return &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(5, 10, "EvidenceLens-Unpaywall/0.1 (mailto:"+cfg.Email+")"),
	}
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	_ = i.wm.MarkRunning(ctx, "unpaywall")
	if doi := os.Getenv("UNPAYWALL_DOI"); doi != "" {
		return i.enrichOne(ctx, doi)
	}
	// Batch/queue mode is processor-driven and not yet populated; no-op cleanly.
	i.logger.Info("unpaywall: no UNPAYWALL_DOI set; nothing to do this run")
	return ingestcommon.RunResult{}, nil
}

func (i *Ingester) enrichOne(ctx context.Context, doi string) (ingestcommon.RunResult, error) {
	api := fmt.Sprintf("https://api.unpaywall.org/v2/%s?email=%s",
		url.PathEscape(doi), url.QueryEscape(i.cfg.Email))
	body, err := i.fetcher.Get(ctx, api, nil)
	if err != nil {
		return ingestcommon.RunResult{}, err
	}
	id := "doi:" + doi
	// Archive the upstream JSON verbatim.
	key, err := i.archiver.Put(ctx, "unpaywall", id, json.RawMessage(body))
	if err != nil {
		return ingestcommon.RunResult{}, err
	}
	if _, err := i.pub.PublishRaw(ctx, "unpaywall", id, key); err != nil {
		return ingestcommon.RunResult{}, err
	}
	return ingestcommon.RunResult{DocsFetched: 1, DocsArchived: 1, DocsPublished: 1}, nil
}
