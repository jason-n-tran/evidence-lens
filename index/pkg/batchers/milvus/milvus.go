// Package milvus batches embedding upserts into Milvus via RESTful API v2.
//
// Spec §5.4: batch 100 vectors OR 5s. Collection evidence_v1, HNSW,
// 1024-d. Idempotent by doc_id (string primary key — no hash trick needed).
package milvus

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Config struct {
	URI               string
	Token             string
	Collection        string
	BatchSize         int
	FlushAfterSeconds int
	Logger            *slog.Logger
}

// docPayload models the bits of Document we need: id + embedding + facet
// fields used for Milvus scalar filtering.
type docPayload struct {
	ID            string    `json:"id"`
	Embedding     []float32 `json:"embedding"`
	Source        string    `json:"source"`
	StudyType     string    `json:"study_type"`
	PublishedYear int       `json:"published_year"`
	HasCOI        bool      `json:"has_coi_authors"`
	License       string    `json:"license"`
}

type Batcher struct {
	cfg      Config
	in       chan docPayload
	flushReq chan struct{}
	wg       sync.WaitGroup
	client   *http.Client
}

func New(cfg Config) (*Batcher, error) {
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 100
	}
	if cfg.FlushAfterSeconds == 0 {
		cfg.FlushAfterSeconds = 5
	}
	return &Batcher{
		cfg:      cfg,
		in:       make(chan docPayload, cfg.BatchSize*2),
		flushReq: make(chan struct{}, 1),
		client:   &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// Flush requests a manual flush (wired to SIGUSR1).
func (b *Batcher) Flush() {
	select {
	case b.flushReq <- struct{}{}:
	default:
	}
}

func (b *Batcher) Submit(raw json.RawMessage) {
	var d docPayload
	if err := json.Unmarshal(raw, &d); err != nil {
		b.cfg.Logger.Warn("milvus submit unmarshal", "err", err)
		return
	}
	if len(d.Embedding) == 0 {
		return
	}
	select {
	case b.in <- d:
	default:
		b.cfg.Logger.Warn("milvus batcher dropping; channel full")
	}
}
