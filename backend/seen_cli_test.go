package main

import "testing"

func intPtr(i int) *int    { return &i }
func boolPtr(b bool) *bool { return &b }

// `feed add --dedup-days N --dedup-title` persists the per-feed pool overrides.
func TestFeedAddStoresDedupOverrides(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{
		Title:      strPtr("Deals"),
		URL:        strPtr("https://d.example.com/rss"),
		DedupDays:  intPtr(7),
		DedupTitle: boolPtr(true),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.DedupDays != 7 {
		t.Errorf("DedupDays = %d, want 7", ch.DedupDays)
	}
	if !ch.DedupTitle {
		t.Error("DedupTitle = false, want true")
	}
}

// `feed upd --dedup-days -1 --dedup-title` disables the pool for a feed and
// turns on the title axis; both round-trip through db.gz.
func TestFeedUpdChangesDedup(t *testing.T) {
	setupFeedsTestDB(t)
	if err := (&UpdCmd{ID: 0, DedupDays: intPtr(-1), DedupTitle: boolPtr(true)}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.DedupDays != -1 {
		t.Errorf("DedupDays = %d, want -1 (disabled)", ch.DedupDays)
	}
	if !ch.DedupTitle {
		t.Error("DedupTitle = false, want true")
	}
}

// A per-feed dedup horizon below -1 is invalid config (-1 is the only disable
// sentinel); the offline field check rejects it before any store write.
func TestFeedUpdRejectsInvalidDedupDays(t *testing.T) {
	setupFeedsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, DedupDays: intPtr(-2)}).Run(), "dedup days")
}

// `srr dedup --days N` sets the store-wide default horizon in db.gz; a negative
// value is rejected (only a per-feed -1 disables, never the store default).
func TestDedupCmdSetsStoreDefault(t *testing.T) {
	setupEmptyDB(t)
	if err := (&DedupCmd{Days: intPtr(45)}).Run(); err != nil {
		t.Fatalf("set: %v", err)
	}
	if got := reopenDB(t).core.DedupDays; got != 45 {
		t.Errorf("store DedupDays = %d, want 45", got)
	}
	wantErr(t, (&DedupCmd{Days: intPtr(-1)}).Run(), "store default")
}
