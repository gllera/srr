package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
)

func setupFeedsTestDB(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}
	stubPassthroughResolve()

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if err := db.AddFeed(&Feed{
		Title:     "Test",
		URL:       "https://a.example.com/feed",
		ETag:      "etag-a",
		Watermark: 0x111,
	}); err != nil {
		t.Fatalf("AddFeed: %v", err)
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

// strPtr returns a pointer to its argument; useful for CLI flag-pointer fields.
func strPtr(s string) *string { return &s }

// stubPassthroughResolve makes subscribe-time discovery an offline no-op (URL
// stored verbatim), so cmd tests that aren't about resolution never hit the
// network. Installed by the setup helpers; resolution tests override it.
func stubPassthroughResolve() {
	resolveFeedURL = func(_ context.Context, rawURL string) (string, error) { return rawURL, nil }
}

// feed add stores the discovered feed URL when subscribe-time discovery
// repoints a homepage URL to its <link rel=alternate> feed.
func TestFeedAddStoresDiscoveredURL(t *testing.T) {
	setupEmptyDB(t)
	resolveFeedURL = func(_ context.Context, _ string) (string, error) {
		return "https://blog.example.com/feed.xml", nil
	}
	cmd := &AddCmd{Title: strPtr("News"), URL: strPtr("https://blog.example.com/")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.URL != "https://blog.example.com/feed.xml" {
		t.Errorf("URL = %q, want resolved feed URL", ch.URL)
	}
}

// feed add hard-fails and stores nothing when no feed can be resolved.
func TestFeedAddHardFailsWhenUnresolvable(t *testing.T) {
	setupEmptyDB(t)
	resolveFeedURL = func(_ context.Context, _ string) (string, error) {
		return "", fmt.Errorf("no feed found")
	}
	wantErr(t, (&AddCmd{Title: strPtr("News"), URL: strPtr("https://blog.example.com/")}).Run(), "no feed found")
	if n := len(reopenDB(t).Feeds()); n != 0 {
		t.Errorf("Feeds len = %d, want 0 (add rejected)", n)
	}
}

// feed add skips resolution when its recipe's ingest is external — that source
// is not an HTTP-fetchable feed, so probing it would wrongly reject the add.
func TestFeedAddSkipsResolveForExternalIngest(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "ext", "my-fetcher"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	called := false
	resolveFeedURL = func(_ context.Context, rawURL string) (string, error) {
		called = true
		return rawURL, nil
	}
	cmd := &AddCmd{Title: strPtr("X"), URL: strPtr("https://x.example/"), Recipe: strPtr("ext")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if called {
		t.Error("resolveFeedURL must not run for an external ingest strategy")
	}
}

// feed add eagerly rejects a reference to a recipe that does not exist —
// BEFORE the subscribe-time network probe (so the operator gets the clear
// "recipe does not exist" rather than a resolve error). The resolver is rigged
// to fail the test if it is ever called.
func TestFeedAddRejectsUnknownRecipe(t *testing.T) {
	setupEmptyDB(t)
	resolveFeedURL = func(_ context.Context, _ string) (string, error) {
		t.Error("resolveFeedURL must not run when the recipe ref is invalid")
		return "", fmt.Errorf("network probe should not have happened")
	}
	cmd := &AddCmd{Title: strPtr("X"), URL: strPtr("https://x.example.com/feed"), Recipe: strPtr("nope")}
	wantErr(t, cmd.Run(), `recipe "nope" does not exist`)
	if n := len(reopenDB(t).Feeds()); n != 0 {
		t.Errorf("Feeds len = %d, want 0 (add rejected)", n)
	}
}

// feed upd -u resolves the new URL and stores the discovered feed URL.
func TestFeedUpdResolvesNewURL(t *testing.T) {
	setupFeedsTestDB(t)
	resolveFeedURL = func(_ context.Context, _ string) (string, error) {
		return "https://a.example.com/discovered.xml", nil
	}
	if err := (&UpdCmd{ID: 0, URL: strPtr("https://a.example.com/homepage")}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := reopenDB(t).Feeds()[0].URL; got != "https://a.example.com/discovered.xml" {
		t.Errorf("URL = %q, want resolved feed URL", got)
	}
}

// feed upd -u hard-fails and leaves the feed untouched when the new URL is
// unresolvable.
func TestFeedUpdHardFailsWhenUnresolvable(t *testing.T) {
	setupFeedsTestDB(t)
	resolveFeedURL = func(_ context.Context, _ string) (string, error) {
		return "", fmt.Errorf("no feed found")
	}
	wantErr(t, (&UpdCmd{ID: 0, URL: strPtr("https://a.example.com/homepage")}).Run(), "no feed found")
	if got := reopenDB(t).Feeds()[0].URL; got != "https://a.example.com/feed" {
		t.Errorf("URL = %q, want unchanged after failed resolve", got)
	}
}

// feed upd -u does not resolve when the URL is unchanged (no repoint, no probe).
func TestFeedUpdSkipsResolveWhenURLUnchanged(t *testing.T) {
	setupFeedsTestDB(t)
	called := false
	resolveFeedURL = func(_ context.Context, u string) (string, error) {
		called = true
		return u, nil
	}
	if err := (&UpdCmd{ID: 0, URL: strPtr("https://a.example.com/feed")}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if called {
		t.Error("resolveFeedURL must not run when the URL is unchanged")
	}
}

func setupEmptyDB(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}
	stubPassthroughResolve()
}

func TestFeedAddCreates(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{
		Title: strPtr("News"),
		URL:   strPtr("https://feed.example.com/rss"),
		Tag:   strPtr("tech"),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	db := reopenDB(t)
	if len(db.Feeds()) != 1 {
		t.Fatalf("Feeds len = %d, want 1", len(db.Feeds()))
	}
	ch := db.Feeds()[0]
	if ch == nil {
		t.Fatal("expected feed at id 0")
	}
	if ch.Title != "News" {
		t.Errorf("Title = %q, want %q", ch.Title, "News")
	}
	if ch.URL != "https://feed.example.com/rss" {
		t.Errorf("URL = %q, want one URL", ch.URL)
	}
	if ch.Tag != "tech" {
		t.Errorf("Tag = %q, want %q", ch.Tag, "tech")
	}
}

func TestFeedAddRequiresTitle(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{URL: strPtr("https://feed.example.com/rss")}
	wantErr(t, cmd.Run(), "title is required")
}

func TestFeedAddRequiresURL(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{Title: strPtr("News")}
	wantErr(t, cmd.Run(), "--url is required")
}

func TestFeedAddRejectsInvalidURL(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{Title: strPtr("News"), URL: strPtr("not-a-url")}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestRmCmdRemovesFeeds(t *testing.T) {
	setupFeedsTestDB(t)
	// Add a second feed so we can verify only the requested one is removed.
	if err := (&AddCmd{Title: strPtr("Other"), URL: strPtr("https://z.example.com/feed")}).Run(); err != nil {
		t.Fatalf("AddCmd: %v", err)
	}
	feeds := reopenDB(t).Feeds()
	if len(feeds) != 2 {
		t.Fatalf("setup: Feeds len = %d, want 2", len(feeds))
	}

	if err := (&RmCmd{ID: []int{0}}).Run(); err != nil {
		t.Fatalf("RmCmd: %v", err)
	}
	feeds = reopenDB(t).Feeds()
	if len(feeds) != 1 {
		t.Fatalf("after rm Feeds len = %d, want 1", len(feeds))
	}
	if _, ok := feeds[0]; ok {
		t.Error("feed 0 should have been removed")
	}
}

func TestRmCmdNoOpForMissingID(t *testing.T) {
	// RmCmd uses delete() which is a no-op on missing keys; this is the
	// documented behavior.
	setupFeedsTestDB(t)
	if err := (&RmCmd{ID: []int{99}}).Run(); err != nil {
		t.Fatalf("RmCmd: %v", err)
	}
	if len(reopenDB(t).Feeds()) != 1 {
		t.Errorf("Feeds changed despite missing id")
	}
}

func TestLsCmdEmitsRecipe(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "read", "", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	mustRun := func(c interface{ Run() error }) {
		t.Helper()
		if err := c.Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	mustRun(&AddCmd{Title: strPtr("A"), URL: strPtr("https://a.example.com/feed"), Recipe: strPtr("read")})

	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&LsCmd{Format: "json"}).Run(); err != nil {
		t.Fatalf("LsCmd: %v", err)
	}
	if !strings.Contains(out.String(), `"recipe":"read"`) {
		t.Errorf("ls output missing recipe field: %s", out.String())
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
	mustRun(&AddCmd{Title: strPtr("A"), URL: strPtr("https://a.example.com/feed"), Tag: strPtr("tech")})
	mustRun(&AddCmd{Title: strPtr("B"), URL: strPtr("https://b.example.com/feed"), Tag: strPtr("news")})

	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&LsCmd{Format: "json", Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("LsCmd: %v", err)
	}
	body := out.String()
	if !strings.Contains(body, `"title":"A"`) {
		t.Errorf("expected feed A in filtered output: %s", body)
	}
	if strings.Contains(body, `"title":"B"`) {
		t.Errorf("did not expect feed B in tech-filtered output: %s", body)
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

func TestFeedUpdReplacesURLResetsState(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: 0, URL: strPtr("https://c.example.com/feed")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.URL != "https://c.example.com/feed" {
		t.Errorf("URL = %q, want the new url", ch.URL)
	}
	if ch.ETag != "" || ch.Watermark != 0 {
		t.Errorf("fetch state not reset on URL change: etag=%q wm=%#x", ch.ETag, ch.Watermark)
	}
}

func TestFeedUpdSameURLPreservesState(t *testing.T) {
	setupFeedsTestDB(t)
	// Re-setting the same URL must not clear the per-feed fetch state.
	cmd := &UpdCmd{ID: 0, URL: strPtr("https://a.example.com/feed")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.ETag != "etag-a" || ch.Watermark != 0x111 {
		t.Errorf("state lost on unchanged URL: etag=%q wm=%#x", ch.ETag, ch.Watermark)
	}
}

func TestFeedUpdRejectsInvalidURL(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: 0, URL: strPtr("not-a-url")}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestFeedUpdRequiresFieldFlag(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: 0}
	wantErr(t, cmd.Run(), "nothing to update")
}

func TestFeedUpdFeedNotFound(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: 99, Title: strPtr("X")}
	wantErr(t, cmd.Run(), "not found")
}

func TestFeedUpdChangesTitle(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: 0, Title: strPtr("New Title")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.Title != "New Title" {
		t.Errorf("Title = %q, want %q", ch.Title, "New Title")
	}
	if ch.URL != "https://a.example.com/feed" {
		t.Errorf("URL = %q, want unchanged", ch.URL)
	}
}

func TestFeedUpdEmptyTitleRejected(t *testing.T) {
	setupFeedsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, Title: strPtr("")}).Run(), "title cannot be empty")
	if got := reopenDB(t).Feeds()[0].Title; got != "Test" {
		t.Errorf("Title = %q, want %q (should not have committed)", got, "Test")
	}
}

func TestFeedUpdClearsTag(t *testing.T) {
	setupFeedsTestDB(t)
	if err := (&UpdCmd{ID: 0, Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("set tag: %v", err)
	}
	if reopenDB(t).Feeds()[0].Tag != "tech" {
		t.Fatal("setup: tag not set")
	}
	if err := (&UpdCmd{ID: 0, Tag: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear tag: %v", err)
	}
	if got := reopenDB(t).Feeds()[0].Tag; got != "" {
		t.Errorf("Tag = %q, want \"\"", got)
	}
}

func TestFeedUpdSetsRecipe(t *testing.T) {
	setupFeedsTestDB(t)
	if err := recipeSet(t, "read", "", "#readability", "#default"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	cmd := &UpdCmd{ID: 0, Recipe: strPtr("read")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := reopenDB(t).Feeds()[0].Recipe; got != "read" {
		t.Errorf("Recipe = %q, want %q", got, "read")
	}
}

func TestFeedUpdClearsRecipe(t *testing.T) {
	setupFeedsTestDB(t)
	if err := recipeSet(t, "read", "", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	if err := (&UpdCmd{ID: 0, Recipe: strPtr("read")}).Run(); err != nil {
		t.Fatalf("set recipe: %v", err)
	}
	if err := (&UpdCmd{ID: 0, Recipe: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear recipe: %v", err)
	}
	if got := reopenDB(t).Feeds()[0].Recipe; got != "" {
		t.Errorf("Recipe = %q, want \"\" (⇒ default)", got)
	}
}

func TestFeedUpdRejectsUnknownRecipe(t *testing.T) {
	setupFeedsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, Recipe: strPtr("nope")}).Run(), `recipe "nope" does not exist`)
	if got := reopenDB(t).Feeds()[0].Recipe; got != "" {
		t.Errorf("Recipe = %q, want unchanged (commit rejected)", got)
	}
}

func TestFeedUpdNoURLFlagLeavesURLUntouched(t *testing.T) {
	setupFeedsTestDB(t)
	if err := (&UpdCmd{ID: 0, Title: strPtr("X")}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.URL != "https://a.example.com/feed" {
		t.Errorf("URL changed: %q", ch.URL)
	}
	if ch.ETag != "etag-a" || ch.Watermark != 0x111 {
		t.Errorf("state changed: etag=%q wm=%#x", ch.ETag, ch.Watermark)
	}
}

func TestFeedUpdIDTooLarge(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: 65536, Title: strPtr("X")}
	wantErr(t, cmd.Run(), "[0, 65535]")
}

func TestFeedUpdIDNegative(t *testing.T) {
	setupFeedsTestDB(t)
	cmd := &UpdCmd{ID: -1, Title: strPtr("X")}
	wantErr(t, cmd.Run(), "[0, 65535]")
}

func TestFeedShowFound(t *testing.T) {
	setupFeedsTestDB(t)
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&ShowCmd{ID: 0, Format: "json"}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	body := out.String()
	if !strings.Contains(body, `"id":0`) {
		t.Errorf("missing id: %s", body)
	}
	if !strings.Contains(body, `"title":"Test"`) {
		t.Errorf("missing title: %s", body)
	}
	if !strings.Contains(body, `"url":"https://a.example.com/feed"`) {
		t.Errorf("missing feed url: %s", body)
	}
}

func TestFeedShowMissing(t *testing.T) {
	setupFeedsTestDB(t)
	wantErr(t, (&ShowCmd{ID: 99, Format: "json"}).Run(), "not found")
}

func TestFeedShowYAML(t *testing.T) {
	setupFeedsTestDB(t)
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&ShowCmd{ID: 0, Format: "yaml"}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	body := out.String()
	if !strings.Contains(body, "title: Test") {
		t.Errorf("missing yaml title: %s", body)
	}
}

func TestFeedShowIDTooLarge(t *testing.T) {
	setupFeedsTestDB(t)
	wantErr(t, (&ShowCmd{ID: 65536, Format: "json"}).Run(), "[0, 65535]")
}

func TestFeedShowIDNegative(t *testing.T) {
	setupFeedsTestDB(t)
	wantErr(t, (&ShowCmd{ID: -1, Format: "json"}).Run(), "[0, 65535]")
}

func TestFeedShowEmitsRecipe(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "read", "", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	if err := (&AddCmd{
		Title:  strPtr("P"),
		URL:    strPtr("https://p.example.com/feed"),
		Recipe: strPtr("read"),
	}).Run(); err != nil {
		t.Fatalf("setup: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]

	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&ShowCmd{ID: ch.id, Format: "json"}).Run(); err != nil {
		t.Fatalf("ShowCmd: %v", err)
	}
	if !strings.Contains(out.String(), `"recipe":"read"`) {
		t.Errorf("show output missing recipe field: %s", out.String())
	}
}

// applyFromString runs ApplyCmd against an in-memory JSON payload.
func applyFromString(t *testing.T, json string) error {
	t.Helper()
	cmd := &ApplyCmd{}
	cmd.in = strings.NewReader(json)
	return cmd.Run()
}

func TestFeedApplySingleCreate(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `{"title":"NewCh","url":"https://x.example.com/feed","tag":"t"}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	db := reopenDB(t)
	if len(db.Feeds()) != 1 {
		t.Fatalf("Feeds len = %d, want 1", len(db.Feeds()))
	}
	ch := db.Feeds()[0]
	if ch.Title != "NewCh" || ch.Tag != "t" {
		t.Errorf("unexpected feed: %+v", ch)
	}
	if ch.URL != "https://x.example.com/feed" {
		t.Errorf("URL = %q, want the applied url", ch.URL)
	}
}

func TestFeedApplySingleUpdate(t *testing.T) {
	setupFeedsTestDB(t)
	err := applyFromString(t, `{"id":0,"title":"Renamed","url":"https://a.example.com/feed"}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.Title != "Renamed" {
		t.Errorf("Title = %q, want Renamed", ch.Title)
	}
}

func TestFeedApplyPreservesStateOnUnchangedURL(t *testing.T) {
	setupFeedsTestDB(t)
	err := applyFromString(t, `{"id":0,"title":"Test","url":"https://a.example.com/feed"}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.ETag != "etag-a" || ch.Watermark != 0x111 {
		t.Errorf("kept feed state lost on unchanged URL: etag=%q wm=%#x", ch.ETag, ch.Watermark)
	}
}

func TestFeedApplyResetsStateOnChangedURL(t *testing.T) {
	setupFeedsTestDB(t)
	err := applyFromString(t, `{"id":0,"title":"Test","url":"https://c.example.com/feed"}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.URL != "https://c.example.com/feed" {
		t.Errorf("URL = %q, want the new url", ch.URL)
	}
	if ch.ETag != "" || ch.Watermark != 0 {
		t.Errorf("state not reset on URL change: etag=%q wm=%#x", ch.ETag, ch.Watermark)
	}
}

func TestFeedApplyArray(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `[
		{"title":"A","url":"https://a.example.com/feed"},
		{"title":"B","url":"https://b.example.com/feed"}
	]`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := len(reopenDB(t).Feeds()); got != 2 {
		t.Errorf("Feeds len = %d, want 2", got)
	}
}

func TestFeedApplyAtomicRollback(t *testing.T) {
	setupEmptyDB(t)
	// Second item missing title -> whole input must reject without writes.
	err := applyFromString(t, `[
		{"title":"A","url":"https://a.example.com/feed"},
		{"url":"https://b.example.com/feed"}
	]`)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := len(reopenDB(t).Feeds()); got != 0 {
		t.Errorf("Feeds len = %d, want 0 (rollback)", got)
	}
}

func TestFeedApplyAtomicRollbackOnBadURL(t *testing.T) {
	setupEmptyDB(t)
	// Second item has an invalid URL — rejected during apply, after entry A
	// has been added in-memory. Disk should still rollback.
	err := applyFromString(t, `[
		{"title":"A","url":"https://a.example.com/feed"},
		{"title":"B","url":"not-a-url"}
	]`)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := len(reopenDB(t).Feeds()); got != 0 {
		t.Errorf("Feeds len = %d, want 0 (disk rollback)", got)
	}
}

func TestFeedApplyNullArrayEntry(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `[{"title":"A","url":"https://a.example.com/feed"}, null]`)
	wantErr(t, err, "null entry")
	if got := len(reopenDB(t).Feeds()); got != 0 {
		t.Errorf("Feeds len = %d, want 0", got)
	}
}

func TestFeedApplyIdMissingErrors(t *testing.T) {
	setupFeedsTestDB(t)
	err := applyFromString(t, `{"id":99,"title":"x","url":"https://x.example.com/feed"}`)
	wantErr(t, err, "not found")
}

func TestFeedApplyInvalidJSON(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `{not json`)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestFeedApplyCreateMissingURL(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `{"title":"X"}`)
	wantErr(t, err, "url required")
}

func TestFeedApplyIgnoresReadOnlyFields(t *testing.T) {
	setupFeedsTestDB(t)
	// Input includes "etag"; stored ETag must NOT be overwritten (it's a
	// read-only-from-input field — only the feedView's url/title/tag/recipe
	// are applied).
	err := applyFromString(t, `{"id":0,"title":"Test","url":"https://a.example.com/feed","etag":"bogus-from-input"}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.ETag != "etag-a" {
		t.Errorf("apply leaked input etag into stored state: %q", ch.ETag)
	}
}

// writeEditorScript writes a /bin/sh script to a tempfile, chmods it +x, and
// returns its path. The script body receives the JSON tempfile as $1.
// Tests then point $EDITOR (or $VISUAL) at this path.
func writeEditorScript(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/editor.sh"
	content := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write editor script: %v", err)
	}
	return path
}

func TestFeedEditApplies(t *testing.T) {
	setupFeedsTestDB(t)
	// Editor: rewrite title to "Renamed", keep url and id intact.
	script := writeEditorScript(t, `cat > "$1" <<'EOF'
{"id":0,"title":"Renamed","url":"https://a.example.com/feed"}
EOF`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	if err := (&EditCmd{ID: 0}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Feeds()[0]
	if ch.Title != "Renamed" {
		t.Errorf("Title = %q, want Renamed", ch.Title)
	}
	if ch.ETag != "etag-a" {
		t.Errorf("feed state lost: %q", ch.ETag)
	}
}

func TestFeedEditNoChangeNoOp(t *testing.T) {
	setupFeedsTestDB(t)
	// Editor: do nothing — leave the file exactly as written.
	script := writeEditorScript(t, `: # no-op`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	before := reopenDB(t).Feeds()[0].Title

	if err := (&EditCmd{ID: 0}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := reopenDB(t).Feeds()[0].Title; got != before {
		t.Errorf("title changed unexpectedly: %q -> %q", before, got)
	}
}

func TestFeedEditIdChangedErrors(t *testing.T) {
	setupFeedsTestDB(t)
	script := writeEditorScript(t, `cat > "$1" <<'EOF'
{"id":7,"title":"Hijack","url":"https://a.example.com/feed"}
EOF`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	wantErr(t, err, "id from 0 to 7")
	if reopenDB(t).Feeds()[0].Title == "Hijack" {
		t.Errorf("hijacked title was applied")
	}
}

func TestFeedEditInvalidJsonErrors(t *testing.T) {
	setupFeedsTestDB(t)
	script := writeEditorScript(t, `printf 'not json' > "$1"`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "JSON") && !strings.Contains(err.Error(), "json") {
		t.Errorf("error should mention JSON: %v", err)
	}
}

func TestFeedEditEditorNonZeroExit(t *testing.T) {
	setupFeedsTestDB(t)
	script := writeEditorScript(t, `exit 42`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	wantErr(t, err, "editor exited")
	if reopenDB(t).Feeds()[0].Title != "Test" {
		t.Errorf("Title unexpectedly changed despite editor failure")
	}
}

func TestFeedEditFeedNotFound(t *testing.T) {
	setupFeedsTestDB(t)
	t.Setenv("EDITOR", writeEditorScript(t, `:`))
	t.Setenv("VISUAL", "")
	wantErr(t, (&EditCmd{ID: 99}).Run(), "not found")
}

// TestValidateTag verifies that validateTag only accepts tags that survive
// normalizeGroupName unchanged on every /-segment — ensuring export→import -a
// is identity (B2).
func TestValidateTag(t *testing.T) {
	// Tags that should be REJECTED (import would mutate or error on them).
	bad := []string{
		"Tech-News", // dash → underscore by normalizeGroupName
		"My Blog",   // space → underscore
		"UPPER",     // uppercase lowercased
		"tech/2024", // second segment is numeric-only
		"tech/",     // trailing slash → empty segment
		"/tech",     // leading slash → empty segment
		"café/news", // non-ASCII letter dropped → segment mutated
	}
	for _, tag := range bad {
		if err := validateTag(tag); err == nil {
			t.Errorf("validateTag(%q) = nil, want error", tag)
		}
	}

	// Tags that should be ACCEPTED (already normalized; no mutation by import).
	good := []string{
		"",              // empty = no tag, always ok
		"tech",          // single lower-only segment
		"news",          // single lower-only segment
		"tech_news",     // underscores fine
		"tech/news",     // two valid segments
		"tech/go_blogs", // nested valid segments
	}
	for _, tag := range good {
		if err := validateTag(tag); err != nil {
			t.Errorf("validateTag(%q) = %v, want nil", tag, err)
		}
	}
}

func TestFeedEditApplyFailsPreservesTempfile(t *testing.T) {
	setupFeedsTestDB(t)
	// Editor writes valid JSON with an invalid URL — passes JSON parse
	// and id check, fails inside applyViews validation during apply.
	script := writeEditorScript(t, `cat > "$1" <<'EOF'
{"id":0,"title":"Test","url":"not-a-url"}
EOF`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "tempfile:") {
		t.Errorf("error should embed tempfile path: %v", err)
	}
	if !strings.Contains(err.Error(), "invalid url") {
		t.Errorf("error should mention invalid url: %v", err)
	}
	// And no DB write.
	if reopenDB(t).Feeds()[0].Title != "Test" {
		t.Errorf("Title unexpectedly changed despite apply failure")
	}
}
