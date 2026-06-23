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

// fakeEncoder writes an executable shell script to a temp dir and returns its
// path (the command for newAssetFetcher). body is the script after the shebang;
// the cache file path arrives as "$1".
func fakeEncoder(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "encoder.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write encoder: %v", err)
	}
	return p
}

const encodedBytes = "ENCODED-OUTPUT-BYTES"
const jpegBytes = "\xff\xd8\xff\xe0\x00\x10JFIF\x00original-jpeg"
const pdfBytes = "%PDF-1.4\n original pdf"

func TestUploadCacheRefRunsEncoderBeforeUpload(t *testing.T) {
	be := tempStore(t)
	// Encoder ignores its input and emits fixed bytes — stands in for a transcoder.
	out := filepath.Join(t.TempDir(), "out.bin")
	if err := os.WriteFile(out, []byte(encodedBytes), 0o644); err != nil {
		t.Fatalf("write out: %v", err)
	}
	af := newAssetFetcher(be, 1024, fakeEncoder(t, "cat '"+out+"'"))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}

	// Stored bytes are the ENCODER's output; the key is keyed on the SOURCE hash
	// and keeps the source extension.
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".jpg", sum); key != want {
		t.Errorf("key = %q, want source-hash key %q", key, want)
	}
	if got := string(readKey(t, be, key)); got != encodedBytes {
		t.Errorf("stored body = %q, want encoded bytes %q", got, encodedBytes)
	}
}

func TestUploadCacheRefSkipsEncoderWhenSourceAlreadyUploaded(t *testing.T) {
	be := tempStore(t)
	// Pre-seed the store at the source-hash key with a sentinel.
	sum := sha256.Sum256([]byte(jpegBytes))
	key := contentHashKey(".jpg", sum)
	if err := be.Put(context.Background(), key, strings.NewReader("ALREADY"), true); err != nil {
		t.Fatalf("seed store: %v", err)
	}

	// An encoder with a side effect: if it runs, it creates ran.
	ran := filepath.Join(t.TempDir(), "ran")
	af := newAssetFetcher(be, 1024, fakeEncoder(t, "touch '"+ran+"'\ncat \"$1\""))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	got, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got != key {
		t.Errorf("key = %q, want %q", got, key)
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Error("encoder ran even though the source was already uploaded")
	}
	if body := string(readKey(t, be, key)); body != "ALREADY" {
		t.Errorf("present key was re-uploaded: stored %q, want ALREADY", body)
	}
}

func TestUploadCacheRefEncoderRunsForEveryFileType(t *testing.T) {
	be := tempStore(t)
	// A pass-through encoder with a side effect, on a non-media (PDF) file: the
	// encoder must still run (no media gate) and its output is stored verbatim.
	ran := filepath.Join(t.TempDir(), "ran")
	af := newAssetFetcher(be, 1024, fakeEncoder(t, "touch '"+ran+"'\ncat \"$1\""))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "doc.pdf", pdfBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "doc.pdf")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if _, err := os.Stat(ran); err != nil {
		t.Errorf("encoder was not run for a non-media file: %v", err)
	}
	if !strings.HasSuffix(key, ".pdf") {
		t.Errorf("key = %q, want source .pdf extension", key)
	}
	if got := string(readKey(t, be, key)); got != pdfBytes {
		t.Errorf("stored body = %q, want %q", got, pdfBytes)
	}
}

func TestUploadCacheRefEncoderFailsSoftToOriginal(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, fakeEncoder(t, "echo boom >&2\nexit 1"))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft, got error: %v", err)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (fail-soft)", got, jpegBytes)
	}
}

func TestUploadCacheRefStoresUnderContentHashKey(t *testing.T) {
	const body = "IMAGEBYTES"
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, "")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "sub/photo.jpg", body)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "sub/photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}

	sum := sha256.Sum256([]byte(body))
	if want := contentHashKey(".jpg", sum); key != want {
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
	af := newAssetFetcher(be, 1024, "")
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
	af := newAssetFetcher(tempStore(t), 1024, "")
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
	af := newAssetFetcher(tempStore(t), 1024, "")
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "link.jpg"); err == nil {
		t.Fatal("expected symlink rejection, got nil")
	}
}

func TestUploadCacheRefRejectsOversize(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1, "") // 1 KB cap
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "big.jpg", strings.Repeat("x", 4096))
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "big.jpg"); err == nil {
		t.Fatal("expected oversize rejection, got nil")
	}
}

func TestUploadCacheRefMissingFile(t *testing.T) {
	af := newAssetFetcher(tempStore(t), 1024, "")
	if _, err := af.UploadCacheRef(context.Background(), t.TempDir(), "nope.jpg"); err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

// failMidWriteBackend wraps a real Backend and fails AtomicPut after writing
// writeOK bytes, simulating a mid-stream crash or I/O error.  Get/Put/Rm/Close
// delegate to the inner backend unchanged so the existence check works normally.
type failMidWriteBackend struct {
	inner    store.Backend
	writeOK  int64 // bytes to copy before injecting an error
	atomicOK bool  // once set, AtomicPut succeeds (used to let the seeded Put through)
}

var errMidWrite = io.ErrUnexpectedEOF

func (f *failMidWriteBackend) Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
	return f.inner.Get(ctx, key, ignoreMissing)
}
func (f *failMidWriteBackend) Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error {
	return f.inner.Put(ctx, key, r, ignoreExisting)
}
func (f *failMidWriteBackend) AtomicPut(ctx context.Context, key string, r io.Reader) error {
	if f.atomicOK {
		return f.inner.AtomicPut(ctx, key, r)
	}
	// Drain exactly writeOK bytes then return an error, simulating a mid-write failure.
	buf := make([]byte, f.writeOK)
	io.ReadFull(r, buf) //nolint:errcheck — we intentionally discard the partial read
	return errMidWrite
}
func (f *failMidWriteBackend) Rm(ctx context.Context, key string) error {
	return f.inner.Rm(ctx, key)
}
func (f *failMidWriteBackend) Close() error { return f.inner.Close() }

// TestUploadCacheRefNoPartialFileOnAtomicPutFailure is the B6 regression test:
// a mid-upload failure must leave no partial object at the immutable
// content-hash key.  With AtomicPut the write goes to a .tmp file; on failure
// the tmp is abandoned and the final key is never created, so the next
// existence check returns "not found" rather than truncated bytes.
func TestUploadCacheRefNoPartialFileOnAtomicPutFailure(t *testing.T) {
	inner := tempStore(t)
	be := &failMidWriteBackend{inner: inner, writeOK: 4} // fail after 4 bytes

	af := newAssetFetcher(be, 1024, "")
	cacheDir := t.TempDir()
	// Content longer than writeOK so the mid-stream failure fires.
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	_, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err == nil {
		t.Fatal("expected upload error, got nil")
	}

	// The immutable key must NOT exist — not even partially.
	sum := sha256.Sum256([]byte(jpegBytes))
	key := contentHashKey(".jpg", sum)
	rc, getErr := inner.Get(context.Background(), key, true)
	if getErr != nil {
		t.Fatalf("Get after failed upload: %v", getErr)
	}
	if rc != nil {
		rc.Close()
		t.Errorf("partial object found at immutable key %q after failed upload; AtomicPut should prevent this", key)
	}
}
