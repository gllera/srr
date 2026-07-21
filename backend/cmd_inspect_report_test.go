package main

import (
	"strings"
	"testing"
)

// inspReportStore builds a small 2-feed store (feed 0 tag "news" at chron
// 0,2,4; feed 1 tag "tech" at chron 1,3) for the inspectOne / fromHashReport
// tests, reading packs straight off the freshly-written latest packs (no Commit
// needed — PutArticles writes them). FetchedAt is pinned so inspectOne's
// fetched_at line is assertable.
func inspReportStore(t *testing.T) (keyGetter, *DBCore, []*Feed) {
	t.Helper()
	db, core, _ := setupTestDB(t)
	f0 := &Feed{Title: "News", URL: "https://n.example/f", Tag: "news"}
	f1 := &Feed{Title: "Tech", URL: "https://t.example/f", Tag: "tech"}
	if err := db.AddFeed(f0); err != nil {
		t.Fatalf("AddFeed f0: %v", err)
	}
	if err := db.AddFeed(f1); err != nil {
		t.Fatalf("AddFeed f1: %v", err)
	}
	db.core.FetchedAt = 1700000000
	items := []*Item{
		{Feed: f0, Title: "a0", Content: "c0", Link: "l0", Published: 100},
		{Feed: f1, Title: "a1", Content: "c1", Link: "l1", Published: 101},
		{Feed: f0, Title: "a2", Content: "c2", Link: "l2", Published: 102},
		{Feed: f1, Title: "a3", Content: "c3", Link: "l3", Published: 103},
		{Feed: f0, Title: "a4", Content: "c4", Link: "l4", Published: 104},
	}
	if _, err := db.PutArticles(ctx, items); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	return fetch, core, []*Feed{f0, f1}
}

// TestFilterReportLiveCountsAfterExpiration pins filterReport's UI-mirroring
// equality on an expired store: the idx-walk match count (which skips
// chron < add_idx) must equal the summed live counts (total_art - expired),
// for both a feed-id token and a tag token — the same numbers the frontend
// shows as filteredTotal.
func TestFilterReportLiveCountsAfterExpiration(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10, Tag: "news"}
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
	if err := ins.filterReport(core, packs, "0", 0); err != nil {
		t.Fatalf("filterReport by feed id on an expired store: %v", err)
	}
	if err := ins.filterReport(core, packs, "news", 0); err != nil {
		t.Fatalf("filterReport by tag on an expired store: %v", err)
	}
}

// TestInspectOneHealthy pins the --chron single-entry report on a consistent
// store: the idx entry's feed_id, the resolved data feed_id, the pinned
// fetched_at, and the feed lookup line all agree, and the call returns nil.
func TestInspectOneHealthy(t *testing.T) {
	fetch, core, _ := inspReportStore(t)
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	out := captureStdout(t, func() {
		if err := ins.inspectOne(fetch, core, packs, nil, 2); err != nil { // chron 2 = feed 0
			t.Fatalf("ins.inspectOne(2): %v", err)
		}
	})
	for _, want := range []string{"entry feed_id=0", "data feed_id: 0", "fetched_at: 1700000000", "feed: News"} {
		if !strings.Contains(out, want) {
			t.Errorf("inspectOne output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "MISMATCH") || strings.Contains(out, "not in feeds") {
		t.Errorf("healthy store flagged an inconsistency:\n%s", out)
	}
}

// TestInspectOneSubIDMismatch: when the idx entry's feed_id disagrees with the
// data pack's stored feed_id, inspectOne prints SUB_ID MISMATCH and returns the
// feed_id-mismatch error (the drift that skews reader feed attribution).
func TestInspectOneSubIDMismatch(t *testing.T) {
	fetch, core, _ := inspReportStore(t)
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	packs[0].feedIDs[2] = 7 // idx now claims feed 7; data pack still says feed 0
	out := captureStdout(t, func() {
		if err := ins.inspectOne(fetch, core, packs, nil, 2); err == nil {
			t.Fatal("inspectOne returned nil on a feed_id mismatch")
		} else if !strings.Contains(err.Error(), "feed_id mismatch") {
			t.Fatalf("err = %v, want feed_id mismatch", err)
		}
	})
	if !strings.Contains(out, "SUB_ID MISMATCH") {
		t.Errorf("output missing SUB_ID MISMATCH:\n%s", out)
	}
}

// TestInspectOneOffsetOutOfRange: when the resolved (packId, offset) lands past
// the data pack's entries, inspectOne prints the OUT OF RANGE banner (the
// frontend's `reading 'f'` crash class) and returns the offset error.
func TestInspectOneOffsetOutOfRange(t *testing.T) {
	fetch, core, _ := inspReportStore(t)
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	n := packIdxFor(4, len(packs))
	pid, _ := packs[n].getPackRef(4)
	dataKey := dataKeyFor(core, pid)
	// Serve an empty data pack for chron 4's data key so any offset is OOB.
	short := func(key string) ([]byte, error) {
		if key == dataKey {
			return []byte{}, nil
		}
		return fetch(key)
	}
	out := captureStdout(t, func() {
		if err := ins.inspectOne(short, core, packs, nil, 4); err == nil {
			t.Fatal("inspectOne returned nil on an out-of-range offset")
		} else if !strings.Contains(err.Error(), "offset") {
			t.Fatalf("err = %v, want an offset-out-of-range error", err)
		}
	})
	if !strings.Contains(out, "OUT OF RANGE") {
		t.Errorf("output missing OUT OF RANGE banner:\n%s", out)
	}
}

// TestInspectOneFeedNotRegistered: an idx entry whose feed_id is not in
// db.feeds prints the "feed N not in feeds" diagnostic (the reader renders
// [DELETED]) but — with data and idx still agreeing — returns nil.
func TestInspectOneFeedNotRegistered(t *testing.T) {
	fetch, core, _ := inspReportStore(t)
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	delete(core.Feeds, 0) // feed 0 owns chron 2, but is no longer registered
	out := captureStdout(t, func() {
		if err := ins.inspectOne(fetch, core, packs, nil, 2); err != nil {
			t.Fatalf("ins.inspectOne(2): %v (idx/data still agree, want nil)", err)
		}
	})
	if !strings.Contains(out, "feed 0 not in feeds") {
		t.Errorf("output missing unregistered-feed diagnostic:\n%s", out)
	}
}

// TestFromHashReport table-drives fromHashReport's nav.fromHash replay: floor/
// pos/token parse, %-unescape, the resolve()-vs-last() decision, pos clamping,
// and the no-match-above-floor terminal. Each case asserts a distinct branch of
// the printed report.
func TestFromHashReport(t *testing.T) {
	fetch, core, _ := inspReportStore(t)
	packs, _, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	cases := []struct {
		name, hash, want string
	}{
		{"pos matches, no filter", "2", "stays at chron 2"},
		{"filter miss falls to last()", "0,4!tech", "jumps to chron 3"},
		{"unknown token disables filter", "1!nope", "resolved to 0 feeds"},
		{"pos out of range clamps", "99", "pos clamped to 4"},
		{"no match above floor", "4,4!tech", "no matching article above floor"},
		{"percent-unescape token", "2!a%20b", "tokens=[a b]"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := captureStdout(t, func() {
				if err := ins.fromHashReport(fetch, core, packs, nil, c.hash); err != nil {
					t.Fatalf("ins.fromHashReport(%q): %v", c.hash, err)
				}
			})
			if !strings.Contains(out, c.want) {
				t.Errorf("ins.fromHashReport(%q) missing %q:\n%s", c.hash, c.want, out)
			}
		})
	}
}

// TestListTagsReport pins the --list-tags live-count math: per-tag article
// totals are TotalArt−Expired, feeds with 0 articles are skipped entirely, and
// the untagged bucket is reported separately.
func TestListTagsReport(t *testing.T) {
	_, core, _ := setupTestDB(t)
	core.Feeds = map[int]*Feed{
		0: {id: 0, Tag: "news", TotalArt: 5, Expired: 2}, // 3 live
		1: {id: 1, Tag: "news", TotalArt: 3},             // 3 live → news: 2 feeds, 6
		2: {id: 2, Tag: "tech", TotalArt: 4},             // tech: 1 feed, 4
		3: {id: 3, Tag: "", TotalArt: 2},                 // untagged: 1 feed, 2
		4: {id: 4, Tag: "empty", TotalArt: 0},            // dropped (no articles)
	}
	out := captureStdout(t, func() {
		if err := ins.listTagsReport(core); err != nil {
			t.Fatalf("listTagsReport: %v", err)
		}
	})
	for _, want := range []string{
		"news", "2 feeds", "6 articles",
		"tech", "1 feeds", "4 articles",
		"(untagged)", "2 articles",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("listTagsReport output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "empty") {
		t.Errorf("a zero-article tag leaked into the report:\n%s", out)
	}
	// "tags (2)" — only news and tech have articles.
	if !strings.Contains(out, "tags (2)") {
		t.Errorf("tag count header wrong (want 2 tags):\n%s", out)
	}
}
