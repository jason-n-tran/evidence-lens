// Package hpo ingests the Human Phenotype Ontology OBO bulk
// (spec section 2 row 27). Public, CC-BY. Refresh monthly.
package hpo

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

const obURL = "https://purl.obolibrary.org/obo/hp.obo"

type Ingester struct {
	logger *slog.Logger; wm *watermark.Store
	archiver *objectstore.Archiver; pub *natspub.Publisher; fetcher *ingestcommon.Fetcher
}

func New(logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	return &Ingester{
		logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(1, 2, "EvidenceLens-HPO/0.1 (mailto:contact@example.com)"),
	}
}

type term struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Def  string `json:"def"`
	Syns []string `json:"synonyms"`
}

func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "hpo"); err != nil { return ingestcommon.RunResult{}, err }
	body, err := i.fetcher.Get(ctx, obURL, nil)
	if err != nil { return ingestcommon.RunResult{}, fmt.Errorf("download obo: %w", err) }
	terms := parseOBO(string(body))
	var counters ingestcommon.Counters
	for _, t := range terms {
		counters.Fetched.Add(1)
		docID := "hpo:" + t.ID
		raw, _ := json.Marshal(t)
		key, err := i.archiver.Put(ctx, "hpo", docID, raw)
		if err != nil { counters.Failed.Add(1); continue }
		counters.Archived.Add(1)
		if _, err := i.pub.PublishRaw(ctx, "hpo", docID, key); err == nil { counters.Published.Add(1) }
		if ctx.Err() != nil { break }
	}
	stamp := time.Now().UTC().Format("2006-01-02")
	_ = i.wm.Set(ctx, "hpo", stamp, "idle", "")
	return ingestcommon.RunResult{
		DocsFetched: counters.Fetched.Load(), DocsArchived: counters.Archived.Load(),
		DocsPublished: counters.Published.Load(), HighWatermark: stamp,
	}, nil
}

// parseOBO extracts [Term] stanzas. Tiny, dependency-free, sufficient for HPO.
func parseOBO(body string) []term {
	out := []term{}
	stanzas := strings.Split(body, "[Term]")
	for _, s := range stanzas[1:] {
		var t term
		for _, ln := range strings.Split(s, "\n") {
			if strings.HasPrefix(ln, "id: ") { t.ID = strings.TrimSpace(ln[4:]) }
			if strings.HasPrefix(ln, "name: ") { t.Name = strings.TrimSpace(ln[6:]) }
			if strings.HasPrefix(ln, "def: ") { t.Def = strings.TrimSpace(ln[5:]) }
			if strings.HasPrefix(ln, "synonym: ") { t.Syns = append(t.Syns, strings.TrimSpace(ln[9:])) }
		}
		if t.ID != "" { out = append(out, t) }
	}
	return out
}
