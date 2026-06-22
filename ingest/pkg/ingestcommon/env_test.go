package ingestcommon

import (
	"os"
	"testing"
	"time"
)

func TestGetEnv(t *testing.T) {
	t.Setenv("EL_TEST_X", "set-value")
	if got := GetEnv("EL_TEST_X", "fb"); got != "set-value" {
		t.Errorf("GetEnv set: got %q", got)
	}
	if got := GetEnv("EL_TEST_UNSET", "fb"); got != "fb" {
		t.Errorf("GetEnv fallback: got %q", got)
	}
	t.Setenv("EL_TEST_EMPTY", "")
	if got := GetEnv("EL_TEST_EMPTY", "fb"); got != "fb" {
		t.Errorf("GetEnv empty -> fallback: got %q", got)
	}
}

func TestGetEnvInt(t *testing.T) {
	t.Setenv("EL_TEST_N", "42")
	if got := GetEnvInt("EL_TEST_N", 0); got != 42 {
		t.Errorf("GetEnvInt: got %d", got)
	}
	t.Setenv("EL_TEST_N", "not-a-number")
	if got := GetEnvInt("EL_TEST_N", 7); got != 7 {
		t.Errorf("GetEnvInt fallback on parse fail: got %d", got)
	}
}

func TestGetEnvDuration(t *testing.T) {
	t.Setenv("EL_TEST_D", "250ms")
	if got := GetEnvDuration("EL_TEST_D", time.Hour); got != 250*time.Millisecond {
		t.Errorf("GetEnvDuration: got %v", got)
	}
}

func TestMustEnv(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("expected panic on unset")
		}
	}()
	_ = os.Unsetenv("EL_TEST_REQUIRED")
	_ = MustEnv("EL_TEST_REQUIRED")
}
