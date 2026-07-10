package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeAged creates a file with the given content and mtime age.
func writeAged(t *testing.T, path string, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	stamp := time.Now().Add(-age)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
}

// The cache sweep runs after each fetch cycle: files unused for longer than
// max-age are deleted (a consumed download's mtime never refreshes once its
// asset is in the store), fresh ones — possibly mid-warming for a retrying
// feed — are kept.
func TestSweepAssetCacheRemovesOnlyOldFiles(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "tg", "1", "old.mp4")
	oldPart := filepath.Join(dir, "tg", "1", "gone.mp4.part")
	fresh := filepath.Join(dir, "tg", "1", "fresh.mp4")
	writeAged(t, old, 48*time.Hour)
	writeAged(t, oldPart, 48*time.Hour)
	writeAged(t, fresh, time.Minute)

	if got := sweepAssetCache(dir, 24*time.Hour); got != 2 {
		t.Errorf("removed = %d, want 2", got)
	}
	for _, p := range []string{old, oldPart} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s still present", p)
		}
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh file removed: %v", err)
	}
}

// max-age 0 disables the sweep entirely.
func TestSweepAssetCacheDisabled(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.bin")
	writeAged(t, old, 1000*time.Hour)

	if got := sweepAssetCache(dir, 0); got != 0 {
		t.Errorf("removed = %d, want 0 (disabled)", got)
	}
	if _, err := os.Stat(old); err != nil {
		t.Errorf("file removed despite disabled sweep: %v", err)
	}
}

// A missing cache dir is a quiet no-op (nothing downloaded yet).
func TestSweepAssetCacheMissingDir(t *testing.T) {
	if got := sweepAssetCache(filepath.Join(t.TempDir(), "nope"), time.Hour); got != 0 {
		t.Errorf("removed = %d, want 0", got)
	}
}

// UploadCacheRef must refresh the source file's mtime when it consumes it, so
// relevance-tracking is central — the age sweep can't delete a file the
// pipeline still references even if the ingest script never touches on reuse.
func TestUploadCacheRefTouchesSourceFile(t *testing.T) {
	dir := t.TempDir()
	full := filepath.Join(dir, "pic.jpg")
	writeAged(t, full, 100*time.Hour)

	af := newAssetFetcher(tempStore(t), 0, "")
	if _, _, err := af.UploadCacheRef(t.Context(), dir, "pic.jpg"); err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	fi, err := os.Stat(full)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if time.Since(fi.ModTime()) > time.Minute {
		t.Errorf("consume did not refresh mtime: %v", fi.ModTime())
	}
}
