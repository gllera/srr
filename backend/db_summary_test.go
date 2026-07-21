package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// setupSplitBoundaryDB builds a store whose first pack at the given split
// size just finalized: size+1 articles written in two batches (mirrors
// TestPutArticlesIdxPackSplitAtBoundary). Shared by the idx (idxPackSize) and
// meta (metaPackSize) boundary suites via the wrappers below.
func setupSplitBoundaryDB(t *testing.T, size int) (*DB, string) {
	t.Helper()
	db, c, dir := setupTestDB(t)
	globals.PackSize = 1024 // data packs never split (read lazily at write time)

	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	articles := make([]*Item, size)
	for i := range articles {
		articles[i] = &Item{Feed: ch, Title: fmt.Sprintf("A%d", i), Content: "c", Published: int64(i)}
	}
	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "Last", Content: "c", Published: int64(size)},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	return db, dir
}

// setupBoundaryDB builds a store whose first idx pack just finalized:
// idxPackSize+1 articles written in two batches.
func setupBoundaryDB(t *testing.T) (*DB, string) {
	t.Helper()
	return setupSplitBoundaryDB(t, idxPackSize)
}

// The HdrPacks=0-with-finalized-packs state synced here is also exactly what
// a pre-summary store (first run after upgrade) or a post-`srr gen --bump`
// reset presents, so this covers all three rebuild triggers.
func TestSyncIdxSummaryAtBoundary(t *testing.T) {
	db, dir := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if db.core.hdrPacks() != 1 {
		t.Fatalf("HdrPacks = %d, want 1", db.core.hdrPacks())
	}

	sum := decompressGz(t, filepath.Join(dir, db.core.Names.hsumKey()))
	pack0 := decompressGz(t, filepath.Join(dir, "idx/0.gz"))
	// The idx header is variable-length: the fixed prefix plus numSlots×4
	// cumulative counts, dense up to the high-water feed id.
	numSlots := int(binary.LittleEndian.Uint32(pack0[idxStateSize:]))
	headerSize := idxHeaderPrefix + numSlots*4
	if len(sum) != headerSize {
		t.Fatalf("summary size = %d, want %d", len(sum), headerSize)
	}
	if !bytes.Equal(sum, pack0[:headerSize]) {
		t.Error("summary bytes != idx/0.gz header bytes")
	}
}

func TestSyncIdxSummaryNoopWhenCurrent(t *testing.T) {
	db, dir := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	// Remove the file; a no-op second call must not recreate it.
	os.Remove(filepath.Join(dir, db.core.Names.hsumKey()))
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary (noop): %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, db.core.Names.hsumKey())); !os.IsNotExist(err) {
		t.Error("no-op SyncIdxSummary recreated the summary")
	}
}

func TestSyncIdxSummaryBelowBoundaryNoop(t *testing.T) {
	db, c, _ := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	putOneArticle(t, db, ch, 1)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if c.hdrPacks() != 0 {
		t.Errorf("HdrPacks = %d, want 0 below the boundary", c.hdrPacks())
	}
	if c.Names.HSum != nil {
		t.Errorf("unexpected summary published: %s", c.Names.hsumKey())
	}
}

// Full inspect --validate sweep over a boundary-crossing store with a
// published summary — the writer-side contract check for idx/h<N>.gz, and
// the only Go coverage of validateAll.
func TestInspectValidateSummary(t *testing.T) {
	db, _ := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
		t.Fatalf("inspect --validate: %v", err)
	}
}

// hdrs claiming more coverage than the store has finalized packs is an
// integrity issue, not a warning.
func TestInspectValidateSummaryOverclaim(t *testing.T) {
	db, _ := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	db.core.Names.HSum.Covers = 2
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err == nil {
		t.Fatal("inspect --validate passed with hdrs > finalized pack count")
	}
}
