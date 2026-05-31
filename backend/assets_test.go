package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
