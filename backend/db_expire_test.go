package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"srr/store"
)

const (
	expNow  int64 = 1_700_000_000
	old20d        = expNow - 20*86400 // older than a 10-day window
	fresh1d       = expNow - 1*86400  // inside any window
)

// putExpireBatch writes one batch through the production path with a chosen
// fetched_at (the same db.core.FetchedAt mechanism one fetch cycle uses).
func putExpireBatch(t *testing.T, db *DB, fetchedAt int64, items []*Item) {
	t.Helper()
	db.core.FetchedAt = fetchedAt
	if _, err := db.PutArticles(ctx, items); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
}

func mustWriteAsset(t *testing.T, dir, key string) string {
	t.Helper()
	p := filepath.Join(dir, key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("asset-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func assetGone(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	return os.IsNotExist(err)
}

func TestExpireNoConfiguredFeedsIsNoop(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "old"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if ch.AddIdx != 0 || ch.Expired != 0 || core.TotalArticles != 1 {
		t.Fatalf("state changed: AddIdx=%d Expired=%d total=%d", ch.AddIdx, ch.Expired, core.TotalArticles)
	}
}

func TestExpireBumpsAddIdxAndExpired(t *testing.T) {
	db, _, _ := setupTestDB(t)
	fast := &Feed{Title: "fast", URL: "https://a.example/f", ExpireDays: 10}
	slow := &Feed{Title: "slow", URL: "https://b.example/f"}
	for _, f := range []*Feed{fast, slow} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	// chron: 0=fast(old) 1=slow(old) 2=fast(old) | 3=fast(fresh)
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: fast, Title: "o1"}, {Feed: slow, Title: "o2"}, {Feed: fast, Title: "o3"},
	})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: fast, Title: "f1"}})

	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if fast.AddIdx != 3 || fast.Expired != 2 {
		t.Fatalf("fast AddIdx=%d Expired=%d, want 3/2", fast.AddIdx, fast.Expired)
	}
	if slow.AddIdx != 0 || slow.Expired != 0 {
		t.Fatalf("slow AddIdx=%d Expired=%d, want 0/0 (no policy)", slow.AddIdx, slow.Expired)
	}
	// TotalArt is the immutable all-time count (idx headers derive from it).
	if fast.TotalArt != 3 || slow.TotalArt != 1 {
		t.Fatalf("TotalArt fast=%d slow=%d, want 3/1 (all-time)", fast.TotalArt, slow.TotalArt)
	}
}

func TestExpireCutoffBoundaryKeepsExactAge(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	// fetched_at == cutoff exactly: NOT expired (strictly-older-than contract).
	putExpireBatch(t, db, expNow-10*86400, []*Item{{Feed: ch, Title: "edge"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if ch.AddIdx != 0 || ch.Expired != 0 {
		t.Fatalf("boundary article expired: AddIdx=%d Expired=%d", ch.AddIdx, ch.Expired)
	}
}

func TestExpireDeletesAssetsSharedOrNot(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	kOld1 := "assets/aa/1111111111111111.webp"
	kOld2 := "assets/bb/2222222222222222.webp"
	kFresh := "assets/cc/3333333333333333.webp"
	pOld1, pOld2 := mustWriteAsset(t, dir, kOld1), mustWriteAsset(t, dir, kOld2)
	pFresh := mustWriteAsset(t, dir, kFresh)

	// Two expired articles share kOld1 (dedup: one Rm); the fresh article's
	// own asset must survive.
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + kOld1 + `"><a href="` + kOld2 + `">d</a>`},
		{Feed: ch, Title: "o2", Content: `<video src="` + kOld1 + `" poster="http://x.example/p.jpg"></video>`},
	})
	putExpireBatch(t, db, fresh1d, []*Item{
		{Feed: ch, Title: "f1", Content: `<img src="` + kFresh + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if !assetGone(t, pOld1) || !assetGone(t, pOld2) {
		t.Fatal("expired assets not deleted")
	}
	if assetGone(t, pFresh) {
		t.Fatal("fresh asset deleted")
	}
}

func TestExpireRmFailureAbortsAll(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	key := "assets/aa/1111111111111111.webp"
	// A non-empty DIRECTORY at the key path makes local Rm (os.Remove) fail.
	if err := os.MkdirAll(filepath.Join(dir, key, "block"), 0o755); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + key + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err == nil {
		t.Fatal("want error from failing Rm")
	}
	if ch.AddIdx != 0 || ch.Expired != 0 {
		t.Fatalf("state applied despite Rm failure: AddIdx=%d Expired=%d", ch.AddIdx, ch.Expired)
	}
}

func TestExpireSecondRunIsNoop(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1"}})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if ch.AddIdx != 1 || ch.Expired != 1 {
		t.Fatalf("second run changed state: AddIdx=%d Expired=%d, want 1/1", ch.AddIdx, ch.Expired)
	}
}

func TestExpirePerFeedCutoffs(t *testing.T) {
	db, _, _ := setupTestDB(t)
	// Different windows: a 20-day-old article expires only for the 10-day feed.
	short := &Feed{Title: "short", URL: "https://a.example/f", ExpireDays: 10}
	long := &Feed{Title: "long", URL: "https://b.example/f", ExpireDays: 30}
	for _, f := range []*Feed{short, long} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: short, Title: "s"}, {Feed: long, Title: "l"},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if short.AddIdx != 1 || short.Expired != 1 {
		t.Fatalf("short AddIdx=%d Expired=%d, want 1/1", short.AddIdx, short.Expired)
	}
	if long.AddIdx != 0 || long.Expired != 0 {
		t.Fatalf("long AddIdx=%d Expired=%d, want 0/0", long.AddIdx, long.Expired)
	}
}

func TestExpireWholeFeedReachesFrontier(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	// EVERY article of the feed expires: AddIdx must reach the store frontier.
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1"}, {Feed: ch, Title: "o2"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if ch.AddIdx != core.TotalArticles || ch.Expired != ch.TotalArt {
		t.Fatalf("AddIdx=%d Expired=%d, want %d/%d (whole feed expired)",
			ch.AddIdx, ch.Expired, core.TotalArticles, ch.TotalArt)
	}
	// AddIdx == TotalArticles ⇒ the next run takes the minStart guard no-op path.
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if ch.AddIdx != 2 || ch.Expired != 2 {
		t.Fatalf("second run changed state: AddIdx=%d Expired=%d, want 2/2", ch.AddIdx, ch.Expired)
	}
}

func TestExpireDormantAdvanceKeepsInvariant(t *testing.T) {
	// The advanced frontier must keep the inspect cross-check green:
	// live entries at chron >= AddIdx == TotalArt − Expired.
	db, core, _ := setupTestDB(t)
	dormant := &Feed{Title: "dormant", URL: "https://a.example/f", ExpireDays: 10}
	filler := &Feed{Title: "filler", URL: "https://b.example/f"}
	for _, f := range []*Feed{dormant, filler} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: dormant, Title: "d0"}})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: filler, Title: "f0"}, {Feed: filler, Title: "f1"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	// dormant fully expired at its natural prefix end (chron 0 expired → AddIdx
	// 1; the early stop fires at chron 1, filler's fresh region — an expiring
	// cycle takes no separate advance).
	if dormant.AddIdx != 1 || dormant.Expired != 1 {
		t.Fatalf("AddIdx=%d xp=%d, want 1/1", dormant.AddIdx, dormant.Expired)
	}
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatal(err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues != 0 {
		t.Fatalf("checkDBMeta: %d issues after dormant expiry", issues)
	}
	// A much later cycle: filler's articles (no policy, fetched below dormant's
	// cutoff now) no longer trigger the early stop, the walk exhausts
	// (stopChron = 3), and dormant — no live own entry, nothing expired —
	// advances 1 → 3 over filler's region. The invariant must survive the jump.
	if err := db.ExpireArticles(ctx, expNow+20*86400); err != nil {
		t.Fatal(err)
	}
	if dormant.AddIdx != 3 || dormant.Expired != 1 {
		t.Fatalf("dormant frontier: AddIdx=%d xp=%d, want 3/1", dormant.AddIdx, dormant.Expired)
	}
	packs, _, err = loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatal(err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues != 0 {
		t.Fatalf("checkDBMeta: %d issues after dormant advance", issues)
	}
}

func TestCollectAssetRefs(t *testing.T) {
	keys := map[string]struct{}{}
	content := `<img src="assets/aa/1111111111111111.webp">` +
		`<video src="assets/bb/2222222222222222.webm" poster="assets/cc/3333333333333333.webp"></video>` +
		`<audio src="assets/dd/4444444444444444.opus"></audio>` +
		`<a href="assets/ee/5555555555555555.pdf">doc</a>` +
		`<img src="https://x.example/ext.jpg"><a href="relative/path.html">r</a>` +
		// assets/-prefixed but NOT the strict key grammar: traversal attempts
		// and malformed hashes must never be harvested — Rm path-joins the key
		// on local/SFTP, so a loose prefix check would delete outside assets/.
		`<img src="assets/../db.gz"><a href="assets/../../etc/passwd">t</a>` +
		`<img src="assets/aa/UPPERCASE.webp"><img src="assets/aa/1111.webp">`
	collectAssetRefs(content, keys)
	want := []string{
		"assets/aa/1111111111111111.webp",
		"assets/bb/2222222222222222.webm",
		"assets/cc/3333333333333333.webp",
		"assets/dd/4444444444444444.opus",
		"assets/ee/5555555555555555.pdf",
	}
	if len(keys) != len(want) {
		t.Fatalf("collected %d keys, want %d: %v", len(keys), len(want), keys)
	}
	for _, k := range want {
		if _, ok := keys[k]; !ok {
			t.Fatalf("missing key %s", k)
		}
	}
	// Fast path + empty content contribute nothing and never error.
	collectAssetRefs("", keys)
	collectAssetRefs("<p>no asset refs at all</p>", keys)
	if len(keys) != len(want) {
		t.Fatalf("no-ref content added keys: %v", keys)
	}
}

// Expiring an article must give its deleted assets' bytes back to the feed's
// AssetBytes counter (measured by Stat just before the Rm), leaving assets of
// still-live articles uncounted and untouched.
func TestExpireReducesAssetBytes(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	kOld := "assets/aa/1111111111111111.webp"
	kFresh := "assets/cc/3333333333333333.webp"
	mustWriteAsset(t, dir, kOld) // "asset-bytes" = 11 bytes
	mustWriteAsset(t, dir, kFresh)
	ch.AssetBytes = 30 // as if the feed had uploaded 30 asset bytes all-time

	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + kOld + `">`},
	})
	putExpireBatch(t, db, fresh1d, []*Item{
		{Feed: ch, Title: "f1", Content: `<img src="` + kFresh + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if ch.AssetBytes != 30-11 {
		t.Fatalf("AssetBytes = %d, want %d (deleted asset size subtracted)", ch.AssetBytes, 30-11)
	}
}

// A cross-feed shared asset can be charged to the uploading feed but expired
// via another feed's article: the decrement clamps at 0 instead of going
// negative on the feed that was never charged.
func TestExpireAssetBytesClampsAtZero(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	kOld := "assets/aa/1111111111111111.webp"
	mustWriteAsset(t, dir, kOld) // 11 bytes; ch was never charged for them
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + kOld + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if ch.AssetBytes != 0 {
		t.Fatalf("AssetBytes = %d, want 0 (clamped)", ch.AssetBytes)
	}
}

// A shared asset expired via articles of TWO feeds decrements only the first
// (chron-order) referent — deterministic attribution, no double subtraction.
func TestExpireSharedAssetDecrementsFirstReferent(t *testing.T) {
	db, _, dir := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	b := &Feed{Title: "B", URL: "https://b.example/f", ExpireDays: 10}
	for _, f := range []*Feed{a, b} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	key := "assets/aa/1111111111111111.webp"
	mustWriteAsset(t, dir, key) // "asset-bytes" = 11 bytes
	a.AssetBytes, b.AssetBytes = 20, 20

	// chron 0 = A's article (first referent), chron 1 = B's; both expire.
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: a, Title: "o1", Content: `<img src="` + key + `">`},
		{Feed: b, Title: "o2", Content: `<img src="` + key + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if a.AssetBytes != 9 || b.AssetBytes != 20 {
		t.Fatalf("AssetBytes = A:%d B:%d, want A:9 B:20 (first referent decremented once)", a.AssetBytes, b.AssetBytes)
	}
}

// statFailBackend fails every Stat, pinning the measure-then-delete order.
type statFailBackend struct {
	store.Backend
}

func (f *statFailBackend) Stat(context.Context, string) (int64, error) {
	return 0, errors.New("injected stat failure")
}

// A Stat failure must abort the cycle BEFORE any asset is deleted (all
// measuring happens up front), so the retry recomputes a clean window with
// every object still in place — no decrement is ever lost to it.
func TestExpireStatFailureAbortsBeforeDeletes(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	key := "assets/aa/1111111111111111.webp"
	p := mustWriteAsset(t, dir, key)
	ch.AssetBytes = 20
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + key + `">`},
	})

	db.Backend = &statFailBackend{Backend: db.Backend}
	if err := db.ExpireArticles(ctx, expNow); err == nil {
		t.Fatal("want error from failing Stat")
	}
	if assetGone(t, p) {
		t.Fatal("asset deleted despite the Stat failure — measuring must precede ANY delete")
	}
	if ch.AddIdx != 0 || ch.Expired != 0 || ch.AssetBytes != 20 {
		t.Fatalf("state applied despite Stat failure: AddIdx=%d Expired=%d AssetBytes=%d", ch.AddIdx, ch.Expired, ch.AssetBytes)
	}
}
