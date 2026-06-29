// Package nihreporter ingests NIH RePORTER funding records (spec §5.1.9).
// REST: api.reporter.nih.gov/v2/projects/search with date filters.
package nihreporter

import (
	"bytes"
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

type Config struct{ MaxPerRun int }

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
		fetcher: ingestcommon.NewFetcher(1, 2, "EvidenceLens-NIH-RePORTER/0.1 (mailto:contact@example.com)"),
	}
}

type searchReq struct {
	Criteria struct {
		ProjectStartDate struct {
			FromDate string `json:"from_date"`
			ToDate   string `json:"to_date"`
		} `json:"project_start_date"`
	} `json:"criteria"`
	Offset        int      `json:"offset"`
	Limit         int      `json:"limit"`
	SortField     string   `json:"sort_field"`
	SortOrder     string   `json:"sort_order"`
	IncludeFields []string `json:"include_fields"`
}

// projectMeta pulls only the appl_id needed to build the doc id; the full
// json.RawMessage is archived so the processor's parser sees every field
// (PIs, funding, agency, terms). A narrow struct here would silently drop
// every field it didn't declare.
type projectMeta struct {
	ApplID           int64  `json:"appl_id"`
	ProjectStartDate string `json:"project_start_date"` // ISO timestamp (for backfill march)
}

type searchResp struct {
	Meta struct {
		Total int `json:"total"`
	} `json:"meta"`
	Results []json.RawMessage `json:"results"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "nih-reporter"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	hwm, _ := i.wm.Get(ctx, "nih-reporter")
	if hwm == "" {
		// NIH grants don't start daily — project_start_date clusters around
		// fiscal-year boundaries, so a short rolling window is almost always
		// empty. Default the first run to a 1-year lookback (overridable via
		// NIH_LOOKBACK_DAYS) so an initial/sample run actually pulls records.
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			days := ingestcommon.GetEnvInt("NIH_LOOKBACK_DAYS", 365)
			hwm = time.Now().AddDate(0, 0, -days).Format("2006-01-02")
		}
	}
	to := time.Now().Format("2006-01-02")
	var counters ingestcommon.Counters
	latestSeen := "" // max project_start_date this run (window's sort key)

	offset := 0
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		req := searchReq{
			Offset:    offset,
			Limit:     500,
			SortField: "appl_id",
			SortOrder: "asc",
			IncludeFields: []string{
				"ApplId", "ProjectNum", "ProjectTitle", "AbstractText",
				"AwardAmount", "FiscalYear", "Organization",
				"PrincipalInvestigators", "AgencyIcAdmin",
				"ProjectStartDate", "ProjectEndDate",
			},
		}
		req.Criteria.ProjectStartDate.FromDate = hwm
		req.Criteria.ProjectStartDate.ToDate = to
		body, err := json.Marshal(req)
		if err != nil {
			break
		}
		respBytes, err := i.fetcher.Post(ctx,
			"https://api.reporter.nih.gov/v2/projects/search",
			bytes.NewReader(body),
			map[string]string{"Content-Type": "application/json"},
		)
		if err != nil {
			// Record the failure and don't advance the watermark, so a transient
			// API error can't silently look like a successful empty run.
			i.logger.Error("nih-reporter fetch failed", "err", err, "offset", offset)
			_ = i.wm.Set(ctx, "nih-reporter", hwm, "failed", err.Error())
			return ingestcommon.RunResult{
				DocsFetched:   counters.Fetched.Load(),
				DocsArchived:  counters.Archived.Load(),
				DocsPublished: counters.Published.Load(),
				HighWatermark: hwm,
			}, err
		}
		var resp searchResp
		if err := json.Unmarshal(respBytes, &resp); err != nil {
			i.logger.Error("nih-reporter decode failed", "err", err)
			_ = i.wm.Set(ctx, "nih-reporter", hwm, "failed", "decode: "+err.Error())
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
			var meta projectMeta
			if err := json.Unmarshal(raw, &meta); err != nil || meta.ApplID == 0 {
				counters.Failed.Add(1)
				continue
			}
			if len(meta.ProjectStartDate) >= 10 {
				latestSeen = ingestcommon.MaxDate(latestSeen, meta.ProjectStartDate[:10])
			}
			docID := fmt.Sprintf("nih-reporter:%d", meta.ApplID)
			// Archive the full upstream record verbatim.
			key, err := i.archiver.Put(ctx, "nih-reporter", docID, raw)
			if err != nil {
				counters.Failed.Add(1)
				continue
			}
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "nih-reporter", docID, key); err == nil {
				counters.Published.Add(1)
			}
		}
		offset += len(resp.Results)
		if offset >= resp.Meta.Total {
			break
		}
	}

	// Empty window -> keep hwm; backfill + hit cap -> resume at latest start
	// date seen (march through history); else -> today (caught up).
	newHWM := ingestcommon.NextWatermark(hwm, to, int(counters.Fetched.Load()), i.cfg.MaxPerRun, latestSeen)
	_ = i.wm.Set(ctx, "nih-reporter", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
		HighWatermark: newHWM,
	}, nil
}
