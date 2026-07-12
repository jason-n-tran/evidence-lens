//go:build unix

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// registerFlushSignal wires SIGUSR1 to trigger a manual batcher flush.
// Per-OS file because SIGUSR1 doesn't exist on Windows.
func registerFlushSignal(c chan<- os.Signal) {
	signal.Notify(c, syscall.SIGUSR1)
}
