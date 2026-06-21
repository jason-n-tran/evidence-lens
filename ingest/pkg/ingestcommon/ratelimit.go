package ingestcommon

import (
	"context"
	"sync"
	"time"
)

// RateLimiter is a simple token bucket. Standalone (no x/time/rate
// dependency) so the binary stays small.
type RateLimiter struct {
	mu       sync.Mutex
	tokens   float64
	capacity float64
	rate     float64 // tokens per second
	last     time.Time
}

// NewRateLimiter creates a token-bucket limiter with capacity=burst and
// refill rate=perSec tokens/second.
func NewRateLimiter(perSec, burst int) *RateLimiter {
	return &RateLimiter{
		tokens:   float64(burst),
		capacity: float64(burst),
		rate:     float64(perSec),
		last:     time.Now(),
	}
}

// Wait blocks until one token is available or ctx is cancelled.
func (rl *RateLimiter) Wait(ctx context.Context) error {
	for {
		rl.mu.Lock()
		now := time.Now()
		elapsed := now.Sub(rl.last).Seconds()
		rl.tokens = min(rl.capacity, rl.tokens+elapsed*rl.rate)
		rl.last = now

		if rl.tokens >= 1 {
			rl.tokens--
			rl.mu.Unlock()
			return nil
		}
		need := (1 - rl.tokens) / rl.rate
		rl.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(need * float64(time.Second))):
		}
	}
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
