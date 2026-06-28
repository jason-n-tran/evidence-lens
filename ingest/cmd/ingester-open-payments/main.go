// ingester-open-payments: CMS Open Payments annual bulk CSV (spec section
// 5.1.10). FLAGSHIP — drives every COIBadge in the frontend.
//
// Two roles:
//   1. Annual bulk fetch: download CSV from
//      download.cms.gov/openpayments/PGYY_P0NNNNNN.zip and bulk-load into
//      Postgres open_payments table.
//   2. /lookup endpoint: synchronous HTTP API consumed by the processor's
//      author-payment-joiner to fuzzy-match author -> NPI/payments.
//
// Unlike the other 25 ingesters, this one is a long-running HTTP server
// (the /lookup endpoint), not a one-shot — it's deployed as a normal
// Dokploy app rather than a scheduled container. The annual bulk fetch
// is triggered by a separate Dokploy schedule that POSTs /reload.
package main

import (
	"context"

	"github.com/evidencelens/evidencelens/ingest/internal/ingesters/openpayments"
	"github.com/evidencelens/evidencelens/ingest/pkg/ingestcommon"
	"github.com/evidencelens/evidencelens/ingest/pkg/objectstore"
	"github.com/evidencelens/evidencelens/ingest/pkg/otel"
)

func main() {
	ctx, cancel := ingestcommon.Setup(context.Background())
	defer cancel()
	logger := ingestcommon.MustNewLogger("ingester-open-payments")
	shutdown, _ := otel.Init(ctx, "ingester-open-payments")
	defer func() {
		if shutdown != nil {
			_ = shutdown(context.Background())
		}
	}()

	arch, err := objectstore.New(
		ingestcommon.MustEnv("S3_ACCESS_KEY_ID"),
		ingestcommon.MustEnv("S3_SECRET_ACCESS_KEY"),
		ingestcommon.MustEnv("S3_BUCKET"),
		ingestcommon.MustEnv("S3_ENDPOINT"),
	)
	if err != nil {
		logger.Error("objectstore init", "err", err)
		return
	}

	srv := openpayments.NewServer(openpayments.Config{
		DatabaseURL:        ingestcommon.MustEnv("DATABASE_URL"),
		MinFuzzyConfidence: 0.90,
	}, logger, arch)
	if err := srv.ListenAndServe(ctx); err != nil {
		logger.Error("server", "err", err)
	}
}
