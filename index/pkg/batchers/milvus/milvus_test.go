package milvus

import (
	"encoding/json"
	"log/slog"
	"os"
	"testing"
)

func TestNew(t *testing.T) {
	b, err := New(Config{
		URI:        "http://localhost:19530",
		Collection: "evidence_v1",
		Logger:     slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if b.cfg.BatchSize != 100 {
		t.Errorf("default batch size = %d, want 100", b.cfg.BatchSize)
	}
	if b.cfg.FlushAfterSeconds != 5 {
		t.Errorf("default flush seconds = %d, want 5", b.cfg.FlushAfterSeconds)
	}
}

func TestSubmitDropsEmpty(t *testing.T) {
	b, _ := New(Config{
		URI:        "http://localhost:19530",
		Collection: "evidence_v1",
		Logger:     slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	// doc with no embedding should not be enqueued
	raw, _ := json.Marshal(map[string]any{"id": "doc1"})
	b.Submit(raw)
	if len(b.in) != 0 {
		t.Error("expected empty channel for doc with no embedding")
	}
}

func TestSubmitEnqueues(t *testing.T) {
	b, _ := New(Config{
		URI:        "http://localhost:19530",
		Collection: "evidence_v1",
		Logger:     slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	raw, _ := json.Marshal(map[string]any{
		"id":        "doc1",
		"embedding": []float32{0.1, 0.2, 0.3},
		"source":    "pubmed",
	})
	b.Submit(raw)
	if len(b.in) != 1 {
		t.Errorf("expected 1 item in channel, got %d", len(b.in))
	}
}
