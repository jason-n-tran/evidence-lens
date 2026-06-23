// Package trials ingests ClinicalTrials.gov v2 records (spec §5.1.3).
//
// Endpoint: clinicaltrials.gov/api/v2/studies?filter.advanced=
//   AREA[LastUpdatePostDate]RANGE[YYYY-MM-DD,MAX]
// pageSize=1000, paginated via nextPageToken.
package trials

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

type Config struct {
	PageSize  int
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
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(5, 10, "EvidenceLens-Trials/0.1 (mailto:contact@example.com)"),
	}
}

type studiesResponse struct {
	Studies       []map[string]any `json:"studies"`
	NextPageToken string           `json:"nextPageToken"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "trials"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	hwm, _ := i.wm.Get(ctx, "trials")
	if hwm == "" {
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			hwm = time.Now().AddDate(0, 0, -2).Format("2006-01-02")
		}
	}
	var counters ingestcommon.Counters
	latestSeen := "" // max LastUpdatePostDate this run (ISO; the window's sort key)

	cursor := ""
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		q := url.Values{}
		q.Set("filter.advanced", fmt.Sprintf("AREA[LastUpdatePostDate]RANGE[%s,MAX]", hwm))
		q.Set("pageSize", fmt.Sprintf("%d", i.cfg.PageSize))
		q.Set("countTotal", "false")
		if cursor != "" {
			q.Set("pageToken", cursor)
		}
		body, err := i.fetcher.Get(ctx, "https://clinicaltrials.gov/api/v2/studies?"+q.Encode(), nil)
		if err != nil {
			break
		}
		var resp studiesResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			break
		}
		for _, study := range resp.Studies {
			counters.Fetched.Add(1)
			id := getStudyNCT(study)
			if id == "" {
				counters.Failed.Add(1)
				continue
			}
			if d := getLastUpdate(study); d != "" {
				latestSeen = ingestcommon.MaxDate(latestSeen, d)
			}
			rawJSON, _ := json.Marshal(study)
			key, err := i.archiver.Put(ctx, "ctgov", id, rawJSON)
			if err != nil {
				counters.Failed.Add(1)
				continue
			}
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "ctgov", id, key); err == nil {
				counters.Published.Add(1)
			}
		}
		if resp.NextPageToken == "" {
			break
		}
		cursor = resp.NextPageToken
	}

	newHWM := ingestcommon.NextWatermark(hwm, time.Now().Format("2006-01-02"),
		int(counters.Fetched.Load()), i.cfg.MaxPerRun, latestSeen)
	_ = i.wm.Set(ctx, "trials", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched: counters.Fetched.Load(), DocsArchived: counters.Archived.Load(),
		DocsPublished: counters.Published.Load(), HighWatermark: newHWM,
	}, nil
}

// getLastUpdate extracts protocolSection.statusModule.lastUpdatePostDateStruct.date
// (ISO YYYY-MM-DD), the field the [LastUpdatePostDate] window filters on.
func getLastUpdate(s map[string]any) string {
	proto, ok := s["protocolSection"].(map[string]any)
	if !ok {
		return ""
	}
	status, ok := proto["statusModule"].(map[string]any)
	if !ok {
		return ""
	}
	st, ok := status["lastUpdatePostDateStruct"].(map[string]any)
	if !ok {
		return ""
	}
	if d, ok := st["date"].(string); ok {
		return d
	}
	return ""
}

func getStudyNCT(s map[string]any) string {
	if proto, ok := s["protocolSection"].(map[string]any); ok {
		if id, ok := proto["identificationModule"].(map[string]any); ok {
			if nct, ok := id["nctId"].(string); ok {
				return nct
			}
		}
	}
	return ""
}
