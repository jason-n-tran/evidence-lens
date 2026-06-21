// Package watermark reads / writes per-source ingestion checkpoints to
// the Postgres `ingestion_state` table (spec section 3.5).
package watermark

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is a thin wrapper around pgxpool.Pool for ingestion_state.
type Store struct{ pool *pgxpool.Pool }

// New connects to Postgres and returns a Store.
func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgx pool: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Get returns the current high-watermark string for source. Empty string
// + nil error means "first run, no watermark yet".
func (s *Store) Get(ctx context.Context, source string) (string, error) {
	var hw string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(last_high_watermark, '') FROM ingestion_state WHERE source = $1
	`, source).Scan(&hw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return hw, err
}

// Set writes high-watermark + status + last_run_at atomically.
func (s *Store) Set(ctx context.Context, source, highWatermark, status, errMsg string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ingestion_state (source, last_run_at, last_high_watermark, status, last_error, updated_at)
		VALUES ($1, NOW(), $2, $3, NULLIF($4,''), NOW())
		ON CONFLICT (source) DO UPDATE SET
			last_run_at = EXCLUDED.last_run_at,
			last_high_watermark = EXCLUDED.last_high_watermark,
			status = EXCLUDED.status,
			last_error = EXCLUDED.last_error,
			updated_at = EXCLUDED.updated_at
	`, source, highWatermark, status, errMsg)
	return err
}

// MarkRunning is a convenience for "I'm starting".
func (s *Store) MarkRunning(ctx context.Context, source string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ingestion_state (source, last_run_at, status, updated_at)
		VALUES ($1, NOW(), 'running', NOW())
		ON CONFLICT (source) DO UPDATE SET
			status = 'running',
			last_run_at = NOW(),
			updated_at = NOW()
	`, source)
	return err
}

// SinceLastRun returns time since last_run_at; zero on first run.
func (s *Store) SinceLastRun(ctx context.Context, source string) (time.Duration, error) {
	var ts *time.Time
	err := s.pool.QueryRow(ctx, `SELECT last_run_at FROM ingestion_state WHERE source=$1`, source).Scan(&ts)
	if errors.Is(err, pgx.ErrNoRows) || ts == nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return time.Since(*ts), nil
}
