// reindex-neo4j: One-off tool to replay NATS indexable-docs.> events into Neo4j.
//
// Use this to retroactively populate the citation graph if Neo4j was
// down or if the schema changed. It creates an ephemeral consumer to
// read the entire stream from the beginning.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/evidencelens/evidencelens/index/pkg/batchers/neo4jb"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sigs; cancel() }()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "reindex-neo4j")

	nc, err := nats.Connect(getenv("NATS_URL", "nats://localhost:4222"))
	if err != nil {
		logger.Error("nats connect", "err", err)
		return
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		logger.Error("jetstream", "err", err)
		return
	}

	// Connect to Neo4j using indexer config.
	nb, err := neo4jb.New(neo4jb.Config{
		URL:       getenv("NEO4J_URL", "bolt://localhost:7687"),
		User:      getenv("NEO4J_USER", "neo4j"),
		Password:  getenv("NEO4J_PASSWORD", "changeme-dev-only"),
		BatchSize: 500,
		FlushAfterSeconds: 2, // Faster flush for replay
		Logger:    logger.With("batcher", "neo4j"),
	})
	if err != nil {
		logger.Error("neo4j init", "err", err)
		return
	}
	go nb.Run(ctx)

	streamName := getenv("NATS_STREAM", "EVIDENCELENS")
	consumerName := fmt.Sprintf("reindex-neo4j-%d", time.Now().Unix())
	
	cons, err := js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		Name:           consumerName,
		FilterSubjects: []string{"indexable-docs.>"},
		DeliverPolicy:  jetstream.DeliverAllPolicy,
		AckPolicy:      jetstream.AckExplicitPolicy,
	})
	if err != nil {
		logger.Error("consumer", "err", err)
		return
	}

	logger.Info("starting replay", "consumer", consumerName, "stream", streamName)

	processed := 0
	lastLog := time.Now()

	consCtx, err := cons.Consume(func(msg jetstream.Msg) {
		var ev struct {
			Document json.RawMessage `json:"document"`
		}
		if err := json.Unmarshal(msg.Data(), &ev); err != nil {
			logger.Warn("unmarshal error", "err", err)
			_ = msg.Ack()
			return
		}
		nb.SubmitBlocking(ev.Document)
		_ = msg.Ack()
		processed++

		if time.Since(lastLog) > 5*time.Second {
			logger.Info("progress", "count", processed)
			lastLog = time.Now()
		}
	})
	if err != nil {
		logger.Error("consume", "err", err)
		return
	}

	// Monitor for completion
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Info("interrupted")
			goto shutdown
		case <-ticker.C:
			info, err := cons.Info(ctx)
			if err != nil {
				logger.Warn("cons info error", "err", err)
				continue
			}
			if info.NumPending == 0 && info.NumAckPending == 0 {
				logger.Info("replay complete", "total", processed)
				goto shutdown
			}
		}
	}

shutdown:
	consCtx.Stop() // Stop receiving new messages first
	nb.Close()     // Then close the batcher (Wait for in-flight flushes)
	// Cleanup ephemeral consumer
	_ = js.DeleteConsumer(context.Background(), streamName, consumerName)
	logger.Info("shutdown complete")
}
