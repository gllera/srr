package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setupBoundaryDB builds a store whose first idx pack just finalized:
// idxPackSize+1 articles written in two batches (mirrors
// TestPutArticlesIdxPackSplitAtBoundary).
func setupBoundaryDB(t *testing.T) (*DB, string) {
	t.Helper()
	db, c, dir := setupTestDB(t)
	globals.PackSize = 1024 // data packs never split (read lazily at write time)

	ch := &Channel{id: 1}
	c.Channels = map[int]*Channel{ch.id: ch}
	c.FetchedAt = 1700000000

	articles := make([]*Item, idxPackSize)
	for i := range articles {
		articles[i] = &Item{Channel: ch, Title: fmt.Sprintf("A%d", i), Content: "c", Published: int64(i)}
	}
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.PutArticles(ctx, []*Item{
		{Channel: ch, Title: "Last", Content: "c", Published: int64(idxPackSize)},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	return db, dir
}

// The HdrPacks=0-with-finalized-packs state synced here is also exactly what
// a pre-summary store (first run after upgrade) or a post-`srr gen --bump`
// reset presents, so this covers all three rebuild triggers.
func TestSyncIdxSummaryAtBoundary(t *testing.T) {
	db, dir := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if db.core.HdrPacks != 1 {
		t.Fatalf("HdrPacks = %d, want 1", db.core.HdrPacks)
	}

	sum := decompressGz(t, filepath.Join(dir, "idx/h1.gz"))
	if len(sum) != idxHeaderSize {
		t.Fatalf("summary size = %d, want %d", len(sum), idxHeaderSize)
	}
	pack0 := decompressGz(t, filepath.Join(dir, "idx/0.gz"))
	if !bytes.Equal(sum, pack0[:idxHeaderSize]) {
		t.Error("summary bytes != idx/0.gz header bytes")
	}
}

func TestSyncIdxSummaryNoopWhenCurrent(t *testing.T) {
	db, dir := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	// Remove the file; a no-op second call must not recreate it.
	os.Remove(filepath.Join(dir, "idx/h1.gz"))
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary (noop): %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "idx/h1.gz")); !os.IsNotExist(err) {
		t.Error("no-op SyncIdxSummary recreated the summary")
	}
}

func TestSyncIdxSummaryBelowBoundaryNoop(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Channel{id: 1}
	c.Channels = map[int]*Channel{ch.id: ch}
	putOneArticle(t, db, ch, 1)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if c.HdrPacks != 0 {
		t.Errorf("HdrPacks = %d, want 0 below the boundary", c.HdrPacks)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "idx/h*.gz"))
	if len(matches) != 0 {
		t.Errorf("unexpected summary files: %v", matches)
	}
}

func TestGCSummariesGraceWindow(t *testing.T) {
	db, c, dir := setupTestDB(t)

	// Plant summary names directly; the sweep works on computed names only.
	if err := os.MkdirAll(filepath.Join(dir, "idx"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for g := 1; g <= 5; g++ {
		if err := os.WriteFile(filepath.Join(dir, summaryKey(g)), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	c.HdrPacks = 5

	if err := db.GCSummaries(ctx, 2); err != nil {
		t.Fatalf("GCSummaries: %v", err)
	}
	for g := 1; g <= 2; g++ {
		assertKey(t, dir, summaryKey(g), false)
	}
	for g := 3; g <= 5; g++ {
		assertKey(t, dir, summaryKey(g), true)
	}

	// A second sweep on the same state is a no-op (Rm silent-on-missing).
	if err := db.GCSummaries(ctx, 2); err != nil {
		t.Fatalf("GCSummaries (idempotent): %v", err)
	}
}

func TestGCSummariesEmptyStoreNoop(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.GCSummaries(ctx, 2); err != nil {
		t.Fatalf("GCSummaries on empty store: %v", err)
	}
}

// hdrs is omitempty: absent from db.gz at 0 (readers treat absent as 0).
func TestCommitHdrsOmitemptyWhenZero(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw := string(decompressGz(t, filepath.Join(dir, "db.gz")))
	if strings.Contains(raw, `"hdrs"`) {
		t.Errorf("fresh db.gz should omit %q: %s", "hdrs", raw)
	}

	c.HdrPacks = 2
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw = string(decompressGz(t, filepath.Join(dir, "db.gz")))
	if !strings.Contains(raw, `"hdrs":2`) {
		t.Errorf("db.gz missing %q: %s", `"hdrs":2`, raw)
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
	db.core.HdrPacks = 2
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err == nil {
		t.Fatal("inspect --validate passed with hdrs > finalized pack count")
	}
}
