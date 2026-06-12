package main

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"srrb/store"
)

func tempStore(t *testing.T) store.Backend {
	t.Helper()
	dir := t.TempDir()
	be, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { be.Close() })
	return be
}

func readKey(t *testing.T, be store.Backend, key string) []byte {
	t.Helper()
	rc, err := be.Get(context.Background(), key, false)
	if err != nil {
		t.Fatalf("get %q: %v", key, err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read %q: %v", key, err)
	}
	return b
}

// writeCacheFile writes content to cacheDir/name (creating parents) for the
// UploadCacheRef tests, returning the cache dir's absolute path.
func writeCacheFile(t *testing.T, cacheDir, name, content string) {
	t.Helper()
	full := filepath.Join(cacheDir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write cache file: %v", err)
	}
}

func TestUploadCacheRefStoresUnderContentHashKey(t *testing.T) {
	const body = "IMAGEBYTES"
	be := tempStore(t)
	af := newAssetFetcher(be, 1024)

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "sub/photo.jpg", body)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "sub/photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}

	sum := sha256.Sum256([]byte(body))
	if want := contentHashKey("sub/photo.jpg", sum); key != want {
		t.Errorf("key = %q, want content-hash key %q", key, want)
	}
	if !strings.HasPrefix(key, "assets/") || !strings.HasSuffix(key, ".jpg") {
		t.Errorf("unexpected key shape: %q", key)
	}
	if got := string(readKey(t, be, key)); got != body {
		t.Errorf("stored body = %q, want %q", got, body)
	}
}

func TestUploadCacheRefSkipsWhenAlreadyPresent(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024)
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "p.jpg", "ORIGINAL")

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "p.jpg")
	if err != nil {
		t.Fatalf("first UploadCacheRef: %v", err)
	}

	// Overwrite the stored object with a sentinel; a second call must find the
	// key present and skip the re-upload, leaving the sentinel intact.
	if err := be.Put(context.Background(), key, strings.NewReader("SENTINEL"), true); err != nil {
		t.Fatalf("seed store: %v", err)
	}
	key2, err := af.UploadCacheRef(context.Background(), cacheDir, "p.jpg")
	if err != nil {
		t.Fatalf("second UploadCacheRef: %v", err)
	}
	if key2 != key {
		t.Errorf("key not stable across runs: %q vs %q", key2, key)
	}
	if got := string(readKey(t, be, key)); got != "SENTINEL" {
		t.Errorf("present key was re-uploaded: stored %q, want SENTINEL", got)
	}
}

func TestUploadCacheRefRejectsTraversal(t *testing.T) {
	parent := t.TempDir()
	cacheDir := filepath.Join(parent, "cache")
	if err := os.Mkdir(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir cache: %v", err)
	}
	// A real file outside the cache dir, referenced via "..".
	if err := os.WriteFile(filepath.Join(parent, "outside.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	af := newAssetFetcher(tempStore(t), 1024)
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "../outside.jpg"); err == nil {
		t.Fatal("expected traversal rejection, got nil")
	}
}

func TestUploadCacheRefRejectsSymlink(t *testing.T) {
	parent := t.TempDir()
	cacheDir := filepath.Join(parent, "cache")
	if err := os.Mkdir(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir cache: %v", err)
	}
	target := filepath.Join(parent, "secret.jpg")
	if err := os.WriteFile(target, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(cacheDir, "link.jpg")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	af := newAssetFetcher(tempStore(t), 1024)
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "link.jpg"); err == nil {
		t.Fatal("expected symlink rejection, got nil")
	}
}

func TestUploadCacheRefRejectsOversize(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1) // 1 KB cap
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "big.jpg", strings.Repeat("x", 4096))
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "big.jpg"); err == nil {
		t.Fatal("expected oversize rejection, got nil")
	}
}

func TestUploadCacheRefMissingFile(t *testing.T) {
	af := newAssetFetcher(tempStore(t), 1024)
	if _, err := af.UploadCacheRef(context.Background(), t.TempDir(), "nope.jpg"); err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}
