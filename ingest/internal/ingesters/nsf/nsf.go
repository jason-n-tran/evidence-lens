// Package nsf ingests NSF Award Search records (spec section 2 row 23).
// Public REST: api.nsf.gov/services/v1/awards.json
package nsf

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

type Config struct{ MaxPerRun int }
type Ingester struct {
	cfg Config; logger *slog.Logger; wm *watermark.Store
	archiver *objectstore.Archiver; pub *natspub.Publisher; fetcher *ingestcommon.Fetcher
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	return &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(2, 4, "EvidenceLens-NSF/0.1 (mailto:contact@example.com)"),
	}
}

type awardsResp struct {
	Response struct {
		Award []map[string]any `json:"award"`
	} `json:"response"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "nsf"); err != nil { return ingestcommon.RunResult{}, err }
	const nsfDate = "01/02/2006" // NSF uses MM/DD/YYYY (NOT lexically sortable)
	hwm, _ := i.wm.Get(ctx, "nsf")
	if hwm == "" {
		// Backfill seed wins on first run; else the 1-year cold-start lookback.
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			days := ingestcommon.GetEnvInt("NSF_LOOKBACK_DAYS", 365)
			hwm = time.Now().AddDate(0, 0, -days).Format(nsfDate)
		}
	}
	to := time.Now().Format(nsfDate)
	var counters ingestcommon.Counters
	latestSeen := "" // max award startDate seen this run (for backfill march)
	offset := 1
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		q := url.Values{}
		q.Set("dateStart", hwm)
		q.Set("dateEnd", to)
		q.Set("offset", fmt.Sprintf("%d", offset))
		q.Set("printFields",
			"id,title,abstractText,piFirstName,piLastName,awardeeName,awardeeStateCode,fundsObligatedAmt,startDate,expDate")
		req := "https://api.nsf.gov/services/v1/awards.json?" + q.Encode()
		body, err := i.fetcher.Get(ctx, req, nil)
		if err != nil { break }
		var r awardsResp
		if err := json.Unmarshal(body, &r); err != nil || len(r.Response.Award) == 0 { break }
		for _, a := range r.Response.Award {
			counters.Fetched.Add(1)
			id := fmt.Sprintf("%v", a["id"])
			if id == "" || id == "<nil>" { counters.Failed.Add(1); continue }
			if sd, ok := a["startDate"].(string); ok && sd != "" {
				latestSeen = ingestcommon.ParseAdvance(nsfDate, latestSeen, sd)
			}
			docID := "nsf:" + id
			raw, _ := json.Marshal(a)
			key, err := i.archiver.Put(ctx, "nsf", docID, raw)
			if err != nil { counters.Failed.Add(1); continue }
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "nsf", docID, key); err == nil { counters.Published.Add(1) }
		}
		offset += len(r.Response.Award)
	}
	// Advance the watermark: empty window -> keep; backfill + hit cap -> resume
	// at the latest date seen (march through history); else -> today (caught up).
	newHWM := ingestcommon.NextWatermark(hwm, to, int(counters.Fetched.Load()), i.cfg.MaxPerRun, latestSeen)
	_ = i.wm.Set(ctx, "nsf", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched: counters.Fetched.Load(), DocsArchived: counters.Archived.Load(),
		DocsPublished: counters.Published.Load(), HighWatermark: newHWM,
	}, nil
}
