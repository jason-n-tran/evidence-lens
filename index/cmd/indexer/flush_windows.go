//go:build windows

package main

import "os"

// registerFlushSignal is a no-op on Windows: SIGUSR1 doesn't exist
// there. Operators on Windows should restart the container instead.
func registerFlushSignal(_ chan<- os.Signal) {}
