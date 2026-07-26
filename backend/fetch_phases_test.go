package main

import (
	"context"
	"errors"
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

// The AssetBytes fold is a DELTA, and every other case in this file passes just
// as well against an absolute `live.AssetBytes = snap.AssetBytes`: in all of
// them nothing touched the live feed between the phases, so prior == live and
// the two forms agree. This is the case that separates them — a peer's
// ExpireArticles landing in between, the one thing that lowers the counter.
//
// The snapshot's total predates that release, so assigning it would resurrect
// the freed bytes into `ab`, permanently: nothing recomputes the counter, it is
// only ever adjusted, so the store's reported footprint would drift up by the
// expired bytes on every cycle that raced an expiration. Relative composes.
func TestApplyFetchedFoldsAssetBytesRelatively(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)
	live.AssetBytes = 1000

	snap, rec := snapFeed(live) // baseline 1000
	snap.AssetBytes = 1040      // the fan-out uploaded 40 bytes of new assets
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}
	live.AssetBytes = 100 // a peer's expiration released 900 between the phases

	if items := db.applyFetched([]fetchedFeed{rec}, 19000); len(items) != 1 {
		t.Fatalf("items = %v, want the record applied (the guard is fetch state, not AssetBytes)", items)
	}
	if live.AssetBytes != 140 {
		t.Fatalf("AssetBytes = %d, want 140 = the live 100 + the fan-out's 40-byte upload delta"+
			" (an absolute assignment answers the snapshot's stale 1040)", live.AssetBytes)
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
// leaving the live feed untouched EXCEPT for its asset-bytes charge, which is
// not discardable (see TestApplyFetchedChargesAssetBytesOnDiscard).
func TestApplyFetchedDiscardsURLRepoint(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)

	snap, rec := snapFeed(live)
	snap.LastOK = 111
	snap.AssetBytes = 40 // the fan-out uploaded 40 bytes before the repoint
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
	if live.AssetBytes != 40 {
		t.Fatalf("AssetBytes = %d, want 40 — the fan-out's uploads are in the store"+
			" whatever happened to its articles, so a discard must still charge them", live.AssetBytes)
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
	snap.AssetBytes = 40 // the fan-out uploaded 40 bytes before losing the race
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}
	live.LastOK = 555 // the other fetch's fold advanced the live state

	items := db.applyFetched([]fetchedFeed{rec}, 19000)

	if len(items) != 0 {
		t.Fatalf("items = %v, want none once another fetch advanced the feed", items)
	}
	if live.LastOK != 555 {
		t.Fatalf("LastOK = %d, want the other fetch's state kept", live.LastOK)
	}
	if live.AssetBytes != 40 {
		t.Fatalf("AssetBytes = %d, want 40 — the fan-out's uploads are in the store"+
			" whatever happened to its articles, so a discard must still charge them", live.AssetBytes)
	}
}

// TestApplyFetchedChargesAssetBytesOnDiscard is the accounting half of the two
// discard guards above, stated once as its own case because the property is not
// about either guard in particular: an assets/ object is content-hash-addressed
// and was AtomicPut during the lock-free fan-out, so it is durably in the store
// before applyFetched ever runs. Whether the record that referenced it lands is
// irrelevant to the store's footprint, so `ab` must move either way.
//
// What made the old apply-only charge PERMANENT rather than merely late: the
// bytes are never re-offered. A later cycle referencing the same content hash
// takes UploadCacheRef's store-existence branch, which reports 0 uploaded bytes,
// so no feed ever charges them again — while the reference sidecar still records
// an owner, and expiration still decrements that owner by the object's real size
// when it leaves. Every discarded upload therefore ate a permanent hole in some
// feed's counter, clamped at 0 and never recomputed.
//
// The charge is RELATIVE here too, so it composes with a peer's expiration the
// same way the apply path does.
func TestApplyFetchedChargesAssetBytesOnDiscard(t *testing.T) {
	cases := []struct {
		name string
		// race mutates the live feed the way the racing writer would, producing
		// the discard this case is about.
		race func(live *Feed)
	}{
		{"url repoint", func(live *Feed) { live.URL = "http://y/other" }},
		{"concurrent advance", func(live *Feed) { live.LastOK = 555 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, _, _ := setupTestDB(t)
			live := &Feed{Title: "A", URL: "http://x/feed"}
			seedFeed(t, db, live)
			live.AssetBytes = 1000

			snap, rec := snapFeed(live) // baseline 1000
			snap.AssetBytes = 1040      // the fan-out uploaded 40 bytes of new assets
			snap.newItems = []*Item{{Feed: snap, Title: "n1"}}

			live.AssetBytes = 100 // a peer's expiration released 900 in between
			tc.race(live)

			if items := db.applyFetched([]fetchedFeed{rec}, 19000); len(items) != 0 {
				t.Fatalf("items = %v, want the record discarded", items)
			}
			if live.AssetBytes != 140 {
				t.Fatalf("AssetBytes = %d, want 140 = the live 100 + the fan-out's 40-byte"+
					" upload delta; a discarded record's uploads are still in the store,"+
					" and charging only on the apply path under-counts `ab` permanently",
					live.AssetBytes)
			}
		})
	}
}

// TestApplyFetchedRemovedFeedChargesNobody is the stated exception: a feed
// deleted during the fan-out has no counter left to charge, so its uploads go
// unaccounted by construction. Pinned so the asymmetry is a decision on the
// record rather than something a later reader has to rediscover.
func TestApplyFetchedRemovedFeedChargesNobody(t *testing.T) {
	db, _, _ := setupTestDB(t)
	live := &Feed{Title: "A", URL: "http://x/feed"}
	seedFeed(t, db, live)
	live.AssetBytes = 100

	snap, rec := snapFeed(live)
	snap.id = 99 // removed and gone from db.core.Feeds
	snap.AssetBytes = 40
	snap.newItems = []*Item{{Feed: snap, Title: "n1"}}

	if items := db.applyFetched([]fetchedFeed{rec}, 19000); len(items) != 0 {
		t.Fatalf("items = %v, want none for a removed feed", items)
	}
	if live.AssetBytes != 100 {
		t.Fatalf("AssetBytes = %d, want the surviving feed 100 untouched —"+
			" a removed feed's uploads must not be charged to a bystander", live.AssetBytes)
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

// --- checkStoreBusy (the FET5 fail-fast probe) -----------------------------

// checkStoreBusy is what stops a cycle burning a whole network fan-out it can
// never commit. It had NO test in any suite, and the one that looks like its
// coverage — TestMCPFetchStoreBusy — is not: the write phase's own acquireMarker
// produces the same os.ErrExist, so that test passes with this function deleted.
// The assertion that distinguishes them is whether the FAN-OUT ran, which is why
// every case below counts feed-server hits.
//
// The dangerous direction is OVER-refusal. Drop the `!held.expired(...)`
// conjunct and every cycle of the 5-minute loop aborts before fetching on a
// SIGKILLed predecessor's stale marker — logging rather than failing, so the
// store silently stops updating. That is the wedge the lease design removed, and
// case "expired foreign lease" is what keeps it removed.
func TestCheckStoreBusyProbe(t *testing.T) {
	live := storeLease{Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(time.Hour).Unix()}
	expired := storeLease{Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(-time.Second).Unix()}
	own := storeLease{Owner: leaseOwner, Expires: time.Now().Add(time.Hour).Unix()}

	cases := []struct {
		name     string
		payload  func(t *testing.T) []byte // nil = plant no marker at all
		wantHits int32                     // feed-server requests, i.e. did the fan-out run
		wantErr  bool
	}{
		{"no marker", nil, 1, false},
		{
			"live foreign lease", func(t *testing.T) []byte { return marshalLease(t, live) },
			0, true, // refused BEFORE the fan-out — the whole point
		},
		{
			"expired foreign lease", func(t *testing.T) []byte { return marshalLease(t, expired) },
			1, false, // the SIGKILL unwedge: steal it and commit
		},
		{
			"own lease", func(t *testing.T) []byte { return marshalLease(t, own) },
			1, false, // this process instance; the in-process gate is the real serializer
		},
		{
			// The clearest separation of probe from acquire in the whole table:
			// the fan-out RAN (the probe declined to judge a marker whose liveness
			// is genuinely unknowable) and the cycle still failed — from the write
			// phase's acquireMarker, the single authority. wantHits is what makes
			// this case unable to pass if the two were ever collapsed.
			"payload-less legacy marker", func(*testing.T) []byte { return nil },
			1, true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, _, _ := setupTestDB(t)
			allowLoopback(t)

			var hits atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				hits.Add(1)
				w.Header().Set("Content-Type", "application/rss+xml")
				w.Write([]byte(sampleRSS))
			}))
			t.Cleanup(srv.Close)
			seedFeed(t, db, &Feed{Title: "Live", URL: srv.URL})

			if tc.payload != nil {
				writeMarker(t, db.Backend, dbLockKey, tc.payload(t))
			}

			err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1))
			switch {
			case tc.wantErr && err == nil:
				t.Fatal("cycle succeeded against a marker it must refuse")
			case tc.wantErr && !errors.Is(err, os.ErrExist):
				t.Fatalf("cycle error = %v, want one wrapping os.ErrExist (serve's 409 / MCP's \"store busy\")", err)
			case !tc.wantErr && err != nil:
				t.Fatalf("fetchLoop: %v", err)
			}
			if got := hits.Load(); got != tc.wantHits {
				t.Errorf("feed fetched %d time(s), want %d — the probe ran the fan-out it should have skipped (or skipped one it should have run)", got, tc.wantHits)
			}
		})
	}
}

// The other half of the expired-lease case: the cycle does not merely proceed,
// it COMMITS. A probe that refused here would leave the 5-min loop logging
// forever after any hard kill, with the store frozen and nothing failing.
func TestCheckStoreBusyExpiredLeaseStillCommits(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	seedFeed(t, db, &Feed{Title: "Live", URL: srv.URL})

	stale := storeLease{Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(-time.Hour).Unix()}
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, stale))

	if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
		t.Fatalf("fetchLoop against an expired lease: %v", err)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 1 {
			t.Fatalf("TotalArticles = %d, want 1 — the cycle did not commit past a dead writer's marker", d.core.TotalArticles)
		}
		return nil
	})
}

// --force is the documented escape from any marker, live lease included.
func TestCheckStoreBusyForceOverridesLiveLease(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	seedFeed(t, db, &Feed{Title: "Live", URL: srv.URL})

	held := storeLease{Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(time.Hour).Unix()}
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, held))

	saved := globals.Force
	globals.Force = true
	t.Cleanup(func() { globals.Force = saved })

	if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
		t.Fatalf("fetchLoop with --force: %v", err)
	}
}
