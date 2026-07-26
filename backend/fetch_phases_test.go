package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The FET5 contract: a fetch cycle holds `.locked` only for its short write
// phase, never across the network fan-out. These tests drive the real runFetch
// against a live httptest feed and observe the lock from the outside.

// TestFetchFanOutHoldsNoStoreLock pins the lock-free fan-out: the feed server
// checks for the store's `.locked` marker while it is being fetched — the one
// moment the pre-FET5 cycle was guaranteed to hold it.
func TestFetchFanOutHoldsNoStoreLock(t *testing.T) {
	db, _, dir := setupTestDB(t)
	allowLoopback(t)

	var lockedDuringFetch atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, err := os.Stat(filepath.Join(dir, dbLockKey)); err == nil {
			lockedDuringFetch.Store(true)
		}
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	seedFeed(t, db, &Feed{Title: "Live", URL: srv.URL})

	if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
		t.Fatalf("fetchLoop: %v", err)
	}
	if lockedDuringFetch.Load() {
		t.Fatal(".locked was held during the network fan-out; want a lock-free fetch phase")
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 1 {
			t.Fatalf("TotalArticles = %d, want 1", d.core.TotalArticles)
		}
		return nil
	})
}

// snapFeed builds the detached snapshot double of live that the fan-out would
// have mutated, plus the fetchedFeed guard record captured before the fan-out.
func snapFeed(live *Feed) (*Feed, fetchedFeed) {
	snap := &Feed{Title: live.Title, URL: live.URL}
	snap.id = live.id
	return snap, fetchedFeed{
		feed:            snap,
		priorURL:        live.URL,
		priorState:      fetchState(live),
		priorAssetBytes: live.AssetBytes,
	}
}

// TestApplyFetchedFoldsResultsOntoFreshFeeds is the happy path of the locked
// write phase: the snapshot's fetch state lands on the freshly-loaded feed, its
// items are repointed at that feed, its dedup stamps enter the pool, and its
// asset-bytes delta is charged.
func TestApplyFetchedFoldsResultsOntoFreshFeeds(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)

	snap, rec := snapFeed(live)
	snap.Watermark = 99
	snap.ETag = "e2"
	snap.LastOK = 111
	snap.LastNew = 111
	snap.AssetBytes = 40
	snap.newItems = []*Item{{Feed: snap, Title: "n1", Published: 5}}
	snap.seenStamps = []uint32{7}

	items := db.applyFetched([]fetchedFeed{rec}, 19000)

	if len(items) != 1 || items[0].Feed != live {
		t.Fatalf("items = %v, want the snapshot's item repointed at the live feed", items)
	}
	if live.Watermark != 99 || live.ETag != "e2" || live.LastOK != 111 || live.LastNew != 111 {
		t.Fatalf("fetch state not adopted: wm=%d etag=%q last_ok=%d last_new=%d",
			live.Watermark, live.ETag, live.LastOK, live.LastNew)
	}
	if live.AssetBytes != 40 {
		t.Fatalf("AssetBytes = %d, want the fan-out's upload delta 40", live.AssetBytes)
	}
	if !db.seen.has(live.id, 7) {
		t.Fatal("seen stamp not merged into the pool")
	}
}

// TestApplyFetchedPersistsDiscoveryRepoint: our own fan-out repointing the URL
// (subscribe-time discovery on an HTML page) is not a conflict — the live feed
// still holds the pre-fan-out URL, and the repoint must persist.
func TestApplyFetchedPersistsDiscoveryRepoint(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/page"}
	seedFeed(t, db, live)

	snap, rec := snapFeed(live)
	snap.URL = "http://x/feed" // discovery repoint during the fan-out
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}

	items := db.applyFetched([]fetchedFeed{rec}, 19000)

	if len(items) != 1 {
		t.Fatalf("items = %v, want the repointed feed's item applied", items)
	}
	if live.URL != "http://x/feed" {
		t.Fatalf("URL = %q, want the discovery repoint persisted", live.URL)
	}
}

// TestApplyFetchedDiscardsURLRepoint: the operator repointed the feed while the
// fan-out ran — the results describe a different source and must be discarded,
// leaving the live feed untouched.
func TestApplyFetchedDiscardsURLRepoint(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)

	snap, rec := snapFeed(live)
	snap.LastOK = 111
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}
	snap.seenStamps = []uint32{7}
	live.URL = "http://y/other" // concurrent operator repoint

	items := db.applyFetched([]fetchedFeed{rec}, 19000)

	if len(items) != 0 {
		t.Fatalf("items = %v, want none from a repointed feed", items)
	}
	if live.LastOK != 0 {
		t.Fatalf("LastOK = %d, want the live feed untouched", live.LastOK)
	}
	if db.seen.has(live.id, 7) {
		t.Fatal("discarded record must not stamp the pool")
	}
}

// TestApplyFetchedDiscardsUnknownFeed: the feed was removed while the fan-out
// ran; its results have nowhere to land and must be dropped without a panic.
func TestApplyFetchedDiscardsUnknownFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)

	snap, rec := snapFeed(live)
	snap.id = 99
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}

	if items := db.applyFetched([]fetchedFeed{rec}, 19000); len(items) != 0 {
		t.Fatalf("items = %v, want none for an unknown feed", items)
	}
}

// TestApplyFetchedDiscardsConcurrentAdvance: another fetch of the same feed
// committed between the snapshot and the write phase (a GUI single-feed fetch
// racing the loop). Applying our stale result would re-ingest its articles as
// duplicates — the whole record must be discarded instead.
func TestApplyFetchedDiscardsConcurrentAdvance(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)

	snap, rec := snapFeed(live)
	snap.LastOK = 111
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}
	live.LastOK = 555 // the other fetch's fold advanced the live state

	items := db.applyFetched([]fetchedFeed{rec}, 19000)

	if len(items) != 0 {
		t.Fatalf("items = %v, want none once another fetch advanced the feed", items)
	}
	if live.LastOK != 555 {
		t.Fatalf("LastOK = %d, want the other fetch's state kept", live.LastOK)
	}
}

// TestFetchMutationDuringFanOutNotBlocked pins the point of FET5: a locked
// store mutation (a GUI save, a feed edit) no longer contends with a running
// cycle's network fan-out. The feed server wedges the fan-out open while the
// test performs a locked title edit, which must complete promptly; the cycle
// then finishes and must keep BOTH the edit and the fetched article.
func TestFetchMutationDuringFanOutNotBlocked(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)

	release := make(chan struct{})
	started := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release // hold the fan-out open until the mutation below lands
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	seedFeed(t, db, &Feed{Title: "Old", URL: srv.URL})

	done := make(chan error, 1)
	go func() { done <- (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)) }()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("fetch never reached the server")
	}

	// The concurrent operator edit, bounded so a pre-FET5 lock hold fails the
	// test after 2s instead of hanging it for the whole fan-out.
	dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
	mutErr := withDBCtx(dctx, true, func(ctx context.Context, d *DB) error {
		d.core.Feeds[0].Title = "Renamed"
		return d.Commit(ctx)
	})
	dcancel()

	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("fetchLoop: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fetch cycle did not finish after the wedge was released")
	}

	if mutErr != nil {
		t.Fatalf("locked mutation during the fan-out failed: %v (cycle must not hold the store across network I/O)", mutErr)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		ch := d.core.Feeds[0]
		if ch.Title != "Renamed" {
			t.Fatalf("Title = %q, want the concurrent edit %q to survive the cycle's write phase", ch.Title, "Renamed")
		}
		if d.core.TotalArticles != 1 {
			t.Fatalf("TotalArticles = %d, want the fetched article stored alongside the edit", d.core.TotalArticles)
		}
		return nil
	})
}
