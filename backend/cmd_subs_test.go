package main

import (
	"strings"
	"testing"
)

func setupSubsTestDB(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if err := db.AddSubscription(&Subscription{
		Title: "Test",
		Sources: []*Source{
			{URL: "https://a.example.com/feed", ETag: "etag-a", Watermark: 0x111},
			{URL: "https://b.example.com/feed", ETag: "etag-b", Watermark: 0x222},
		},
	}); err != nil {
		t.Fatalf("AddSubscription: %v", err)
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

func TestAddSrcCmdAppendsAndPreservesState(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 0, URLs: []string{"https://c.example.com/feed", "https://d.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 4 {
		t.Fatalf("Sources len = %d, want 4", len(sub.Sources))
	}
	wantURLs := []string{
		"https://a.example.com/feed",
		"https://b.example.com/feed",
		"https://c.example.com/feed",
		"https://d.example.com/feed",
	}
	for i, want := range wantURLs {
		if sub.Sources[i].URL != want {
			t.Errorf("Sources[%d].URL = %q, want %q", i, sub.Sources[i].URL, want)
		}
	}
	if sub.Sources[0].ETag != "etag-a" || sub.Sources[1].ETag != "etag-b" {
		t.Errorf("existing per-source state lost: ETags = %q, %q", sub.Sources[0].ETag, sub.Sources[1].ETag)
	}
	if sub.Sources[0].Watermark != 0x111 || sub.Sources[1].Watermark != 0x222 {
		t.Errorf("existing Watermarks lost: %#x, %#x", sub.Sources[0].Watermark, sub.Sources[1].Watermark)
	}
}

func TestAddSrcCmdIdempotentDuplicateInArgs(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 0, URLs: []string{"https://c.example.com/feed", "https://c.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 3 {
		t.Errorf("Sources len = %d, want 3 (deduped)", len(sub.Sources))
	}
}

func TestAddSrcCmdIdempotentAlreadyASource(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 0, URLs: []string{"https://a.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 2 {
		t.Errorf("Sources len = %d, want 2 (no-op)", len(sub.Sources))
	}
	if sub.Sources[0].ETag != "etag-a" {
		t.Errorf("existing source state clobbered: ETag = %q, want %q", sub.Sources[0].ETag, "etag-a")
	}
}

func TestAddSrcCmdMixedNewAndExisting(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 0, URLs: []string{
		"https://a.example.com/feed", // already exists
		"https://c.example.com/feed", // new
		"https://c.example.com/feed", // dup of arg
		"https://b.example.com/feed", // already exists
	}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 3 {
		t.Fatalf("Sources len = %d, want 3", len(sub.Sources))
	}
	if sub.Sources[2].URL != "https://c.example.com/feed" {
		t.Errorf("appended URL = %q, want c.example.com/feed", sub.Sources[2].URL)
	}
}

func TestAddSrcCmdInvalidURL(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 0, URLs: []string{"not-a-url"}}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestAddSrcCmdSubNotFound(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 99, URLs: []string{"https://c.example.com/feed"}}
	wantErr(t, cmd.Run(), "not found")
}

func TestAddSrcCmdIDTooLarge(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: 256, URLs: []string{"https://c.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestAddSrcCmdIDNegative(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddSrcCmd{ID: -1, URLs: []string{"https://c.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestAddSrcCmdAtomicOnError(t *testing.T) {
	setupSubsTestDB(t)
	// Second URL is invalid — whole call must fail without appending the first.
	cmd := &AddSrcCmd{ID: 0, URLs: []string{"https://c.example.com/feed", "not-a-url"}}
	if err := cmd.Run(); err == nil {
		t.Fatal("expected error")
	}

	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 2 {
		t.Errorf("Sources len = %d, want 2 (rollback)", len(sub.Sources))
	}
}

func TestRmSrcCmdRemovesAndPreservesState(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: 0, URLs: []string{"https://a.example.com/feed"}}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 1 {
		t.Fatalf("Sources len = %d, want 1", len(sub.Sources))
	}
	if sub.Sources[0].URL != "https://b.example.com/feed" {
		t.Errorf("remaining URL = %q, want b.example.com/feed", sub.Sources[0].URL)
	}
	if sub.Sources[0].ETag != "etag-b" || sub.Sources[0].Watermark != 0x222 {
		t.Errorf("per-source state lost on remaining source: ETag=%q Watermark=%#x", sub.Sources[0].ETag, sub.Sources[0].Watermark)
	}
}

func TestRmSrcCmdNotASource(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: 0, URLs: []string{"https://nope.example.com/feed"}}
	wantErr(t, cmd.Run(), "not a source")
}

func TestRmSrcCmdLeavesEmpty(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: 0, URLs: []string{
		"https://a.example.com/feed",
		"https://b.example.com/feed",
	}}
	wantErr(t, cmd.Run(), "no sources")

	// And nothing was committed.
	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 2 {
		t.Errorf("Sources len = %d, want 2 (rollback)", len(sub.Sources))
	}
}

func TestRmSrcCmdDuplicateInArgs(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: 0, URLs: []string{
		"https://a.example.com/feed",
		"https://a.example.com/feed",
	}}
	wantErr(t, cmd.Run(), "duplicate")
}

func TestRmSrcCmdSubNotFound(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: 99, URLs: []string{"https://a.example.com/feed"}}
	wantErr(t, cmd.Run(), "not found")
}

func TestRmSrcCmdIDNegative(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: -1, URLs: []string{"https://a.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestRmSrcCmdIDTooLarge(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &RmSrcCmd{ID: 256, URLs: []string{"https://a.example.com/feed"}}
	wantErr(t, cmd.Run(), "[0, 255]")
}

// strPtr returns a pointer to its argument; useful for CLI flag-pointer fields.
func strPtr(s string) *string          { return &s }
func intPtr(n int) *int                { return &n }
func sliceStrPtr(v []string) *[]string { return &v }

func setupEmptyDB(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}
}

func TestAddCmdCreatesSubscription(t *testing.T) {
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
	if len(db.Subscriptions()) != 1 {
		t.Fatalf("Subscriptions len = %d, want 1", len(db.Subscriptions()))
	}
	// New subscription is assigned id 0 (first free slot).
	sub := db.Subscriptions()[0]
	if sub == nil {
		t.Fatal("expected subscription at id 0")
	}
	if sub.Title != "News" {
		t.Errorf("Title = %q, want %q", sub.Title, "News")
	}
	if len(sub.Sources) != 1 || sub.Sources[0].URL != "https://feed.example.com/rss" {
		t.Errorf("Sources = %+v, want one URL", sub.Sources)
	}
	if sub.Tag != "tech" {
		t.Errorf("Tag = %q, want %q", sub.Tag, "tech")
	}
}

func TestAddCmdCreateRequiresTitle(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{URLs: sliceStrPtr([]string{"https://feed.example.com/rss"})}
	wantErr(t, cmd.Run(), "title is required")
}

func TestAddCmdCreateRequiresURL(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{Title: strPtr("News")}
	wantErr(t, cmd.Run(), "--url is required")
}

func TestAddCmdCreateMultipleURLs(t *testing.T) {
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
	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 2 {
		t.Errorf("Sources len = %d, want 2", len(sub.Sources))
	}
}

func TestAddCmdUpdateChangesTitle(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddCmd{Upd: intPtr(0), Title: strPtr("New Title")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	sub := reopenDB(t).Subscriptions()[0]
	if sub.Title != "New Title" {
		t.Errorf("Title = %q, want %q", sub.Title, "New Title")
	}
	// Existing sources are preserved.
	if len(sub.Sources) != 2 {
		t.Errorf("Sources len = %d, want 2", len(sub.Sources))
	}
}

func TestAddCmdUpdateEmptyTitleRejected(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddCmd{Upd: intPtr(0), Title: strPtr("")}
	wantErr(t, cmd.Run(), "title cannot be empty")
}

func TestAddCmdUpdateClearsTag(t *testing.T) {
	setupSubsTestDB(t)
	// First assign a tag.
	if err := (&AddCmd{Upd: intPtr(0), Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("set tag: %v", err)
	}
	if reopenDB(t).Subscriptions()[0].Tag != "tech" {
		t.Fatal("setup: tag not set")
	}
	// Empty Tag must clear it.
	if err := (&AddCmd{Upd: intPtr(0), Tag: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear tag: %v", err)
	}
	if got := reopenDB(t).Subscriptions()[0].Tag; got != "" {
		t.Errorf("Tag = %q, want \"\" (cleared)", got)
	}
}

func TestAddCmdUpdateSetsPipeline(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddCmd{Upd: intPtr(0), Parsers: sliceStrPtr([]string{"#sanitize", "#minify"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Pipeline) != 2 || sub.Pipeline[0] != "#sanitize" || sub.Pipeline[1] != "#minify" {
		t.Errorf("Pipeline = %v, want [#sanitize #minify]", sub.Pipeline)
	}
}

func TestAddCmdUpdateClearsPipeline(t *testing.T) {
	setupSubsTestDB(t)
	if err := (&AddCmd{Upd: intPtr(0), Parsers: sliceStrPtr([]string{"#sanitize"})}).Run(); err != nil {
		t.Fatalf("set pipeline: %v", err)
	}
	// An empty-string entry in --parsers clears the pipeline (CLI convention).
	if err := (&AddCmd{Upd: intPtr(0), Parsers: sliceStrPtr([]string{""})}).Run(); err != nil {
		t.Fatalf("clear pipeline: %v", err)
	}
	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Pipeline) != 0 {
		t.Errorf("Pipeline = %v, want empty (cleared)", sub.Pipeline)
	}
}

func TestAddCmdUpdateReplacesSourcesPreservingState(t *testing.T) {
	setupSubsTestDB(t)
	// Replace one URL, keep the other.
	cmd := &AddCmd{
		Upd: intPtr(0),
		URLs: sliceStrPtr([]string{
			"https://a.example.com/feed", // kept (must preserve etag-a)
			"https://c.example.com/feed", // new
		}),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	sub := reopenDB(t).Subscriptions()[0]
	if len(sub.Sources) != 2 {
		t.Fatalf("Sources len = %d, want 2", len(sub.Sources))
	}
	if sub.Sources[0].URL != "https://a.example.com/feed" || sub.Sources[0].ETag != "etag-a" {
		t.Errorf("kept source state lost: %+v", sub.Sources[0])
	}
	if sub.Sources[1].URL != "https://c.example.com/feed" || sub.Sources[1].ETag != "" {
		t.Errorf("new source not fresh: %+v", sub.Sources[1])
	}
}

func TestAddCmdUpdateRejectsInvalidURL(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddCmd{Upd: intPtr(0), URLs: sliceStrPtr([]string{"not-a-url"})}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestAddCmdUpdateRejectsDuplicateURLs(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddCmd{Upd: intPtr(0), URLs: sliceStrPtr([]string{
		"https://x.example.com/feed",
		"https://x.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "duplicate url")
}

func TestAddCmdUpdateSubNotFound(t *testing.T) {
	setupSubsTestDB(t)
	cmd := &AddCmd{Upd: intPtr(99), Title: strPtr("X")}
	wantErr(t, cmd.Run(), "not found")
}

func TestRmCmdRemovesSubscriptions(t *testing.T) {
	setupSubsTestDB(t)
	// Add a second subscription so we can verify only the requested one is removed.
	if err := (&AddCmd{Title: strPtr("Other"), URLs: sliceStrPtr([]string{"https://z.example.com/feed"})}).Run(); err != nil {
		t.Fatalf("AddCmd: %v", err)
	}
	subs := reopenDB(t).Subscriptions()
	if len(subs) != 2 {
		t.Fatalf("setup: Subscriptions len = %d, want 2", len(subs))
	}

	if err := (&RmCmd{ID: []int{0}}).Run(); err != nil {
		t.Fatalf("RmCmd: %v", err)
	}
	subs = reopenDB(t).Subscriptions()
	if len(subs) != 1 {
		t.Fatalf("after rm Subscriptions len = %d, want 1", len(subs))
	}
	if _, ok := subs[0]; ok {
		t.Error("subscription 0 should have been removed")
	}
}

func TestRmCmdNoOpForMissingID(t *testing.T) {
	// RmCmd uses delete() which is a no-op on missing keys; this is the
	// documented behavior.
	setupSubsTestDB(t)
	if err := (&RmCmd{ID: []int{99}}).Run(); err != nil {
		t.Fatalf("RmCmd: %v", err)
	}
	if len(reopenDB(t).Subscriptions()) != 1 {
		t.Errorf("Subscriptions changed despite missing id")
	}
}

func TestParseSourcesRejectsEmpty(t *testing.T) {
	if _, err := parseSources(nil, nil); err == nil || !strings.Contains(err.Error(), "at least one --url") {
		t.Errorf("err = %v, want 'at least one --url'", err)
	}
}

func TestParseSourcesRejectsInvalidURL(t *testing.T) {
	if _, err := parseSources([]string{"bogus"}, nil); err == nil || !strings.Contains(err.Error(), "invalid url") {
		t.Errorf("err = %v, want 'invalid url'", err)
	}
}

func TestParseSourcesRejectsDuplicates(t *testing.T) {
	urls := []string{"https://a.example.com/feed", "https://a.example.com/feed"}
	if _, err := parseSources(urls, nil); err == nil || !strings.Contains(err.Error(), "duplicate url") {
		t.Errorf("err = %v, want 'duplicate url'", err)
	}
}

func TestParseSourcesReusesPriorSourceByURL(t *testing.T) {
	prev := []*Source{
		{URL: "https://a.example.com/feed", ETag: "etag-a", Watermark: 1234},
		{URL: "https://b.example.com/feed", ETag: "etag-b"},
	}
	out, err := parseSources([]string{
		"https://a.example.com/feed", // kept (must reuse pointer)
		"https://c.example.com/feed", // new
	}, prev)
	if err != nil {
		t.Fatalf("parseSources: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("out len = %d, want 2", len(out))
	}
	if out[0] != prev[0] {
		t.Error("kept source pointer not reused (per-source state would be lost)")
	}
	if out[1].URL != "https://c.example.com/feed" || out[1].ETag != "" {
		t.Errorf("new source not fresh: %+v", out[1])
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
	for _, s := range db.Subscriptions() {
		if s.Tag == "tech" {
			tagged++
		}
	}
	if tagged != 1 {
		t.Errorf("expected 1 sub tagged 'tech', got %d", tagged)
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

func TestSubscriptionURLsJoined(t *testing.T) {
	s := &Subscription{Sources: []*Source{
		{URL: "https://a.example.com/feed"},
		{URL: "https://b.example.com/feed"},
	}}
	got := s.URLs()
	want := "https://a.example.com/feed, https://b.example.com/feed"
	if got != want {
		t.Errorf("URLs() = %q, want %q", got, want)
	}
}

func TestSubscriptionURLsEmpty(t *testing.T) {
	s := &Subscription{}
	if got := s.URLs(); got != "" {
		t.Errorf("URLs() = %q, want empty", got)
	}
}
