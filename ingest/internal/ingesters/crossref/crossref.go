// Package crossref enriches DOI metadata via api.crossref.org/works/{doi}
// (spec §5.1.7).
//
// Two trigger modes:
//   - Single DOI: env CROSSREF_DOI set (used by per-record HTTP triggers
//     from the processor).
//   - Batch: cron-driven sweep of DOIs lacking journal/publisher metadata.
//     Reads candidates from the `crossref_enrich_queue` table populated
//     by the processor when it parses a record with a DOI but no
//     journal record. CROSSREF_BATCH_SIZE caps work per /run.
package crossref

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"

	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct{ Email string }

type Ingester struct {
	cfg      Config
	logger   *slog.Logger
	wm       *watermark.Store
	archiver *objectstore.Archiver
	pub      *natspub.Publisher
	fetcher  *ingestcommon.Fetcher
	pool     *pgxpool.Pool
}

func New(cfg Config, logger *slog.Logger, wm *watermark.Store, arch *objectstore.Archiver, pub *natspub.Publisher) *Ingester {
	i := &Ingester{
		cfg: cfg, logger: logger, wm: wm, archiver: arch, pub: pub,
		fetcher: ingestcommon.NewFetcher(50, 100, fmt.Sprintf("EvidenceLens/0.1 (mailto:%s)", cfg.Email)),
	}
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		if pool, err := pgxpool.New(context.Background(), dsn); err == nil {
			i.pool = pool
		}
	}
	return i
}

// Run dispatches single-DOI or batch mode based on env.
func (i *Ingester) Run(ctx context.Context) (ingestcommon.RunResult, error) {
	if err := i.wm.MarkRunning(ctx, "crossref"); err != nil {
		return ingestcommon.RunResult{}, err
	}
	if doi := os.Getenv("CROSSREF_DOI"); doi != "" {
		return i.enrichOne(ctx, doi)
	}
	return i.enrichBatch(ctx)
}

func (i *Ingester) enrichOne(ctx context.Context, doi string) (ingestcommon.RunResult, error) {
	body, err := i.fetcher.Get(ctx, fmt.Sprintf("https://api.crossref.org/works/%s", doi), nil)
	if err != nil {
		return ingestcommon.RunResult{}, err
	}
	id := "doi:" + doi
	rawJSON, _ := json.Marshal(json.RawMessage(body))
	key, err := i.archiver.Put(ctx, "crossref", id, rawJSON)
	if err != nil {
		return ingestcommon.RunResult{}, err
	}
	if _, err := i.pub.PublishRaw(ctx, "crossref", id, key); err != nil {
		return ingestcommon.RunResult{}, err
	}
	return ingestcommon.RunResult{DocsFetched: 1, DocsArchived: 1, DocsPublished: 1}, nil
}

// enrichBatch pulls a capped batch of DOIs lacking metadata from
// crossref_enrich_queue and processes them with the fetcher's per-second
// rate cap. The table is created lazily; the schema is documented in
// docs/sources/crossref.md.
func (i *Ingester) enrichBatch(ctx context.Context) (ingestcommon.RunResult, error) {
	limit, _ := strconv.Atoi(ingestcommon.GetEnv("CROSSREF_BATCH_SIZE", "500"))
	if i.pool == nil {
		i.logger.Info("crossref: no DATABASE_URL; batch path disabled")
		return ingestcommon.RunResult{}, nil
	}
	if err := i.ensureQueueTable(ctx); err != nil {
		return ingestcommon.RunResult{}, err
	}
	rows, err := i.pool.Query(ctx,
		`DELETE FROM crossref_enrich_queue
		 WHERE doi IN (
		   SELECT doi FROM crossref_enrich_queue
		   ORDER BY enqueued_at ASC LIMIT $1
		 )
		 RETURNING doi`,
		limit,
	)
	if err != nil {
		return ingestcommon.RunResult{}, err
	}
	defer rows.Close()
	var dois []string
	for rows.Next() {
		var doi string
		if err := rows.Scan(&doi); err == nil {
			dois = append(dois, doi)
		}
	}
	var counters ingestcommon.Counters
	for _, doi := range dois {
		counters.Fetched.Add(1)
		body, err := i.fetcher.Get(ctx, fmt.Sprintf("https://api.crossref.org/works/%s", doi), nil)
		if err != nil {
			counters.Failed.Add(1)
			i.requeue(ctx, doi)
			continue
		}
		id := "doi:" + doi
		rawJSON, _ := json.Marshal(json.RawMessage(body))
		key, err := i.archiver.Put(ctx, "crossref", id, rawJSON)
		if err != nil {
			counters.Failed.Add(1)
			i.requeue(ctx, doi)
			continue
		}
		counters.Archived.Add(1)
		if _, err := i.pub.PublishRaw(ctx, "crossref", id, key); err == nil {
			counters.Published.Add(1)
		}
	}
	return ingestcommon.RunResult{
		DocsFetched:   counters.Fetched.Load(),
		DocsArchived:  counters.Archived.Load(),
		DocsPublished: counters.Published.Load(),
	}, nil
}

func (i *Ingester) ensureQueueTable(ctx context.Context) error {
	_, err := i.pool.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS crossref_enrich_queue (
		   doi TEXT PRIMARY KEY,
		   enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		 )`,
	)
	return err
}

func (i *Ingester) requeue(ctx context.Context, doi string) {
	_, _ = i.pool.Exec(ctx,
		`INSERT INTO crossref_enrich_queue (doi) VALUES ($1)
		 ON CONFLICT (doi) DO NOTHING`,
		doi,
	)
}
