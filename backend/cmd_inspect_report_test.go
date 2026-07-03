package main

import (
	"testing"
)

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
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if err := filterReport(core, packs, "0", 0); err != nil {
		t.Fatalf("filterReport by feed id on an expired store: %v", err)
	}
	if err := filterReport(core, packs, "news", 0); err != nil {
		t.Fatalf("filterReport by tag on an expired store: %v", err)
	}
}
