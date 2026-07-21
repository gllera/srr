//go:build unix

package mod

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// setProcessGroup puts cmd in its own process group and makes context
// cancellation kill that whole group rather than just the direct child.
//
// cmd.WaitDelay alone only makes Run() RETURN on time: os/exec's default Cancel
// kills the /bin/sh, leaving every pipeline child and backgrounded grandchild
// orphaned and running. On the long-running serve loop a persistently hanging
// external ingest command then leaks one process tree per feed per cycle.
//
// The negative pid is the whole-group kill; ESRCH (the group is already gone)
// maps to os.ErrProcessDone so Wait's error reporting matches the default
// Cancel's exactly.
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error {
		// Cancel runs only after a successful Start, so Process is non-nil; the
		// guard costs nothing and keeps a nil deref off the timeout path.
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
