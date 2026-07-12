// Package neo4jb batches MERGE Cypher into Neo4j.
//
// Spec §5.4: batch 500 MERGE statements per tx.
// Edges: (:Document)-[:CITES]->(:Document), (:Document)-[:AUTHORED_BY]->(:Author),
//        (:Document)-[:PUBLISHED_IN]->(:Journal), (:Document)-[:TAGGED_WITH]->(:MeshTerm),
//        (:Author)-[:RECEIVED_PAYMENT {amount,year,type}]->(:Sponsor)
package neo4jb

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

type Config struct {
	URL               string
	User              string
	Password          string
	BatchSize         int
	FlushAfterSeconds int
	Logger            *slog.Logger
}

type docNode struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Source        string   `json:"source"`
	CitationCount int64    `json:"citation_count"`
	PageRank      float64  `json:"citation_pagerank"`
	PublishedAt   string   `json:"published_at"`
	Citations     []string `json:"citations"`
	MeshTerms     []string `json:"mesh_terms"`
	Authors       []struct {
		DisplayName string `json:"display_name"`
		ORCID       string `json:"orcid"`
		Payments    []struct {
			SponsorName string  `json:"sponsor_name"`
			Year        int     `json:"year"`
			AmountUSD   float64 `json:"amount_usd"`
			PaymentType string  `json:"payment_type"`
		} `json:"payments"`
	} `json:"authors"`
	Journal struct {
		Name string `json:"name"`
		ISSN string `json:"issn"`
	} `json:"journal"`
}

type Batcher struct {
	cfg      Config
	driver   neo4j.DriverWithContext
	in       chan docNode
	flushReq chan struct{}
	wg       sync.WaitGroup
}

func New(cfg Config) (*Batcher, error) {
	if cfg.BatchSize == 0 { cfg.BatchSize = 500 }
	if cfg.FlushAfterSeconds == 0 { cfg.FlushAfterSeconds = 5 }
	d, err := neo4j.NewDriverWithContext(cfg.URL, neo4j.BasicAuth(cfg.User, cfg.Password, ""))
	if err != nil {
		return nil, err
	}
	return &Batcher{
		cfg: cfg, driver: d,
		in: make(chan docNode, cfg.BatchSize*2),
		flushReq: make(chan struct{}, 1),
	}, nil
}

// Flush requests a manual flush (wired to SIGUSR1 in indexer/cmd).
func (b *Batcher) Flush() {
	select { case b.flushReq <- struct{}{}: default: }
}

func (b *Batcher) Submit(raw json.RawMessage) {
	d, ok := b.unmarshal(raw)
	if !ok {
		return
	}
	select {
	case b.in <- d:
	default:
		b.cfg.Logger.Warn("neo4j batcher dropping; channel full")
	}
}

// SubmitBlocking submits a document and blocks if the channel is full.
// Useful for reindex tools where 100% fidelity is required.
func (b *Batcher) SubmitBlocking(raw json.RawMessage) {
	d, ok := b.unmarshal(raw)
	if !ok {
		return
	}
	b.in <- d
}
