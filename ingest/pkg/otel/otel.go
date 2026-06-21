// Package otel sets up OpenTelemetry traces for an ingester. Reads
// OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME from env. Returns a
// shutdown func the caller must defer.
package otel

import (
	"context"
	"fmt"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Init wires up the OTLP HTTP trace exporter and a batch span processor.
// Pass the service name; env var OTEL_SERVICE_NAME overrides if set.
func Init(ctx context.Context, defaultServiceName string) (func(context.Context) error, error) {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		// No-op: nil shutdown, no exporter wired.
		return func(context.Context) error { return nil }, nil
	}

	serviceName := os.Getenv("OTEL_SERVICE_NAME")
	if serviceName == "" {
		serviceName = defaultServiceName
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
		),
		resource.WithFromEnv(),
		resource.WithProcess(),
		resource.WithHost(),
	)
	if err != nil {
		return nil, fmt.Errorf("otel resource: %w", err)
	}

	exp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(stripScheme(endpoint)),
		otlptracehttp.WithInsecure(), // collector is in-cluster
	)
	if err != nil {
		return nil, fmt.Errorf("otlp exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(1.0))),
	)
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}

func stripScheme(s string) string {
	for _, p := range []string{"https://", "http://"} {
		if len(s) > len(p) && s[:len(p)] == p {
			return s[len(p):]
		}
	}
	return s
}
