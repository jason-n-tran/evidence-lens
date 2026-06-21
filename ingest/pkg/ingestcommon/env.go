// Package ingestcommon provides the shared infrastructure for every
// EvidenceLens ingester: env-var config, HTTP retry, watermark, R2
// archival, Pub/Sub publishing, OTel instrumentation, and structured
// logging.
//
// Pattern lifted from Moogle's spider package (see
// services/spider/cmd/spider/main.go in the moogle repo) and extended
// with proto-typed events, OTel context propagation, and per-source
// rate limiters.
package ingestcommon

import (
	"os"
	"strconv"
	"time"
)

// GetEnv returns the value of the named env var, or fallback if unset
// or empty. Mirrors Moogle's pattern.
func GetEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// GetEnvInt returns env var as int, or fallback on parse failure.
func GetEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// GetEnvDuration parses a Go duration ("10s", "5m", "1h") from env, or
// returns fallback.
func GetEnvDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

// MustEnv returns the value of the named env var or panics if unset.
// Use only at startup for required configuration.
func MustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic("required env var not set: " + key)
	}
	return v
}
