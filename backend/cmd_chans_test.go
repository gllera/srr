package main

import (
	"strings"
	"testing"
)

func setupChannelsTestDB(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if err := db.AddChannel(&Channel{
		Title: "Test",
		Feeds: []*Feed{
			{URL: "https://a.example.com/feed", ETag: "etag-a", Watermark: 0x111},
			{URL: "https://b.example.com/feed", ETag: "etag-b", Watermark: 0x222},
		},
	}); err != nil {
		t.Fatalf("AddChannel: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	db.Close(ctx)
}

func reopenDB(t *testing.T) *DB {
	t.Helper()
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen NewDB: %v", err)
	}
	t.Cleanup(func() { db.Close(ctx) })
	return db
}

func wantErr(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), substr) {
		t.Fatalf("error = %v, want substring %q", err, substr)
	}
}

func TestAddFeedCmdAppendsAndPreservesState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 0, URLs: []string{"https://c.example.com/feed", "https://d.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 4 {
		t.Fatalf("Feeds len = %d, want 4", len(ch.Feeds))
	}
	wantURLs := []string{
		"https://a.example.com/feed",
		"https://b.example.com/feed",
		"https://c.example.com/feed",
		"https://d.example.com/feed",
	}
	for i, want := range wantURLs {
		if ch.Feeds[i].URL != want {
			t.Errorf("Feeds[%d].URL = %q, want %q", i, ch.Feeds[i].URL, want)
		}
	}
	if ch.Feeds[0].ETag != "etag-a" || ch.Feeds[1].ETag != "etag-b" {
		t.Errorf("existing per-feed state lost: ETags = %q, %q", ch.Feeds[0].ETag, ch.Feeds[1].ETag)
	}
	if ch.Feeds[0].Watermark != 0x111 || ch.Feeds[1].Watermark != 0x222 {
		t.Errorf("existing Watermarks lost: %#x, %#x", ch.Feeds[0].Watermark, ch.Feeds[1].Watermark)
	}
}

func TestAddFeedCmdIdempotentDuplicateInArgs(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 0, URLs: []string{"https://c.example.com/feed", "https://c.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 3 {
		t.Errorf("Feeds len = %d, want 3 (deduped)", len(ch.Feeds))
	}
}

func TestAddFeedCmdIdempotentAlreadyAFeed(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 0, URLs: []string{"https://a.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (no-op)", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("existing feed state clobbered: ETag = %q, want %q", ch.Feeds[0].ETag, "etag-a")
	}
}

func TestAddFeedCmdMixedNewAndExisting(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 0, URLs: []string{
		"https://a.example.com/feed", // already exists
		"https://c.example.com/feed", // new
		"https://c.example.com/feed", // dup of arg
		"https://b.example.com/feed", // already exists
	}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 3 {
		t.Fatalf("Feeds len = %d, want 3", len(ch.Feeds))
	}
	if ch.Feeds[2].URL != "https://c.example.com/feed" {
		t.Errorf("appended URL = %q, want c.example.com/feed", ch.Feeds[2].URL)
	}
}

func TestAddFeedCmdInvalidURL(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 0, URLs: []string{"not-a-url"}}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestAddFeedCmdChannelNotFound(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 99, URLs: []string{"https://c.example.com/feed"}}
	wantErr(t, cmd.Run(), "not found")
}

func TestAddFeedCmdIDTooLarge(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: 256, URLs: []string{"https://c.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestAddFeedCmdIDNegative(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &AddFeedCmd{ID: -1, URLs: []string{"https://c.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestAddFeedCmdAtomicOnError(t *testing.T) {
	setupChannelsTestDB(t)
	// Second URL is invalid — whole call must fail without appending the first.
	cmd := &AddFeedCmd{ID: 0, URLs: []string{"https://c.example.com/feed", "not-a-url"}}
	if err := cmd.Run(); err == nil {
		t.Fatal("expected error")
	}

	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (rollback)", len(ch.Feeds))
	}
}

func TestRmFeedCmdRemovesAndPreservesState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: 0, URLs: []string{"https://a.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 1 {
		t.Fatalf("Feeds len = %d, want 1", len(ch.Feeds))
	}
	if ch.Feeds[0].URL != "https://b.example.com/feed" {
		t.Errorf("remaining URL = %q, want b.example.com/feed", ch.Feeds[0].URL)
	}
	if ch.Feeds[0].ETag != "etag-b" || ch.Feeds[0].Watermark != 0x222 {
		t.Errorf("per-feed state lost on remaining feed: ETag=%q Watermark=%#x", ch.Feeds[0].ETag, ch.Feeds[0].Watermark)
	}
}

func TestRmFeedCmdNotAFeed(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: 0, URLs: []string{"https://nope.example.com/feed"}}
	wantErr(t, cmd.Run(), "not a feed")
}

func TestRmFeedCmdLeavesEmpty(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: 0, URLs: []string{
		"https://a.example.com/feed",
		"https://b.example.com/feed",
	}}
	wantErr(t, cmd.Run(), "no feeds")

	// And nothing was committed.
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (rollback)", len(ch.Feeds))
	}
}

func TestRmFeedCmdDuplicateInArgs(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: 0, URLs: []string{
		"https://a.example.com/feed",
		"https://a.example.com/feed",
	}}
	wantErr(t, cmd.Run(), "duplicate")
}

func TestRmFeedCmdChannelNotFound(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: 99, URLs: []string{"https://a.example.com/feed"}}
	wantErr(t, cmd.Run(), "not found")
}

func TestRmFeedCmdIDNegative(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: -1, URLs: []string{"https://a.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestRmFeedCmdIDTooLarge(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &RmFeedCmd{ID: 256, URLs: []string{"https://a.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

// strPtr returns a pointer to its argument; useful for CLI flag-pointer fields.
func strPtr(s string) *string          { return &s }
func sliceStrPtr(v []string) *[]string { return &v }

func setupEmptyDB(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}
}

func TestChanAddCreates(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{
		Title: strPtr("News"),
		URLs:  sliceStrPtr([]string{"https://feed.example.com/rss"}),
		Tag:   strPtr("tech"),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	db := reopenDB(t)
	if len(db.Channels()) != 1 {
		t.Fatalf("Channels len = %d, want 1", len(db.Channels()))
	}
	ch := db.Channels()[0]
	if ch == nil {
		t.Fatal("expected channel at id 0")
	}
	if ch.Title != "News" {
		t.Errorf("Title = %q, want %q", ch.Title, "News")
	}
	if len(ch.Feeds) != 1 || ch.Feeds[0].URL != "https://feed.example.com/rss" {
		t.Errorf("Feeds = %+v, want one URL", ch.Feeds)
	}
	if ch.Tag != "tech" {
		t.Errorf("Tag = %q, want %q", ch.Tag, "tech")
	}
}

func TestChanAddRequiresTitle(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{URLs: sliceStrPtr([]string{"https://feed.example.com/rss"})}
	wantErr(t, cmd.Run(), "title is required")
}

func TestChanAddRequiresURL(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{Title: strPtr("News")}
	wantErr(t, cmd.Run(), "--url is required")
}

func TestChanAddMultipleURLs(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{
		Title: strPtr("News"),
		URLs: sliceStrPtr([]string{
			"https://a.example.com/feed",
			"https://b.example.com/feed",
		}),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2", len(ch.Feeds))
	}
}

func TestRmCmdRemovesChannels(t *testing.T) {
	setupChannelsTestDB(t)
	// Add a second channel so we can verify only the requested one is removed.
	if err := (&AddCmd{Title: strPtr("Other"), URLs: sliceStrPtr([]string{"https://z.example.com/feed"})}).Run(); err != nil {
		t.Fatalf("AddCmd: %v", err)
	}
	channels := reopenDB(t).Channels()
	if len(channels) != 2 {
		t.Fatalf("setup: Channels len = %d, want 2", len(channels))
	}

	if err := (&RmCmd{ID: []int{0}}).Run(); err != nil {
		t.Fatalf("RmCmd: %v", err)
	}
	channels = reopenDB(t).Channels()
	if len(channels) != 1 {
		t.Fatalf("after rm Channels len = %d, want 1", len(channels))
	}
	if _, ok := channels[0]; ok {
		t.Error("channel 0 should have been removed")
	}
}

func TestRmCmdNoOpForMissingID(t *testing.T) {
	// RmCmd uses delete() which is a no-op on missing keys; this is the
	// documented behavior.
	setupChannelsTestDB(t)
	if err := (&RmCmd{ID: []int{99}}).Run(); err != nil {
		t.Fatalf("RmCmd: %v", err)
	}
	if len(reopenDB(t).Channels()) != 1 {
		t.Errorf("Channels changed despite missing id")
	}
}

func TestParseFeedsRejectsEmpty(t *testing.T) {
	if _, err := parseFeeds(nil, nil); err == nil || !strings.Contains(err.Error(), "at least one --url") {
		t.Errorf("err = %v, want 'at least one --url'", err)
	}
}

func TestParseFeedsRejectsInvalidURL(t *testing.T) {
	if _, err := parseFeeds([]string{"bogus"}, nil); err == nil || !strings.Contains(err.Error(), "invalid url") {
		t.Errorf("err = %v, want 'invalid url'", err)
	}
}

func TestParseFeedsRejectsDuplicates(t *testing.T) {
	urls := []string{"https://a.example.com/feed", "https://a.example.com/feed"}
	if _, err := parseFeeds(urls, nil); err == nil || !strings.Contains(err.Error(), "duplicate url") {
		t.Errorf("err = %v, want 'duplicate url'", err)
	}
}

func TestParseFeedsReusesPriorFeedByURL(t *testing.T) {
	prev := []*Feed{
		{URL: "https://a.example.com/feed", ETag: "etag-a", Watermark: 1234},
		{URL: "https://b.example.com/feed", ETag: "etag-b"},
	}
	out, err := parseFeeds([]string{
		"https://a.example.com/feed", // kept (must reuse pointer)
		"https://c.example.com/feed", // new
	}, prev)
	if err != nil {
		t.Fatalf("parseFeeds: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("out len = %d, want 2", len(out))
	}
	if out[0] != prev[0] {
		t.Error("kept feed pointer not reused (per-feed state would be lost)")
	}
	if out[1].URL != "https://c.example.com/feed" || out[1].ETag != "" {
		t.Errorf("new feed not fresh: %+v", out[1])
	}
}

func TestLsCmdFiltersByTag(t *testing.T) {
	setupEmptyDB(t)
	mustRun := func(c interface{ Run() error }) {
		t.Helper()
		if err := c.Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	mustRun(&AddCmd{Title: strPtr("A"), URLs: sliceStrPtr([]string{"https://a.example.com/feed"}), Tag: strPtr("tech")})
	mustRun(&AddCmd{Title: strPtr("B"), URLs: sliceStrPtr([]string{"https://b.example.com/feed"}), Tag: strPtr("news")})
	mustRun(&AddCmd{Title: strPtr("C"), URLs: sliceStrPtr([]string{"https://c.example.com/feed"})})

	// LsCmd writes via printFormatted -> fmt.Print; we only verify it doesn't error.
	// Behavior of the tag filter is verified via the underlying db reads instead.
	if err := (&LsCmd{Format: "json"}).Run(); err != nil {
		t.Fatalf("LsCmd no filter: %v", err)
	}
	if err := (&LsCmd{Format: "yaml", Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("LsCmd tag filter: %v", err)
	}

	// Independent check: ensure the data the filter would see is what we expect.
	db := reopenDB(t)
	tagged := 0
	for _, ch := range db.Channels() {
		if ch.Tag == "tech" {
			tagged++
		}
	}
	if tagged != 1 {
		t.Errorf("expected 1 channel tagged 'tech', got %d", tagged)
	}
}

func TestValidFeedURL(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{"https://example.com/feed", true},
		{"http://example.com", true},
		{"ftp://example.com/feed", true}, // any scheme + host is structurally valid
		{"not-a-url", false},
		{"", false},
		{"http://", false},   // missing host
		{"/relative", false}, // missing scheme + host
	}
	for _, c := range cases {
		if got := validFeedURL(c.raw); got != c.want {
			t.Errorf("validFeedURL(%q) = %v, want %v", c.raw, got, c.want)
		}
	}
}

func TestChannelURLsJoined(t *testing.T) {
	ch := &Channel{Feeds: []*Feed{
		{URL: "https://a.example.com/feed"},
		{URL: "https://b.example.com/feed"},
	}}
	got := ch.URLs()
	want := "https://a.example.com/feed, https://b.example.com/feed"
	if got != want {
		t.Errorf("URLs() = %q, want %q", got, want)
	}
}

func TestChannelURLsEmpty(t *testing.T) {
	ch := &Channel{}
	if got := ch.URLs(); got != "" {
		t.Errorf("URLs() = %q, want empty", got)
	}
}

func TestChanUpdReplaceFeedsPreservingState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{
		ID: 0,
		URLs: sliceStrPtr([]string{
			"https://a.example.com/feed", // kept (must preserve etag-a)
			"https://c.example.com/feed", // new
		}),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Fatalf("Feeds len = %d, want 2", len(ch.Feeds))
	}
	if ch.Feeds[0].URL != "https://a.example.com/feed" || ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("kept feed state lost: %+v", ch.Feeds[0])
	}
	if ch.Feeds[0].Watermark != 0x111 {
		t.Errorf("kept feed Watermark lost: %#x, want %#x", ch.Feeds[0].Watermark, 0x111)
	}
	if ch.Feeds[1].URL != "https://c.example.com/feed" || ch.Feeds[1].ETag != "" {
		t.Errorf("new feed not fresh: %+v", ch.Feeds[1])
	}
}

func TestChanUpdReplaceRejectsInvalidURL(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, URLs: sliceStrPtr([]string{"not-a-url"})}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestChanUpdReplaceRejectsDuplicateURLs(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, URLs: sliceStrPtr([]string{
		"https://x.example.com/feed",
		"https://x.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "duplicate url")
}

func TestChanUpdAddURLAppendsAndPreservesState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{
		"https://c.example.com/feed",
		"https://d.example.com/feed",
	})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 4 {
		t.Fatalf("Feeds len = %d, want 4", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" || ch.Feeds[1].ETag != "etag-b" {
		t.Errorf("existing state lost: %q, %q", ch.Feeds[0].ETag, ch.Feeds[1].ETag)
	}
	if ch.Feeds[0].Watermark != 0x111 || ch.Feeds[1].Watermark != 0x222 {
		t.Errorf("existing Watermarks lost: %#x, %#x", ch.Feeds[0].Watermark, ch.Feeds[1].Watermark)
	}
}

func TestChanUpdAddURLIdempotent(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{"https://a.example.com/feed"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (no-op)", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("state clobbered: %q", ch.Feeds[0].ETag)
	}
}

func TestChanUpdAddURLInvalid(t *testing.T) {
	setupChannelsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{"not-a-url"})}).Run(), "invalid url")
}

func TestChanUpdRmURLRemovesAndPreservesState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{"https://a.example.com/feed"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 1 {
		t.Fatalf("Feeds len = %d, want 1", len(ch.Feeds))
	}
	if ch.Feeds[0].URL != "https://b.example.com/feed" || ch.Feeds[0].ETag != "etag-b" || ch.Feeds[0].Watermark != 0x222 {
		t.Errorf("state lost on survivor: %+v", ch.Feeds[0])
	}
}

func TestChanUpdRmURLNotAFeed(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{"https://nope.example.com/feed"})}
	wantErr(t, cmd.Run(), "not a feed")
}

func TestChanUpdRmURLEmptyingFeedListRejected(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{
		"https://a.example.com/feed",
		"https://b.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "no feeds")
	if len(reopenDB(t).Channels()[0].Feeds) != 2 {
		t.Errorf("Feeds changed despite error")
	}
}

func TestChanUpdRmURLDuplicateArgs(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{
		"https://a.example.com/feed",
		"https://a.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "duplicate")
}

func TestChanUpdMutexUrlFlags(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{
		ID:      0,
		URLs:    sliceStrPtr([]string{"https://x.example.com/feed"}),
		AddURLs: sliceStrPtr([]string{"https://y.example.com/feed"}),
	}
	wantErr(t, cmd.Run(), "--url cannot be combined")

	cmd2 := &UpdCmd{
		ID:      0,
		AddURLs: sliceStrPtr([]string{"https://y.example.com/feed"}),
		RmURLs:  sliceStrPtr([]string{"https://a.example.com/feed"}),
	}
	wantErr(t, cmd2.Run(), "--url cannot be combined")

	cmd3 := &UpdCmd{
		ID:     0,
		URLs:   sliceStrPtr([]string{"https://x.example.com/feed"}),
		RmURLs: sliceStrPtr([]string{"https://a.example.com/feed"}),
	}
	wantErr(t, cmd3.Run(), "--url cannot be combined")
}

func TestChanUpdRequiresFieldFlag(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0}
	wantErr(t, cmd.Run(), "nothing to update")
}

func TestChanUpdChannelNotFound(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 99, Title: strPtr("X")}
	wantErr(t, cmd.Run(), "not found")
}

func TestChanUpdChangesTitle(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, Title: strPtr("New Title")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if ch.Title != "New Title" {
		t.Errorf("Title = %q, want %q", ch.Title, "New Title")
	}
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (untouched)", len(ch.Feeds))
	}
}

func TestChanUpdEmptyTitleRejected(t *testing.T) {
	setupChannelsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, Title: strPtr("")}).Run(), "title cannot be empty")
	if got := reopenDB(t).Channels()[0].Title; got != "Test" {
		t.Errorf("Title = %q, want %q (should not have committed)", got, "Test")
	}
}

func TestChanUpdClearsTag(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("set tag: %v", err)
	}
	if reopenDB(t).Channels()[0].Tag != "tech" {
		t.Fatal("setup: tag not set")
	}
	if err := (&UpdCmd{ID: 0, Tag: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear tag: %v", err)
	}
	if got := reopenDB(t).Channels()[0].Tag; got != "" {
		t.Errorf("Tag = %q, want \"\"", got)
	}
}

func TestChanUpdSetsPipeline(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, Parsers: sliceStrPtr([]string{"#sanitize", "#minify"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Pipeline) != 2 || ch.Pipeline[0] != "#sanitize" || ch.Pipeline[1] != "#minify" {
		t.Errorf("Pipeline = %v, want [#sanitize #minify]", ch.Pipeline)
	}
}

func TestChanUpdClearsPipeline(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Parsers: sliceStrPtr([]string{"#sanitize"})}).Run(); err != nil {
		t.Fatalf("set pipeline: %v", err)
	}
	if err := (&UpdCmd{ID: 0, Parsers: sliceStrPtr([]string{""})}).Run(); err != nil {
		t.Fatalf("clear pipeline: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Pipeline) != 0 {
		t.Errorf("Pipeline = %v, want empty", ch.Pipeline)
	}
}

func TestChanUpdSetsIngest(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, Ingest: strPtr("#telegram")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := reopenDB(t).Channels()[0].Ingest; got != "#telegram" {
		t.Errorf("Ingest = %q, want %q", got, "#telegram")
	}
}

func TestChanUpdClearsIngest(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Ingest: strPtr("#telegram")}).Run(); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := (&UpdCmd{ID: 0, Ingest: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got := reopenDB(t).Channels()[0].Ingest; got != "" {
		t.Errorf("Ingest = %q, want \"\"", got)
	}
}

func TestChanUpdNoFeedFlagsLeavesFeedsUntouched(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Title: strPtr("X")}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Fatalf("Feeds len = %d, want 2 (untouched)", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" || ch.Feeds[1].ETag != "etag-b" {
		t.Errorf("ETags changed: %q, %q", ch.Feeds[0].ETag, ch.Feeds[1].ETag)
	}
	if ch.Feeds[0].Watermark != 0x111 || ch.Feeds[1].Watermark != 0x222 {
		t.Errorf("Watermarks changed: %#x, %#x", ch.Feeds[0].Watermark, ch.Feeds[1].Watermark)
	}
}
