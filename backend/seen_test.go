package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// A version-1 seen.gz body (pre-bg-relocation) must still parse: the bg tail is
// version-gated, so a v1 per-feed record (etag/lastMod only, no bg bytes) loads
// with bg == nil and no error. Pins the read-compat Task 4's legacy bridge relies on.
func TestParseSeenV1ReadCompat(t *testing.T) {
	var b []byte
	b = append(b, seenMagic...)
	b = append(b, 1)                            // version 1
	b = binary.LittleEndian.AppendUint32(b, 0)  // 0 dedup entries
	b = binary.LittleEndian.AppendUint32(b, 1)  // 1 feed record
	b = binary.LittleEndian.AppendUint16(b, 42) // feed_id
	b = appendLenPrefixed(b, `"etag-v1"`)
	b = appendLenPrefixed(b, "") // empty lastMod, and NO bg bytes (v1)

	p, err := parseSeen(b)
	if err != nil {
		t.Fatalf("parseSeen(v1 body): %v", err)
	}
	fs, ok := p.feed[42]
	if !ok || fs.etag != `"etag-v1"` || fs.lastMod != "" || fs.bg != nil {
		t.Fatalf("v1 feed decoded wrong: %+v ok=%v", fs, ok)
	}
}

// fnv32 must be byte-for-byte the FNV-32a used by ingest.hash (ingest/feed.go),
// so a title/guid hashed here lands in the same u32 keyspace the ingest layer
// stamps GUIDs into. Pinned to the standard FNV-1a-32 test vectors.
func TestFNV32MatchesFNVBasis(t *testing.T) {
	cases := []struct {
		in   string
		want uint32
	}{
		{"", 0x811c9dc5},       // the FNV offset basis
		{"a", 0xe40c292c},      // standard vector
		{"foobar", 0xbf9cf968}, // standard vector
	}
	for _, c := range cases {
		if got := fnv32(c.in); got != c.want {
			t.Errorf("fnv32(%q) = %#x, want %#x", c.in, got, c.want)
		}
	}
}

// A nil *seenPool must be safe on every method: has→false, stamp/evict→no-op.
// The fetch tests build fetchRun{…} literals with no pool, so an unconditional
// run.seen.has(...) would nil-panic every existing feed test (plan §5 B1, T10).
func TestSeenPoolNilSafe(t *testing.T) {
	var p *seenPool
	if p.has(1, 2) {
		t.Error("nil pool has() = true, want false")
	}
	// Must not panic.
	p.stamp(1, 2, 3)
	p.evict(10, func(int) int { return 30 }, seenFeedCap, nil)
}

// stamp then has: membership is keyed by (feed_id, hash); a different feed id or
// a different hash is a miss.
func TestSeenPoolHasStamp(t *testing.T) {
	p := newSeenPool()
	p.stamp(5, 0xdead, 100)
	if !p.has(5, 0xdead) {
		t.Error("has(5, 0xdead) = false after stamp, want true")
	}
	if p.has(6, 0xdead) {
		t.Error("has(6, 0xdead) = true, want false (different feed id)")
	}
	if p.has(5, 0xbeef) {
		t.Error("has(5, 0xbeef) = true, want false (different hash)")
	}
}

// A fresh pool is clean; a stamp that adds/changes an entry dirties it; a stamp
// of the identical (feed, hash, day) does not (write-if-changed, plan §5/§9).
func TestSeenPoolDirtyFlag(t *testing.T) {
	p := newSeenPool()
	if p.dirty {
		t.Error("new pool dirty, want clean")
	}
	p.stamp(1, 2, 5)
	if !p.dirty {
		t.Error("dirty = false after a new stamp, want true")
	}
	p.dirty = false
	p.stamp(1, 2, 5) // identical: no change
	if p.dirty {
		t.Error("dirty = true after a no-op re-stamp, want false")
	}
	p.stamp(1, 2, 6) // day advanced
	if !p.dirty {
		t.Error("dirty = false after a changed stamp, want true")
	}
}

// marshal → parseSeen must preserve the full (feed_id, hash) → when set,
// including the when values, and must reload clean (not dirty).
func TestSeenPoolRoundTrip(t *testing.T) {
	p := newSeenPool()
	p.stamp(1, 0x11111111, 100)
	p.stamp(1, 0x22222222, 101)
	p.stamp(2, 0x33333333, 100)
	p.stamp(65535, 0xffffffff, 200) // max feed id, max hash, high day
	// HTTP conditional-fetch validators (etag/last_modified) ride in the same file.
	p.feed[1] = feedState{etag: `W/"abc-123"`, lastMod: "Mon, 01 Jan 2024 00:00:00 GMT"}
	p.feed[2] = feedState{etag: `"only-etag"`}
	p.feed[9] = feedState{lastMod: "only-lastmod"}

	got, err := parseSeen(p.marshal())
	if err != nil {
		t.Fatalf("parseSeen: %v", err)
	}
	if got.dirty {
		t.Error("reloaded pool dirty, want clean")
	}
	if len(got.m) != len(p.m) {
		t.Fatalf("reloaded %d dedup entries, want %d", len(got.m), len(p.m))
	}
	for k, when := range p.m {
		if got.m[k] != when {
			t.Errorf("entry %#x when = %d, want %d", k, got.m[k], when)
		}
	}
	if len(got.feed) != len(p.feed) {
		t.Fatalf("reloaded %d feed entries, want %d", len(got.feed), len(p.feed))
	}
	for id, fs := range p.feed {
		if g := got.feed[id]; g.etag != fs.etag || g.lastMod != fs.lastMod {
			t.Errorf("feed[%d] = %+v, want %+v", id, g, fs)
		}
	}
}

// Round-trip of an empty pool is a valid, empty pool.
func TestSeenPoolRoundTripEmpty(t *testing.T) {
	got, err := parseSeen(newSeenPool().marshal())
	if err != nil {
		t.Fatalf("parseSeen(empty): %v", err)
	}
	if len(got.m) != 0 {
		t.Errorf("empty round-trip has %d entries, want 0", len(got.m))
	}
}

// Age eviction drops entries older than the per-feed horizon and keeps the
// rest; the horizon is configurable, so a wider H keeps what a narrower H drops.
func TestSeenPoolAgeEviction(t *testing.T) {
	const day = 100
	live := map[int]*Feed{1: {}}

	// H = 30: an entry 31 days old is dropped; 30 days old is kept.
	p := newSeenPool()
	p.stamp(1, 0xaaaa, day)
	p.stamp(1, 0xbbbb, day)
	p.evict(day+31, func(int) int { return 30 }, seenFeedCap, live)
	if p.has(1, 0xaaaa) || p.has(1, 0xbbbb) {
		t.Error("H=30: entry 31 days old survived, want evicted")
	}

	p = newSeenPool()
	p.stamp(1, 0xaaaa, day)
	p.evict(day+30, func(int) int { return 30 }, seenFeedCap, live)
	if !p.has(1, 0xaaaa) {
		t.Error("H=30: entry exactly 30 days old evicted, want kept")
	}

	// H = 60 keeps the same 31-day-old entry the H=30 run dropped.
	p = newSeenPool()
	p.stamp(1, 0xaaaa, day)
	p.evict(day+31, func(int) int { return 60 }, seenFeedCap, live)
	if !p.has(1, 0xaaaa) {
		t.Error("H=60: entry 31 days old evicted, want kept (horizon must move)")
	}
}

// The per-feed flood cap keeps a feed's newest capPerFeed entries by when and
// drops the oldest; it is per feed, so one feed's cap never touches another's.
func TestSeenPoolFloodCap(t *testing.T) {
	const cap = 4
	live := map[int]*Feed{1: {}, 2: {}}
	p := newSeenPool()
	// Feed 1: 6 entries on days 10..15 (newest = day 15).
	for i := range 6 {
		p.stamp(1, uint32(0x1000+i), uint16(10+i))
	}
	// Feed 2: 2 entries — under cap, must be untouched.
	p.stamp(2, 0x2000, 10)
	p.stamp(2, 0x2001, 11)

	p.evict(20, func(int) int { return 10000 }, cap, live) // horizon huge: only the cap bites

	// Feed 1 keeps its newest 4 (days 12..15); days 10,11 evicted.
	if p.has(1, 0x1000) || p.has(1, 0x1001) {
		t.Error("flood cap kept an oldest-by-when entry, want evicted")
	}
	for i := 2; i < 6; i++ {
		if !p.has(1, uint32(0x1000+i)) {
			t.Errorf("flood cap evicted a newest entry (day %d), want kept", 10+i)
		}
	}
	// Feed 2 (under cap) untouched.
	if !p.has(2, 0x2000) || !p.has(2, 0x2001) {
		t.Error("flood cap on feed 1 evicted feed 2's entries")
	}
}

// A feed_id absent from the live feeds map has its entries dropped by evict —
// the id-reuse hygiene: a removed (or reused) id shares no dedup history
// (plan §5 Feed lifecycle, T11).
func TestSeenPoolDeadFeedPurge(t *testing.T) {
	p := newSeenPool()
	p.stamp(5, 0xdead, 100) // feed 5 will be gone
	p.stamp(7, 0xbeef, 100) // feed 7 stays live
	live := map[int]*Feed{7: {}}

	p.evict(101, func(int) int { return 30 }, seenFeedCap, live)

	if p.has(5, 0xdead) {
		t.Error("dead feed 5's entry survived evict, want purged")
	}
	if !p.has(7, 0xbeef) {
		t.Error("live feed 7's entry purged, want kept")
	}
}

// Removing a feed must purge its dedup entries synchronously and persist that
// purge, so an id immediately reused by a new feed (AddFeed picks the smallest
// free id, with no fetch cycle in between) starts with NO dedup history — a new
// source shares none (plan §5 Feed lifecycle / T11). evict's dead-feed sweep
// can't cover this: db.core.Feeds transitions {5:old} → {5:new} directly, so no
// evict ever observes the id as absent.
func TestSeenPoolPurgedOnFeedRemove(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "Old", URL: "http://old.example"}); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	id := db.core.Feeds[0].id
	db.seen.stamp(id, 0xdead, 100) // a guid this feed had seen
	if err := db.commitState(ctx); err != nil {
		t.Fatalf("commitState: %v", err)
	}

	db.RemoveFeed(id)
	if err := db.commitState(ctx); err != nil { // the RmCmd / deleteFeed path
		t.Fatalf("commitState after remove: %v", err)
	}

	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close(ctx)
	if db2.seen.has(id, 0xdead) {
		t.Error("removed feed's dedup entry survived; a reused id would inherit it")
	}
}

// A live but pool-disabled feed (horizonFor returns dedupDisabled) has its
// residual entries dropped — disabling a feed purges its memory next cycle.
func TestSeenPoolDisabledFeedPurge(t *testing.T) {
	p := newSeenPool()
	p.stamp(3, 0xfeed, 100)
	live := map[int]*Feed{3: {}}
	p.evict(100, func(int) int { return dedupDisabled }, seenFeedCap, live)
	if p.has(3, 0xfeed) {
		t.Error("disabled feed's entry survived evict, want purged")
	}
}

// A truncated, bad-magic, or bad-version seen.gz body must be rejected by
// parseSeen so the caller can degrade to an empty pool (never an article loss).
func TestParseSeenCorruptionGuard(t *testing.T) {
	valid := newSeenPool()
	valid.stamp(1, 0x1234, 50)
	valid.feed[1] = feedState{etag: `"e"`, lastMod: "lm"} // exercise the per-feed section too
	good := valid.marshal()

	cases := map[string][]byte{
		"empty":          {},
		"short-header":   {'S', 'E', 'E', 'N'},
		"bad-magic":      append([]byte("XXXX"), good[4:]...),
		"bad-version":    append([]byte("SEEN"), append([]byte{99}, good[5:]...)...),
		"truncated-body": good[:len(good)-1],
		"trailing-byte":  append(append([]byte(nil), good...), 0),
	}
	for name, data := range cases {
		if _, err := parseSeen(data); err == nil {
			t.Errorf("parseSeen(%s) = nil error, want a corruption error", name)
		}
	}
	// Sanity: the untampered body parses.
	if _, err := parseSeen(good); err != nil {
		t.Errorf("parseSeen(good) = %v, want nil", err)
	}
}

// SyncSeen + Commit persists the pool to the store; a fresh NewDB on the same
// store loads it back — the persistence half of the round-trip (parse symmetry
// is TestSeenPoolRoundTrip). NewDB must always leave a non-nil pool. Adapted for
// ping/pong: SyncSeen alone only flips core.SeenFlag in memory (see
// TestSeenInactiveSlotIgnoredWithoutCommit) — a Commit is required for the flip
// to be durable and for a reopen to name the slot SyncSeen just wrote via the
// direct (non-fallback) path, so this test now goes through commitState like the
// other persistence tests.
func TestSyncSeenPersistsAcrossReopen(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if db.seen == nil {
		t.Fatal("NewDB left db.seen nil, want an (empty) pool")
	}
	db.seen.stamp(1, 0xabc123, 100)
	if err := db.commitState(ctx); err != nil { // SyncSeen (flip) + Commit (publish)
		t.Fatalf("commitState: %v", err)
	}

	// A second DB on the same store (local reads need no lock) reloads seen.gz.
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen NewDB: %v", err)
	}
	defer db2.Close(ctx)
	if !db2.seen.has(1, 0xabc123) {
		t.Error("reopened pool lost the stamp, want persisted")
	}
}

// SyncSeen skips the store write when the pool is clean (write-if-dirty): a
// freshly-loaded, unmutated pool leaves neither ping/pong slot (nor the legacy
// name, never written by SyncSeen at all now) behind. Adapted for ping/pong:
// the write target is a flag-named slot, not the single legacy filename, so the
// meaningful assertion is that NEITHER seen.0.gz NOR seen.1.gz appears.
func TestSyncSeenSkipsWhenClean(t *testing.T) {
	db, _, dir := setupTestDB(t)
	if err := db.SyncSeen(ctx); err != nil {
		t.Fatalf("SyncSeen: %v", err)
	}
	for _, key := range []string{seenSlotKey(false), seenSlotKey(true), seenLegacyKey} {
		if _, err := os.Stat(filepath.Join(dir, key)); !os.IsNotExist(err) {
			t.Errorf("clean pool wrote %s (err=%v), want skipped", key, err)
		}
	}
}

// The HTTP conditional-fetch validators (etag/last_modified) now live in
// seen.gz, not db.gz: a feed's ETag/LastModified round-trip through the sidecar
// and hydrate back onto the in-memory feed on reopen.
func TestETagLastModifiedPersistViaSeen(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "T", URL: "http://x", ETag: `W/"e-123"`, LastModified: "Mon, 01 Jan 2024 00:00:00 GMT"}); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	if err := db.commitState(ctx); err != nil { // Commit + SyncSeen
		t.Fatalf("commitState: %v", err)
	}

	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close(ctx)
	ch := db2.core.Feeds[0]
	if ch.ETag != `W/"e-123"` {
		t.Errorf("ETag = %q, want hydrated from seen.gz", ch.ETag)
	}
	if ch.LastModified != "Mon, 01 Jan 2024 00:00:00 GMT" {
		t.Errorf("LastModified = %q, want hydrated from seen.gz", ch.LastModified)
	}
}

// The HTTP validators must NOT be written to db.gz — that is the whole point of
// moving them (they are backend-only fetch state, not reader data, and db.gz is
// the one no-cache object every reader re-downloads).
func TestETagLastModifiedAbsentFromDbGz(t *testing.T) {
	db, _, dir := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "T", URL: "http://x", ETag: "etag-marker-xyz", LastModified: "lastmod-marker-xyz"}); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw := decompressGz(t, filepath.Join(dir, "db.gz"))
	for _, marker := range []string{"etag-marker-xyz", "lastmod-marker-xyz", `"etag"`, "last_modified"} {
		if bytes.Contains(raw, []byte(marker)) {
			t.Errorf("db.gz still carries HTTP validator %q:\n%s", marker, raw)
		}
	}
}

// A corrupt seen.gz makes NewDB fall back to an empty pool without erroring —
// dedup degrades to watermark-only (bg rides here too now), never an article
// loss (T9 at the DB level).
func TestNewDBCorruptSeenFallsBackToEmpty(t *testing.T) {
	_, _, dir := setupTestDB(t)
	if err := os.WriteFile(filepath.Join(dir, seenLegacyKey), []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB with corrupt %s errored: %v, want empty-pool fallback", seenLegacyKey, err)
	}
	defer db2.Close(ctx)
	if db2.seen == nil || len(db2.seen.m) != 0 {
		t.Errorf("corrupt %s: pool not empty, want empty fallback", seenLegacyKey)
	}
}

// titleHash folds the title (foldSearchText) before hashing, so titles that
// fold to the same tokens collide (the intended title-dedup behavior) while
// distinct titles do not.
func TestTitleHashFolds(t *testing.T) {
	if titleHash("Hello World") != titleHash("hello   world!") {
		t.Error("titleHash not fold-insensitive: 'Hello World' vs 'hello   world!'")
	}
	if titleHash("Hello World") == titleHash("Goodbye World") {
		t.Error("titleHash collided two distinct titles")
	}
}

// seenSlotKey must map false/true to the fixed ping/pong slot names the plan
// commits to (seen.0.gz / seen.1.gz) — db.gz's SeenFlag names the active one.
func TestSeenSlotKey(t *testing.T) {
	if got := seenSlotKey(false); got != "seen.0.gz" {
		t.Fatalf("seenSlotKey(false) = %q, want seen.0.gz", got)
	}
	if got := seenSlotKey(true); got != "seen.1.gz" {
		t.Fatalf("seenSlotKey(true) = %q, want seen.1.gz", got)
	}
}

// seen.gz v2 carries each feed's BoundaryGUIDs (bg) alongside its HTTP
// validators; the round-trip must preserve both, including a feed with bg but
// no validators.
func TestSeenMarshalRoundTripV2WithBG(t *testing.T) {
	p := newSeenPool()
	p.stamp(3, 0xDEADBEEF, 100)
	p.feed[3] = feedState{etag: `"abc"`, lastMod: "Mon, 01", bg: []uint32{1, 2, 0xFFFFFFFF}}
	p.feed[7] = feedState{bg: []uint32{42}} // bg without validators

	body := p.marshal()
	if body[4] != seenVersion || seenVersion != 2 {
		t.Fatalf("expected version 2, got %d", body[4])
	}
	got, err := parseSeen(body)
	if err != nil {
		t.Fatalf("parseSeen: %v", err)
	}
	if w, ok := got.m[seenKey(3, 0xDEADBEEF)]; !ok || w != 100 {
		t.Fatalf("dedup entry lost: %v %v", w, ok)
	}
	if fs := got.feed[3]; fs.etag != `"abc"` || fs.lastMod != "Mon, 01" || len(fs.bg) != 3 || fs.bg[2] != 0xFFFFFFFF {
		t.Fatalf("feed 3 state wrong: %+v", fs)
	}
	if fs := got.feed[7]; len(fs.bg) != 1 || fs.bg[0] != 42 {
		t.Fatalf("feed 7 bg wrong: %+v", fs)
	}
}

// bg is relocated out of db.gz into seen.gz: after a commitState, db.gz must not
// carry a "bg" key, and a reopen must hydrate bg back onto the feed from seen.gz.
func TestBGRoundTripsSeenNotDBGZ(t *testing.T) {
	db, _, dir := setupTestDB(t)
	f := &Feed{Title: "T", URL: "http://x", BoundaryGUIDs: []uint32{11, 22}}
	if err := db.AddFeed(f); err != nil {
		t.Fatal(err)
	}
	id := f.id
	if err := db.commitState(ctx); err != nil { // SyncSeen + Commit
		t.Fatal(err)
	}
	if raw := decompressGz(t, filepath.Join(dir, "db.gz")); bytes.Contains(raw, []byte(`"bg"`)) {
		t.Fatalf("db.gz still carries bg: %s", raw)
	}
	db2, err := NewDB(ctx, false) // reopen same store (globals.Store == dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close(ctx)
	if got := db2.core.Feeds[id].BoundaryGUIDs; len(got) != 2 || got[0] != 11 {
		t.Fatalf("bg not hydrated from seen: %v", got)
	}
}

// A feed carrying bg but NO HTTP validators must keep its bg through a
// snapshotHTTP/SyncSeen round-trip (regression for the Task-2 forward-note:
// snapshotHTTP must not delete/clobber a validator-less bg-only record).
func TestSnapshotHTTPKeepsValidatorlessBG(t *testing.T) {
	db, _, _ := setupTestDB(t)
	f := &Feed{Title: "T", URL: "http://x", BoundaryGUIDs: []uint32{9, 8, 7}} // no ETag/LastModified
	if err := db.AddFeed(f); err != nil {
		t.Fatal(err)
	}
	db.seen.snapshotHTTP(db.core.Feeds)
	if got := db.seen.feed[f.id].bg; len(got) != 3 || got[2] != 7 {
		t.Fatalf("validator-less bg dropped by snapshotHTTP: %v", got)
	}
}

// A dirty SyncSeen writes the INACTIVE slot and flips SeenFlag; a clean (idle)
// SyncSeen writes nothing and does not flip.
func TestSyncSeenPingPongFlipsFlag(t *testing.T) {
	db, _, dir := setupTestDB(t)
	if db.core.SeenFlag {
		t.Fatal("fresh store should start flag=false")
	}
	db.seen.stamp(0, 1, 10) // dirty
	if err := db.SyncSeen(ctx); err != nil {
		t.Fatal(err)
	}
	if !db.core.SeenFlag {
		t.Fatal("dirty write must flip flag to true")
	}
	if _, err := os.Stat(filepath.Join(dir, "seen.1.gz")); err != nil {
		t.Fatalf("inactive slot seen.1.gz not written: %v", err)
	}
	if err := db.SyncSeen(ctx); err != nil { // clean now
		t.Fatal(err)
	}
	if !db.core.SeenFlag {
		t.Fatal("clean sync must NOT flip flag")
	}
}

// A corrupt ACTIVE slot falls back to the sibling slot (previous generation),
// recovering a usable pool instead of degrading to empty.
func TestLoadSeenSiblingFallbackOnCorruptActive(t *testing.T) {
	db, _, dir := setupTestDB(t)
	db.seen.stamp(0, 0xAA, 5)
	if err := db.SyncSeen(ctx); err != nil { // writes seen.1, flag→true
		t.Fatal(err)
	}
	db.seen.stamp(0, 0xBB, 6)
	if err := db.SyncSeen(ctx); err != nil { // writes seen.0, flag→false (active=seen.0)
		t.Fatal(err)
	}
	// Corrupt the ACTIVE slot (seen.0); sibling seen.1 still holds {0xAA}.
	if err := os.WriteFile(filepath.Join(dir, seenSlotKey(db.core.SeenFlag)), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := db.loadSeen(ctx)
	if !got.has(0, 0xAA) {
		t.Fatal("expected sibling-slot fallback to recover the prior pool, got empty/other")
	}
	// Pin that it read the SIBLING (seen.1, the older generation holding only
	// {0xAA}), not some other path: 0xBB lives only in the corrupt active slot.
	if got.has(0, 0xBB) {
		t.Fatal("recovered 0xBB — read the corrupt active slot, not the sibling")
	}
}

// Crash consistency: SyncSeen writes the inactive slot + flips the in-memory flag,
// but until Commit persists that flag, a reopen must read the still-committed slot
// — the uncommitted slot's content must not be visible.
func TestSeenInactiveSlotIgnoredWithoutCommit(t *testing.T) {
	db, _, _ := setupTestDB(t)
	db.seen.stamp(0, 0x01, 3)
	if err := db.SyncSeen(ctx); err != nil { // seen.1 written, flag→true (in mem)
		t.Fatal(err)
	}
	if err := db.Commit(ctx); err != nil { // db.gz persists flag=true
		t.Fatal(err)
	}
	db.seen.stamp(0, 0x02, 4)
	if err := db.SyncSeen(ctx); err != nil { // seen.0 written, flag→false in mem, NOT committed
		t.Fatal(err)
	}
	db2, err := NewDB(ctx, false) // reopen: reads committed db.gz (flag=true → seen.1)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close(ctx)
	if !db2.seen.has(0, 0x01) {
		t.Fatal("committed slot content lost")
	}
	if db2.seen.has(0, 0x02) {
		t.Fatal("uncommitted slot content must not be visible")
	}
}

// RemoveFeed must purge the feed's relocated bg (its seen.gz feedState), not
// just its dedup entries — an id immediately reused by a new feed must inherit
// no dedup window. dropFeed purges the whole feedState (validators + bg).
func TestRemoveFeedPurgesBG(t *testing.T) {
	db, _, _ := setupTestDB(t)
	f := &Feed{Title: "T", URL: "http://x", BoundaryGUIDs: []uint32{5, 6}}
	if err := db.AddFeed(f); err != nil {
		t.Fatal(err)
	}
	id := f.id
	// commitState → snapshotHTTP pulls bg into the pool's feedState, SyncSeen persists.
	if err := db.commitState(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := db.seen.feed[id]; !ok {
		t.Fatal("precondition: a bg-carrying feedState should exist after commitState")
	}
	db.RemoveFeed(id)
	if _, ok := db.seen.feed[id]; ok {
		t.Fatal("RemoveFeed did not purge the feed's bg/feedState from the pool")
	}
}
