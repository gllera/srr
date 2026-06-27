package main

import (
	"context"
	"net/http"
	"net/http/httptest"
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
	err := (&FetchCmd{}).runFetch(ctx, newFetchClient(1), nil, func(p feedProgress) {
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

func TestRunFetchFilterExcludes(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	var seen []feedProgress
	// Filter matches no feed (id 999).
	err := (&FetchCmd{}).runFetch(ctx, newFetchClient(1), func(ch *Feed) bool { return ch.id == 999 },
		func(p feedProgress) { seen = append(seen, p) })
	if err != nil {
		t.Fatalf("runFetch: %v", err)
	}
	if len(seen) != 0 {
		t.Fatalf("progress = %+v, want none", seen)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 0 {
			t.Fatalf("TotalArticles = %d, want 0 (filtered out)", d.core.TotalArticles)
		}
		return nil
	})
}
