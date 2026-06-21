package ingestcommon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// ServeRun starts an HTTP server on the configured PORT (Cloud Run
// convention: env var PORT, default 8080). Two routes:
//   POST /run   — invoke the ingester once, return JSON RunResult.
//   GET  /healthz — liveness.
//
// Cloud Run's request-response invocation model fits this perfectly: the
// scheduler hits /run on cron, Cloud Run scales to 1 for the duration,
// then back to 0.
func ServeRun(ctx context.Context, runner *Runner) error {
	port := GetEnv("PORT", "8080")
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		deadline := GetEnvDuration("CLOUD_RUN_TIMEOUT", 14*time.Minute)
		res := runner.RunOnce(r.Context(), deadline)
		w.Header().Set("Content-Type", "application/json")
		if res.Error != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":          "failed",
				"error":           res.Error.Error(),
				"docs_fetched":    res.DocsFetched,
				"docs_archived":   res.DocsArchived,
				"duration_s":      res.DurationSeconds,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":          "ok",
			"docs_fetched":    res.DocsFetched,
			"docs_archived":   res.DocsArchived,
			"docs_published":  res.DocsPublished,
			"high_watermark":  res.HighWatermark,
			"duration_s":      res.DurationSeconds,
		})
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%s", port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	runner.Logger.Info("http server listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
