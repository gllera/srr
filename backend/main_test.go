package main

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/alecthomas/kong"
	kongyaml "github.com/alecthomas/kong-yaml"
	"gopkg.in/yaml.v3"
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

// configResolver: env > yaml, and the scoped (moved) flags resolve from their
// TOP-LEVEL srr.yaml key regardless of command depth — the boxes' existing
// config files keep working with zero edits — while per-command flags can
// never be captured by a stray top-level key.
func TestConfigResolver(t *testing.T) {
	type fetchCmd struct {
		PackSize int    `env:"SRR_PACK_SIZE"` // scoped: in scopedYAMLFlags
		Interval string ``                    // per-command: NOT in the set
	}
	type resolverCLI struct {
		Store string   `env:"SRR_STORE"`
		Fetch fetchCmd `cmd:""`
	}
	yamlSrc := []byte("store: fromyaml\npack-size: 42\ninterval: fromtoplevel\n")

	parse := func(t *testing.T, args []string) *resolverCLI {
		t.Helper()
		inner, err := kongyaml.Loader(bytes.NewReader(yamlSrc))
		if err != nil {
			t.Fatalf("kongyaml.Loader: %v", err)
		}
		var root map[string]any
		if err := yaml.Unmarshal(yamlSrc, &root); err != nil {
			t.Fatalf("yaml.Unmarshal: %v", err)
		}
		var c resolverCLI
		parser, err := kong.New(&c, kong.Name("test"), kong.Resolvers(configResolver(inner, root)))
		if err != nil {
			t.Fatalf("kong.New: %v", err)
		}
		if _, err := parser.Parse(args); err != nil {
			t.Fatalf("parse: %v", err)
		}
		return &c
	}

	t.Run("env_wins_over_yaml", func(t *testing.T) {
		t.Setenv("SRR_STORE", "fromenv")
		if got := parse(t, []string{"fetch"}).Store; got != "fromenv" {
			t.Errorf("Store = %q, want fromenv (env beats the config file)", got)
		}
	})

	t.Run("empty_env_falls_through_to_yaml", func(t *testing.T) {
		t.Setenv("SRR_STORE", "")
		if got := parse(t, []string{"fetch"}).Store; got != "fromyaml" {
			t.Errorf("Store = %q, want fromyaml (empty env falls through)", got)
		}
	})

	t.Run("scoped_flag_reads_top_level_key_at_depth", func(t *testing.T) {
		// UNSET, not empty: kong's native env handling parses a set-but-empty
		// int env var and hard-errors before any resolver runs (pre-existing
		// kong behavior, unchanged by the move — only string flags fall through).
		if orig, ok := os.LookupEnv("SRR_PACK_SIZE"); ok {
			os.Unsetenv("SRR_PACK_SIZE")
			t.Cleanup(func() { os.Setenv("SRR_PACK_SIZE", orig) })
		}
		if got := parse(t, []string{"fetch"}).Fetch.PackSize; got != 42 {
			t.Errorf("PackSize = %d, want 42 (top-level yaml key must reach the scoped flag)", got)
		}
	})

	t.Run("env_beats_top_level_key_for_scoped_flag", func(t *testing.T) {
		t.Setenv("SRR_PACK_SIZE", "9")
		if got := parse(t, []string{"fetch"}).Fetch.PackSize; got != 9 {
			t.Errorf("PackSize = %d, want 9 (env beats yaml through the clause)", got)
		}
	})

	t.Run("per_command_flag_never_captured_by_top_level_key", func(t *testing.T) {
		if got := parse(t, []string{"fetch"}).Fetch.Interval; got != "" {
			t.Errorf("Interval = %q, want empty (a stray top-level key must not leak into per-command flags)", got)
		}
	})
}

// A cron health check must be able to tell the failure CLASSES apart without
// scraping the message. kong owns 1 for usage errors, so the classes start
// above it.
func TestExitCodeForClassifiesFailures(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"lock contention", fmt.Errorf("create lock file: %w", os.ErrExist), exitLocked},
		{"validation", fmt.Errorf("3 issue(s) found: %w", errValidation), exitValidation},
		{"store missing", fmt.Errorf("fetch db.gz: %w", fs.ErrNotExist), exitStoreIO},
		{"store permission", fmt.Errorf("open store: %w", fs.ErrPermission), exitStoreIO},
		{"anything else", errors.New("bad recipe reference"), exitGeneric},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := exitCodeFor(c.err); got != c.want {
				t.Errorf("exitCodeFor(%v) = %d, want %d", c.err, got, c.want)
			}
		})
	}
}
