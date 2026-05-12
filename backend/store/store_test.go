package store

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
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

func newTestCache(t *testing.T) (*Cache, string) {
	t.Helper()
	remote, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open remote: %v", err)
	}
	t.Cleanup(func() { remote.Close() })
	cacheDir := t.TempDir()
	return &Cache{remote: remote, local: &Local{path: cacheDir}, valid: true}, cacheDir
}

func TestCachePutWritesAtomically(t *testing.T) {
	c, cacheDir := newTestCache(t)

	if err := c.Put(ctx, "x.gz", strings.NewReader("hello"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}

	cacheFile := filepath.Join(cacheDir, "x.gz")
	got, err := os.ReadFile(cacheFile)
	if err != nil {
		t.Fatalf("ReadFile cache: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("cache content = %q, want %q", got, "hello")
	}
	if _, err := os.Stat(cacheFile + ".tmp"); !os.IsNotExist(err) {
		t.Error(".tmp file should not remain after successful cacheLocally")
	}
}

func TestCachePutReplacesAtomically(t *testing.T) {
	c, cacheDir := newTestCache(t)

	if err := c.Put(ctx, "x.gz", strings.NewReader("v1"), true); err != nil {
		t.Fatalf("Put v1: %v", err)
	}
	if err := c.Put(ctx, "x.gz", strings.NewReader("version-two-longer"), true); err != nil {
		t.Fatalf("Put v2: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(cacheDir, "x.gz"))
	if err != nil {
		t.Fatalf("ReadFile cache: %v", err)
	}
	if string(got) != "version-two-longer" {
		t.Errorf("cache content = %q, want %q", got, "version-two-longer")
	}
}

func TestCacheEvictsLocalOnWriteFailure(t *testing.T) {
	c, cacheDir := newTestCache(t)

	if err := c.Put(ctx, "x.gz", strings.NewReader("v1"), true); err != nil {
		t.Fatalf("Put v1: %v", err)
	}
	cacheFile := filepath.Join(cacheDir, "x.gz")
	if _, err := os.Stat(cacheFile); err != nil {
		t.Fatalf("cache file should exist after Put v1: %v", err)
	}

	// Replace the cache file with a directory so AtomicPut's rename fails
	// (can't rename a regular file over a non-empty directory). Rm of the
	// directory will succeed via os.Remove since it's empty.
	if err := os.Remove(cacheFile); err != nil {
		t.Fatalf("Remove cache file: %v", err)
	}
	if err := os.Mkdir(cacheFile, 0o755); err != nil {
		t.Fatalf("Mkdir as cache file: %v", err)
	}

	if err := c.Put(ctx, "x.gz", strings.NewReader("v2"), true); err != nil {
		t.Fatalf("Put v2 (remote succeeds even if cache write fails): %v", err)
	}

	if _, err := os.Stat(cacheFile); !os.IsNotExist(err) {
		t.Errorf("expected cache entry evicted after local write failure, stat err=%v", err)
	}

	rc, err := c.Get(ctx, "x.gz", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "v2" {
		t.Errorf("Get content = %q, want %q", got, "v2")
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

func openCache(t *testing.T, cacheDir, storeURL string) (*Cache, string) {
	t.Helper()
	remote, err := Open(ctx, storeURL)
	if err != nil {
		t.Fatalf("Open remote: %v", err)
	}
	t.Cleanup(func() { remote.Close() })
	c, err := NewCache(remote, cacheDir, storeURL)
	if err != nil {
		t.Fatalf("NewCache: %v", err)
	}
	return c, c.local.path
}

// Mirrors DBCore's omitempty serialization so a version=0 input matches what
// the backend actually writes (field absent) rather than an explicit zero.
func gzipJSONDB(t *testing.T, version int) []byte {
	t.Helper()
	m := map[string]any{
		"data_tog":      false,
		"fetched_at":    0,
		"total_art":     0,
		"next_pid":      0,
		"pack_off":      0,
		"subscriptions": map[string]any{},
	}
	if version != 0 {
		m["version"] = version
	}
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("json marshal: %v", err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(body); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func TestCacheWipesSubdirOnVersionBump(t *testing.T) {
	cacheDir := t.TempDir()
	storeURL := t.TempDir()
	c, subdir := openCache(t, cacheDir, storeURL)

	// Seed remote + cache with version=1 and a sibling entry.
	if err := c.AtomicPut(ctx, "db.gz", bytes.NewReader(gzipJSONDB(t, 1))); err != nil {
		t.Fatalf("seed db.gz: %v", err)
	}
	if err := c.Put(ctx, "x.gz", strings.NewReader("hello"), true); err != nil {
		t.Fatalf("Put x.gz: %v", err)
	}
	if _, err := os.Stat(filepath.Join(subdir, "x.gz")); err != nil {
		t.Fatalf("seed x.gz missing from cache: %v", err)
	}

	// Bump the remote db.gz version out-of-band (simulating another writer).
	remote := c.remote
	if err := remote.AtomicPut(ctx, "db.gz", bytes.NewReader(gzipJSONDB(t, 2))); err != nil {
		t.Fatalf("bump remote db.gz: %v", err)
	}

	// Next read of db.gz should detect the mismatch and wipe the cache.
	rc, err := c.Get(ctx, "db.gz", false)
	if err != nil {
		t.Fatalf("Get db.gz: %v", err)
	}
	rc.Close()

	if _, err := os.Stat(filepath.Join(subdir, "x.gz")); !os.IsNotExist(err) {
		t.Errorf("x.gz should be wiped on version bump, stat err = %v", err)
	}
}

func TestCachePreservesEntriesWhenVersionUnchanged(t *testing.T) {
	cacheDir := t.TempDir()
	storeURL := t.TempDir()
	c, subdir := openCache(t, cacheDir, storeURL)

	if err := c.AtomicPut(ctx, "db.gz", bytes.NewReader(gzipJSONDB(t, 1))); err != nil {
		t.Fatalf("seed db.gz: %v", err)
	}
	if err := c.Put(ctx, "x.gz", strings.NewReader("hello"), true); err != nil {
		t.Fatalf("Put x.gz: %v", err)
	}

	rc, err := c.Get(ctx, "db.gz", false)
	if err != nil {
		t.Fatalf("Get db.gz: %v", err)
	}
	rc.Close()

	if _, err := os.Stat(filepath.Join(subdir, "x.gz")); err != nil {
		t.Errorf("cached entry should survive same-version re-read: %v", err)
	}
}

// Regression: a failed wipeSubdir used to leave c.valid=false but useCache=true
// for finalized packs, so the next Get would happily serve old-version cached
// packs alongside the just-updated db.gz. The compromised flag bypasses local
// reads (and skips writes) so the process re-fetches everything from remote.
func TestCacheCompromisedAfterWipeFailureBypassesLocal(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("read-only chmod doesn't constrain root; skipping")
	}

	cacheDir := t.TempDir()
	storeURL := t.TempDir()
	c, subdir := openCache(t, cacheDir, storeURL)

	if err := c.AtomicPut(ctx, "db.gz", bytes.NewReader(gzipJSONDB(t, 1))); err != nil {
		t.Fatalf("seed db.gz: %v", err)
	}
	if err := c.Put(ctx, "5.gz", strings.NewReader("stale"), true); err != nil {
		t.Fatalf("seed 5.gz: %v", err)
	}

	// Bump remote out-of-band and rewrite the finalized pack (simulating a
	// cron rewrite that triggered `srr clear-cache --all`).
	remote := c.remote
	if err := remote.AtomicPut(ctx, "db.gz", bytes.NewReader(gzipJSONDB(t, 2))); err != nil {
		t.Fatalf("bump remote: %v", err)
	}
	if err := remote.Put(ctx, "5.gz", strings.NewReader("fresh"), true); err != nil {
		t.Fatalf("rewrite remote 5.gz: %v", err)
	}

	// Make the cache subdir read-only so wipeSubdir's RemoveAll fails.
	if err := os.Chmod(subdir, 0o500); err != nil {
		t.Fatalf("chmod subdir: %v", err)
	}
	t.Cleanup(func() { os.Chmod(subdir, 0o755) })

	rc, err := c.Get(ctx, "db.gz", false)
	if err != nil {
		t.Fatalf("Get db.gz: %v", err)
	}
	rc.Close()

	if !c.compromised {
		t.Fatal("compromised flag should be set after wipe failure")
	}

	rc, err = c.Get(ctx, "5.gz", false)
	if err != nil {
		t.Fatalf("Get 5.gz: %v", err)
	}
	if got := readAllClose(t, rc); got != "fresh" {
		t.Errorf("Get 5.gz = %q, want %q (cache should be bypassed)", got, "fresh")
	}
}

// Directly exercises the flag so the bypass semantics stay locked in even if
// the wipe path is refactored.
func TestCompromisedBypassesFinalizedAndLatestPacks(t *testing.T) {
	c, _ := newTestCache(t)

	if err := c.Put(ctx, "5.gz", strings.NewReader("stale-finalized"), true); err != nil {
		t.Fatalf("Put 5.gz: %v", err)
	}
	if err := c.Put(ctx, "true.gz", strings.NewReader("stale-latest"), true); err != nil {
		t.Fatalf("Put true.gz: %v", err)
	}
	if err := c.remote.Put(ctx, "5.gz", strings.NewReader("fresh-finalized"), true); err != nil {
		t.Fatalf("remote 5.gz: %v", err)
	}
	if err := c.remote.Put(ctx, "true.gz", strings.NewReader("fresh-latest"), true); err != nil {
		t.Fatalf("remote true.gz: %v", err)
	}

	c.compromised = true

	rc, err := c.Get(ctx, "5.gz", false)
	if err != nil {
		t.Fatalf("Get 5.gz: %v", err)
	}
	if got := readAllClose(t, rc); got != "fresh-finalized" {
		t.Errorf("5.gz = %q, want fresh-finalized (bypassed)", got)
	}

	rc, err = c.Get(ctx, "true.gz", false)
	if err != nil {
		t.Fatalf("Get true.gz: %v", err)
	}
	if got := readAllClose(t, rc); got != "fresh-latest" {
		t.Errorf("true.gz = %q, want fresh-latest (bypassed)", got)
	}
}

// Locks in readVersion's (version, ok) semantics: a malformed remote response
// (corrupt gzip, partial body, invalid JSON) must NOT trigger a wipe just
// because the parse failed. Reverting readVersion to return a bare int would
// silently regress to "transient CDN glitch nukes the local pack cache."
func TestCachePreservesEntriesOnMalformedRemote(t *testing.T) {
	cacheDir := t.TempDir()
	storeURL := t.TempDir()
	c, subdir := openCache(t, cacheDir, storeURL)

	if err := c.AtomicPut(ctx, "db.gz", bytes.NewReader(gzipJSONDB(t, 5))); err != nil {
		t.Fatalf("seed db.gz: %v", err)
	}
	if err := c.Put(ctx, "x.gz", strings.NewReader("hello"), true); err != nil {
		t.Fatalf("Put x.gz: %v", err)
	}

	// Replace remote db.gz with bytes that can't be parsed.
	if err := c.remote.AtomicPut(ctx, "db.gz", bytes.NewReader([]byte("not gzip"))); err != nil {
		t.Fatalf("malformed remote: %v", err)
	}

	rc, err := c.Get(ctx, "db.gz", false)
	if err != nil {
		t.Fatalf("Get db.gz: %v", err)
	}
	rc.Close()

	if _, err := os.Stat(filepath.Join(subdir, "x.gz")); err != nil {
		t.Errorf("x.gz should survive malformed remote response: %v", err)
	}
}
