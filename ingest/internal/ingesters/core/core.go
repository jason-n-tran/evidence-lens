// Package core ingests CORE (~250M OA papers) via api.core.ac.uk/v3
// (spec section 2 row 5). Requires CORE_API_KEY (free tier 1000 req/day).
package core

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

type Config struct{ MaxPerRun int }

type Ingester struct {
	cfg Config; logger *slog.Logger; wm *watermark.Store
	archiver *objectstore.Archiver; pub *natspub.Publisher; fetcher *ingestcommon.Fetcher
	apiKey string
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	return &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(2, 4, "EvidenceLens-CORE/0.1 (mailto:contact@example.com)"),
		apiKey:  os.Getenv("CORE_API_KEY"),
	}
}

type coreResp struct {
	TotalHits int `json:"totalHits"`
	Results   []map[string]any `json:"results"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "core"); err != nil { return ingestcommon.RunResult{}, err }
	hwm, _ := i.wm.Get(ctx, "core")
	if hwm == "" {
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			hwm = time.Now().AddDate(0, 0, -7).Format("2006-01-02")
		}
	}
	to := time.Now().Format("2006-01-02")
	var counters ingestcommon.Counters
	latestSeen := "" // max updatedDate this run (window filters on updatedDate)
	if i.apiKey == "" {
		i.logger.Warn("core: CORE_API_KEY not set; skipping run")
		return ingestcommon.RunResult{}, nil
	}

	page := 1
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		q := url.Values{}
		q.Set("q", fmt.Sprintf(`updatedDate>=%s AND updatedDate<=%s`, hwm, to))
		q.Set("limit", "100")
		q.Set("page", fmt.Sprintf("%d", page))
		req := fmt.Sprintf("https://api.core.ac.uk/v3/search/works?%s", q.Encode())
		body, err := i.fetcher.Get(ctx, req, map[string]string{"Authorization": "Bearer " + i.apiKey})
		if err != nil { break }
		var r coreResp
		if err := json.Unmarshal(body, &r); err != nil || len(r.Results) == 0 { break }
		for _, w := range r.Results {
			counters.Fetched.Add(1)
			id := fmt.Sprintf("%v", w["id"])
			if id == "" || id == "<nil>" { counters.Failed.Add(1); continue }
			// updatedDate is an ISO timestamp; date prefix sorts chronologically.
			if ud, ok := w["updatedDate"].(string); ok && len(ud) >= 10 {
				latestSeen = ingestcommon.MaxDate(latestSeen, ud[:10])
			}
			docID := "core:" + id
			raw, _ := json.Marshal(w)
			key, err := i.archiver.Put(ctx, "core", docID, raw)
			if err != nil { counters.Failed.Add(1); continue }
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "core", docID, key); err == nil { counters.Published.Add(1) }
		}
		page++
	}
	newHWM := ingestcommon.NextWatermark(hwm, to, int(counters.Fetched.Load()), i.cfg.MaxPerRun, latestSeen)
	_ = i.wm.Set(ctx, "core", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched: counters.Fetched.Load(), DocsArchived: counters.Archived.Load(),
		DocsPublished: counters.Published.Load(), HighWatermark: newHWM,
	}, nil
}
