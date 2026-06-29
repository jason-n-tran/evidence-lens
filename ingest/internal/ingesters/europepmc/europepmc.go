// Package europepmc ingests Europe PMC literature records via the public REST
// search API at ebi.ac.uk/europepmc/webservices/rest/search (no key required).
//
// Uses resultType=core (full bibliographic record incl. abstract, authors,
// journal, keywords) and cursorMark pagination. Filters by publication year so
// a delta run pulls recent literature without the paywalled date filters some
// other sources require.
package europepmc

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

type Config struct {
	MaxPerRun int
	Query     string // base query; year filter is appended
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
		fetcher: ingestcommon.NewFetcher(3, 6, "EvidenceLens-EuropePMC/0.1 (mailto:contact@example.com)"),
	}
}

// resultMeta extracts only the id/source needed to build the doc id; the full
// json.RawMessage of each result is archived verbatim.
type resultMeta struct {
	ID     string `json:"id"`
	Source string `json:"source"`
}

type searchResp struct {
	HitCount       int    `json:"hitCount"`
	NextCursorMark string `json:"nextCursorMark"`
	ResultList     struct {
		Result []json.RawMessage `json:"result"`
	} `json:"resultList"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "europepmc"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	// Watermark stores the publication year to pull; default to the current
	// year so a fresh run pulls recent literature. In backfill mode the year
	// walks BACKWARD (see end of Run) so successive runs sweep history; seed the
	// starting year with BACKFILL_SINCE (a 4-digit year) if set.
	year, _ := i.wm.Get(ctx, "europepmc")
	if year == "" {
		if bs := ingestcommon.BackfillSince(); len(bs) >= 4 {
			year = bs[:4]
		} else {
			year = fmt.Sprintf("%d", time.Now().Year())
		}
	}
	baseQuery := i.cfg.Query
	if baseQuery == "" {
		baseQuery = "SRC:MED"
	}
	query := fmt.Sprintf("%s AND PUB_YEAR:%s", baseQuery, year)

	var counters ingestcommon.Counters
	cursor := "*"
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		q := url.Values{}
		q.Set("query", query)
		q.Set("format", "json")
		q.Set("resultType", "core")
		q.Set("pageSize", "100")
		q.Set("cursorMark", cursor)
		reqURL := "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + q.Encode()
		body, err := i.fetcher.Get(ctx, reqURL, nil)
		if err != nil {
			i.logger.Error("europepmc fetch failed", "err", err, "year", year)
			_ = i.wm.Set(ctx, "europepmc", year, "failed", err.Error())
			return i.result(counters, year), err
		}
		var resp searchResp
		if err := json.Unmarshal(body, &resp); err != nil {
			i.logger.Error("europepmc decode failed", "err", err)
			_ = i.wm.Set(ctx, "europepmc", year, "failed", "decode: "+err.Error())
			return i.result(counters, year), err
		}
		if len(resp.ResultList.Result) == 0 {
			break
		}
		for _, raw := range resp.ResultList.Result {
			counters.Fetched.Add(1)
			var meta resultMeta
			if err := json.Unmarshal(raw, &meta); err != nil || meta.ID == "" {
				counters.Failed.Add(1)
				continue
			}
			docID := "europepmc:" + meta.ID
			key, err := i.archiver.Put(ctx, "europepmc", docID, raw)
			if err != nil {
				counters.Failed.Add(1)
				continue
			}
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "europepmc", docID, key); err == nil {
				counters.Published.Add(1)
			}
		}
		// Europe PMC signals end-of-results by returning the same cursor.
		if resp.NextCursorMark == "" || resp.NextCursorMark == cursor {
			break
		}
		cursor = resp.NextCursorMark
	}

	// Backfill march: this ingester pages within ONE year. When backfill is on
	// and we DRAINED the year (finished under the per-run cap, i.e. no more
	// results), step the watermark to the PRIOR year so the next run sweeps
	// further back through history. If we hit the cap, stay on this year to
	// finish it next run. Without backfill, stay on the current year (normal
	// incremental mode just re-pulls the latest year).
	nextYear := year
	if ingestcommon.BackfillEnabled() && int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		if y, err := strconv.Atoi(year); err == nil && y > 1900 {
			nextYear = fmt.Sprintf("%d", y-1)
		}
	}
	_ = i.wm.Set(ctx, "europepmc", nextYear, "idle", "")
	return i.result(counters, year), nil
}

func (i *Ingester) result(c ingestcommon.Counters, hwm string) ingestcommon.RunResult {
	return ingestcommon.RunResult{
		DocsFetched:   c.Fetched.Load(),
		DocsArchived:  c.Archived.Load(),
		DocsPublished: c.Published.Load(),
		HighWatermark: hwm,
	}
}
