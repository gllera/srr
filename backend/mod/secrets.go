package mod

import (
	"os"
	"slices"
)

// secrets holds the operator-declared environment variables from srr.yaml's
// `secrets:` section. They are merged into every external (shell) ingest/mod
// command's environment, overriding any ambient process-env value of the same
// name (secrets win). Set once at startup by main via SetSecrets, before any
// New() snapshots the environment. nil/empty means "no secrets" — the previous
// pure os.Environ() behaviour.
var secrets map[string]string

// SetSecrets registers the srr.yaml `secrets:` map for SubprocessEnv. Passing nil
// clears it (used by tests and the no-section case).
func SetSecrets(s map[string]string) { secrets = s }

// SubprocessEnv returns the environment handed to an external ingest/mod command:
// os.Environ() with the configured secrets appended at the end. Go's exec.Cmd
// uses the last occurrence of a key, so a secret placed at the tail WINS over
// any ambient var of the same name (last-wins semantics). With no secrets it
// returns os.Environ() unchanged. Shared by mod.New and ingest.New so both
// subprocess paths see the same merged environment.
func SubprocessEnv() []string {
	base := os.Environ()
	if len(secrets) == 0 {
		return base
	}

	kv := make([]string, 0, len(secrets))
	for k, v := range secrets {
		kv = append(kv, k+"="+v)
	}
	slices.Sort(kv)
	return append(base, kv...)
}
