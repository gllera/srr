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

// TestFetchLoopCycleNotCappedByShutdownGrace pins the fix for the 30s cap bug:
// in normal operation (no shutdown pending) an --interval cycle runs UNCAPPED,
// so a legitimately slow cycle still reaches its commit instead of being
// guillotined at shutdownGrace and rolled back. The grace is shrunk far below
// the cycle's own duration; the pre-fix code applied it to every cycle and this
// feed would never store.
func TestFetchLoopCycleNotCappedByShutdownGrace(t *testing.T) {
	allowLoopback(t)
	orig := shutdownGrace
	shutdownGrace = 20 * time.Millisecond
	t.Cleanup(func() { shutdownGrace = orig })

	// A cycle that takes far longer than the grace but never a shutdown signal.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)

	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Slow", URL: srv.URL})

	cctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- (&FetchCmd{Interval: time.Hour}).fetchLoop(cctx, newFetchClient(1)) }()

	deadline := time.After(3 * time.Second)
	for {
		var n int
		withDB(false, func(_ context.Context, d *DB) error { n = d.core.TotalArticles; return nil })
		if n == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("article never stored (TotalArticles=%d): cycle was capped by shutdownGrace", n)
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("fetchLoop did not return within 2s of cancel")
	}
}

// TestFetchLoopShutdownGraceBoundsWedgedCycle pins the RETAINED half of the
// contract: once a shutdown signal arrives, an in-flight cycle is still cut
// after shutdownGrace so it cannot block shutdown forever. The handler blocks
// until teardown; without the grace the loop would hang on it, so a prompt
// return proves the bound fired.
func TestFetchLoopShutdownGraceBoundsWedgedCycle(t *testing.T) {
	allowLoopback(t)
	orig := shutdownGrace
	shutdownGrace = 50 * time.Millisecond
	t.Cleanup(func() { shutdownGrace = orig })

	release := make(chan struct{})
	started := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release // wedge the cycle until the test releases it at teardown
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) }) // runs before srv.Close (LIFO) so Close doesn't hang

	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Wedged", URL: srv.URL})

	cctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- (&FetchCmd{Interval: time.Hour}).fetchLoop(cctx, newFetchClient(1)) }()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("fetch never reached the server")
	}
	cancel() // shutdown while the cycle is wedged in-flight
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("fetchLoop returned %v, want nil on cancel", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fetchLoop did not honor shutdownGrace: still running 2s after shutdown")
	}
}

// TestFetchCycleExpiresArticles verifies the cycle wiring: a feed with
// expire-days set sheds its over-age backlog (AddIdx/Expired bumped, asset
// deleted) during a normal fetch cycle, before Commit publishes it.
func TestFetchCycleExpiresArticles(t *testing.T) {
	db, _, dir := setupTestDB(t)
	allowLoopback(t)
	ch := &Feed{Title: "Old", URL: rssServer(t), ExpireDays: 30}
	seedFeed(t, db, ch)

	key := "assets/aa/00112233445566aa.webp"
	p := mustWriteAsset(t, dir, key)
	db.core.FetchedAt = time.Now().Unix() - 40*86400
	if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: "stale", Content: `<img src="` + key + `">`}}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
		t.Fatalf("fetchLoop: %v", err)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		got := d.core.Feeds[0]
		if got.AddIdx != 1 || got.Expired != 1 {
			t.Fatalf("AddIdx=%d Expired=%d, want 1/1", got.AddIdx, got.Expired)
		}
		return nil
	})
	if !assetGone(t, p) {
		t.Fatalf("asset %s not deleted by the cycle", key)
	}
}
