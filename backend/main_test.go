package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/alecthomas/kong"
	kongyaml "github.com/alecthomas/kong-yaml"
)

// readConfig resolves the YAML config source in precedence order: the inline
// $SRR_CONFIG_INLINE bytes, else the $SRR_CONFIG file, else the
// $XDG_CONFIG_HOME/srr/srr.yaml fallback; a missing file is empty, not an error.
func TestReadConfig(t *testing.T) {
	t.Run("inline_wins_over_path", func(t *testing.T) {
		t.Setenv("SRR_CONFIG_INLINE", "store: inline\n")
		t.Setenv("SRR_CONFIG", "/should/not/be/read.yaml")
		data, err := readConfig()
		if err != nil {
			t.Fatalf("readConfig: %v", err)
		}
		if string(data) != "store: inline\n" {
			t.Errorf("data = %q, want the inline bytes", data)
		}
	})

	t.Run("path_over_xdg_fallback", func(t *testing.T) {
		t.Setenv("SRR_CONFIG_INLINE", "")
		dir := t.TempDir()
		path := filepath.Join(dir, "cfg.yaml")
		if err := os.WriteFile(path, []byte("store: fromfile\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("SRR_CONFIG", path)
		// An XDG file that must be ignored because SRR_CONFIG is set.
		xdg := t.TempDir()
		if err := os.MkdirAll(filepath.Join(xdg, "srr"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(xdg, "srr", "srr.yaml"), []byte("store: fromxdg\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("XDG_CONFIG_HOME", xdg)

		data, err := readConfig()
		if err != nil {
			t.Fatalf("readConfig: %v", err)
		}
		if string(data) != "store: fromfile\n" {
			t.Errorf("data = %q, want the SRR_CONFIG file bytes", data)
		}
	})

	t.Run("xdg_fallback", func(t *testing.T) {
		t.Setenv("SRR_CONFIG_INLINE", "")
		t.Setenv("SRR_CONFIG", "")
		xdg := t.TempDir()
		if err := os.MkdirAll(filepath.Join(xdg, "srr"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(xdg, "srr", "srr.yaml"), []byte("store: fromxdg\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("XDG_CONFIG_HOME", xdg)

		data, err := readConfig()
		if err != nil {
			t.Fatalf("readConfig: %v", err)
		}
		if string(data) != "store: fromxdg\n" {
			t.Errorf("data = %q, want the XDG-fallback bytes", data)
		}
	})

	t.Run("missing_file_is_empty_not_error", func(t *testing.T) {
		t.Setenv("SRR_CONFIG_INLINE", "")
		t.Setenv("SRR_CONFIG", filepath.Join(t.TempDir(), "does-not-exist.yaml"))
		data, err := readConfig()
		if err != nil {
			t.Fatalf("readConfig on a missing file must not error: %v", err)
		}
		if len(data) != 0 {
			t.Errorf("data = %q, want empty (missing file)", data)
		}
	})
}

// envFirstResolver restores the documented precedence env > config file: an
// explicitly-set SRR_* env var wins over a stale value in srr.yaml, while an
// empty env var falls through to the YAML/default.
func TestEnvFirstResolver(t *testing.T) {
	type resolverCLI struct {
		Store string `env:"SRR_STORE"`
	}
	yaml := []byte("store: fromyaml\n")

	resolveStore := func() string {
		t.Helper()
		inner, err := kongyaml.Loader(bytes.NewReader(yaml))
		if err != nil {
			t.Fatalf("kongyaml.Loader: %v", err)
		}
		var c resolverCLI
		parser, err := kong.New(&c, kong.Name("test"), kong.Resolvers(envFirstResolver(inner)))
		if err != nil {
			t.Fatalf("kong.New: %v", err)
		}
		if _, err := parser.Parse(nil); err != nil {
			t.Fatalf("parse: %v", err)
		}
		return c.Store
	}

	t.Run("env_wins_over_yaml", func(t *testing.T) {
		t.Setenv("SRR_STORE", "fromenv")
		if got := resolveStore(); got != "fromenv" {
			t.Errorf("Store = %q, want fromenv (env beats the config file)", got)
		}
	})

	t.Run("empty_env_falls_through_to_yaml", func(t *testing.T) {
		t.Setenv("SRR_STORE", "")
		if got := resolveStore(); got != "fromyaml" {
			t.Errorf("Store = %q, want fromyaml (empty env falls through)", got)
		}
	})
}
