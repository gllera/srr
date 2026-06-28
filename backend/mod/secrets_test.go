package mod

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func envMap(env []string) map[string]string {
	m := make(map[string]string, len(env))
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return m
}

// TestSubprocessEnvMergesSecrets proves the srr.yaml secrets are merged into the
// external-command environment, that a secret OVERRIDES an ambient process-env
// var (secrets win), and that a non-overlapping ambient var still passes through.
func TestSubprocessEnvMergesSecrets(t *testing.T) {
	t.Setenv("SRR_SECRETS_AMBIENT", "from-env")
	t.Setenv("SRR_SECRETS_OVERRIDE", "ambient-value")
	t.Cleanup(func() { SetSecrets(nil) })

	SetSecrets(map[string]string{
		"SRR_SECRETS_OVERRIDE": "secret-value", // must beat the ambient value
		"SRR_SECRETS_NEW":      "new-secret",
	})

	out := SubprocessEnv()
	env := envMap(out)

	if got := env["SRR_SECRETS_OVERRIDE"]; got != "secret-value" {
		t.Errorf("secret should win over ambient: got %q, want %q", got, "secret-value")
	}
	if got := env["SRR_SECRETS_NEW"]; got != "new-secret" {
		t.Errorf("new secret not present: got %q, want %q", got, "new-secret")
	}
	if got := env["SRR_SECRETS_AMBIENT"]; got != "from-env" {
		t.Errorf("ambient var should pass through: got %q, want %q", got, "from-env")
	}

	// secrets win by last-wins (exec.Cmd semantics): the final occurrence must be
	// the secret value, regardless of how many times the key appears.
	last := ""
	for _, kv := range out {
		if after, ok := strings.CutPrefix(kv, "SRR_SECRETS_OVERRIDE="); ok {
			last = after
		}
	}
	if last != "secret-value" {
		t.Errorf("secret should be the last (winning) value: got %q, want %q", last, "secret-value")
	}
}

// TestSubprocessEnvEmptyReturnsProcessEnv proves the no-secrets path is a pure
// pass-through of os.Environ() (today's behaviour, byte-for-byte).
func TestSubprocessEnvEmptyReturnsProcessEnv(t *testing.T) {
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(nil)

	if got, want := SubprocessEnv(), os.Environ(); !slices.Equal(got, want) {
		t.Errorf("empty secrets should return os.Environ() unchanged:\n got %v\nwant %v", got, want)
	}
}

// TestExternalModSecretEnv proves the srr.yaml `secrets:` map is merged into an
// external (shell) mod's environment and overrides an ambient var (secrets win).
// SetSecrets must precede New(), which snapshots the environment.
func TestExternalModSecretEnv(t *testing.T) {
	t.Setenv("SRR_TEST_SECRET", "ambient")
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(map[string]string{"SRR_TEST_SECRET": "from-yaml"})

	out := filepath.Join(t.TempDir(), "secret.txt")
	// Stash the secret to a file; pass the item JSON through unchanged via cat.
	cmd := fmt.Sprintf(`printf '%%s' "$SRR_TEST_SECRET" > %s; cat`, out)

	item := &RawItem{GUID: 1, Title: "T", Content: "C", Link: "https://x/1"}
	if err := New().Process(context.Background(), cmd, item); err != nil {
		t.Fatalf("process: %v", err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read secret: %v", err)
	}
	if string(data) != "from-yaml" {
		t.Errorf("secret not merged into mod env: got %q, want %q", string(data), "from-yaml")
	}
}
