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

func (b *Batcher) unmarshal(raw json.RawMessage) (docNode, bool) {
	var d docNode
	if err := json.Unmarshal(raw, &d); err != nil {
		b.cfg.Logger.Warn("neo4j submit unmarshal", "err", err)
		return d, false
	}
	return d, true
}

// FOREACH is used instead of UNWIND+WITH chains because UNWIND on an empty
// list produces zero rows, which silently drops all downstream clauses for
// that document (no edges of any kind would be created). FOREACH is
// row-count-neutral: an empty list is a no-op and subsequent clauses still
// execute.
const cypherUpsert = `
UNWIND $docs AS doc
MERGE (d:Document {id: doc.id})
SET d.title = doc.title,
    d.source = doc.source,
    d.citation_count = doc.citation_count,
    d.pagerank = doc.pagerank,
    d.published_at = doc.published_at
FOREACH (term IN coalesce(doc.mesh_terms, []) |
  MERGE (m:MeshTerm {name: term})
  MERGE (d)-[:TAGGED_WITH]->(m)
)
FOREACH (author IN coalesce(doc.authors, []) |
  MERGE (a:Author {key: coalesce(author.orcid, author.display_name)})
  ON CREATE SET a.display_name = author.display_name, a.orcid = author.orcid
  MERGE (d)-[:AUTHORED_BY]->(a)
  FOREACH (p IN coalesce(author.payments, []) |
    MERGE (s:Sponsor {name: p.sponsor_name})
    MERGE (a)-[r:RECEIVED_PAYMENT {year: p.year}]->(s)
    ON CREATE SET r.amount_usd = p.amount_usd, r.payment_type = p.payment_type
  )
)
FOREACH (cited_id IN coalesce(doc.citations, []) |
  MERGE (c:Document {id: cited_id})
  MERGE (d)-[:CITES]->(c)
)
`

func (b *Batcher) Run(ctx context.Context) {
	b.wg.Add(1)
	defer b.wg.Done()
	tick := time.NewTicker(time.Duration(b.cfg.FlushAfterSeconds) * time.Second)
	defer tick.Stop()

	batch := make([]docNode, 0, b.cfg.BatchSize)
	flush := func() {
		if len(batch) == 0 { return }
		b.cfg.Logger.Info("flush", "n", len(batch))
		params := map[string]any{"docs": flatten(batch)}
		ses := b.driver.NewSession(ctx, neo4j.SessionConfig{})
		defer ses.Close(ctx)
		_, err := ses.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
			return tx.Run(ctx, cypherUpsert, params)
		})
		if err != nil {
			b.cfg.Logger.Error("neo4j upsert", "n", len(batch), "err", err)
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
		case d := <-b.in:
			batch = append(batch, d)
			if len(batch) >= b.cfg.BatchSize {
				flush()
			}
		}
	}
}

// flatten coerces typed structs to map[string]any for Neo4j param binding.
func flatten(docs []docNode) []map[string]any {
	out := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		authors := make([]map[string]any, 0, len(d.Authors))
		for _, a := range d.Authors {
			payments := make([]map[string]any, 0, len(a.Payments))
			for _, p := range a.Payments {
				payments = append(payments, map[string]any{
					"sponsor_name": p.SponsorName, "year": p.Year,
					"amount_usd": p.AmountUSD, "payment_type": p.PaymentType,
				})
			}
			authors = append(authors, map[string]any{
				"display_name": a.DisplayName, "orcid": a.ORCID, "payments": payments,
			})
		}
		out = append(out, map[string]any{
			"id": d.ID, "title": d.Title, "source": d.Source,
			"citation_count": d.CitationCount, "pagerank": d.PageRank,
			"published_at": d.PublishedAt, "citations": d.Citations,
			"mesh_terms": d.MeshTerms, "authors": authors,
		})
	}
	return out
}

func (b *Batcher) Close() {
	close(b.in)
	b.wg.Wait()
	_ = b.driver.Close(context.Background())
}
