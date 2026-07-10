package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// artTestStore builds and commits a small multi-data-pack store used by the
// `srr art ls` tests: two feeds (news/tech), five interleaved articles at
// chron 0..4. Content is padded past the 1 KB PackSize floor so PutArticles
// splits it across several data packs, exercising getPackRef + loadContent's
// per-pack dataCache. Returns the (still open) db and the two seeded feeds.
func artTestStore(t *testing.T) (*DB, *Feed, *Feed) {
	t.Helper()
	db, _, _ := setupTestDB(t)
	f0 := &Feed{Title: "News feed", URL: "https://n.example/f", Tag: "news"}
	f1 := &Feed{Title: "Tech feed", URL: "https://t.example/f", Tag: "tech"}
	if err := db.AddFeed(f0); err != nil {
		t.Fatalf("AddFeed f0: %v", err)
	}
	if err := db.AddFeed(f1); err != nil {
		t.Fatalf("AddFeed f1: %v", err)
	}
	pad := strings.Repeat("x", 700) // > PackSize/2 so 5 articles need >1 data pack
	items := []*Item{
		{Feed: f0, Title: "a0", Content: pad, Link: "l0", Published: 100},
		{Feed: f1, Title: "a1", Content: pad, Link: "l1", Published: 101},
		{Feed: f0, Title: "a2", Content: pad, Link: "l2", Published: 102},
		{Feed: f1, Title: "a3", Content: pad, Link: "l3", Published: 103},
		{Feed: f0, Title: "a4", Content: pad, Link: "l4", Published: 104},
	}
	if _, err := db.PutArticles(ctx, items); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	return db, f0, f1
}

// artRun runs an ArtCmd against the committed store (which it reopens
// read-only) and decodes the JSON it prints.
func artRun(t *testing.T, cmd *ArtCmd) articlesOutput {
	t.Helper()
	var out articlesOutput
	raw := captureOutput(t, func() {
		if err := cmd.Run(); err != nil {
			t.Fatalf("ArtCmd.Run: %v", err)
		}
	})
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("decode art output: %v (raw: %q)", err, raw)
	}
	return out
}

func artTitles(out articlesOutput) []string {
	titles := make([]string, len(out.Articles))
	for i, a := range out.Articles {
		titles[i] = a.Title
	}
	return titles
}

func artEqualStrs(a, b []string) bool {
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

// TestArtListNewestFirst covers the un-filtered read path: articles come back
// in descending chronIdx order (newest first) with content loaded, Total is the
// full count, and no next_cursor is emitted when the page isn't full.
func TestArtListNewestFirst(t *testing.T) {
	artTestStore(t)

	out := artRun(t, &ArtCmd{Limit: 50})
	if out.Total != 5 {
		t.Errorf("Total = %d, want 5", out.Total)
	}
	if want := []string{"a4", "a3", "a2", "a1", "a0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (newest-first)", artTitles(out), want)
	}
	// Idx (chronIdx) strictly descending; content + link resolved from data packs.
	for i, a := range out.Articles {
		if i > 0 && out.Articles[i-1].Idx <= a.Idx {
			t.Errorf("Idx not strictly descending at %d: %d then %d", i, out.Articles[i-1].Idx, a.Idx)
		}
		if a.Content == "" {
			t.Errorf("article %q has empty content (loadContent didn't fill it)", a.Title)
		}
	}
	if out.Articles[0].Link != "l4" {
		t.Errorf("newest link = %q, want l4", out.Articles[0].Link)
	}
	if out.NextCursor != nil {
		t.Errorf("NextCursor = %v, want nil (page not full)", *out.NextCursor)
	}
}

// TestArtListFilters covers the -i (feed id) and -g (tag) filter-set build and
// filteredTotal accounting: each restricts the result set and Total to the
// matching feed's live articles.
func TestArtListFilters(t *testing.T) {
	artTestStore(t)

	t.Run("by feed id", func(t *testing.T) {
		out := artRun(t, &ArtCmd{ID: []int{1}, Limit: 50})
		if want := []string{"a3", "a1"}; !artEqualStrs(artTitles(out), want) {
			t.Errorf("titles = %v, want %v (feed 1 only)", artTitles(out), want)
		}
		if out.Total != 2 {
			t.Errorf("Total = %d, want 2", out.Total)
		}
	})

	t.Run("by tag", func(t *testing.T) {
		out := artRun(t, &ArtCmd{Tag: []string{"news"}, Limit: 50})
		if want := []string{"a4", "a2", "a0"}; !artEqualStrs(artTitles(out), want) {
			t.Errorf("titles = %v, want %v (tag news = feed 0)", artTitles(out), want)
		}
		if out.Total != 3 {
			t.Errorf("Total = %d, want 3", out.Total)
		}
	})
}

// TestArtListAddIdxExpiredHidden pins readAllIdx's `chron < ch.AddIdx` skip: an
// article logically expired past the feed's AddIdx is invisible to the listing,
// and Total counts only the surviving entries.
func TestArtListAddIdxExpiredHidden(t *testing.T) {
	db, f0, _ := artTestStore(t)

	// Feed 0's chron-0 entry ("a0") sits below add_idx=1 → logically expired.
	f0.AddIdx = 1
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	out := artRun(t, &ArtCmd{Limit: 50})
	if want := []string{"a4", "a3", "a2", "a1"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (a0 hidden by add_idx)", artTitles(out), want)
	}
	if out.Total != 4 {
		t.Errorf("Total = %d, want 4 (expired entry excluded)", out.Total)
	}
	for _, a := range out.Articles {
		if a.Title == "a0" {
			t.Fatal("expired article a0 leaked into the listing")
		}
	}
}

// TestArtListCursorPagination walks the whole store two-at-a-time via --before,
// asserting the next_cursor contract: it is the lowest chronIdx returned, is
// emitted only while a full page (len==limit) with a positive lastID is
// produced, and drives the following page's --before cursor.
func TestArtListCursorPagination(t *testing.T) {
	artTestStore(t)

	// Page 1: newest two (chron 4,3). Full page → cursor = 3.
	p1 := artRun(t, &ArtCmd{Limit: 2})
	if want := []string{"a4", "a3"}; !artEqualStrs(artTitles(p1), want) {
		t.Fatalf("page1 titles = %v, want %v", artTitles(p1), want)
	}
	if p1.Total != 5 {
		t.Errorf("page1 Total = %d, want 5 (full store)", p1.Total)
	}
	if p1.NextCursor == nil || *p1.NextCursor != 3 {
		t.Fatalf("page1 NextCursor = %v, want 3", p1.NextCursor)
	}

	// Page 2: chron 2,1. Full page → cursor = 1.
	p2 := artRun(t, &ArtCmd{Limit: 2, Before: p1.NextCursor})
	if want := []string{"a2", "a1"}; !artEqualStrs(artTitles(p2), want) {
		t.Fatalf("page2 titles = %v, want %v", artTitles(p2), want)
	}
	if p2.NextCursor == nil || *p2.NextCursor != 1 {
		t.Fatalf("page2 NextCursor = %v, want 1", p2.NextCursor)
	}

	// Page 3: chron 0 only. Not a full page → no cursor.
	p3 := artRun(t, &ArtCmd{Limit: 2, Before: p2.NextCursor})
	if want := []string{"a0"}; !artEqualStrs(artTitles(p3), want) {
		t.Fatalf("page3 titles = %v, want %v", artTitles(p3), want)
	}
	if p3.NextCursor != nil {
		t.Errorf("page3 NextCursor = %v, want nil (last, partial page)", *p3.NextCursor)
	}
}

// TestArtListFilteredTotalVsLimit pins filteredTotal (all matching, ignoring the
// page window) diverging from the returned page (capped by --limit), and the
// cursor pointing at the last returned match rather than the last raw chron.
func TestArtListFilteredTotalVsLimit(t *testing.T) {
	artTestStore(t)

	out := artRun(t, &ArtCmd{Tag: []string{"news"}, Limit: 2})
	if want := []string{"a4", "a2"}; !artEqualStrs(artTitles(out), want) {
		t.Fatalf("titles = %v, want %v (news, first page of 2)", artTitles(out), want)
	}
	if out.Total != 3 {
		t.Errorf("Total = %d, want 3 (all news articles, not just the page)", out.Total)
	}
	if out.NextCursor == nil || *out.NextCursor != 2 {
		t.Fatalf("NextCursor = %v, want 2 (last returned match, skipping feed-1 chron 3)", out.NextCursor)
	}
}

// TestArtListEmptyStore covers the total==0 short-circuit.
func TestArtListEmptyStore(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	out := artRun(t, &ArtCmd{Limit: 50})
	if out.Total != 0 || len(out.Articles) != 0 {
		t.Errorf("empty store = %+v, want zero articles", out)
	}
}
