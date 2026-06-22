package ingestcommon

import (
	"context"
	"testing"
	"time"
)

func TestRateLimiter_Burst(t *testing.T) {
	rl := NewRateLimiter(10, 5)
	ctx := context.Background()

	start := time.Now()
	for i := 0; i < 5; i++ {
		if err := rl.Wait(ctx); err != nil {
			t.Fatalf("burst should not block: %v", err)
		}
	}
	if d := time.Since(start); d > 50*time.Millisecond {
		t.Errorf("burst took %v, expected < 50ms", d)
	}
}

func TestRateLimiter_Refill(t *testing.T) {
	rl := NewRateLimiter(20, 1)
	ctx := context.Background()

	// Drain.
	if err := rl.Wait(ctx); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	if err := rl.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	d := time.Since(start)
	// At 20/s = 50ms per token. Allow generous tolerance for CI jitter.
	if d < 30*time.Millisecond || d > 200*time.Millisecond {
		t.Errorf("expected ~50ms refill, got %v", d)
	}
}

func TestRateLimiter_Cancel(t *testing.T) {
	rl := NewRateLimiter(1, 1) // very slow
	if err := rl.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := rl.Wait(ctx); err == nil {
		t.Error("expected ctx timeout")
	}
}
