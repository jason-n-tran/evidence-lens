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

func (b *Batcher) Run(ctx context.Context) {
	b.wg.Add(1)
	defer b.wg.Done()

	tick := time.NewTicker(time.Duration(b.cfg.FlushAfterSeconds) * time.Second)
	defer tick.Stop()

	batch := make([]docPayload, 0, b.cfg.BatchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := b.upsert(ctx, batch); err != nil {
			b.cfg.Logger.Error("milvus upsert", "n", len(batch), "err", err)
		} else {
			b.cfg.Logger.Info("flush", "n", len(batch))
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

// milvusEntity is one row in the Milvus upsert payload. doc_id is the
// primary key (VARCHAR), so Milvus deduplicates by doc_id automatically.
type milvusEntity struct {
	DocID         string    `json:"doc_id"`
	Embedding     []float32 `json:"embedding"`
	Source        string    `json:"source"`
	StudyType     string    `json:"study_type"`
	PublishedYear int       `json:"published_year"`
	HasCOI        bool      `json:"has_coi_authors"`
	License       string    `json:"license"`
}

type milvusUpsertBody struct {
	CollectionName string         `json:"collectionName"`
	Data           []milvusEntity `json:"data"`
}

// upsert calls the Milvus RESTful API v2 to upsert a batch of vectors.
// POST /v2/vectordb/entities/upsert — idempotent by doc_id primary key.
func (b *Batcher) upsert(ctx context.Context, batch []docPayload) error {
	entities := make([]milvusEntity, 0, len(batch))
	for _, d := range batch {
		entities = append(entities, milvusEntity{
			DocID:         d.ID,
			Embedding:     d.Embedding,
			Source:        d.Source,
			StudyType:     d.StudyType,
			PublishedYear: d.PublishedYear,
			HasCOI:        d.HasCOI,
			License:       d.License,
		})
	}

	body, _ := json.Marshal(milvusUpsertBody{
		CollectionName: b.cfg.Collection,
		Data:           entities,
	})

	url := strings.TrimRight(b.cfg.URI, "/") + "/v2/vectordb/entities/upsert"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if b.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+b.cfg.Token)
	}

	resp, err := b.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("milvus http %d", resp.StatusCode)
	}

	// Milvus RESTful v2 returns HTTP 200 for all responses;
	// check the body code for application-level errors.
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil // body parse error is non-fatal for upsert
	}
	if result.Code != 0 {
		return fmt.Errorf("milvus upsert error %d: %s", result.Code, result.Message)
	}
	return nil
}

func (b *Batcher) Close() {
	close(b.in)
	b.wg.Wait()
}
