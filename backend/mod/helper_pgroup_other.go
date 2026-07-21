//go:build !unix

package mod

import "os/exec"

// setProcessGroup is a no-op off unix: process groups and the negative-pid
// group kill are POSIX. `make release` cross-compiles windows/*, so the unix
// implementation must not be the only one. The subprocess is still bounded
// there by the context deadline + WaitDelay — only orphaned grandchildren
// survive, which is the pre-existing behavior everywhere.
func setProcessGroup(cmd *exec.Cmd) {}
