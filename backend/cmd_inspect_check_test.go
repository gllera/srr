package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// inspBoundaryStore builds the boundary-crossing store (one finalized idx pack +
// latest, one finalized-meta-shard series) used by the corruption-detection
// tests, with the idx summary and meta shards published. The corruption tests
// take this valid store, mutate exactly one byte/count/field (in a fresh
// re-parse of the packs, a clone of the core, or a wrapping fetch), and assert
// the relevant check now returns issues > 0 — the inverse of the "valid store
// validates clean" smoke tests.
func inspBoundaryStore(t *testing.T) (keyGetter, *DBCore) {
	t.Helper()
	db, _ := setupBoundaryDB(t)
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	return fetch, &db.core
}

// inspCloneCore shallow-copies a DBCore and clones its Feeds map so a sub-test
// can mutate db.gz-side fields without contaminating the shared store.
func inspCloneCore(c *DBCore) *DBCore {
	cp := *c
	cp.Feeds = make(map[int]*Feed, len(c.Feeds))
	for k, v := range c.Feeds {
		f := *v
		cp.Feeds[k] = &f
	}
	return &cp
}

func inspFreshPacks(t *testing.T, fetch keyGetter, core *DBCore) []*idxPack {
	t.Helper()
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	return packs
}

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
	packs, _, err := loadIdxPacks(fetch, core)
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
	packs, _, err := loadIdxPacks(fetch, core)
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
	packs, _, err := loadIdxPacks(fetch, core)
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
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues != 1 {
		t.Fatalf("checkDBMeta reported %d issues, want exactly 1 (live-count mismatch)", issues)
	}
}

// TestCheckBoundsVsDataDetectsMismatch: an idx entry whose feed_id disagrees
// with the data pack's stored feed_id is flagged (the read-path drift that
// misattributes an article to the wrong feed).
func TestCheckBoundsVsDataDetectsMismatch(t *testing.T) {
	fetch, core := inspBoundaryStore(t)
	packs := inspFreshPacks(t, fetch, core)
	packs[0].feedIDs[5] = 2 // idx claims feed 2 at chron 5; data still says feed 1
	if issues := checkBoundsVsData(fetch, core, packs, nil); issues == 0 {
		t.Error("checkBoundsVsData: 0 issues on a feed_id mismatch, want > 0")
	}
}

// TestCheckBoundsVsDataDetectsOOB: when the resolved offset lands past the data
// pack's entries, the check counts it (the frontend `reading 'f'` crash class).
func TestCheckBoundsVsDataDetectsOOB(t *testing.T) {
	fetch, core := inspBoundaryStore(t)
	packs := inspFreshPacks(t, fetch, core)
	// Serve a 1-entry data pack for every data key, so all offsets >= 1 are OOB.
	oneEntry := []byte(`{"f":1,"a":1,"c":"x"}` + "\n")
	trunc := func(key string) ([]byte, error) {
		if strings.HasPrefix(key, "data/") {
			return oneEntry, nil
		}
		return fetch(key)
	}
	if issues := checkBoundsVsData(trunc, core, packs, nil); issues == 0 {
		t.Error("checkBoundsVsData: 0 issues on out-of-range offsets, want > 0")
	}
}

// TestCheckUnknownFeedIDsDetectsUnregistered: an idx feed_id absent from
// db.feeds is flagged (the reader renders "[DELETED]").
func TestCheckUnknownFeedIDsDetectsUnregistered(t *testing.T) {
	fetch, core := inspBoundaryStore(t)
	packs := inspFreshPacks(t, fetch, core)
	c2 := inspCloneCore(core)
	delete(c2.Feeds, 1) // every entry now references an unregistered feed
	if issues := checkUnknownFeedIDs(c2, packs); issues == 0 {
		t.Error("checkUnknownFeedIDs: 0 issues with an unregistered feed_id, want > 0")
	}
}

// TestCheckFeedCountsContinuityDetectsBreak: a wrong cumulative header count in
// the second pack breaks the boundary-transition invariant.
func TestCheckFeedCountsContinuityDetectsBreak(t *testing.T) {
	fetch, core := inspBoundaryStore(t)

	t.Run("continuity break", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		packs[1].feedCounts[1] = 99999 // header disagrees with pack 0's cumulative
		if issues := checkFeedCountsContinuity(packs); issues == 0 {
			t.Error("checkFeedCountsContinuity: 0 issues on a broken transition, want > 0")
		}
	})

	t.Run("pack 0 header nonzero", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		packs[0].feedCounts[1] = 7 // nothing precedes pack 0, so this must be 0
		// A nonzero pack-0 header also perturbs the pack0->pack1 continuity
		// transition, so issues>0 alone wouldn't prove the dedicated pack-0 check
		// fired. Assert its distinctive message so removing that check fails here.
		var issues int
		out := captureStdout(t, func() { issues = checkFeedCountsContinuity(packs) })
		if issues == 0 {
			t.Error("checkFeedCountsContinuity: 0 issues on a nonzero pack-0 header, want > 0")
		}
		if !strings.Contains(out, "pack 0 sub 1") || !strings.Contains(out, "expected 0") {
			t.Errorf("want the pack-0-nonzero diagnostic, got:\n%s", out)
		}
	})
}

// TestCheckIdxSummaryDetectsCorruption covers checkIdxSummary's detection
// branches: header-base mismatch, per-slot feedCount mismatch (via mutated
// packs), and truncation / over-slots / trailing-data (via a wrapping fetch
// that tampers the decompressed summary buffer).
func TestCheckIdxSummaryDetectsCorruption(t *testing.T) {
	fetch, core := inspBoundaryStore(t)
	sumKey := summaryKey(core.HdrPacks)

	t.Run("base mismatch", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		packs[0].packIDBase += 100 // summary bases (on disk) no longer match
		if issues := checkIdxSummary(fetch, core, packs); issues == 0 {
			t.Error("checkIdxSummary: 0 issues on a base mismatch, want > 0")
		}
	})

	t.Run("per-slot feedCount mismatch", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		packs[0].feedCounts[1] = 12345 // summary feedCount disagrees
		if issues := checkIdxSummary(fetch, core, packs); issues == 0 {
			t.Error("checkIdxSummary: 0 issues on a feedCount mismatch, want > 0")
		}
	})

	t.Run("truncated summary", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		w := func(key string) ([]byte, error) {
			if key == sumKey {
				return []byte{1, 2, 3}, nil // shorter than idxHeaderPrefix
			}
			return fetch(key)
		}
		if issues := checkIdxSummary(w, core, packs); issues == 0 {
			t.Error("checkIdxSummary: 0 issues on a truncated summary, want > 0")
		}
	})

	t.Run("over-slots chunk", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		w := func(key string) ([]byte, error) {
			b, err := fetch(key)
			if key == sumKey && err == nil {
				b = append([]byte(nil), b...)
				binary.LittleEndian.PutUint32(b[idxStateSize:], 1<<20) // absurd numSlots
			}
			return b, err
		}
		if issues := checkIdxSummary(w, core, packs); issues == 0 {
			t.Error("checkIdxSummary: 0 issues on an over-slots chunk, want > 0")
		}
	})

	t.Run("trailing data", func(t *testing.T) {
		packs := inspFreshPacks(t, fetch, core)
		w := func(key string) ([]byte, error) {
			b, err := fetch(key)
			if key == sumKey && err == nil {
				b = append(append([]byte(nil), b...), 0, 0, 0, 0) // extra bytes past the last chunk
			}
			return b, err
		}
		if issues := checkIdxSummary(w, core, packs); issues == 0 {
			t.Error("checkIdxSummary: 0 issues on trailing summary data, want > 0")
		}
	})
}

// TestCheckMetaDetectsCorruption covers checkMeta's detection branches on a
// store with published finalized meta shards: latest-tail count, summary size,
// a too-short shard, a wrong shard entry count, a summary-vs-shard bloom
// mismatch, absent grams, and an mp overclaim.
func TestCheckMetaDetectsCorruption(t *testing.T) {
	fetch, core := inspBoundaryStore(t)
	sumKey := metaSummaryKey(core.MetaPacks)
	shard0 := finalizedMetaKey(0)

	t.Run("latest tail count", func(t *testing.T) {
		c2 := inspCloneCore(core)
		c2.MetaTail = 0 // in range, but the latest shard really holds MetaTail entries
		if issues := checkMeta(fetch, c2); issues == 0 {
			t.Error("checkMeta: 0 issues on a wrong mt, want > 0")
		}
	})

	t.Run("mp overclaim", func(t *testing.T) {
		c2 := inspCloneCore(core)
		c2.MetaPacks += 5 // claims more finalized shards than exist
		// An overclaim also fails the coverage-range check (mp*5000 >= total_art
		// by construction), so issues>0 alone wouldn't prove the overclaim
		// early-return fired. Assert its distinctive message.
		var issues int
		out := captureStdout(t, func() { issues = checkMeta(fetch, c2) })
		if issues == 0 {
			t.Error("checkMeta: 0 issues on an mp overclaim, want > 0")
		}
		if !strings.Contains(out, "finalized meta shards exist") {
			t.Errorf("want the mp-overclaim diagnostic, got:\n%s", out)
		}
	})

	t.Run("summary size", func(t *testing.T) {
		w := func(key string) ([]byte, error) {
			if key == sumKey {
				return []byte{1, 2, 3}, nil // not MetaPacks*searchBloomBytes
			}
			return fetch(key)
		}
		if issues := checkMeta(w, core); issues == 0 {
			t.Error("checkMeta: 0 issues on a wrong-size summary, want > 0")
		}
	})

	t.Run("shard shorter than bloom", func(t *testing.T) {
		w := func(key string) ([]byte, error) {
			if key == shard0 {
				return make([]byte, searchBloomBytes-1), nil
			}
			return fetch(key)
		}
		if issues := checkMeta(w, core); issues == 0 {
			t.Error("checkMeta: 0 issues on a too-short shard, want > 0")
		}
	})

	t.Run("shard entry count", func(t *testing.T) {
		w := func(key string) ([]byte, error) {
			b, err := fetch(key)
			if key == shard0 && err == nil {
				bloom := b[:searchBloomBytes]
				body := b[searchBloomBytes:]
				nl := bytes.IndexByte(body, '\n')
				b = append(append([]byte(nil), bloom...), body[nl+1:]...) // drop one entry
			}
			return b, err
		}
		if issues := checkMeta(w, core); issues == 0 {
			t.Error("checkMeta: 0 issues on a wrong shard entry count, want > 0")
		}
	})

	t.Run("summary vs shard bloom", func(t *testing.T) {
		w := func(key string) ([]byte, error) {
			b, err := fetch(key)
			if key == sumKey && err == nil {
				b = append([]byte(nil), b...)
				b[0] ^= 0xFF // flip a byte in shard 0's summary bloom region
			}
			return b, err
		}
		if issues := checkMeta(w, core); issues == 0 {
			t.Error("checkMeta: 0 issues on a summary/shard bloom mismatch, want > 0")
		}
	})

	t.Run("absent grams", func(t *testing.T) {
		// Zero shard 0's bloom AND its summary region together, so the bloom-equality
		// check still passes and only the no-false-negatives gram probe fires.
		w := func(key string) ([]byte, error) {
			b, err := fetch(key)
			if err != nil {
				return b, err
			}
			if key == shard0 {
				b = append([]byte(nil), b...)
				for i := 0; i < searchBloomBytes; i++ {
					b[i] = 0
				}
			}
			if key == sumKey {
				b = append([]byte(nil), b...)
				for i := 0; i < searchBloomBytes; i++ {
					b[i] = 0
				}
			}
			return b, err
		}
		if issues := checkMeta(w, core); issues == 0 {
			t.Error("checkMeta: 0 issues when a shard's grams are absent from its bloom, want > 0")
		}
	})
}
