package main

import (
	"testing"
)

// TestFeedCountsFalsePositiveAfterHighestIDDelete reproduces B3: deleting the
// highest-id feed shrinks feedSlots(core) below that feed's id, so
// ownFeedCounts (sized to feedSlots) can't account for that feed's entries in
// finalized packs.  checkFeedCountsContinuity must still report 0 issues
// because the on-disk packs are mathematically intact.
//
// Setup: two packs that together hold a healthy store.
//
//	pack 0 (finalized): 3 entries — 2 × feed 0, 1 × feed 1
//	                     header feedCounts = [0, 0] (nothing before this pack)
//	                     numSlots = 2  (both feeds existed at write time)
//	pack 1 (latest):    2 entries — 2 × feed 0
//	                     header feedCounts = [2, 1] (pack 0's contribution)
//	                     numSlots = 2
//
// After feed 1 (the highest id) is deleted feedSlots drops to 1, so
// parseIdxPack sizes ownFeedCounts to 1.  ownFeedCount(1) then returns 0
// while feedCount(1) in pack 1 still returns 1 → spurious mismatch.
func TestFeedCountsFalsePositiveAfterHighestIDDelete(t *testing.T) {
	// Pack 0: finalized, 3 entries [0,0,1], feedCounts=[0,0], numSlots=2.
	// Entry layout: feed 0, feed 0, feed 1.
	// Boundary footer: empty (all entries share one data pack).
	raw0 := buildIdxRaw(
		1, 0, // packIDBase=1, packOffBase=0
		[]uint32{0, 0},    // cumulative feedCounts before this pack
		[]uint16{0, 0, 1}, // 3 entries: feed 0, feed 0, feed 1
		nil,               // no pack-id advances within this pack
	)
	// slots=1 simulates post-delete state (feed 1 removed, feedSlots=1).
	pack0, err := parseIdxPack(raw0, 0, 3, 1)
	if err != nil {
		t.Fatalf("parseIdxPack pack0: %v", err)
	}

	// Pack 1: latest, 2 entries [0,0], feedCounts=[2,1], numSlots=2.
	// feedCounts[0]=2 (feed 0 had 2 in pack 0), feedCounts[1]=1 (feed 1 had 1).
	raw1 := buildIdxRaw(
		2, 3, // packIDBase=2, packOffBase=3 (continues from pack 0's 3 entries)
		[]uint32{2, 1}, // cumulative feedCounts: pack 0 contributed 2+1
		[]uint16{0, 0}, // 2 entries: both feed 0
		nil,
	)
	pack1, err := parseIdxPack(raw1, 1, 2, 1)
	if err != nil {
		t.Fatalf("parseIdxPack pack1: %v", err)
	}

	// Verify the bug is reproducible: ownFeedCount(1) returns 0 due to shrunk
	// slot sizing, even though pack 0 has 1 entry for feed 1.
	if got := pack0.ownFeedCount(1); got != 0 {
		t.Logf("ownFeedCount(1) = %d; bug may already be fixed or test is wrong", got)
	}

	// The continuity check must report 0 issues on a mathematically intact store.
	packs := []*idxPack{pack0, pack1}
	issues := checkFeedCountsContinuity(packs)
	if issues != 0 {
		t.Errorf("checkFeedCountsContinuity: got %d issue(s), want 0 (false positive after highest-id feed delete)", issues)
	}
}

// TestDBMetaCleanAfterExpiration: a store whose feed has expired a prefix
// (AddIdx mid-history, Expired > 0) must validate clean — entries before
// AddIdx are expected there, and total_art stays the all-time idx count.
func TestDBMetaCleanAfterExpiration(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1"}, {Feed: ch, Title: "o2"}})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues != 0 {
		t.Fatalf("checkDBMeta reported %d issues on an expired store", issues)
	}
}

// TestDBMetaFlagsOutOfRangeExpired: xp outside [0, total_art] is corruption.
func TestDBMetaFlagsOutOfRangeExpired(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	ch.Expired = 5 // > TotalArt(1)
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	// Exactly two checks fire: the xp range check (5 > total_art=1) and the
	// live-count cross-check (live=1 but total_art-expired=-4).
	if issues := checkDBMeta(fetch, core, packs); issues != 2 {
		t.Fatalf("checkDBMeta reported %d issues, want exactly 2 (xp range + live count)", issues)
	}
}

// TestDBMetaFlagsOutOfRangeAddIdx: add_idx outside [0, TotalArticles] is
// corruption.
func TestDBMetaFlagsOutOfRangeAddIdx(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	ch.AddIdx = core.TotalArticles + 1 // out of range [0, 1]
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	// Exactly two checks fire: the add_idx range check (2 > TotalArticles=1)
	// and the live-count cross-check (no entry sits at chron >= 2, so live=0
	// but total_art-expired=1).
	if issues := checkDBMeta(fetch, core, packs); issues != 2 {
		t.Fatalf("checkDBMeta reported %d issues, want exactly 2 (add_idx range + live count)", issues)
	}
}

// TestDBMetaFlagsLiveCountMismatch: an in-range but INCONSISTENT
// (AddIdx, Expired) pair — Expired bumped without moving AddIdx — must be
// flagged by the live-count cross-check, and only by it (Expired stays
// within [0, total_art], so the range checks must NOT fire). This is the
// drift that silently skews the reader's live counts.
func TestDBMetaFlagsLiveCountMismatch(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}, {Feed: ch, Title: "f2"}})
	ch.Expired = 1 // in range [0, TotalArt=2] but AddIdx stays 0 → live=2 != 2-1
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues != 1 {
		t.Fatalf("checkDBMeta reported %d issues, want exactly 1 (live-count mismatch)", issues)
	}
}
