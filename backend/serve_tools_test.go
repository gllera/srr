package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const sampleRSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>S</title>
<item><title>Hello</title><link>https://e.example/a</link><description>&lt;p&gt;Body&lt;/p&gt;</description></item>
</channel></rss>`

func TestPreview(t *testing.T) {
	setupTestDB(t)
	allowLoopback(t)
	url := rssServer(t)

	rec := doReq(t, newMux(), "GET", "/api/preview?url="+url, "")
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

// GET /api/resolve reads the wire's own label: the feed-level title, the item
// count, and the (possibly discovery-resolved) feed URL — what the add-feed
// dialog pre-fills before the operator commits.
func TestResolve(t *testing.T) {
	setupTestDB(t)
	allowLoopback(t)
	url := rssServer(t)

	rec := doReq(t, newMux(), "GET", "/api/resolve?url="+url, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got struct {
		URL   string `json:"url"`
		Title string `json:"title"`
		Items int    `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.URL != url || got.Title != "S" || got.Items != 1 {
		t.Fatalf("got %+v, want url=%s title=S items=1", got, url)
	}
}

func TestResolveInvalidURL(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/resolve?url=notaurl", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestGenShowAndBump(t *testing.T) {
	setupTestDB(t)
	ov := doReq(t, newMux(), "GET", "/api/overview", "")
	var got overviewView
	if err := json.Unmarshal(ov.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode overview: %v", err)
	}
	if got.Gen != 0 {
		t.Fatalf("initial gen = %d, want 0", got.Gen)
	}
	bump := doReq(t, newMux(), "POST", "/api/gen/bump", "")
	if bump.Code != http.StatusOK {
		t.Fatalf("bump = %d (%s)", bump.Code, bump.Body)
	}
	var g struct {
		Gen int `json:"gen"`
	}
	json.Unmarshal(bump.Body.Bytes(), &g)
	if g.Gen != 1 {
		t.Fatalf("after bump gen = %d, want 1", g.Gen)
	}
}

func TestServeExportImportRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
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
	stubPassthroughResolve()
	imp := doReq(t, newMux(), "POST", "/api/import", opml)
	if imp.Code != http.StatusOK {
		t.Fatalf("import = %d (%s)", imp.Code, imp.Body)
	}
	ov := doReq(t, newMux(), "GET", "/api/overview", "")
	if !strings.Contains(ov.Body.String(), "https://a.example/feed") {
		t.Fatalf("imported feed not listed in overview: %s", ov.Body)
	}
}

func TestHandleImportTagOverrideSkipsGroupResolution(t *testing.T) {
	setupTestDB(t)
	// A numeric-only folder name ("2024") makes resolveTag/normalizeGroupName error;
	// a ?tag= override must skip that resolution (the CLI -g does).
	opml := `<opml version="2.0"><body><outline text="2024">` +
		`<outline text="Alpha" type="rss" xmlUrl="https://a.example/feed"/></outline></body></opml>`
	rec := doReq(t, newMux(), "POST", "/api/import?tag=mytag&dry_run=1", opml)
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d, body %s", rec.Code, rec.Body.String())
	}
}

func TestInspectValidate(t *testing.T) {
	db, _, _ := setupTestDB(t) // empty store is internally consistent
	// A real store always has a committed db.gz; setupTestDB doesn't write one,
	// so commit here — the read-only inspect handler must not create it itself.
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got struct {
		Report string `json:"report"`
		OK     bool   `json:"ok"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.OK {
		t.Fatalf("empty store should validate ok; report:\n%s", got.Report)
	}
	// Confirm the report was actually captured (the db header always prints it),
	// so a silently-broken capture can't pass as ok.
	if !strings.Contains(got.Report, "total_art") {
		t.Fatalf("report missing captured content:\n%s", got.Report)
	}
}

func TestInspectBadMode(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=bogus", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestInspectFromHashMissingParam(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=from-hash", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (missing hash)", rec.Code)
	}
}
