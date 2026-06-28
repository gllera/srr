package mod

import (
	"maps"
	"os"
	"slices"
	"strings"
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
// the process environment (os.Environ) with the configured secrets overlaid so a
// secret REPLACES — not merely shadows — any ambient var of the same name. The
// result is deduped to one entry per name and sorted for determinism. (A plain
// append won't do: exec.Cmd does not dedup env, and whether a later duplicate
// wins is up to the child runtime — shell/Python keep the last, but glibc/Go
// getenv return the first, so an ambient var could beat a secret.) With no
// secrets it returns os.Environ() unchanged. Shared by mod.New and ingest.New so
// both subprocess paths see the same merged environment.
func SubprocessEnv() []string {
	base := os.Environ()
	if len(secrets) == 0 {
		return base
	}

	merged := make(map[string]string, len(base)+len(secrets))
	for _, kv := range base {
		if k, v, ok := strings.Cut(kv, "="); ok {
			merged[k] = v
		}
	}
	maps.Copy(merged, secrets)

	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	slices.Sort(out)
	return out
}
