// Package meili batches Document writes to Meilisearch.
//
// Spec section 5.4 batcher: 1000 docs OR 5s, whichever first. Lifts
// Moogle's size-threshold pattern and adds the time trigger.
package meili

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/meilisearch/meilisearch-go"
)

type Config struct {
	URL               string
	APIKey            string
	IndexName         string
	BatchSize         int
	FlushAfterSeconds int
	Logger            *slog.Logger
}

type Batcher struct {
	cfg      Config
	client   meilisearch.ServiceManager
	in       chan json.RawMessage
	flushReq chan struct{}
	wg       sync.WaitGroup
}

func New(cfg Config) (*Batcher, error) {
	if cfg.BatchSize == 0 { cfg.BatchSize = 1000 }
	if cfg.FlushAfterSeconds == 0 { cfg.FlushAfterSeconds = 5 }
	c := meilisearch.New(cfg.URL, meilisearch.WithAPIKey(cfg.APIKey))
	return &Batcher{
		cfg: cfg, client: c,
		in: make(chan json.RawMessage, cfg.BatchSize*2),
		flushReq: make(chan struct{}, 1),
	}, nil
}

// Flush requests a manual flush (wired to SIGUSR1 in indexer/cmd).
func (b *Batcher) Flush() {
	select { case b.flushReq <- struct{}{}: default: }
}

func (b *Batcher) Submit(doc json.RawMessage) {
	select {
	case b.in <- doc:
	default:
		// Channel full: drop with log. Operator should scale up indexer.
		b.cfg.Logger.Warn("meili batcher dropping; channel full")
	}
}

func (b *Batcher) Run(ctx context.Context) {
	b.wg.Add(1)
	defer b.wg.Done()

	tick := time.NewTicker(time.Duration(b.cfg.FlushAfterSeconds) * time.Second)
	defer tick.Stop()

	batch := make([]json.RawMessage, 0, b.cfg.BatchSize)
	flush := func() {
		if len(batch) == 0 { return }
		b.cfg.Logger.Info("flush", "n", len(batch))
		idx := b.client.Index(b.cfg.IndexName)
		// Convert canonical Document to flattened IndexableDocument
		// (spec section 3.2). Avoids storing nested arrays Meilisearch
		// can't facet-filter on.
		toSend := make([]any, 0, len(batch))
		for _, m := range batch {
			var d map[string]any
			if err := json.Unmarshal(m, &d); err != nil { continue }
			toSend = append(toSend, flatten(d))
		}
		if _, err := idx.AddDocuments(toSend, "id"); err != nil {
			b.cfg.Logger.Error("meili add docs", "n", len(batch), "err", err)
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-tick.C:
			flush()
		case <-b.flushReq:
			flush()
		case doc := <-b.in:
			batch = append(batch, doc)
			if len(batch) >= b.cfg.BatchSize {
				flush()
			}
		}
	}
}

// flatten converts a canonical Document dict into the IndexableDocument
// shape from spec section 3.2 — denormalized scalar facet-filter fields
// promoted to the top level so Meilisearch can sort/filter on them
// without nested-array gymnastics.
func flatten(d map[string]any) map[string]any {
	// Meilisearch primary keys must be alphanumeric + hyphens + underscores
	// only. Canonical ids use "source:native_id" (e.g. "pubmed:12345678") —
	// replace the colon separator with an underscore for storage.
	meiliID := d["id"]
	if s, ok := meiliID.(string); ok {
		meiliID = strings.ReplaceAll(s, ":", "_")
	}
	out := map[string]any{
		"id":             meiliID,
		"canonical_id":   d["id"], // preserve original for lookup
		"title":          d["title"],
		"abstract":       d["abstract"],
		"full_text":      d["full_text"],
		"study_type":     d["study_type"],
		"mesh_terms":     d["mesh_terms"],
		"keywords":       d["keywords"],
		"license":        d["license"],
		"source":         d["source"],
		"canonical_url":  d["canonical_url"],
		"citation_count":     d["citation_count"],
		"citation_pagerank": d["citation_pagerank"],
		"published_at":   d["published_at"],
		"has_coi_authors": d["has_coi_authors"],
		"max_author_payment_usd": d["max_author_payment_usd"],
		"has_full_text":  d["full_text"] != nil && d["full_text"] != "",
		"salience":       d["salience"],
		// Persist which model produced the vector so the corpus is auditable for
		// stub/fake embeddings (a past bug embedded everything with a SHA-256
		// "stub-deterministic" vector). The audit tallies this; after a clean
		// re-embed every doc should read the real model (e.g. BAAI/bge-m3).
		"embedding_model": d["embedding_model"],
	}
	// Detail-page fields. The document/trial pages and JSON-LD read these off
	// the stored doc; if they're dropped here they silently render blank
	// (trial pages even 404, since the page requires doc.trial). Pass through
	// the identifiers + the nested journal/trial/authors objects verbatim.
	for _, k := range []string{"doi", "pmid", "pmcid", "nct_id", "journal", "trial", "authors"} {
		if v, ok := d[k]; ok && v != nil {
			out[k] = v
		}
	}
	if pa, ok := d["published_at"].(string); ok && len(pa) >= 4 {
		if y, err := parseYear(pa[:4]); err == nil {
			out["published_year"] = y
		}
	}
	// Flat journal scalars kept for faceting/sorting alongside the full object.
	if j, ok := d["journal"].(map[string]any); ok {
		out["journal_name"] = j["name"]
		out["journal_predatory"] = j["is_predatory"]
	}
	// Flat author-name array kept for the result-card byline (cheap to read);
	// the full authors[] above carries badge/orcid/affiliation for detail pages.
	if authors, ok := d["authors"].([]any); ok {
		names := make([]string, 0, len(authors))
		for _, a := range authors {
			if am, ok := a.(map[string]any); ok {
				if n, ok := am["display_name"].(string); ok {
					names = append(names, n)
				}
			}
		}
		out["authors_display"] = names
	}
	return out
}

func parseYear(s string) (int, error) {
	var y int
	_, err := fmt.Sscanf(s, "%d", &y)
	return y, err
}

func (b *Batcher) Close() {
	close(b.in)
	b.wg.Wait()
}
