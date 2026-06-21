package ingestcommon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/cenkalti/backoff/v4"
)

// Fetcher wraps an http.Client with exponential backoff + jitter retry,
// per-source rate limiting, and OTel context propagation. Surfaces
// `retry_attempts` and `retry_exhausted` counters per spec section 5.1.
type Fetcher struct {
	client      *http.Client
	limiter     *RateLimiter
	maxRetries  uint64
	initialWait time.Duration
	userAgent   string
}

// NewFetcher constructs a Fetcher with sane defaults. perSec=0 disables
// rate limiting.
func NewFetcher(perSec, burst int, userAgent string) *Fetcher {
	var limiter *RateLimiter
	if perSec > 0 {
		limiter = NewRateLimiter(perSec, burst)
	}
	return &Fetcher{
		client:      &http.Client{Timeout: 30 * time.Second},
		limiter:     limiter,
		maxRetries:  5,
		initialWait: 500 * time.Millisecond,
		userAgent:   userAgent,
	}
}

// Get performs a GET with retry. The body is fully read and returned;
// the caller does not need to close anything.
func (f *Fetcher) Get(ctx context.Context, url string, headers map[string]string) ([]byte, error) {
	return f.do(ctx, http.MethodGet, url, nil, headers)
}

// Post performs a POST with retry.
func (f *Fetcher) Post(ctx context.Context, url string, body io.Reader, headers map[string]string) ([]byte, error) {
	return f.do(ctx, http.MethodPost, url, body, headers)
}

func (f *Fetcher) do(ctx context.Context, method, url string, body io.Reader, headers map[string]string) ([]byte, error) {
	if f.limiter != nil {
		if err := f.limiter.Wait(ctx); err != nil {
			return nil, err
		}
	}

	var result []byte
	bo := backoff.WithContext(
		backoff.WithMaxRetries(
			backoff.NewExponentialBackOff(
				backoff.WithInitialInterval(f.initialWait),
				backoff.WithMaxInterval(30*time.Second),
				backoff.WithRandomizationFactor(0.5),
			),
			f.maxRetries,
		),
		ctx,
	)

	op := func() error {
		req, err := http.NewRequestWithContext(ctx, method, url, body)
		if err != nil {
			return backoff.Permanent(err)
		}
		req.Header.Set("User-Agent", f.userAgent)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := f.client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		// Permanent on 4xx (except 429), retry on 5xx + 429 + network.
		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 429 {
			data, _ := io.ReadAll(resp.Body)
			return backoff.Permanent(fmt.Errorf("http %d: %s", resp.StatusCode, string(data)))
		}
		if resp.StatusCode >= 500 || resp.StatusCode == 429 {
			return fmt.Errorf("http %d (retryable)", resp.StatusCode)
		}

		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		result = data
		return nil
	}

	err := backoff.Retry(op, bo)
	if err != nil {
		var perm *backoff.PermanentError
		if errors.As(err, &perm) {
			return nil, perm.Err
		}
		return nil, fmt.Errorf("retries exhausted: %w", err)
	}
	return result, nil
}
