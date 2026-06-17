package main

import (
	"fmt"
	"testing"
)

// feed_id widened from u8 to u16: this exercises ids ≥ 256 end-to-end —
// register 300 feeds, write one article each through PutArticles, then
// round-trip the latest idx pack through parseIdxPack and run the full
// inspect --validate sweep. Pre-widen, the entry's single feed_id byte would
// alias id 256 → 0, 257 → 1, … and the variable header (numSlots) would not
// reach 300.
func TestFeedWidthBeyond255(t *testing.T) {
	db, c, _ := setupTestDB(t)

	const n = 300
	// One article per feed; ids 0..n-1. Each feed needs a non-empty URL
	// so the inspect --validate reopen (NewDB) passes the feed→feed migration
	// guard.
	c.Feeds = make(map[int]*Feed, n)
	articles := make([]*Item, 0, n)
	for id := range n {
		ch := &Feed{id: id, Title: fmt.Sprintf("ch%d", id), URL: fmt.Sprintf("https://example.com/%d", id)}
		c.Feeds[id] = ch
		articles = append(articles, &Item{
			Feed:      ch,
			Title:     fmt.Sprintf("a%d", id),
			Content:   fmt.Sprintf("c%d", id),
			Link:      fmt.Sprintf("https://example.com/%d/1", id),
			Published: int64(1000 + id),
		})
	}

	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Round-trip the latest idx pack: every entry's feed_id must survive,
	// including the ids ≥ 256 that a u8 entry could not hold.
	_, raw, err := db.loadPack(ctx, latestKey(c, "idx"))
	if err != nil {
		t.Fatalf("loadPack: %v", err)
	}
	pack, err := parseIdxPack(raw, 0, n)
	if err != nil {
		t.Fatalf("parseIdxPack: %v", err)
	}
	if pack.numSlots != n {
		t.Errorf("numSlots = %d, want %d", pack.numSlots, n)
	}
	seen := make(map[uint16]bool, n)
	for _, id := range pack.feedIDs {
		seen[id] = true
	}
	for id := range n {
		if !seen[uint16(id)] {
			t.Errorf("feed_id %d missing from parsed idx entries", id)
		}
		if got := pack.ownFeedCount(id); got != 1 {
			t.Errorf("ownFeedCount(%d) = %d, want 1", id, got)
		}
	}
	// A high id must not alias a low one: id 256 distinct from id 0.
	if seen[256] != true {
		t.Error("feed_id 256 not parsed (u8 aliasing would lose it)")
	}

	// Full validation sweep over the committed store (reopens via NewDB).
	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
		t.Fatalf("inspect --validate: %v", err)
	}
}
