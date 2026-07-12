// indexer (spec section 5.4) — consumes NATS indexable-docs.> and fans
// out to three batchers (Meilisearch, Milvus, Neo4j) in parallel.
//
// Skeleton lifted from Moogle's indexer/main.py pattern (signal handling
// + batching with size threshold) and extended with time-based flush
// and per-destination batchers.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/evidencelens/evidencelens/index/pkg/batchers/meili"
	"github.com/evidencelens/evidencelens/index/pkg/batchers/milvus"
	"github.com/evidencelens/evidencelens/index/pkg/batchers/neo4jb"
	"github.com/evidencelens/evidencelens/index/pkg/initdata"
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

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "indexer")

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

	// Idempotent stream creation. This must run before any consumer or
	// publisher touches NATS, including on the processor side.
	streamName := getenv("NATS_STREAM", "EVIDENCELENS")
	_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     streamName,
		Subjects: []string{"raw-docs.>", "indexable-docs.>", "dlq.>"},
		Storage:  jetstream.FileStorage,
		Replicas: 1,
	})
	if err != nil {
		logger.Error("stream create", "err", err)
		return
	}
	logger.Info("nats stream ready", "stream", streamName)

	// One-time idempotent init: Milvus collection + Neo4j indexes.
	vectorSize := 0 // 0 = use default (1024); overridden by EMBEDDING_DIM
	if s := getenv("EMBEDDING_DIM", ""); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			vectorSize = n
		}
	}
	if err := initdata.EnsureMilvusCollection(ctx, initdata.MilvusConfig{
		URI:        getenv("MILVUS_URI", "http://localhost:19530"),
		Token:      getenv("MILVUS_TOKEN", ""),
		Collection: "evidence_v1",
		VectorSize: vectorSize,
		Logger:     logger.With("init", "milvus"),
	}); err != nil {
		logger.Warn("milvus collection init", "err", err)
	}
	if err := initdata.EnsureNeo4jIndexes(ctx, initdata.Neo4jConfig{
		URL:      getenv("NEO4J_URL", "bolt://localhost:7687"),
		User:     getenv("NEO4J_USER", "neo4j"),
		Password: getenv("NEO4J_PASSWORD", "changeme-dev-only"),
		Logger:   logger.With("init", "neo4j"),
	}); err != nil {
		logger.Warn("neo4j index init", "err", err)
	}

	// Three batchers, each running its own goroutine.
	mb, err := meili.New(meili.Config{
		URL:               getenv("MEILI_URL", "http://localhost:7700"),
		APIKey:            getenv("MEILI_KEY", ""),
		IndexName:         "documents",
		BatchSize:         1000,
		FlushAfterSeconds: 5,
		Logger:            logger.With("batcher", "meili"),
	})
	if err != nil {
		logger.Error("meili init", "err", err)
		return
	}
	go mb.Run(ctx)

	vb, err := milvus.New(milvus.Config{
		URI:               getenv("MILVUS_URI", "http://localhost:19530"),
		Token:             getenv("MILVUS_TOKEN", ""),
		Collection:        "evidence_v1",
		BatchSize:         100,
		FlushAfterSeconds: 5,
		Logger:            logger.With("batcher", "milvus"),
	})
	if err != nil {
		logger.Error("milvus init", "err", err)
		return
	}
	go vb.Run(ctx)

	nb, err := neo4jb.New(neo4jb.Config{
		URL:               getenv("NEO4J_URL", "bolt://localhost:7687"),
		User:              getenv("NEO4J_USER", "neo4j"),
		Password:          getenv("NEO4J_PASSWORD", "changeme-dev-only"),
		BatchSize:         500,
		FlushAfterSeconds: 5,
		Logger:            logger.With("batcher", "neo4j"),
	})
	if err != nil {
		logger.Error("neo4j init", "err", err)
		return
	}
	go nb.Run(ctx)

	cons, err := js.CreateOrUpdateConsumer(ctx, "EVIDENCELENS", jetstream.ConsumerConfig{
		Durable:        "indexer",
		FilterSubjects: []string{"indexable-docs.>"},
		AckPolicy:      jetstream.AckExplicitPolicy,
		MaxAckPending:  1000,
		MaxDeliver:     5,
	})
	if err != nil {
		logger.Error("consumer", "err", err)
		return
	}

	// DLQ publisher: bare nats.Conn.Publish to dlq.indexer subject.
	dlq := func(payload []byte, reason string) {
		_ = nc.Publish("dlq.indexer", append([]byte("# "+reason+"\n"), payload...))
	}

	consCtx, err := cons.Consume(func(msg jetstream.Msg) {
		var ev struct {
			Document json.RawMessage `json:"document"`
		}
		if err := json.Unmarshal(msg.Data(), &ev); err != nil {
			dlq(msg.Data(), "unmarshal: "+err.Error())
			_ = msg.Ack()
			return
		}
		// Fan out to all three batchers. Each is non-blocking buffered.
		mb.Submit(ev.Document)
		vb.Submit(ev.Document)
		nb.Submit(ev.Document)
		_ = msg.Ack()
	})
	if err != nil {
		logger.Error("consume", "err", err)
		return
	}
	defer consCtx.Stop()

	// SIGUSR1 -> manual flush. Documented in
	// docs/runbooks/indexer-dlq.md as the "force flush everything" hook.
	flushSig := make(chan os.Signal, 1)
	registerFlushSignal(flushSig)
	go func() {
		for range flushSig {
			logger.Info("manual flush requested")
			mb.Flush()
			vb.Flush()
			nb.Flush()
		}
	}()

	logger.Info("indexer running")
	<-ctx.Done()
	logger.Info("indexer shutting down")
	mb.Close()
	vb.Close()
	nb.Close()
}
