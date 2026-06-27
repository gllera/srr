package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"srrb/mod"
)

const sampleRSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>S</title>
<item><title>Hello</title><link>https://e.example/a</link><description>&lt;p&gt;Body&lt;/p&gt;</description></item>
</channel></rss>`

func TestPreview(t *testing.T) {
	setupTestDB(t)
	// A local RSS server; allow loopback fetch past the SSRF guard.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	prev := mod.AllowPrivateFetch
	mod.AllowPrivateFetch = true
	t.Cleanup(func() { mod.AllowPrivateFetch = prev })

	rec := doReq(t, newMux(), "GET", "/api/preview?url="+srv.URL, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got []previewArticle
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Title != "Hello" {
		t.Fatalf("got %+v", got)
	}
	if got[0].Link != "https://e.example/a" {
		t.Errorf("link = %q, want https://e.example/a", got[0].Link)
	}
	if !strings.Contains(got[0].Content, "Body") {
		t.Errorf("content = %q, want it to contain Body", got[0].Content)
	}
}

func TestPreviewRequiresURL(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/preview", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestGenShowAndBump(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/gen", "")
	var g struct {
		Gen int `json:"gen"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil {
		t.Fatalf("decode gen: %v", err)
	}
	if g.Gen != 0 {
		t.Fatalf("initial gen = %d, want 0", g.Gen)
	}
	bump := doReq(t, newMux(), "POST", "/api/gen/bump", "")
	if bump.Code != http.StatusOK {
		t.Fatalf("bump = %d (%s)", bump.Code, bump.Body)
	}
	json.Unmarshal(bump.Body.Bytes(), &g)
	if g.Gen != 1 {
		t.Fatalf("after bump gen = %d, want 1", g.Gen)
	}
}

func TestServeExportImportRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubResolve(t)
	seedFeed(t, db, &Feed{Title: "Alpha", URL: "https://a.example/feed", Tag: "news"})

	exp := doReq(t, newMux(), "GET", "/api/export", "")
	if exp.Code != http.StatusOK {
		t.Fatalf("export = %d", exp.Code)
	}
	opml := exp.Body.String()
	if !strings.Contains(opml, "https://a.example/feed") {
		t.Fatalf("export missing feed: %s", opml)
	}

	// Fresh store; import the exported OPML.
	setupTestDB(t)
	stubResolve(t)
	imp := doReqRaw(t, newMux(), "POST", "/api/import", opml)
	if imp.Code != http.StatusOK {
		t.Fatalf("import = %d (%s)", imp.Code, imp.Body)
	}
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	if !strings.Contains(list.Body.String(), "https://a.example/feed") {
		t.Fatalf("imported feed not listed: %s", list.Body)
	}
}
