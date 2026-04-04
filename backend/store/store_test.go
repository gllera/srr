package store

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var ctx = context.Background()

func setupLocalStore(t *testing.T) (Backend, string) {
	t.Helper()
	dir := t.TempDir()
	b, err := Open(ctx, dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })
	return b, dir
}

func TestLocalRmNonExistent(t *testing.T) {
	b, _ := setupLocalStore(t)
	if err := b.Rm(ctx, "nonexistent.txt"); err != nil {
		t.Errorf("Rm(nonexistent) = %v, want nil", err)
	}
}

func readAllClose(t *testing.T, rc io.ReadCloser) string {
	t.Helper()
	if rc == nil {
		return ""
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return string(data)
}

func TestLocalPutCreatesSubdirectories(t *testing.T) {
	b, dir := setupLocalStore(t)

	if err := b.Put(ctx, "sub/dir/file.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rc, err := b.Get(ctx, "sub/dir/file.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
	if _, err := os.Stat(filepath.Join(dir, "sub", "dir")); os.IsNotExist(err) {
		t.Error("subdirectories should have been auto-created")
	}
}

func TestLocalPutExclusiveCreateReturnsError(t *testing.T) {
	b, _ := setupLocalStore(t)

	if err := b.Put(ctx, "file.txt", strings.NewReader("first"), false); err != nil {
		t.Fatalf("Put(first): %v", err)
	}
	if err := b.Put(ctx, "file.txt", strings.NewReader("second"), false); err == nil {
		t.Error("Put(ignoreExisting=false) on existing file should fail")
	}
}

func TestLocalAtomicPutNoTempFileRemains(t *testing.T) {
	b, dir := setupLocalStore(t)

	if err := b.AtomicPut(ctx, "atomic.txt", strings.NewReader("content")); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "atomic.txt.tmp")); !os.IsNotExist(err) {
		t.Error("temp file should not remain after AtomicPut")
	}
	rc, _ := b.Get(ctx, "atomic.txt", false)
	if got := readAllClose(t, rc); got != "content" {
		t.Errorf("content = %q, want %q", got, "content")
	}
}

func TestLocalGetMissingIgnored(t *testing.T) {
	b, _ := setupLocalStore(t)

	rc, err := b.Get(ctx, "missing.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get(missing, ignoreMissing=true) = (%v, %v), want (nil, nil)", rc, err)
	}
}

func TestLocalGetMissingErrors(t *testing.T) {
	b, _ := setupLocalStore(t)

	rc, err := b.Get(ctx, "missing.txt", false)
	if rc != nil {
		rc.Close()
	}
	if err == nil {
		t.Error("Get(missing, ignoreMissing=false) should return error")
	}
}

func TestOpenUnsupportedScheme(t *testing.T) {
	_, err := Open(ctx, "ftp://example.com/path")
	if err == nil {
		t.Error("Open with unsupported scheme should return error")
	}
}

func TestLoadEnvBoolParsing(t *testing.T) {
	type testConfig struct {
		Enabled bool `yaml:"enabled"`
	}

	tests := []struct {
		envVal string
		want   bool
	}{
		{"true", true},
		{"1", true},
		{"false", false},
		{"0", false},
		{"yes", false},
	}

	for _, tt := range tests {
		t.Run(tt.envVal, func(t *testing.T) {
			cfg := &testConfig{}
			t.Setenv("SRR_TEST_ENABLED", tt.envVal)
			loadEnv("test", cfg)
			if cfg.Enabled != tt.want {
				t.Errorf("loadEnv(%q) → Enabled = %v, want %v", tt.envVal, cfg.Enabled, tt.want)
			}
		})
	}
}

func TestLoadEnvStringOverride(t *testing.T) {
	type testConfig struct {
		Region string `yaml:"region"`
	}

	cfg := &testConfig{Region: "default"}
	t.Setenv("SRR_TEST_REGION", "us-west-2")
	loadEnv("test", cfg)
	if cfg.Region != "us-west-2" {
		t.Errorf("Region = %q, want %q", cfg.Region, "us-west-2")
	}
}

func TestLoadEnvNoOverrideWhenUnset(t *testing.T) {
	type testConfig struct {
		Region string `yaml:"region"`
	}

	cfg := &testConfig{Region: "original"}
	loadEnv("test", cfg)
	if cfg.Region != "original" {
		t.Errorf("Region = %q, want %q (unmodified)", cfg.Region, "original")
	}
}

func TestLoadEnvHyphenatedTag(t *testing.T) {
	type testConfig struct {
		AccessKey string `yaml:"access-key"`
	}

	cfg := &testConfig{}
	t.Setenv("SRR_TEST_ACCESS_KEY", "mykey")
	loadEnv("test", cfg)
	if cfg.AccessKey != "mykey" {
		t.Errorf("AccessKey = %q, want %q", cfg.AccessKey, "mykey")
	}
}
