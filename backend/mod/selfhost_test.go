package mod

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// mediaServer serves fixed bytes and counts requests, so dedup is observable.
func mediaServer(t *testing.T, body string) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// cacheFileCount counts non-temp files left in the cache dir.
func cacheFileCount(t *testing.T, dir string) int {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	n := 0
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), ".selfhost-") {
			n++
		}
	}
	return n
}

func TestSelfhostDownloadsImgVideoAudioPoster(t *testing.T) {
	allowPrivateForTest(t) // httptest is on loopback
	srv, _ := mediaServer(t, "BYTES")
	dir := t.TempDir()

	item := &RawItem{Content: `<p><img src="` + srv.URL + `/a.jpg"></p>` +
		`<video src="` + srv.URL + `/b.mp4" poster="` + srv.URL + `/c.jpg"></video>` +
		`<audio src="` + srv.URL + `/d.mp3"></audio>`}
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if strings.Contains(item.Content, srv.URL) {
		t.Errorf("a remote URL survived: %s", item.Content)
	}
	if got := strings.Count(item.Content, `="#`); got != 4 {
		t.Errorf("expected 4 markers, got %d in %s", got, item.Content)
	}
	if got := cacheFileCount(t, dir); got != 4 {
		t.Errorf("expected 4 cached files, got %d", got)
	}
}

func TestSelfhostDedupsByURL(t *testing.T) {
	allowPrivateForTest(t)
	srv, hits := mediaServer(t, "BYTES")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)

	for _, guid := range []uint32{1, 2} {
		item := &RawItem{GUID: guid, Content: `<img src="` + srv.URL + `/same.jpg">`}
		if err := m.Process(ctx, "#selfhost", item); err != nil {
			t.Fatalf("Process: %v", err)
		}
	}
	if *hits != 1 {
		t.Errorf("same URL fetched %d times, want 1 (URL cache)", *hits)
	}
}

func TestSelfhostFailsOpen(t *testing.T) {
	allowPrivateForTest(t)
	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	t.Cleanup(notFound.Close)
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)

	cases := map[string]string{
		"404":            `<img src="` + notFound.URL + `/x.jpg">`,
		"non-http":       `<img src="ftp://example.com/x.jpg">`,
		"already-hosted": `<img src="assets/ab/cd.jpg">`,
	}
	for name, content := range cases {
		item := &RawItem{Content: content}
		if err := m.Process(ctx, "#selfhost", item); err != nil {
			t.Fatalf("%s: Process should fail open, got %v", name, err)
		}
		if item.Content != content {
			t.Errorf("%s: content changed, got %q want %q", name, item.Content, content)
		}
	}
	if got := cacheFileCount(t, dir); got != 0 {
		t.Errorf("no file should be written on failure, got %d", got)
	}
}

func TestSelfhostMaxBodyFailsOpen(t *testing.T) {
	allowPrivateForTest(t)
	srv, _ := mediaServer(t, "THIS-BODY-IS-LONGER-THAN-THE-CAP")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	content := `<img src="` + srv.URL + `/big.jpg">`
	item := &RawItem{Content: content}
	if err := m.Process(ctx, "#selfhost maxbody=4", item); err != nil {
		t.Fatalf("Process should fail open, got %v", err)
	}
	if item.Content != content {
		t.Errorf("oversize asset should leave the URL, got %q", item.Content)
	}
	if got := cacheFileCount(t, dir); got != 0 {
		t.Errorf("oversize asset must not leave a cache file, got %d", got)
	}
}

// The --max-asset-size cap (MaxAssetSize package var) clamps the download even
// with no per-pipeline maxbody: an over-cap body is left as the remote URL.
func TestSelfhostAssetSizeCapFailsOpen(t *testing.T) {
	allowPrivateForTest(t)
	orig := MaxAssetSize
	MaxAssetSize = 4 // bytes; clamps the default 128MiB maxbody
	defer func() { MaxAssetSize = orig }()

	srv, _ := mediaServer(t, "THIS-BODY-IS-LONGER-THAN-THE-CAP")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	content := `<img src="` + srv.URL + `/big.jpg">`
	item := &RawItem{Content: content}
	if err := m.Process(ctx, "#selfhost", item); err != nil { // no maxbody param
		t.Fatalf("Process should fail open, got %v", err)
	}
	if item.Content != content {
		t.Errorf("asset over MaxAssetSize should leave the URL, got %q", item.Content)
	}
	if got := cacheFileCount(t, dir); got != 0 {
		t.Errorf("over-cap asset must not leave a cache file, got %d", got)
	}
}

func TestSelfhostBlocksSSRF(t *testing.T) {
	// No allowPrivateForTest: the loopback test server must be refused by the
	// SSRF guard, and #selfhost must fail open (leave the URL).
	srv, _ := mediaServer(t, "BYTES")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	content := `<img src="` + srv.URL + `/x.jpg">`
	item := &RawItem{Content: content}
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process should fail open under SSRF guard, got %v", err)
	}
	if item.Content != content {
		t.Errorf("SSRF-blocked URL should be left in place, got %q", item.Content)
	}
}

func TestSelfhostNoCacheDirIsNoop(t *testing.T) {
	allowPrivateForTest(t)
	srv, hits := mediaServer(t, "BYTES")
	content := `<img src="` + srv.URL + `/x.jpg">`
	item := &RawItem{Content: content}
	m := New()
	// No WithCacheDir on the context (mirrors srr preview).
	if err := m.Process(context.Background(), "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != content {
		t.Errorf("no-cache-dir should be a no-op, got %q", item.Content)
	}
	if *hits != 0 {
		t.Errorf("no-cache-dir must not fetch, got %d hits", *hits)
	}
}

func TestSelfhostRejectsBadParams(t *testing.T) {
	m := New()
	// A bad/unknown param errors during param parsing, before the cache dir is
	// read — so no WithCacheDir context is needed.
	ctx := context.Background()
	for _, token := range []string{
		"#selfhost foo=bar",
		"#selfhost timeout=abc",
		"#selfhost maxbody=12xb",
		"#selfhost timeout",
	} {
		item := &RawItem{Content: `<img src="http://example.com/x.jpg">`}
		if err := m.Process(ctx, token, item); err == nil {
			t.Errorf("token %q: expected a configuration error", token)
		}
	}
}

// TestCleanExtRejections pins cleanExt's rejects: no extension, a non-alnum
// char in the extension, and an over-6-char extension all yield "" (the cache
// extension is only a hint — peek/process identify the real type by bytes).
func TestCleanExtRejections(t *testing.T) {
	cases := map[string]string{
		"/img":        "",     // no dot → no extension
		"/a.j@g":      "",     // non-alphanumeric char in the extension
		"/a.jpeglong": "",     // extension longer than 6 chars (incl. the dot)
		"/photo.JPG":  ".jpg", // valid → lower-cased (sanity anchor)
	}
	for in, want := range cases {
		if got := cleanExt(in); got != want {
			t.Errorf("cleanExt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSelfhostLeavesAnchorHref(t *testing.T) {
	allowPrivateForTest(t)
	srv, hits := mediaServer(t, "BYTES")
	dir := t.TempDir()
	content := `<a href="` + srv.URL + `/doc.pdf">file</a>`
	item := &RawItem{Content: content}
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != content || *hits != 0 {
		t.Errorf("anchor href is out of scope; content=%q hits=%d", item.Content, *hits)
	}
}

// Reusing a cached URL file must refresh its mtime, so the post-cycle cache
// sweep (age-based) never deletes a file a live feed still consumes.
func TestSelfhostReuseRefreshesMtime(t *testing.T) {
	allowPrivateForTest(t)
	srv, _ := mediaServer(t, "BYTES")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)

	item := &RawItem{GUID: 1, Content: `<img src="` + srv.URL + `/same.jpg">`}
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	ents, err := os.ReadDir(dir)
	if err != nil || len(ents) != 1 {
		t.Fatalf("expected 1 cached file, got %d (err %v)", len(ents), err)
	}
	full := dir + "/" + ents[0].Name()
	stale := time.Now().Add(-100 * time.Hour)
	if err := os.Chtimes(full, stale, stale); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	item2 := &RawItem{GUID: 2, Content: `<img src="` + srv.URL + `/same.jpg">`}
	if err := m.Process(ctx, "#selfhost", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	fi, err := os.Stat(full)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if time.Since(fi.ModTime()) > time.Minute {
		t.Errorf("cache reuse did not refresh mtime: %v", fi.ModTime())
	}
}
