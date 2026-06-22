// Package pubmed implements the PubMed ingester per spec section 5.1.1.
//
// API: NCBI E-utilities (esearch + efetch).
// Watermark: PubMed EDAT (entry date), ISO-8601 string.
// Concurrency: 10 in-flight requests, NCBI rate limit 10/sec with API key.
// First run: env PUBMED_BULK_BASELINE=true switches the run() to a
//   bulk-baseline FTP fetch from ftp.ncbi.nlm.nih.gov/pubmed/baseline/.
//   Default behavior (env unset) caps the first run to a 7-day lookback
//   so a stray invocation doesn't try to ingest 38M records.
//
// This is the reference ingester — every other ingester follows the same
// shape (Config + Run(ctx) returning RunResult).
package pubmed

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

// Config tunes the ingester. All optional except (implicitly) MaxPerRun.
type Config struct {
	APIKey         string
	Tool           string
	Email          string
	MaxPerRun      int
	MaxConcurrency int // 0 = auto: 3 without key, 10 with key
}

// Ingester wires Config + dependencies. Use New to construct.
type Ingester struct {
	cfg      Config
	logger   *slog.Logger
	wm       *watermark.Store
	archiver *objectstore.Archiver
	pub      *natspub.Publisher
	fetcher  *ingestcommon.Fetcher
}

// New constructs an Ingester. Rate-limit: 10 req/s with key, 3 req/s without.
func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	rate := 3
	if cfg.APIKey != "" {
		rate = 10
	}
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = rate // match concurrency to rate limit
	}
	ua := fmt.Sprintf("EvidenceLens-PubMed/%s (mailto:%s)", cfg.Tool, cfg.Email)
	return &Ingester{
		cfg:      cfg,
		logger:   logger,
		wm:       wm,
		archiver: arch,
		pub:      pub,
		fetcher:  ingestcommon.NewFetcher(rate, rate*2, ua),
	}
}

// Run executes one ingestion cycle. Idempotent: rerunning with the same
// watermark is a no-op until new EDAT records appear.
func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "pubmed"); err != nil {
		return ingestcommon.RunResult{}, err
	}

	hwm, err := i.wm.Get(ctx, "pubmed")
	if err != nil {
		return ingestcommon.RunResult{}, err
	}
	if hwm == "" {
		if ingestcommon.GetEnv("PUBMED_BULK_BASELINE", "") == "true" {
			i.logger.Info("first run: bulk baseline FTP path enabled")
			return i.runBaseline(ctx)
		}
		// Default first-run behavior: 7-day lookback so a stray invocation
		// doesn't try to ingest 38M records via E-utilities.
		hwm = time.Now().AddDate(0, 0, -7).Format("2006/01/02")
		i.logger.Info("first run; using 7-day lookback", "from", hwm)
	}

	// 1. esearch — get the PMIDs added since hwm.
	pmids, err := i.esearch(ctx, hwm)
	if err != nil {
		_ = i.wm.Set(ctx, "pubmed", hwm, "failed", err.Error())
		return ingestcommon.RunResult{}, err
	}
	if len(pmids) > i.cfg.MaxPerRun {
		pmids = pmids[:i.cfg.MaxPerRun]
	}
	i.logger.Info("esearch returned", "count", len(pmids), "since", hwm)

	// 2. efetch in batches of 200, MaxConcurrency in-flight.
	var counters ingestcommon.Counters
	counters.Fetched.Add(int64(len(pmids)))

	batches := chunk(pmids, 200)
	sem := make(chan struct{}, i.cfg.MaxConcurrency)
	var wg sync.WaitGroup
	var hwmMu sync.Mutex
	var maxEDAT string
	// Log only the first archive/publish failure (each) so a systemic failure
	// is visible without flooding the log with one line per doc.
	var archiveErrLogged, publishErrLogged atomic.Bool

dispatch:
	for _, batch := range batches {
		batch := batch
		select {
		case <-ctx.Done():
			break dispatch
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			records, edat, err := i.efetch(ctx, batch)
			if err != nil {
				counters.Failed.Add(int64(len(batch)))
				i.logger.Warn("efetch batch failed", "size", len(batch), "err", err)
				return
			}
			hwmMu.Lock()
			if edat > maxEDAT {
				maxEDAT = edat
			}
			hwmMu.Unlock()
			for _, raw := range records {
				key, err := i.archiver.Put(ctx, "pubmed", raw.PMID, raw.Bytes)
				if err != nil {
					counters.Failed.Add(1)
					// Surface the FIRST archive failure with its real error so a
					// silent "fetched N, archived 0" is diagnosable (S3 auth /
					// endpoint / bucket). Logged once to avoid flooding.
					if archiveErrLogged.CompareAndSwap(false, true) {
						i.logger.Error("archive (S3 PutObject) failed",
							"err", err, "pmid", raw.PMID)
					}
					continue
				}
				counters.Archived.Add(1)
				if _, err := i.pub.PublishRaw(ctx, "pubmed", raw.PMID, key); err != nil {
					counters.Failed.Add(1)
					if publishErrLogged.CompareAndSwap(false, true) {
						i.logger.Error("publish (NATS) failed", "err", err, "pmid", raw.PMID)
					}
					continue
				}
				counters.Published.Add(1)
			}
		}()
	}
	wg.Wait()

	newHWM := maxEDAT
	if newHWM == "" {
		newHWM = hwm
	}
	_ = i.wm.Set(ctx, "pubmed", newHWM, "idle", "")

	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
		HighWatermark: newHWM,
	}, nil
}

// runBaseline streams the NCBI baseline FTP files. Each file is a
// gzipped XML PubmedArticleSet covering ~30k articles. We stream over
// HTTP from https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/ (NCBI exposes
// the FTP tree via HTTPS), gunzip on the fly, splitArticles, archive +
// publish. PUBMED_BASELINE_MAX_FILES caps work per /run so Cloud Run
// doesn't time out.
func (i *Ingester) runBaseline(ctx context.Context) (ingestcommon.RunResult, error) {
	const indexURL = "https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/"
	indexBody, err := i.fetcher.Get(ctx, indexURL, nil)
	if err != nil {
		return ingestcommon.RunResult{}, fmt.Errorf("baseline index: %w", err)
	}
	files := parseFTPIndex(indexBody)
	cap := ingestcommon.GetEnvInt("PUBMED_BASELINE_MAX_FILES", 5)
	if cap > 0 && len(files) > cap {
		files = files[:cap]
	}

	hwm, _ := i.wm.Get(ctx, "pubmed")
	var counters ingestcommon.Counters
	for _, fname := range files {
		if hwm != "" && fname <= hwm {
			continue
		}
		body, err := i.fetcher.Get(ctx, indexURL+fname, nil)
		if err != nil {
			i.logger.Warn("baseline fetch", "file", fname, "err", err)
			continue
		}
		gz, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			continue
		}
		xmlBody, err := io.ReadAll(gz)
		gz.Close()
		if err != nil {
			continue
		}
		records, _ := splitArticles(xmlBody)
		for _, raw := range records {
			counters.Fetched.Add(1)
			key, err := i.archiver.Put(ctx, "pubmed", raw.PMID, raw.Bytes)
			if err != nil {
				counters.Failed.Add(1)
				continue
			}
			counters.Archived.Add(1)
			if _, err := i.pub.PublishRaw(ctx, "pubmed", raw.PMID, key); err == nil {
				counters.Published.Add(1)
			}
		}
		hwm = fname
		_ = i.wm.Set(ctx, "pubmed", hwm, "running", "")
		if ctx.Err() != nil {
			break
		}
	}
	_ = i.wm.Set(ctx, "pubmed", hwm, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
		HighWatermark: hwm,
	}, nil
}

// parseFTPIndex extracts pubmedNN.xml.gz filenames from the NCBI HTTPS
// directory listing.
var ftpFileRE = regexp.MustCompile(`href="(pubmed\d+n\d+\.xml\.gz)"`)

func parseFTPIndex(body []byte) []string {
	matches := ftpFileRE.FindAllSubmatch(body, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, string(m[1]))
	}
	sort.Strings(out)
	return out
}

// ---- E-utilities calls ----

const eutilsBase = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

type esearchResult struct {
	XMLName xml.Name `xml:"eSearchResult"`
	IDList  struct {
		ID []string `xml:"Id"`
	} `xml:"IdList"`
	WebEnv     string `xml:"WebEnv"`
	QueryKey   string `xml:"QueryKey"`
	Count      int    `xml:"Count"`
	RetMax     int    `xml:"RetMax"`
}
