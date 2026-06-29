package store

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
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

	if err := b.AtomicPut(ctx, "atomic.txt", strings.NewReader("content"), ObjectMeta{}); err != nil {
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

// The writer↔CDN cache contract: finalized packs are immutable and may be
// cached forever; db.gz and the toggled latest packs are rewritten every fetch
// and must always revalidate (a stale db.gz misroutes the reader to the wrong
// latest pack). Keys with no policy return "".
func TestCacheControlForKey(t *testing.T) {
	cases := []struct {
		key, want string
	}{
		{"db.gz", cacheRevalidate},
		{"idx/0.gz", cacheImmutable},
		{"idx/12.gz", cacheImmutable},
		{"data/1.gz", cacheImmutable},
		{"data/250.gz", cacheImmutable},
		{"idx/L1.gz", cacheImmutable},
		{"idx/L0.gz", cacheImmutable},
		{"data/L7.gz", cacheImmutable},
		{"meta/0.gz", cacheImmutable},
		{"meta/L3.gz", cacheImmutable},
		{"idx/h2.gz", cacheImmutable},
		{"meta/s4.gz", cacheImmutable},
		{"assets/ab/0123456789abcdef.jpg", cacheImmutable},
		{"idx/L.gz", ""},
		{"data/Lx7.gz", ""},
		{"data/LL3.gz", ""},
		{"data/h3.gz", ""},
		{"idx/s3.gz", ""},
		{"meta/h3.gz", ""},
		{"search/0.gz", ""},
		{"search/L3.gz", ""},
		{"search/s4.gz", ""},
		{"L1.gz", ""},
		{"idx/true.gz", ""},
		{"data/false.gz", ""},
		{"idx/sub/3.gz", ""},
		{".locked", ""},
		{"unknown.txt", ""},
		// out/* is the one documented mutable class besides db.gz: revalidate.
		{"out/myfeed.rss", cacheRevalidate},
		{"out/myfeed.json", cacheRevalidate},
		{"out/nested/feed.rss", cacheRevalidate},
		// out/ must NOT match packKeyRe (not immutable).
		{"out/0.gz", cacheRevalidate},
	}
	for _, c := range cases {
		if got := cacheControlForKey(c.key); got != c.want {
			t.Errorf("cacheControlForKey(%q) = %q, want %q", c.key, got, c.want)
		}
	}
}

// Frontend files live at the store root (next to db.gz), uploaded by
// `srr frontend update`. The mutable entry point + manifests must revalidate;
// content-hashed assets are write-once and may be cached forever. Only affects
// S3 (local/SFTP ignore ObjectMeta).
func TestCacheControlForKeyFrontend(t *testing.T) {
	cases := []struct {
		key, want string
	}{
		// Mutable root files: revalidate.
		{"index.html", cacheRevalidate},
		{"manifest.webmanifest", cacheRevalidate},
		{"sitemap.txt", cacheRevalidate},
		// Content-hashed root assets: immutable.
		{"frontend.5730a221.css", cacheImmutable},
		{"frontend.778222e7.js", cacheImmutable},
		{"sw.57d1d92e.js", cacheImmutable},
		{"icon.aea4e164.svg", cacheImmutable},
		{"icon-192.936dab90.png", cacheImmutable},
		{"apple-touch-icon.bcdd2574.png", cacheImmutable},
		// Not a hash (too short / non-hex) → no policy.
		{"frontend.css", ""},
		{"app.1234.js", ""},
		// Only sitemap.txt is special; a generic root .txt gets no policy.
		{"readme.txt", ""},
	}
	for _, c := range cases {
		if got := cacheControlForKey(c.key); got != c.want {
			t.Errorf("cacheControlForKey(%q) = %q, want %q", c.key, got, c.want)
		}
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

func TestLoadEnvIntOverride(t *testing.T) {
	type testConfig struct {
		Port int `yaml:"port"`
	}

	cfg := &testConfig{Port: 22}
	t.Setenv("SRR_TEST_PORT", "2222")
	if err := loadEnv("test", cfg); err != nil {
		t.Fatalf("loadEnv: %v", err)
	}
	if cfg.Port != 2222 {
		t.Errorf("Port = %d, want 2222", cfg.Port)
	}
}

func TestLoadEnvBadIntErrors(t *testing.T) {
	type testConfig struct {
		Port int `yaml:"port"`
	}

	cfg := &testConfig{Port: 22}
	t.Setenv("SRR_TEST_PORT", "not-a-number")
	if err := loadEnv("test", cfg); err == nil {
		t.Fatal("loadEnv: want error for unparseable int, got nil")
	}
	if cfg.Port != 22 {
		t.Errorf("Port = %d, want 22 (unchanged on error)", cfg.Port)
	}
}

func TestEnvName(t *testing.T) {
	// EnvName is the single source of truth for the backend env-override grammar:
	// loadEnv reads this name and `srr config` prints it, so this pins both.
	type cfg struct {
		Region    string `yaml:"region"`
		AccessKey string `yaml:"access-key-id"`
		Inline    string `yaml:"endpoint,omitempty"` // option after the tag is dropped
		NoTag     string ``
	}
	tt := reflect.TypeOf(cfg{})
	cases := []struct {
		field int
		want  string
	}{
		{0, "SRR_S3_REGION"},
		{1, "SRR_S3_ACCESS_KEY_ID"},
		{2, "SRR_S3_ENDPOINT"},
		{3, ""}, // no yaml tag → no derived env name
	}
	for _, c := range cases {
		if got := EnvName("s3", tt.Field(c.field)); got != c.want {
			t.Errorf("EnvName(s3, %s) = %q, want %q", tt.Field(c.field).Name, got, c.want)
		}
	}
}

func TestLoadEnvUnsupportedKindErrors(t *testing.T) {
	// A field kind loadEnv can't apply must error when an override is present,
	// rather than silently leaving it un-overridable (the "env beats YAML"
	// invariant). float64 is not a supported kind.
	type testConfig struct {
		Ratio float64 `yaml:"ratio"`
	}

	cfg := &testConfig{}
	t.Setenv("SRR_TEST_RATIO", "1.5")
	if err := loadEnv("test", cfg); err == nil {
		t.Fatal("loadEnv: want error for unsupported field kind, got nil")
	}
}
