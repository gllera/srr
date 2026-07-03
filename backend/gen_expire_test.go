package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestGenExpireStore is a gated fixture generator (genbig_test.go precedent):
// it writes, through the production write path, a small store whose first
// batch is 40 days old — so a subsequent REAL `srrb art fetch` cycle (real
// wall clock, no time seam in the binary) expires it. Consumed by
// frontend/e2e/contract/expire.e2e.test.ts.
//
// Expected chron layout (PutArticles preserves batch order):
//
//	0 = "ancient exquisite zebra"  (feed 0, ExpireDays=30, fetched 40d ago) → expires
//	1 = "keeper ancient story"     (feed 1, no expiration, fetched 40d ago) → kept
//	2 = "fresh flamingo news"      (feed 0, fetched 1d ago)                 → kept
func TestGenExpireStore(t *testing.T) {
	out := os.Getenv("SRR_GENEXPIRE_OUT")
	if out == "" {
		t.Skip("set SRR_GENEXPIRE_OUT=<dir> to generate the expiration e2e fixture store")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	globals = &Globals{PackSize: 200, Store: out, Workers: 1, MaxFeedSize: defaultMaxFeedSize, CacheDir: t.TempDir()}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)

	// Unreachable URLs: the e2e fetch cycle fails both feeds (ferr) but the
	// cycle still runs the expire step and commits — exactly the contract.
	// AddFeed is offline (no discovery probe — that lives in the feed-add CLI).
	exp := &Feed{Title: "Expiring", URL: "http://127.0.0.1:9/exp.xml", ExpireDays: 30}
	keep := &Feed{Title: "Keeper", URL: "http://127.0.0.1:9/keep.xml"}
	for _, f := range []*Feed{exp, keep} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}

	// Pre-seeded assets/ objects referenced by the articles' content: the
	// expired article's key must be deleted by ExpireArticles, the keeper's
	// must survive. Keys follow the strict assetKeyRe grammar.
	const assetOld = "assets/aa/1111111111111111.webp"
	const assetKeep = "assets/bb/2222222222222222.webp"
	for _, k := range []string{assetOld, assetKeep} {
		p := filepath.Join(out, k)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("asset-bytes"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().Unix()
	put := func(fetchedAt int64, items []*Item) {
		db.core.FetchedAt = fetchedAt
		written, err := db.PutArticles(ctx, items)
		if err != nil {
			t.Fatalf("PutArticles: %v", err)
		}
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatalf("SyncIdxSummary: %v", err)
		}
		if err := db.SyncMeta(ctx, written); err != nil {
			t.Fatalf("SyncMeta: %v", err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("Commit: %v", err)
		}
	}
	put(now-40*86400, []*Item{
		{Feed: exp, Title: "ancient exquisite zebra", Published: now - 40*86400, Content: `<img src="` + assetOld + `">`},
		{Feed: keep, Title: "keeper ancient story", Published: now - 40*86400 + 1, Content: `<img src="` + assetKeep + `">`},
	})
	put(now-86400, []*Item{
		{Feed: exp, Title: "fresh flamingo news", Published: now - 86400, Content: "<p>fresh</p>"},
	})
}
