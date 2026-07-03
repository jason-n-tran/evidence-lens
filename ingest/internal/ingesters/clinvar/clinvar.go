// Package clinvar ingests clinically significant variants from NCBI ClinVar
// via E-utilities: esearch (scoped to pathogenic variants) -> esummary.
//
// Scoped to clinsig_pathogenic[Properties] so the index holds actionable
// variant-disease associations, not benign/uncertain noise. An NCBI_API_KEY
// (optional) raises the E-utilities rate limit.
package clinvar

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

const (
	esearch  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
	esummary = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
	term     = "clinsig_pathogenic[Properties]"
)

type Config struct{ MaxPerRun int }

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
		fetcher: ingestcommon.NewFetcher(3, 6, "EvidenceLens-ClinVar/0.1 (mailto:contact@example.com)"),
		apiKey:  os.Getenv("NCBI_API_KEY"),
	}
}

func (i *Ingester) auth(q url.Values) {
	if i.apiKey != "" {
		q.Set("api_key", i.apiKey)
	}
	if tool := os.Getenv("NCBI_TOOL"); tool != "" {
		q.Set("tool", tool)
	}
	if email := os.Getenv("NCBI_EMAIL"); email != "" {
		q.Set("email", email)
	}
}

type esearchResp struct {
	ESearchResult struct {
		Count   string   `json:"count"`
		IDList  []string `json:"idlist"`
	} `json:"esearchresult"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "clinvar"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	var counters ingestcommon.Counters

	offset := 0
	for int(counters.Fetched.Load()) < i.cfg.MaxPerRun {
		// 1. esearch: page of variant UIDs.
		q := url.Values{}
		q.Set("db", "clinvar")
		q.Set("term", term)
		q.Set("retmode", "json")
		q.Set("retstart", fmt.Sprintf("%d", offset))
		q.Set("retmax", "200")
		i.auth(q)
		body, err := i.fetcher.Get(ctx, esearch+"?"+q.Encode(), nil)
		if err != nil {
			i.logger.Error("clinvar esearch failed", "err", err)
			_ = i.wm.Set(ctx, "clinvar", "", "failed", err.Error())
			return i.result(counters), err
		}
		var sr esearchResp
		if err := json.Unmarshal(body, &sr); err != nil {
			i.logger.Error("clinvar esearch decode failed", "err", err)
			_ = i.wm.Set(ctx, "clinvar", "", "failed", "decode: "+err.Error())
			return i.result(counters), err
		}
		ids := sr.ESearchResult.IDList
		if len(ids) == 0 {
			break
		}

		// 2. esummary: full records for this page of UIDs.
		sq := url.Values{}
		sq.Set("db", "clinvar")
		sq.Set("id", strings.Join(ids, ","))
		sq.Set("retmode", "json")
		i.auth(sq)
		sumBody, err := i.fetcher.Get(ctx, esummary+"?"+sq.Encode(), nil)
		if err != nil {
			i.logger.Error("clinvar esummary failed", "err", err)
			_ = i.wm.Set(ctx, "clinvar", "", "failed", err.Error())
			return i.result(counters), err
		}
		// The esummary result map is {uid: {...}} under "result". Archive each
		// record individually so the parser sees one variant per object.
		var sum struct {
			Result map[string]json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(sumBody, &sum); err != nil {
			i.logger.Error("clinvar esummary decode failed", "err", err)
			_ = i.wm.Set(ctx, "clinvar", "", "failed", "decode: "+err.Error())
			return i.result(counters), err
		}
		for _, uid := range ids {
			rec, ok := sum.Result[uid]
			if !ok {
				continue
			}
			counters.Fetched.Add(1)
			docID := "clinvar:" + uid
			key, err := i.archiver.Put(ctx, "clinvar", docID, rec)
			if err != nil {
				counters.Failed.Add(1)
				continue
			}
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "clinvar", docID, key); err == nil {
				counters.Published.Add(1)
			}
		}
		offset += len(ids)
	}

	_ = i.wm.Set(ctx, "clinvar", time.Now().UTC().Format("2006-01-02"), "idle", "")
	return i.result(counters), nil
}

func (i *Ingester) result(c ingestcommon.Counters) ingestcommon.RunResult {
	return ingestcommon.RunResult{
		DocsFetched:   c.Fetched.Load(),
		DocsArchived:  c.Archived.Load(),
		DocsPublished: c.Published.Load(),
		HighWatermark: time.Now().UTC().Format("2006-01-02"),
	}
}
