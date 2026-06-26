// Package preprint ingests bioRxiv + medRxiv via the bioRxiv API
// (spec §5.1.2). Both servers share the same schema; one ingester serves
// both via the Servers config.
//
// Endpoint: api.biorxiv.org/details/{server}/{from-date}/{to-date}/{cursor}
// Watermark: ISO date of last successful fetch.
package preprint

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

type Config struct {
	Servers   []string // ["biorxiv", "medrxiv"]
	MaxPerRun int
}

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
		cfg:      cfg,
		logger:   logger,
		wm:       wm,
		archiver: arch,
		pub:      pub,
		fetcher:  ingestcommon.NewFetcher(5, 10, "EvidenceLens-preprint/0.1 (mailto:contact@example.com)"),
	}
}

// Collection items are kept as raw JSON so the full upstream record (abstract,
// authors, category, license, etc.) is archived verbatim — matching how the
// fda/trials ingesters archive. A narrow struct here would silently drop every
// field it didn't declare, leaving the processor's parser nothing to read.
type detailsResponse struct {
	Collection []json.RawMessage `json:"collection"`
}

// preprintMeta pulls just the fields needed to build the doc id from each
// archived record; the full json.RawMessage is what gets stored.
type preprintMeta struct {
	DOI  string `json:"doi"`
	Date string `json:"date"` // ISO YYYY-MM-DD (for backfill march)
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "preprint"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	hwm, _ := i.wm.Get(ctx, "preprint")
	if hwm == "" {
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			hwm = time.Now().AddDate(0, 0, -3).Format("2006-01-02")
		}
	}
	to := time.Now().Format("2006-01-02")
	var counters ingestcommon.Counters
	latestSeen := "" // max item date this run (ISO sorts chronologically)

	for _, server := range i.cfg.Servers {
		cursor := 0
		for {
			if int(counters.Fetched.Load()) >= i.cfg.MaxPerRun {
				break
			}
			url := fmt.Sprintf("https://api.biorxiv.org/details/%s/%s/%s/%d", server, hwm, to, cursor)
			body, err := i.fetcher.Get(ctx, url, nil)
			if err != nil {
				i.logger.Warn("preprint fetch", "server", server, "err", err)
				break
			}
			var resp detailsResponse
			if err := json.Unmarshal(body, &resp); err != nil {
				break
			}
			if len(resp.Collection) == 0 {
				break
			}
			for _, item := range resp.Collection {
				counters.Fetched.Add(1)
				var meta preprintMeta
				if err := json.Unmarshal(item, &meta); err != nil || meta.DOI == "" {
					counters.Failed.Add(1)
					continue
				}
				if meta.Date != "" {
					latestSeen = ingestcommon.MaxDate(latestSeen, meta.Date)
				}
				docID := fmt.Sprintf("%s:%s", server, meta.DOI)
				// Archive the full upstream record verbatim.
				key, err := i.archiver.Put(ctx, server, docID, item)
				if err != nil {
					counters.Failed.Add(1)
					continue
				}
				counters.Archived.Add(1)
				if _, err := i.pub.PublishRaw(ctx, server, docID, key); err == nil {
					counters.Published.Add(1)
				}
			}
			cursor += len(resp.Collection)
		}
	}

	newHWM := ingestcommon.NextWatermark(hwm, to, int(counters.Fetched.Load()), i.cfg.MaxPerRun, latestSeen)
	_ = i.wm.Set(ctx, "preprint", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
		HighWatermark: newHWM,
	}, nil
}
