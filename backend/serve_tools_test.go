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

// TestRenderPreviewDropsFilteredItem exercises renderPreview's i.Drop skip: a
// #filter drop_title pipe override fetches, processes, then DROPS the matching
// item instead of returning it.
func TestRenderPreviewDropsFilteredItem(t *testing.T) {
	setupTestDB(t)
	allowLoopback(t)
	url := rssServer(t)

	recipes := map[string]Recipe{"default": {Pipe: []string{"#sanitize", "#minify"}}}
	items, err := renderPreview(ctx, recipes, "default", []string{"#filter drop_title=/Hello/"}, "", url)
	if err != nil {
		t.Fatalf("renderPreview: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("got %d items, want 0 (Hello dropped by #filter)", len(items))
	}
}

// TestRenderPreviewDefaultOverrideResolvesRecipe pins the feed-level override
// semantics of a ["#default"] pipe override: it expands to the *recipe's*
// effective pipe, not the global default's. Proven by pointing the same
// override at a filtering recipe (item dropped) vs the plain default (item
// kept).
func TestRenderPreviewDefaultOverrideResolvesRecipe(t *testing.T) {
	setupTestDB(t)
	allowLoopback(t)
	url := rssServer(t)

	recipes := map[string]Recipe{
		"default": {Pipe: []string{"#sanitize", "#minify"}},
		"dropper": {Pipe: []string{"#filter drop_title=/Hello/"}},
	}
	dropped, err := renderPreview(ctx, recipes, "dropper", []string{"#default"}, "", url)
	if err != nil {
		t.Fatalf("renderPreview dropper: %v", err)
	}
	if len(dropped) != 0 {
		t.Fatalf("got %d items, want 0 (#default expanded to dropper's filtering pipe)", len(dropped))
	}

	kept, err := renderPreview(ctx, recipes, "default", []string{"#default"}, "", url)
	if err != nil {
		t.Fatalf("renderPreview default: %v", err)
	}
	if len(kept) != 1 {
		t.Fatalf("got %d items, want 1 (#default expanded to the default recipe, keeps Hello)", len(kept))
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
	stubPassthroughResolve() // keep the feed (else it lands in skipped, tagless)
	// A numeric-only folder name ("2024") makes resolveTag/normalizeGroupName error;
	// a ?tag= override must skip that resolution (the CLI -g does).
	opml := `<opml version="2.0"><body><outline text="2024">` +
		`<outline text="Alpha" type="rss" xmlUrl="https://a.example/feed"/></outline></body></opml>`
	rec := doReq(t, newMux(), "POST", "/api/import?tag=mytag&dry_run=1", opml)
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d, body %s", rec.Code, rec.Body.String())
	}
	// The override tag reached the resolved feed (numeric-folder resolution skipped).
	var got struct {
		Feeds []struct {
			Tag string `json:"tag"`
		} `json:"feeds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Feeds) != 1 || got.Feeds[0].Tag != "mytag" {
		t.Fatalf("feeds = %+v, want one feed tagged \"mytag\"", got.Feeds)
	}
}

// A malformed OPML upload is a 400 from ParseOPMLBytes, before any walk or probe.
func TestHandleImportMalformedOPML(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "POST", "/api/import", "not-xml")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
	}
}

// handleResolve, past the validFeedURL guard, 400s when the fetch itself fails.
// A valid-form loopback URL is blocked by the SSRF guard (allowLoopback NOT
// enabled), so previewFetch errors — exercising handleResolve's previewFetch
// error branch (only the validFeedURL guard was previously covered).
func TestResolveFetchFails(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/resolve?url=http://127.0.0.1:9/feed", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (fetch failure)", rec.Code)
	}
}

// mode=from-hash with a REAL hash on a seeded, committed store runs InspectCmd
// end-to-end: 200 with ok=true and a non-empty report.
func TestInspectFromHashSeededStore(t *testing.T) {
	db, _, _ := setupTestDB(t)
	f := &Feed{Title: "News", URL: "https://n.example/f", Tag: "news"}
	if err := db.AddFeed(f); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PutArticles(ctx, []*Item{{Feed: f, Title: "a0", Content: "c0", Link: "l0", Published: 100}}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil { // inspect reads the committed db.gz
		t.Fatal(err)
	}

	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=from-hash&hash=%230", "") // #0
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got struct {
		Report string `json:"report"`
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.OK {
		t.Fatalf("ok = false, want true; error=%q report:\n%s", got.Error, got.Report)
	}
	if got.Report == "" {
		t.Fatal("report is empty, want the captured from-hash output")
	}
}

// from-hash on a store with no committed db.gz is the ok=false path: InspectCmd
// fails to open, so the handler still 200s but reports ok=false with the error
// (inspect must not create db.gz as a side effect).
func TestInspectFromHashUncommittedStoreNotOK(t *testing.T) {
	setupTestDB(t) // never commits db.gz
	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=from-hash&hash=%230", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (errors ride the body, not the status)", rec.Code)
	}
	var got struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.OK || got.Error == "" {
		t.Fatalf("ok=%v error=%q, want ok=false with a non-empty error", got.OK, got.Error)
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
