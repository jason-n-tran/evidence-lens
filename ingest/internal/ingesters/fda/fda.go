// Package fda ingests openFDA drug + device endpoints (spec §5.1.5).
//
// Sub-endpoints: drug/drugsfda, drug/enforcement, device/event, device/510k.
// Pagination via skip parameter, max 25,000 per query — partition by date range.
//
// Recalls also publish RecallEvent to NATS recall-fanout (priority lane,
// SLO ≤ 1min E2E).
package fda

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
	"github.com/nats-io/nats.go"
)

type Config struct {
	APIKey    string
	MaxPerRun int
	Endpoints []string
	NATSURL   string // for recall-fanout priority publish
}

type Ingester struct {
	cfg       Config
	logger    *slog.Logger
	wm        *watermark.Store
	archiver  *objectstore.Archiver
	pub       *natspub.Publisher
	fetcher   *ingestcommon.Fetcher
	recallPub *nats.Conn
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	i := &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(4, 8, "EvidenceLens-FDA/0.1 (mailto:contact@example.com)"),
	}
	if cfg.NATSURL != "" {
		if nc, err := nats.Connect(cfg.NATSURL,
			nats.MaxReconnects(-1),
			nats.ReconnectWait(time.Second),
		); err == nil {
			i.recallPub = nc
			logger.Info("fda recall priority lane connected", "nats", cfg.NATSURL)
		} else {
			logger.Warn("fda recall priority lane disabled (nats unreachable)", "err", err)
		}
	}
	return i
}

// publishRecall tees a RecallEvent JSON to NATS subject `recall-fanout`.
// Best-effort: failures are logged and never block the main publish path.
func (i *Ingester) publishRecall(ctx context.Context, recallID string, r map[string]any) {
	openfda, _ := r["openfda"].(map[string]any)
	drugClass := ""
	if cls, ok := openfda["pharm_class_epc"].([]any); ok && len(cls) > 0 {
		if s, ok := cls[0].(string); ok {
			drugClass = s
		}
	}
	productName := ""
	if v, ok := r["product_description"].(string); ok {
		productName = v
	}
	recallClass := ""
	if v, ok := r["classification"].(string); ok {
		recallClass = v
	}
	payload, _ := json.Marshal(map[string]any{
		"recall_id":    recallID,
		"agency":       "fda",
		"product_name": productName,
		"drug_class":   drugClass,
		"recall_class": recallClass,
		"emitted_at":   time.Now().UTC().Format(time.RFC3339),
	})
	if err := i.recallPub.Publish("recall-fanout", payload); err != nil {
		i.logger.Warn("recall-fanout publish failed", "recall_id", recallID, "err", err)
	}
}

type fdaResponse struct {
	Meta struct {
		Results struct{ Total int `json:"total"` } `json:"results"`
	} `json:"meta"`
	Results []map[string]any `json:"results"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "fda"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	hwm, _ := i.wm.Get(ctx, "fda")
	if hwm == "" {
		if bs := ingestcommon.BackfillSince(); bs != "" {
			hwm = bs
		} else {
			// Recalls/enforcement reports are infrequent (often none in any given
			// 2-day window), so a short cold-start finds nothing on first run.
			// Look back 90 days so the initial sweep actually surfaces recent
			// recalls; subsequent runs advance the watermark normally.
			hwm = time.Now().AddDate(0, 0, -90).Format("20060102")
		}
	}
	to := time.Now().Format("20060102")
	var counters ingestcommon.Counters
	latestSeen := "" // max record date this run, normalized to YYYYMMDD (sortable)

	for _, ep := range i.cfg.Endpoints {
		isRecall := ep == "drug/enforcement"
		dateField := pickDateField(ep)
		skip := 0
		// Per-endpoint budget: MaxPerRun is applied to EACH endpoint, not
		// shared. Previously the first endpoint (drug/drugsfda) consumed the
		// whole budget, so drug/enforcement (recalls) was never reached and
		// the recalls page stayed empty.
		epStart := int(counters.Fetched.Load())
		for int(counters.Fetched.Load())-epStart < i.cfg.MaxPerRun {
			// openFDA range syntax is `field:[d1+TO+d2]`, where `+` means a
			// literal space. url.Values.Encode() would percent-encode the `+`
			// to %2B, which openFDA rejects with a parse_exception (and we'd
			// silently fetch 0). So build the `search` clause by hand and append
			// only the remaining params via Encode().
			search := fmt.Sprintf("%s:[%s+TO+%s]", dateField, hwm, to)
			rest := url.Values{}
			rest.Set("limit", "100")
			rest.Set("skip", fmt.Sprintf("%d", skip))
			if i.cfg.APIKey != "" {
				rest.Set("api_key", i.cfg.APIKey)
			}
			reqURL := fmt.Sprintf("https://api.fda.gov/%s.json?search=%s&%s", ep, search, rest.Encode())
			body, err := i.fetcher.Get(ctx, reqURL, nil)
			if err != nil {
				break
			}
			var resp fdaResponse
			if err := json.Unmarshal(body, &resp); err != nil || len(resp.Results) == 0 {
				break
			}
			for _, r := range resp.Results {
				counters.Fetched.Add(1)
				id := pickID(ep, r)
				// Track the latest record date for the backfill march. openFDA
				// dates are YYYYMMDD strings (already sortable); strip any
				// non-digits defensively.
				if dv, ok := r[dateField].(string); ok {
					d := digitsOnly(dv)
					if len(d) >= 8 {
						latestSeen = ingestcommon.MaxDate(latestSeen, d[:8])
					}
				}
				rawJSON, _ := json.Marshal(r)
				source := "openfda-" + sanitize(ep)
				key, err := i.archiver.Put(ctx, source, id, rawJSON)
				if err != nil {
					counters.Failed.Add(1)
					continue
				}
				counters.Archived.Add(1)
				if _, err := i.pub.PublishRaw(ctx, source, id, key); err == nil {
					counters.Published.Add(1)
				}
				// Recall priority lane: tee a RecallEvent into the
				// recall-fanout NATS bridge so the gateway WS subscribers
				// see it within the spec section 14.1 1-min E2E SLO.
				if isRecall && i.recallPub != nil {
					i.publishRecall(ctx, id, r)
				}
			}
			skip += len(resp.Results)
		}
	}

	// MaxPerRun is PER-endpoint here, so the simple `fetched >= MaxPerRun` cap
	// check in NextWatermark would under-trigger; treat "filled the budget on any
	// endpoint" as not-exhausted by comparing against the per-endpoint cap.
	newHWM := ingestcommon.NextWatermark(hwm, to, int(counters.Fetched.Load()),
		i.cfg.MaxPerRun*len(i.cfg.Endpoints), latestSeen)
	_ = i.wm.Set(ctx, "fda", newHWM, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched: counters.Fetched.Load(), DocsArchived: counters.Archived.Load(),
		DocsPublished: counters.Published.Load(), HighWatermark: newHWM,
	}, nil
}

// digitsOnly strips non-digit characters (openFDA dates are usually already
// YYYYMMDD but some endpoints return YYYY-MM-DD).
func digitsOnly(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			b = append(b, s[i])
		}
	}
	return string(b)
}
