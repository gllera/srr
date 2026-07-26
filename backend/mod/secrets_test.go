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

// TestSubprocessEnvGrantedScope proves a GRANTED scope's secrets are merged into
// the external-command environment, that a secret OVERRIDES an ambient
// process-env var (secrets win), and that a non-overlapping ambient var still
// passes through.
func TestSubprocessEnvGrantedScope(t *testing.T) {
	t.Setenv("SRR_SECRETS_AMBIENT", "from-env")
	t.Setenv("SRR_SECRETS_OVERRIDE", "ambient-value")
	t.Cleanup(func() { SetSecrets(nil) })

	SetSecrets(map[string]map[string]string{
		"tg": {
			"SRR_SECRETS_OVERRIDE": "secret-value", // must beat the ambient value
			"SRR_SECRETS_NEW":      "new-secret",
		},
	})

	ctx := WithSecretScopes(context.Background(), []string{"tg"})
	out := SubprocessEnv(ctx)
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

	// A secret REPLACES the ambient var deterministically — the key appears
	// exactly once (not relying on child-runtime last-wins, which glibc/Go getenv
	// would resolve first-wins and let the ambient value beat the secret).
	n := 0
	for _, kv := range out {
		if strings.HasPrefix(kv, "SRR_SECRETS_OVERRIDE=") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("overridden key should appear exactly once (deduped), got %d occurrences", n)
	}
}

// TestSubprocessEnvUngrantedScopeExcluded is the SEC5 containment property: a
// configured scope that the ctx does NOT grant never reaches the command's
// environment — including the no-grant case, which is a pure os.Environ()
// pass-through.
func TestSubprocessEnvUngrantedScopeExcluded(t *testing.T) {
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(map[string]map[string]string{
		"tg": {"SRR_SECRETS_LEAK": "top-secret"},
		"gh": {"SRR_SECRETS_PAT": "ghp"},
	})

	// Granting one scope must not leak the other.
	env := envMap(SubprocessEnv(WithSecretScopes(context.Background(), []string{"gh"})))
	if _, ok := env["SRR_SECRETS_LEAK"]; ok {
		t.Error("ungranted scope's secret leaked into the environment")
	}
	if env["SRR_SECRETS_PAT"] != "ghp" {
		t.Error("granted scope's secret missing")
	}

	// No grant at all (unstamped ctx) ⇒ byte-for-byte os.Environ().
	if got, want := SubprocessEnv(context.Background()), os.Environ(); !slices.Equal(got, want) {
		t.Errorf("no-grant env should be os.Environ() unchanged:\n got %v\nwant %v", got, want)
	}
}

// TestSubprocessEnvUnknownScopeContributesNothing: granting a scope srr.yaml
// does not define adds no vars and does not fail — the loud feedback lives at
// the fetch call site (MissingScopes), not in the env merge.
func TestSubprocessEnvUnknownScopeContributesNothing(t *testing.T) {
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(map[string]map[string]string{"tg": {"SRR_SECRETS_X": "v"}})

	got := SubprocessEnv(WithSecretScopes(context.Background(), []string{"nope"}))
	if want := os.Environ(); !slices.Equal(got, want) {
		t.Errorf("unknown scope should contribute nothing:\n got %v\nwant %v", got, want)
	}
}

// TestSubprocessEnvLaterScopeWins pins the collision rule: when two granted
// scopes define the same var, the later grant in the list wins.
func TestSubprocessEnvLaterScopeWins(t *testing.T) {
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(map[string]map[string]string{
		"a": {"SRR_SECRETS_DUP": "from-a"},
		"b": {"SRR_SECRETS_DUP": "from-b"},
	})

	env := envMap(SubprocessEnv(WithSecretScopes(context.Background(), []string{"a", "b"})))
	if got := env["SRR_SECRETS_DUP"]; got != "from-b" {
		t.Errorf("later granted scope should win: got %q, want %q", got, "from-b")
	}
}

// TestAllScopesAndMissingScopes covers the two scope-list helpers: AllScopes is
// the sorted grant operator-global commands (notify) use, MissingScopes is the
// fetch-time warn signal for a grant srr.yaml no longer defines.
func TestAllScopesAndMissingScopes(t *testing.T) {
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(map[string]map[string]string{"b": {}, "a": {}})

	if got := AllScopes(); !slices.Equal(got, []string{"a", "b"}) {
		t.Errorf("AllScopes = %v, want [a b]", got)
	}
	if got := MissingScopes([]string{"a", "nope", "b", "gone"}); !slices.Equal(got, []string{"nope", "gone"}) {
		t.Errorf("MissingScopes = %v, want [nope gone]", got)
	}
	if got := MissingScopes([]string{"a"}); got != nil {
		t.Errorf("MissingScopes(all known) = %v, want nil", got)
	}
}

// TestExternalModSecretEnv proves a granted scope reaches an external (shell)
// mod's environment through the fetch ctx and overrides an ambient var — and
// that WITHOUT the grant the same command sees only the ambient value.
func TestExternalModSecretEnv(t *testing.T) {
	t.Setenv("SRR_TEST_SECRET", "ambient")
	t.Cleanup(func() { SetSecrets(nil) })
	SetSecrets(map[string]map[string]string{"tg": {"SRR_TEST_SECRET": "from-yaml"}})

	run := func(ctx context.Context) string {
		t.Helper()
		out := filepath.Join(t.TempDir(), "secret.txt")
		// Stash the secret to a file; pass the item JSON through unchanged via cat.
		cmd := fmt.Sprintf(`printf '%%s' "$SRR_TEST_SECRET" > %s; cat`, out)
		item := &RawItem{GUID: 1, Title: "T", Content: "C", Link: "https://x/1"}
		if err := New().Process(ctx, cmd, item); err != nil {
			t.Fatalf("process: %v", err)
		}
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatalf("read secret: %v", err)
		}
		return string(data)
	}

	if got := run(WithSecretScopes(context.Background(), []string{"tg"})); got != "from-yaml" {
		t.Errorf("granted scope not merged into mod env: got %q, want %q", got, "from-yaml")
	}
	if got := run(context.Background()); got != "ambient" {
		t.Errorf("ungranted mod should see only the ambient value: got %q, want %q", got, "ambient")
	}
}
