// ingester-trials: ClinicalTrials.gov v2 (spec section 5.1.3).
package main

import (
	"context"

	"os"

	"github.com/evidencelens/evidencelens/ingest/internal/ingesters/trials"
	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/otel"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

func main() {
	ctx, cancel := ingestcommon.Setup(context.Background())
	defer cancel()
	logger := ingestcommon.MustNewLogger("ingester-trials")
	shutdown, _ := otel.Init(ctx, "ingester-trials")
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

	ing := trials.New(trials.Config{PageSize: ingestcommon.GetEnvInt("CTGOV_PAGE_SIZE", 1000), MaxPerRun: ingestcommon.GetEnvInt("CTGOV_MAX_PER_RUN", 10000)}, logger, wm, arch, pub)
	runner := &ingestcommon.Runner{Source: "trials", Logger: logger, Run: ing.Run}
	os.Exit(ingestcommon.RunCLI(ctx, runner))
}
