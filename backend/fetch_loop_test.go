package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestFetchLoopSingleShot verifies that fetchLoop with a non-positive interval
// runs exactly one fetch cycle and returns runFetch's result directly — the
// behaviour `srr art fetch` (no --interval) relies on.
func TestFetchLoopSingleShot(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
		t.Fatalf("fetchLoop: %v", err)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 1 {
			t.Fatalf("TotalArticles = %d, want 1", d.core.TotalArticles)
		}
		return nil
	})
}

// TestFetchLoopRepeatsUntilCancel verifies that fetchLoop with a positive
// interval keeps fetching on every tick and returns nil once the context is
// cancelled — the loop shared by `srr art fetch --interval` and the new
// `srr serve --interval`.
func TestFetchLoopRepeatsUntilCancel(t *testing.T) {
	allowLoopback(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)

	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: srv.URL})

	cctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- (&FetchCmd{Interval: 10 * time.Millisecond}).fetchLoop(cctx, newFetchClient(1))
	}()

	// Wait until the feed has been fetched at least twice — proof the loop ticks
	// rather than running a single cycle.
	deadline := time.After(2 * time.Second)
	for hits.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("feed fetched %d times in 2s, want >= 2 (loop not ticking)", hits.Load())
		case <-time.After(2 * time.Millisecond):
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("fetchLoop returned %v, want nil on cancel", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fetchLoop did not return within 2s of cancel")
	}
}
