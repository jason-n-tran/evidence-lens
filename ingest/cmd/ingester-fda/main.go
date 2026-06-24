// ingester-fda: openFDA drug + device endpoints (spec section 5.1.5).
//
// Recall events get a priority lane: in addition to the normal raw-docs
// publish, recalls also publish a RecallEvent to NATS recall-fanout for
// the gateway WS subscribers (SLO ≤ 1min E2E per spec section 14.1).
package main

import (
	"context"

	"os"

	"github.com/evidencelens/evidencelens/ingest/internal/ingesters/fda"
	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/otel"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

func main() {
	ctx, cancel := ingestcommon.Setup(context.Background())
	defer cancel()
	logger := ingestcommon.MustNewLogger("ingester-fda")
	shutdown, _ := otel.Init(ctx, "ingester-fda")
	defer func() { if shutdown != nil { _ = shutdown(context.Background()) } }()

	wm, err := watermark.New(ctx, ingestcommon.MustEnv("DATABASE_URL"))
	if err != nil { logger.Error("watermark", "err", err); return }
	defer wm.Close()

	arch, err := objectstore.New(
		ingestcommon.MustEnv("S3_ACCESS_KEY_ID"),
		ingestcommon.MustEnv("S3_SECRET_ACCESS_KEY"),
		ingestcommon.MustEnv("S3_BUCKET"),
		ingestcommon.MustEnv("S3_ENDPOINT"),
	)
	if err != nil { logger.Error("objectstore init", "err", err); return }
	pub, err := natspub.New(ctx, ingestcommon.MustEnv("NATS_URL"), ingestcommon.GetEnv("NATS_SUBJECT_RAW_DOCS", "raw-docs"))
	if err != nil { logger.Error("nats init", "err", err); return }
	defer pub.Close()

	ing := fda.New(fda.Config{
		APIKey:    ingestcommon.GetEnv("OPENFDA_API_KEY", ""),
		MaxPerRun: ingestcommon.GetEnvInt("FDA_MAX_PER_RUN", 5000),
		Endpoints: []string{"drug/drugsfda", "drug/enforcement", "device/event", "device/510k"},
		NATSURL:   ingestcommon.GetEnv("NATS_URL", "nats://localhost:4222"),
	}, logger, wm, arch, pub)
	runner := &ingestcommon.Runner{Source: "fda", Logger: logger, Run: ing.Run}
	os.Exit(ingestcommon.RunCLI(ctx, runner))
}
