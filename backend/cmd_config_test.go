package main

import (
	"reflect"
	"strings"
	"testing"
)

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

// `srr config` (no arg) appends a masked `secrets:` section: keys listed, values
// rendered as the shared maskSecret placeholder so the raw value never leaks.
func TestConfigSecretsMaskedNoArg(t *testing.T) {
	globals = &Globals{Store: "packs"}
	secrets = map[string]string{"TOKEN": "supersecret", "API_HASH": "deadbeef"}
	t.Cleanup(func() { secrets = nil })

	out := captureStdout(t, func() {
		if err := (&ConfigCmd{}).Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	})
	if !strings.Contains(out, "secrets:\n") {
		t.Errorf("missing secrets section\n--- got ---\n%s", out)
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

// `srr config secrets` prints the masked section; `srr config secrets.KEY` prints
// just the masked value; an unknown sub-key errors.
func TestConfigSecretsKeyLookup(t *testing.T) {
	globals = &Globals{Store: "packs"}
	secrets = map[string]string{"TOKEN": "supersecret"}
	t.Cleanup(func() { secrets = nil })

	section := captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "secrets"}).Run(); err != nil {
			t.Fatalf("Run(secrets): %v", err)
		}
	})
	if !strings.Contains(section, "TOKEN: ********") || strings.Contains(section, "supersecret") {
		t.Errorf("section lookup not masked\n--- got ---\n%s", section)
	}

	single := captureStdout(t, func() {
		if err := (&ConfigCmd{Key: "secrets.TOKEN"}).Run(); err != nil {
			t.Fatalf("Run(secrets.TOKEN): %v", err)
		}
	})
	if !strings.Contains(single, "********") || strings.Contains(single, "supersecret") {
		t.Errorf("single-key lookup not masked\n--- got ---\n%s", single)
	}

	if err := (&ConfigCmd{Key: "secrets.NOPE"}).Run(); err == nil {
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
