package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"srrb/mod"
)

func rssServer(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS)) // defined in serve_tools_test.go
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func allowLoopback(t *testing.T) {
	t.Helper()
	prev := mod.AllowPrivateFetch
	mod.AllowPrivateFetch = true
	t.Cleanup(func() { mod.AllowPrivateFetch = prev })
}

func TestRunFetchAllAndProgress(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	// Exactly one feed is seeded, so onFeed fires once from a single worker —
	// the unguarded append is safe here. A multi-feed caller (e.g. the SSE
	// handler) must guard onFeed; it does so by pushing to a channel.
	var seen []feedProgress
	err := (&FetchCmd{}).runFetch(ctx, newFetchClient(1), func(p feedProgress) {
		seen = append(seen, p)
	})
	if err != nil {
		t.Fatalf("runFetch: %v", err)
	}
	if len(seen) != 1 || seen[0].New != 1 {
		t.Fatalf("progress = %+v, want one feed with 1 new", seen)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 1 {
			t.Fatalf("TotalArticles = %d, want 1", d.core.TotalArticles)
		}
		return nil
	})
}

func TestFetchSSE(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	srv := httptest.NewServer(newMux())
	t.Cleanup(srv.Close)
	res, err := http.Post(srv.URL+"/api/fetch", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	s := string(body)
	if !strings.Contains(s, "event: feed") {
		t.Fatalf("stream missing feed event:\n%s", s)
	}
	if !strings.Contains(s, "event: done") {
		t.Fatalf("stream missing done event:\n%s", s)
	}
}

func TestFetchSSELockContention(t *testing.T) {
	_, _, dir := setupTestDB(t)
	if err := os.WriteFile(dir+"/"+dbLockKey, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newMux())
	t.Cleanup(srv.Close)
	res, err := http.Post(srv.URL+"/api/fetch", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "event: error") || !strings.Contains(string(body), "locked") {
		t.Fatalf("expected in-band lock error event, got:\n%s", body)
	}
}
