package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestInspectHTTPURLValidates exercises the --url (HTTP CDN) inspect path end to
// end: a small consistent store is served over HTTP (its on-disk .gz files
// straight through http.FileServer, which httpFetcher GETs and gunzips), and
// `srr inspect --url --validate` walks it and passes.
func TestInspectHTTPURLValidates(t *testing.T) {
	db, _, dir := setupTestDB(t)
	f := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(f); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	db.core.FetchedAt = 1700000000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: f, Title: "t1", Content: "c1", Link: "l1"},
		{Feed: f, Title: "t2", Content: "c2", Link: "l2"},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	srv := httptest.NewServer(http.FileServer(http.Dir(dir)))
	defer srv.Close()

	out := captureStdout(t, func() {
		if err := (&InspectCmd{URL: srv.URL, Chron: -1, Validate: true}).Run(); err != nil {
			t.Fatalf("inspect --url --validate: %v", err)
		}
	})
	if !strings.Contains(out, "OK: all checks passed") {
		t.Errorf("validate over HTTP did not pass:\n%s", out)
	}
	if !strings.Contains(out, "total_art=2") {
		t.Errorf("report missing the HTTP-fetched db header:\n%s", out)
	}
}

// TestInspectHTTPURLServerErrorWraps: a 5xx from the CDN surfaces as a wrapped
// error naming db.gz, rather than a bare status or a panic.
func TestInspectHTTPURLServerErrorWraps(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	err := (&InspectCmd{URL: srv.URL, Chron: -1}).Run()
	if err == nil {
		t.Fatal("inspect --url against a 500 server returned nil")
	}
	if !strings.Contains(err.Error(), "db.gz") || !strings.Contains(err.Error(), "500") {
		t.Errorf("err = %v, want it to wrap the db.gz fetch and the 500 status", err)
	}
}
