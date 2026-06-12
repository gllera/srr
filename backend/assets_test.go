package main

import (
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"net/http/httptest"
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

func TestAssetFetchStoresBodyUnderHashKey(t *testing.T) {
	const body = "JPEGDATA"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		io.WriteString(w, body)
	}))
	defer srv.Close()

	be := tempStore(t)
	af := newAssetFetcher(be, srv.Client(), 1024)

	src := srv.URL + "/photo.jpg"
	key, err := af.Fetch(context.Background(), src)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if !strings.HasPrefix(key, "assets/") || !strings.HasSuffix(key, ".jpg") {
		t.Errorf("unexpected key shape: %q", key)
	}
	if got := string(readKey(t, be, key)); got != body {
		t.Errorf("stored body = %q, want %q", got, body)
	}
}

func TestAssetFetchExtFromContentType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		io.WriteString(w, "PNG")
	}))
	defer srv.Close()

	af := newAssetFetcher(tempStore(t), srv.Client(), 1024)
	// No extension on the URL path → ext derives from Content-Type.
	key, err := af.Fetch(context.Background(), srv.URL+"/image")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if !strings.HasSuffix(key, ".png") {
		t.Errorf("ext not derived from content-type: %q", key)
	}
}

func TestAssetFetchSizeCapAbortsAndRemovesPartial(t *testing.T) {
	big := strings.Repeat("x", 4096)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// No Content-Length (chunked) so the cap is enforced via the stream
		// guard, not the pre-check.
		w.Header().Set("Content-Type", "image/jpeg")
		io.WriteString(w, big)
	}))
	defer srv.Close()

	be := tempStore(t)
	af := newAssetFetcher(be, srv.Client(), 1) // 1 KB cap < 4 KB body

	src := srv.URL + "/big.jpg"
	if _, err := af.Fetch(context.Background(), src); err == nil {
		t.Fatal("expected size-cap error, got nil")
	}
	// The partial object must not survive.
	key := assetKey(src, "/big.jpg", "image/jpeg")
	if rc, err := be.Get(context.Background(), key, true); err != nil {
		t.Fatalf("get: %v", err)
	} else if rc != nil {
		rc.Close()
		t.Errorf("partial asset %q was not removed", key)
	}
}

func TestAssetFetchRejectsNonHTTP(t *testing.T) {
	af := newAssetFetcher(tempStore(t), http.DefaultClient, 1024)
	if _, err := af.Fetch(context.Background(), "ftp://example.com/x.jpg"); err == nil {
		t.Error("expected error for non-http scheme")
	}
}

func TestAssetFetchNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()

	af := newAssetFetcher(tempStore(t), srv.Client(), 1024)
	if _, err := af.Fetch(context.Background(), srv.URL+"/missing.jpg"); err == nil {
		t.Error("expected error for non-200 response")
	}
}

func TestAssetKeyStableForSameURL(t *testing.T) {
	a := assetKey("https://x/y.jpg", "/y.jpg", "")
	b := assetKey("https://x/y.jpg", "/y.jpg", "")
	if a != b {
		t.Errorf("key not stable: %q vs %q", a, b)
	}
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
	af := newAssetFetcher(be, nil, 1024)

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
	af := newAssetFetcher(be, nil, 1024)
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
	af := newAssetFetcher(tempStore(t), nil, 1024)
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
	af := newAssetFetcher(tempStore(t), nil, 1024)
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "link.jpg"); err == nil {
		t.Fatal("expected symlink rejection, got nil")
	}
}

func TestUploadCacheRefRejectsOversize(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, nil, 1) // 1 KB cap
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "big.jpg", strings.Repeat("x", 4096))
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "big.jpg"); err == nil {
		t.Fatal("expected oversize rejection, got nil")
	}
}

func TestUploadCacheRefMissingFile(t *testing.T) {
	af := newAssetFetcher(tempStore(t), nil, 1024)
	if _, err := af.UploadCacheRef(context.Background(), t.TempDir(), "nope.jpg"); err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}
