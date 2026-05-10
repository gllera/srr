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
