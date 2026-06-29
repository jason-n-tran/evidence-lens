// ingester-nih-reporter: NIH RePORTER funding records (spec section 5.1.9).
package main

import (
	"context"

	"os"

	"github.com/evidencelens/evidencelens/ingest/internal/ingesters/nihreporter"
	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/otel"
	"github.com/evidencelens/evidencelens/ingest/pkg/natspub"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/watermark"
)

func main() {
	ctx, cancel := ingestcommon.Setup(context.Background())
	defer cancel()
	logger := ingestcommon.MustNewLogger("ingester-nih-reporter")
	shutdown, _ := otel.Init(ctx, "ingester-nih-reporter")
	defer func() { if shutdown != nil { _ = shutdown(context.Background()) } }()

	wm, _ := watermark.New(ctx, ingestcommon.MustEnv("DATABASE_URL"))
	defer wm.Close()

	arch, _ := objectstore.New(
		ingestcommon.MustEnv("S3_ACCESS_KEY_ID"),
		ingestcommon.MustEnv("S3_SECRET_ACCESS_KEY"),
		ingestcommon.MustEnv("S3_BUCKET"),
		ingestcommon.MustEnv("S3_ENDPOINT"),
	)
	pub, _ := natspub.New(ctx, ingestcommon.MustEnv("NATS_URL"), ingestcommon.GetEnv("NATS_SUBJECT_RAW_DOCS", "raw-docs"))
	defer pub.Close()

	ing := nihreporter.New(nihreporter.Config{MaxPerRun: ingestcommon.GetEnvInt("NIH_MAX_PER_RUN", 5000)}, logger, wm, arch, pub)
	runner := &ingestcommon.Runner{Source: "nih-reporter", Logger: logger, Run: ing.Run}
	os.Exit(ingestcommon.RunCLI(ctx, runner))
}
