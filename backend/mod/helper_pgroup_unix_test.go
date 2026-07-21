//go:build unix

package mod

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A timed-out command must take its whole process TREE with it. WaitDelay alone
// only unblocks Run(): os/exec's default Cancel kills the /bin/sh and leaves
// backgrounded grandchildren running, so a persistently hanging external ingest
// leaks one process tree per feed per cycle on the serve loop. The grandchild
// here writes its own pid, closes the inherited stdout (so only the GROUP kill —
// not WaitDelay's pipe force-close — can account for its death), then sleeps
// well past the deadline; afterwards signal 0 must find no such process.
func TestRunSubprocessKillsProcessGroup(t *testing.T) {
	orig := subprocessWaitDelay
	subprocessWaitDelay = 200 * time.Millisecond
	defer func() { subprocessWaitDelay = orig }()

	pidFile := filepath.Join(t.TempDir(), "pid")
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_, err := RunSubprocess(ctx,
		"sh -c 'echo $$ > "+pidFile+"; exec sleep 30' >/dev/null 2>&1 & wait", nil, "", nil)
	if err == nil {
		t.Fatal("RunSubprocess returned nil error; want the timeout error")
	}

	data, rerr := os.ReadFile(pidFile)
	if rerr != nil {
		t.Fatalf("grandchild never wrote its pid: %v", rerr)
	}
	pid, perr := strconv.Atoi(strings.TrimSpace(string(data)))
	if perr != nil {
		t.Fatalf("bad pid %q: %v", data, perr)
	}
	// The group kill is asynchronous with our return; give it a moment to land.
	for range 50 {
		if err := syscall.Kill(pid, 0); err != nil {
			return // gone (ESRCH) — the kill reached the grandchild
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL) // never leak it out of the test
	t.Fatalf("grandchild %d survived the cancelled command", pid)
}
