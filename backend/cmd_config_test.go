package main

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/alecthomas/kong"
)

// The CacheDir flag has no static default (its value is computed at runtime), so
// its cycleFlags field must carry a default:"${cacheDir}" tag wired to the kong
// var, and the AfterApply hook must land the resolved value in the runtime
// globals; otherwise `srr config` / --help print a blank cache-dir line. Parse
// the real CLI like main() does and assert the default reaches globals.
func TestCacheDirDefaultResolved(t *testing.T) {
	// Ensure no ambient env var masks the default (kong's native env: handling
	// treats even an empty SRR_CACHE_DIR as a value that overrides the default).
	if orig, ok := os.LookupEnv("SRR_CACHE_DIR"); ok {
		os.Unsetenv("SRR_CACHE_DIR")
		t.Cleanup(func() { os.Setenv("SRR_CACHE_DIR", orig) })
	}

	var cli CLI
	saved := globals
	globals = &cli.Globals // mirror main(): AfterApply writes into the parsed CLI
	t.Cleanup(func() { globals = saved })

	parser, err := kong.New(&cli, kongOptions(nil)...)
	if err != nil {
		t.Fatalf("kong.New: %v", err)
	}
	// Deliberately NOT seeded: the kong default + AfterApply chain alone must
	// fill the field for the embedding command.
	if _, err := parser.Parse([]string{"config"}); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if want := defaultCacheDir(); globals.CacheDir != want {
		t.Errorf("CacheDir default = %q, want %q (config/--help would print blank)", globals.CacheDir, want)
	}
}

// With a local store (empty scheme, no active backend config), `srr config`
// must still print every registered backend section so unset configs are
// discoverable. Env var names follow the conventional SRR_… derivation, so they
// are not annotated.
func TestConfigPrintsAllBackendSections(t *testing.T) {
	globals = &Globals{Store: "packs"} // local scheme: no backend config active
	out := captureStdout(t, func() {
		if err := (&ConfigCmd{}).Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	})
	for _, want := range []string{"s3:\n", "  region:", "sftp:\n", "  user:"} {
		if !strings.Contains(out, want) {
			t.Errorf("config output missing %q\n--- got ---\n%s", want, out)
		}
	}
	if strings.Contains(out, "[SRR_") {
		t.Errorf("conventional env names should be suppressed\n--- got ---\n%s", out)
	}
}

// A key argument must resolve against any registered scheme, not only the one
// matching the active store.
func TestConfigKeyResolvesInactiveScheme(t *testing.T) {
	globals = &Globals{Store: "packs"} // local active; s3/sftp inactive

	out := captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "sftp"}).Run(); err != nil {
			t.Fatalf("Run(sftp): %v", err)
		}
	})
	if !strings.Contains(out, "user:") {
		t.Errorf("section lookup for inactive scheme failed, got: %q", out)
	}

	out = captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "s3.region"}).Run(); err != nil {
			t.Fatalf("Run(s3.region): %v", err)
		}
	})
	if strings.Contains(out, "[SRR_") {
		t.Errorf("single-field lookup should print value only, got: %q", out)
	}

	if err := (&ConfigCmd{Key: "s3.nope"}).Run(); err == nil {
		t.Error("unknown backend field should error")
	}
}

// `srr config` (no arg) appends a masked `secrets:` section: scopes and their
// keys listed, values rendered as the shared maskSecret placeholder so the raw
// value never leaks.
func TestConfigSecretsMaskedNoArg(t *testing.T) {
	globals = &Globals{Store: "packs"}
	secrets = map[string]map[string]string{
		"telegram": {"TOKEN": "supersecret", "API_HASH": "deadbeef"},
	}
	t.Cleanup(func() { secrets = nil })

	out := captureStdout(t, func() {
		if err := (&ConfigCmd{}).Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	})
	if !strings.Contains(out, "secrets:\n") || !strings.Contains(out, "telegram:\n") {
		t.Errorf("missing secrets section / scope\n--- got ---\n%s", out)
	}
	if !strings.Contains(out, "TOKEN: ********") {
		t.Errorf("TOKEN not masked\n--- got ---\n%s", out)
	}
	if strings.Contains(out, "supersecret") || strings.Contains(out, "deadbeef") {
		t.Errorf("secret value leaked into output\n--- got ---\n%s", out)
	}
}

// No secrets configured ⇒ no `secrets:` section at all.
func TestConfigNoSecretsOmitsSection(t *testing.T) {
	globals = &Globals{Store: "packs"}
	secrets = nil

	out := captureStdout(t, func() {
		if err := (&ConfigCmd{}).Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	})
	if strings.Contains(out, "secrets:") {
		t.Errorf("no-secrets config must omit the secrets section\n--- got ---\n%s", out)
	}
}

// `srr config secrets` prints the masked section; `srr config secrets.<scope>`
// one scope's masked entries; `srr config secrets.<scope>.<NAME>` just the
// masked value; an unknown scope or sub-key errors.
func TestConfigSecretsKeyLookup(t *testing.T) {
	globals = &Globals{Store: "packs"}
	secrets = map[string]map[string]string{"telegram": {"TOKEN": "supersecret"}}
	t.Cleanup(func() { secrets = nil })

	section := captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "secrets"}).Run(); err != nil {
			t.Fatalf("Run(secrets): %v", err)
		}
	})
	if !strings.Contains(section, "telegram:") || !strings.Contains(section, "TOKEN: ********") || strings.Contains(section, "supersecret") {
		t.Errorf("section lookup not masked\n--- got ---\n%s", section)
	}

	scope := captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "secrets.telegram"}).Run(); err != nil {
			t.Fatalf("Run(secrets.telegram): %v", err)
		}
	})
	if !strings.Contains(scope, "TOKEN: ********") || strings.Contains(scope, "supersecret") {
		t.Errorf("scope lookup not masked\n--- got ---\n%s", scope)
	}

	single := captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "secrets.telegram.TOKEN"}).Run(); err != nil {
			t.Fatalf("Run(secrets.telegram.TOKEN): %v", err)
		}
	})
	if !strings.Contains(single, "********") || strings.Contains(single, "supersecret") {
		t.Errorf("single-key lookup not masked\n--- got ---\n%s", single)
	}

	if err := (&ConfigCmd{Key: "secrets.NOPE"}).Run(); err == nil {
		t.Error("unknown secret scope should error")
	}
	if err := (&ConfigCmd{Key: "secrets.telegram.NOPE"}).Run(); err == nil {
		t.Error("unknown secret key should error")
	}
}

// A conventional env tag (SRR_ + screaming-snake of the field name) is
// suppressed; a hand-rolled tag that breaks the convention is still shown.
func TestGlobalEnvName(t *testing.T) {
	type g struct {
		Workers int    `env:"SRR_WORKERS"`    // conventional → suppressed
		Custom  string `env:"SRR_OTHER_NAME"` // deviates from SRR_CUSTOM → shown
		NoEnv   string ``
	}
	tt := reflect.TypeOf(g{})
	if got := globalEnvName(tt.Field(0)); got != "" {
		t.Errorf("globalEnvName(Workers) = %q, want \"\" (conventional, suppressed)", got)
	}
	if got := globalEnvName(tt.Field(1)); got != "SRR_OTHER_NAME" {
		t.Errorf("globalEnvName(Custom) = %q, want SRR_OTHER_NAME", got)
	}
	if got := globalEnvName(tt.Field(2)); got != "" {
		t.Errorf("globalEnvName(NoEnv) = %q, want empty", got)
	}
}

// Backend env names are the conventional SRR_<SCHEME>_<FIELD> derivation by
// construction, so they always match the expected name and are suppressed.
func TestBackendEnvNameFor(t *testing.T) {
	type cfg struct {
		Region    string `yaml:"region"`
		AccessKey string `yaml:"access-key-id"`
		NoTag     string ``
	}
	tt := reflect.TypeOf(cfg{})
	envName := backendEnvNameFor("s3")
	for _, i := range []int{0, 1, 2} {
		if got := envName(tt.Field(i)); got != "" {
			t.Errorf("backendEnvNameFor(s3)(%s) = %q, want \"\" (conventional)", tt.Field(i).Name, got)
		}
	}
}

// maskSecret must render an unset (nil/empty) secret map as empty, and any
// populated one as the fixed placeholder — never the values (the http backend's
// secret-tagged `headers` map rides the no-arg print through it).
func TestMaskSecretMap(t *testing.T) {
	if got := maskSecret(map[string]string(nil)); got != "" {
		t.Errorf("maskSecret(nil map) = %v, want empty", got)
	}
	if got := maskSecret(map[string]string{}); got != "" {
		t.Errorf("maskSecret(empty map) = %v, want empty", got)
	}
	if got := maskSecret(map[string]string{"X-Api-Key": "abc"}); got != "********" {
		t.Errorf("maskSecret(populated map) = %v, want ********", got)
	}
}

// `srr store import` against a store whose config.gz holds watch rules the manifest
// has no floors for. The two maps live in two objects and can arrive one
// without the other (the documented `{"v":3,"m":<older>}` rollback rewinds the
// manifest, not the mutable sidecar), so a single nil-guard covering both wrote
// into a nil map and panicked the restore.
func TestConfigImportWatchWithNilRoster(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := setWatchRule(ctx, db, "cve", `title=/CVE/i`); err != nil {
		t.Fatal(err)
	}
	db.core.WatchFrom = nil // the roster the manifest lost

	doc := &configDoc{Watch: map[string]string{"cve": `title=/CVE-\d{4}/i`}}
	if err := applyConfigDoc(ctx, db, doc); err != nil {
		t.Fatalf("applyConfigDoc: %v", err)
	}
	if got := db.core.Watch["cve"]; got != `title=/CVE-\d{4}/i` {
		t.Errorf("spec = %q, want the imported one", got)
	}
	if _, ok := db.core.WatchFrom["cve"]; !ok {
		t.Errorf("import did not stamp a coverage floor: WatchFrom=%v", db.core.WatchFrom)
	}
}
