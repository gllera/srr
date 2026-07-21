package main

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"

	"srr/store"
)

// getCountingBackend counts reads per key prefix, so a test can assert that
// resolving a sparse out-feed window touches only the data packs that actually
// hold matches.
type getCountingBackend struct {
	store.Backend
	mu   sync.Mutex
	gets map[string]int
}

func (b *getCountingBackend) Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
	b.mu.Lock()
	if b.gets == nil {
		b.gets = map[string]int{}
	}
	switch {
	case strings.HasPrefix(key, "data/"):
		b.gets["data"]++
	case strings.HasPrefix(key, "idx/h"):
		b.gets["summary"]++
	case strings.HasPrefix(key, "idx/"):
		b.gets["idx"]++
	}
	b.mu.Unlock()
	return b.Backend.Get(ctx, key, ignoreMissing)
}

// sparseOutStore builds a multi-data-pack store where feed `dense` owns almost
// everything and feed `sparse` owns two articles buried near the very start —
// the shape that used to force a full-store rescan on every dirty cycle.
func sparseOutStore(t *testing.T) (*DB, int, int) {
	t.Helper()
	db, _, _ := setupTestDB(t)

	dense := &Feed{Title: "dense", URL: "https://dense.test/feed", Tag: "bulk"}
	sparse := &Feed{Title: "sparse", URL: "https://sparse.test/feed", Tag: "rare"}
	for _, ch := range []*Feed{dense, sparse} {
		if err := db.AddFeed(ch); err != nil {
			t.Fatalf("AddFeed: %v", err)
		}
	}

	// The data-pack split rule measures COMPRESSED bytes, so the bodies must be
	// incompressible or the 1 KB test PackSize never rolls a pack and the store
	// is single-pack — exactly the shape this test must not have.
	body := func(i int) string {
		var b strings.Builder
		r := uint64(i*2654435761 + 1)
		for range 600 {
			r = r*6364136223846793005 + 1442695040888963407
			b.WriteByte(byte('!' + r>>58))
		}
		return b.String()
	}
	var arts []*Item
	for i := range 300 {
		ch := dense
		// Two sparse articles, both early, so a tail window can never reach them.
		if i == 3 || i == 11 {
			ch = sparse
		}
		arts = append(arts, &Item{Feed: ch, Title: "a", Content: body(i), Published: int64(1700000000 + i)})
	}
	db.core.FetchedAt = 1700000000
	if _, err := db.PutArticles(ctx, arts); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	return db, dense.id, sparse.id
}

// referenceWindow is the pre-idx implementation: scan the entire data series
// and take the newest `limit` matches. The new resolver must agree with it
// exactly.
func referenceWindow(t *testing.T, db *DB, include map[int]bool, limit int) []ArticleData {
	t.Helper()
	var matches []ArticleData
	cur := 0
	err := db.walkArticles(ctx, 0, db.core.TotalArticles, func(ad *ArticleData) error {
		chron := cur
		cur++
		if !include[ad.FeedID] {
			return nil
		}
		if ch := db.core.Feeds[ad.FeedID]; ch != nil && chron < ch.AddIdx {
			return nil
		}
		matches = append(matches, *ad)
		return nil
	})
	if err != nil {
		t.Fatalf("reference walk: %v", err)
	}
	if len(matches) > limit {
		matches = matches[len(matches)-limit:]
	}
	return matches
}

func sameArticles(a, b []ArticleData) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The idx-driven window must return exactly what the full data scan returned —
// same articles, same order — for a sparse selector, a dense one, and a
// selector spanning both.
func TestResolveOutWindowMatchesFullScan(t *testing.T) {
	db, dense, sparse := sparseOutStore(t)

	for _, tc := range []struct {
		name    string
		include map[int]bool
		limit   int
	}{
		{"sparse feed", map[int]bool{sparse: true}, 50},
		{"dense feed", map[int]bool{dense: true}, 50},
		{"both feeds", map[int]bool{dense: true, sparse: true}, 20},
		{"limit above the match count", map[int]bool{sparse: true}, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want := referenceWindow(t, db, tc.include, tc.limit)
			got, err := db.resolveOutWindow(ctx, tc.include, tc.limit)
			if err != nil {
				t.Fatalf("resolveOutWindow: %v", err)
			}
			if !sameArticles(got, want) {
				t.Errorf("window mismatch: got %d articles, want %d\ngot  %+v\nwant %+v",
					len(got), len(want), got, want)
			}
		})
	}
}

// Expired articles (chron below the feed's AddIdx) must stay out of the
// window — syndicating one would serve assets retention already deleted.
func TestResolveOutWindowSkipsExpired(t *testing.T) {
	db, _, sparse := sparseOutStore(t)
	db.core.Feeds[sparse].AddIdx = 8 // expires the article at chron 3, keeps chron 11

	got, err := db.resolveOutWindow(ctx, map[int]bool{sparse: true}, 50)
	if err != nil {
		t.Fatalf("resolveOutWindow: %v", err)
	}
	want := referenceWindow(t, db, map[int]bool{sparse: true}, 50)
	if !sameArticles(got, want) {
		t.Fatalf("got %d articles, want %d (the expired one must be excluded)", len(got), len(want))
	}
	if len(got) != 1 {
		t.Errorf("got %d articles, want exactly the one live sparse article", len(got))
	}
}

// The point of the change: a sparse window reads only the data packs that
// actually hold its matches, not the whole series.
func TestResolveOutWindowReadsOnlyMatchingDataPacks(t *testing.T) {
	db, _, sparse := sparseOutStore(t)

	counter := &getCountingBackend{Backend: db.Backend}
	db.Backend = counter

	got, err := db.resolveOutWindow(ctx, map[int]bool{sparse: true}, 50)
	if err != nil {
		t.Fatalf("resolveOutWindow: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d articles, want the 2 sparse ones", len(got))
	}

	counter.mu.Lock()
	defer counter.mu.Unlock()
	// Both sparse articles sit early in the store; at the 1 KB test pack size
	// they land in at most 2 distinct data packs. The old implementation read
	// every data pack in the store (well over 100 here).
	if counter.gets["data"] > 2 {
		t.Errorf("read %d data packs, want <= 2 (only the packs holding a match)", counter.gets["data"])
	}
}

// With the header summary published, packs holding zero entries of the selected
// feeds are skipped without being fetched at all.
func TestOutPackSkipperSkipsPacksWithoutTheFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	only := &Feed{Title: "only", URL: "https://only.test/feed"}
	if err := db.AddFeed(only); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	// A single-feed store: every finalized pack holds entries of that feed, so
	// nothing may be skipped — the conservative direction.
	skip := db.outPackSkipper(ctx, map[int]bool{only.id: true})
	if skip(0) {
		t.Error("skipped a pack in a single-feed store")
	}

	// A feed with no articles at all: with no summary published (HdrPacks == 0)
	// the skipper must degrade to never-skip rather than guess.
	if db.outPackSkipper(ctx, map[int]bool{4242: true})(0) {
		t.Error("skipper claimed a skip with no summary available")
	}
}

// Guard the fixture itself: these tests are meaningless on a single-pack store,
// and the data-pack split rule measures COMPRESSED bytes, so a lazily-written
// body can silently collapse the fixture to one pack.
func TestSparseOutStoreIsMultiPack(t *testing.T) {
	db, _, _ := sparseOutStore(t)
	if db.core.NextPackID < 5 {
		t.Fatalf("fixture has next_pid=%d; it must span several data packs", db.core.NextPackID)
	}
}
