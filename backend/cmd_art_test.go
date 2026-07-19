package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestParseTimeBound covers the --since/--until value grammar: relative
// durations (Go units plus the d/w extensions) resolved against the caller's
// `now`, bare local dates, and RFC3339 instants — plus the forms deliberately
// rejected, bare unix seconds among them.
func TestParseTimeBound(t *testing.T) {
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)

	t.Run("relative", func(t *testing.T) {
		cases := []struct {
			in   string
			back time.Duration
		}{
			{"24h", 24 * time.Hour},
			{"90m", 90 * time.Minute},
			{"7d", 7 * 24 * time.Hour},
			{"2w", 14 * 24 * time.Hour},
			{"1.5d", 36 * time.Hour},
			{"1d12h", 36 * time.Hour}, // d/w compose with Go's own units
		}
		for _, c := range cases {
			got, err := parseTimeBound(c.in, now)
			if err != nil {
				t.Errorf("parseTimeBound(%q): %v", c.in, err)
				continue
			}
			if want := now.Add(-c.back).Unix(); got != want {
				t.Errorf("parseTimeBound(%q) = %d, want %d (%v before now)", c.in, got, want, c.back)
			}
		}
	})

	t.Run("date is local midnight", func(t *testing.T) {
		got, err := parseTimeBound("2026-07-15", now)
		if err != nil {
			t.Fatalf("parseTimeBound: %v", err)
		}
		want := time.Date(2026, 7, 15, 0, 0, 0, 0, time.Local).Unix()
		if got != want {
			t.Errorf("parseTimeBound(date) = %d, want %d (local midnight)", got, want)
		}
	})

	t.Run("rfc3339", func(t *testing.T) {
		got, err := parseTimeBound("2026-07-15T10:00:00Z", now)
		if err != nil {
			t.Fatalf("parseTimeBound: %v", err)
		}
		if want := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC).Unix(); got != want {
			t.Errorf("parseTimeBound(Z) = %d, want %d", got, want)
		}
		// An explicit offset is honoured as given, not reinterpreted locally.
		got, err = parseTimeBound("2026-07-15T12:00:00+02:00", now)
		if err != nil {
			t.Fatalf("parseTimeBound(offset): %v", err)
		}
		if want := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC).Unix(); got != want {
			t.Errorf("parseTimeBound(offset) = %d, want %d", got, want)
		}
	})

	t.Run("rejects", func(t *testing.T) {
		for _, in := range []string{
			"",
			"1719792000", // bare unix seconds: deliberately not a form
			"-24h",       // a negative window bound is meaningless
			"7x",
			"garbage",
			"2026-13-45",
			"2026-07-15T10:00:00", // RFC3339 requires a zone
		} {
			if got, err := parseTimeBound(in, now); err == nil {
				t.Errorf("parseTimeBound(%q) = %d, want error", in, got)
			}
		}
	})
}

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

// artCycleTimes are the fetch-cycle stamps artTimeStore commits, one per
// cycle. fetched_at is chron-monotone (one stamp per cycle, applied to the
// whole batch), which is what makes a --since/--until window a contiguous
// chron range.
var artCycleTimes = []time.Time{
	time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
	time.Date(2026, 7, 3, 0, 0, 0, 0, time.UTC),
}

// artTimeStore commits three fetch cycles of two articles each (one per feed),
// so chron 0..5 carries three distinct fetched_at stamps: a0,a1 | b0,b1 |
// c0,c1. Index 0 is the news feed, 1 the tech feed.
func artTimeStore(t *testing.T) (*DB, *Feed, *Feed) {
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
	for i, name := range []string{"a", "b", "c"} {
		db.core.FetchedAt = artCycleTimes[i].Unix()
		items := []*Item{
			{Feed: f0, Title: name + "0", Content: "body", Link: "l"},
			{Feed: f1, Title: name + "1", Content: "body", Link: "l"},
		}
		if _, err := db.PutArticles(ctx, items); err != nil {
			t.Fatalf("PutArticles cycle %d: %v", i, err)
		}
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	return db, f0, f1
}

// artStamp renders a cycle time as an RFC3339 --since/--until value.
func artStamp(i int) string { return artCycleTimes[i].Format(time.RFC3339) }

// artRunErr runs an ArtCmd expecting a hard error, and returns it.
func artRunErr(t *testing.T, cmd *ArtCmd) error {
	t.Helper()
	err := cmd.Run()
	if err == nil {
		t.Fatal("ArtCmd.Run: want error, got nil")
	}
	return err
}

// TestArtListSince pins the --since half of the window: the bound is
// inclusive, so the cycle stamped exactly at it is kept, and Total counts the
// window rather than the whole store.
func TestArtListSince(t *testing.T) {
	artTimeStore(t)

	out := artRun(t, &ArtCmd{Limit: 50, Since: artStamp(1)})
	if want := []string{"c1", "c0", "b1", "b0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (cycles 1-2, newest first)", artTitles(out), want)
	}
	if out.Total != 4 {
		t.Errorf("Total = %d, want 4 (window only, not the 6-article store)", out.Total)
	}
}

// TestArtListUntil pins the --until half: exclusive, so the cycle stamped
// exactly at the bound is dropped.
func TestArtListUntil(t *testing.T) {
	artTimeStore(t)

	out := artRun(t, &ArtCmd{Limit: 50, Until: artStamp(1)})
	if want := []string{"a1", "a0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (cycle 0 only, newest first)", artTitles(out), want)
	}
	if out.Total != 2 {
		t.Errorf("Total = %d, want 2", out.Total)
	}
}

// TestArtListWindow pins both bounds together: the half-open [since, until)
// window keeps the cycle at --since and drops the one at --until, so
// consecutive windows compose without overlap.
func TestArtListWindow(t *testing.T) {
	artTimeStore(t)

	out := artRun(t, &ArtCmd{Limit: 50, Since: artStamp(1), Until: artStamp(2)})
	if want := []string{"b1", "b0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (single cycle)", artTitles(out), want)
	}
	if out.Total != 2 {
		t.Errorf("Total = %d, want 2", out.Total)
	}
}

// TestArtListWindowEmpty covers a valid window no article falls in: an empty
// page, not an error.
func TestArtListWindowEmpty(t *testing.T) {
	artTimeStore(t)

	out := artRun(t, &ArtCmd{Limit: 50, Since: "2026-08-01T00:00:00Z"})
	if len(out.Articles) != 0 || out.Total != 0 {
		t.Errorf("out = %+v, want an empty page with Total 0", out)
	}
	if out.NextCursor != nil {
		t.Errorf("NextCursor = %v, want nil", *out.NextCursor)
	}
}

// TestArtListWindowWithFilter pins the window composing with -g: both narrow
// the same result set and the same Total.
func TestArtListWindowWithFilter(t *testing.T) {
	artTimeStore(t)

	out := artRun(t, &ArtCmd{Limit: 50, Tag: []string{"news"}, Since: artStamp(1)})
	if want := []string{"c0", "b0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (news feed within the window)", artTitles(out), want)
	}
	if out.Total != 2 {
		t.Errorf("Total = %d, want 2", out.Total)
	}
}

// TestArtListWindowPaging pins --before paging staying inside the window: the
// cursor never walks below the --since bound.
func TestArtListWindowPaging(t *testing.T) {
	artTimeStore(t)

	p1 := artRun(t, &ArtCmd{Limit: 2, Since: artStamp(1)})
	if want := []string{"c1", "c0"}; !artEqualStrs(artTitles(p1), want) {
		t.Fatalf("page1 titles = %v, want %v", artTitles(p1), want)
	}
	if p1.Total != 4 {
		t.Errorf("page1 Total = %d, want 4 (whole window)", p1.Total)
	}
	if p1.NextCursor == nil {
		t.Fatal("page1 NextCursor = nil, want a cursor (full page)")
	}

	p2 := artRun(t, &ArtCmd{Limit: 2, Since: artStamp(1), Before: p1.NextCursor})
	if want := []string{"b1", "b0"}; !artEqualStrs(artTitles(p2), want) {
		t.Fatalf("page2 titles = %v, want %v", artTitles(p2), want)
	}

	// Page 3 would cross below the window: it must come back empty, never
	// leaking cycle-0 articles.
	if p2.NextCursor != nil {
		p3 := artRun(t, &ArtCmd{Limit: 2, Since: artStamp(1), Before: p2.NextCursor})
		if len(p3.Articles) != 0 {
			t.Errorf("page3 titles = %v, want none (window exhausted)", artTitles(p3))
		}
	}
}

// TestArtListWindowInverted pins since >= until as a hard error rather than a
// silently empty result — with an exclusive --until, equality is a provably
// empty window too.
func TestArtListWindowInverted(t *testing.T) {
	artTimeStore(t)

	err := artRunErr(t, &ArtCmd{Limit: 50, Since: artStamp(2), Until: artStamp(0)})
	if !strings.Contains(err.Error(), "since") {
		t.Errorf("error = %v, want it to name --since/--until", err)
	}
	err = artRunErr(t, &ArtCmd{Limit: 50, Since: artStamp(1), Until: artStamp(1)})
	if !strings.Contains(err.Error(), "since") {
		t.Errorf("error = %v, want since == until to be the same hard error", err)
	}
}

// TestArtListWindowBadValue pins an unparseable bound failing the command —
// on both flags, each error naming the flag it came from.
func TestArtListWindowBadValue(t *testing.T) {
	artTimeStore(t)

	err := artRunErr(t, &ArtCmd{Limit: 50, Since: "last tuesday"})
	if !strings.Contains(err.Error(), "--since") {
		t.Errorf("error = %v, want it to name --since", err)
	}
	err = artRunErr(t, &ArtCmd{Limit: 50, Until: "last tuesday"})
	if !strings.Contains(err.Error(), "--until") {
		t.Errorf("error = %v, want it to name --until", err)
	}
}

// TestArtListWindowBeforeAboveCeiling pins --before being clamped DOWN to the
// window ceiling: a cursor taken from an unwindowed page sits above --until, and
// paging from it must still start at the newest in-window article rather than
// leaking the ones above the bound.
func TestArtListWindowBeforeAboveCeiling(t *testing.T) {
	artTimeStore(t)

	above := 6 // one past the newest chron in the store
	out := artRun(t, &ArtCmd{Limit: 50, Until: artStamp(2), Before: &above})
	if want := []string{"b1", "b0", "a1", "a0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (cursor clamped to the --until ceiling)", artTitles(out), want)
	}
	if out.Total != 4 {
		t.Errorf("Total = %d, want 4", out.Total)
	}
}

// artDropLastRecord rewrites the latest data pack without its final JSONL
// record, so the newest chron's idx entry addresses an offset past the end of
// its pack — the corrupt store the window search and the content fill are
// documented to treat differently.
func artDropLastRecord(t *testing.T, db *DB) {
	t.Helper()
	path := filepath.Join(globals.Store, latestKey(&db.core, "data"))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read latest data pack: %v", err)
	}
	plain, err := gunzip(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("gunzip latest data pack: %v", err)
	}
	lines := bytes.SplitAfter(bytes.TrimRight(plain, "\n"), []byte("\n"))
	if len(lines) < 2 {
		t.Fatalf("latest data pack holds %d record(s); the fixture must keep the newest article here", len(lines))
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	for _, l := range lines[:len(lines)-1] {
		if _, err := gz.Write(l); err != nil {
			t.Fatal(err)
		}
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("rewrite latest data pack: %v", err)
	}
}

// TestArtListMissingRecord pins the deliberate asymmetry between the two
// consumers of packReader.at when an idx entry addresses no data-pack record:
// the content fill tolerates it and leaves the row blank, while the window
// search refuses — a probe reading a zero fetched_at would silently relocate
// the whole window instead of reporting the corrupt store.
func TestArtListMissingRecord(t *testing.T) {
	db, _, _ := artTimeStore(t)
	artDropLastRecord(t, db)

	// Unwindowed: the missing record is a blank row, not an error, and every
	// other row still resolves.
	out := artRun(t, &ArtCmd{Limit: 50})
	if len(out.Articles) != 6 {
		t.Fatalf("got %d articles, want 6 (idx entries are unchanged)", len(out.Articles))
	}
	if newest := out.Articles[0]; newest.Title != "" || newest.Content != "" {
		t.Errorf("newest row = %+v, want it left blank for the missing record", newest)
	}
	if out.Articles[1].Title != "c0" {
		t.Errorf("second row title = %q, want %q (neighbours still resolve)", out.Articles[1].Title, "c0")
	}

	// Windowed: the same store is a hard error naming the offending chron.
	err := artRunErr(t, &ArtCmd{Limit: 50, Until: artStamp(2)})
	if !strings.Contains(err.Error(), "no data-pack record") {
		t.Errorf("error = %v, want the window search to refuse the corrupt store", err)
	}
	if !strings.Contains(err.Error(), "chron 5") {
		t.Errorf("error = %v, want it to name the offending chron", err)
	}
}

// TestArtListWindowUnreadablePack pins a data-pack read failure surfacing from
// the window search. The search reads packs the result page never touches, so a
// store with one unreadable pack fails a windowed query that would otherwise
// have returned a plausible-looking window.
func TestArtListWindowUnreadablePack(t *testing.T) {
	db, _, _ := artTimeStore(t)
	path := filepath.Join(globals.Store, latestKey(&db.core, "data"))
	if err := os.WriteFile(path, []byte("not gzip"), 0o644); err != nil {
		t.Fatalf("corrupt latest data pack: %v", err)
	}

	artRunErr(t, &ArtCmd{Limit: 50, Until: artStamp(2)})
	// The content fill propagates the same failure — nothing here is tolerated
	// into a silently short page.
	artRunErr(t, &ArtCmd{Limit: 50})
}

// TestArtListWindowAcrossDeltaSeam pins the window resolving across the
// pack↔delta seam: cycle 0 is consolidated into packs while cycles 1-2 stay in
// the live delta chain, so the binary search must probe both regions.
func TestArtListWindowAcrossDeltaSeam(t *testing.T) {
	db, _, _ := setupTestDB(t)
	f0 := &Feed{Title: "News feed", URL: "https://n.example/f", Tag: "news"}
	f1 := &Feed{Title: "Tech feed", URL: "https://t.example/f", Tag: "tech"}
	if err := db.AddFeed(f0); err != nil {
		t.Fatalf("AddFeed f0: %v", err)
	}
	if err := db.AddFeed(f1); err != nil {
		t.Fatalf("AddFeed f1: %v", err)
	}
	for i, name := range []string{"a", "b", "c"} {
		if i == 1 {
			// Cycle 0 consolidated into packs; 1-2 stay in the chain. The byte
			// cap is lifted out of the way so only the chain cap decides.
			globals.MaxDeltas = 4
			globals.MaxDeltaBytes = 1 << 20
		}
		db.core.FetchedAt = artCycleTimes[i].Unix()
		items := []*Item{
			{Feed: f0, Title: name + "0", Content: "body", Link: "l"},
			{Feed: f1, Title: name + "1", Content: "body", Link: "l"},
		}
		if _, err := db.PutArticles(ctx, items); err != nil {
			t.Fatalf("PutArticles cycle %d: %v", i, err)
		}
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if db.core.NumDeltas == 0 {
		t.Fatal("fixture built no delta chain — the seam is not exercised")
	}

	// Window spanning the seam: cycle 0 (packs) + cycle 1 (delta), with the
	// exclusive --until sitting on cycle 2's stamp.
	out := artRun(t, &ArtCmd{Limit: 50, Until: artStamp(2)})
	if want := []string{"b1", "b0", "a1", "a0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (across the pack/delta seam)", artTitles(out), want)
	}
	if out.Total != 4 {
		t.Errorf("Total = %d, want 4", out.Total)
	}
	for _, a := range out.Articles {
		if a.Content == "" {
			t.Errorf("article %q has empty content", a.Title)
		}
	}

	// The --since search walks different indices than the --until one, so pin
	// the lower bound landing inside the delta region too.
	out = artRun(t, &ArtCmd{Limit: 50, Since: artStamp(2)})
	if want := []string{"c1", "c0"}; !artEqualStrs(artTitles(out), want) {
		t.Errorf("titles = %v, want %v (--since inside the delta chain)", artTitles(out), want)
	}
	if out.Total != 2 {
		t.Errorf("Total = %d, want 2", out.Total)
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
