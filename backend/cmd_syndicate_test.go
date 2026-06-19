package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// captureOutput captures printJSON output by substituting stdout.
func captureOutput(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	old := stdout
	stdout = &buf
	defer func() { stdout = old }()
	fn()
	return buf.String()
}

func TestSyndicateLsEmpty(t *testing.T) {
	_, _, _ = setupTestDB(t)

	out := captureOutput(t, func() {
		if err := (&SyndicateLsCmd{}).Run(); err != nil {
			t.Fatalf("syndicate ls: %v", err)
		}
	})
	// Should print null (empty slice) or []
	if strings.TrimSpace(out) != "null" && strings.TrimSpace(out) != "[]" {
		t.Errorf("empty ls = %q, want null or []", strings.TrimSpace(out))
	}
}

func TestSyndicateSetPersists(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	cmd := &SyndicateSetCmd{
		Name:   "foo",
		Format: "rss",
		Tags:   []string{"news"},
		Limit:  20,
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}

	// Re-open and verify persisted
	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if len(db2.core.Out) != 1 {
		t.Fatalf("Out len = %d, want 1", len(db2.core.Out))
	}
	o := db2.core.Out[0]
	if o.Name != "foo" || o.Format != "rss" || len(o.Tags) != 1 || o.Tags[0] != "news" || o.Limit != 20 {
		t.Errorf("Out[0] = %+v, want {Name:foo Format:rss Tags:[news] Limit:20}", o)
	}
}

func TestSyndicateLsShowsEntry(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		2: {id: 2, URL: "http://b", Tag: "tech"},
	}

	if err := (&SyndicateSetCmd{Name: "bar", Format: "json", Tags: []string{"tech"}, Limit: 10}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}

	out := captureOutput(t, func() {
		if err := (&SyndicateLsCmd{}).Run(); err != nil {
			t.Fatalf("syndicate ls: %v", err)
		}
	})

	var entries []OutFeed
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		t.Fatalf("unmarshal ls output: %v (raw: %q)", err, out)
	}
	if len(entries) != 1 || entries[0].Name != "bar" || entries[0].Format != "json" {
		t.Errorf("ls = %+v, want [{Name:bar Format:json}]", entries)
	}
}

func TestSyndicateSetUpdatesInPlace(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}, Limit: 10}).Run(); err != nil {
		t.Fatalf("syndicate set #1: %v", err)
	}
	// Update same name
	if err := (&SyndicateSetCmd{Name: "foo", Format: "json", Tags: []string{"news"}, Title: "Updated", Limit: 50}).Run(); err != nil {
		t.Fatalf("syndicate set #2: %v", err)
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if len(db2.core.Out) != 1 {
		t.Fatalf("Out len = %d after upsert, want 1", len(db2.core.Out))
	}
	o := db2.core.Out[0]
	if o.Format != "json" || o.Title != "Updated" || o.Limit != 50 {
		t.Errorf("upserted = %+v, want json/Updated/50", o)
	}
}

func TestSyndicateRmRemoves(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}
	if err := (&SyndicateRmCmd{Name: "foo"}).Run(); err != nil {
		t.Fatalf("syndicate rm: %v", err)
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if len(db2.core.Out) != 0 {
		t.Errorf("Out len = %d after rm, want 0", len(db2.core.Out))
	}
}

func TestSyndicateSetInvalidFormat(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{}

	err := (&SyndicateSetCmd{Name: "foo", Format: "xml", Tags: []string{"x"}}).Run()
	if err == nil {
		t.Error("expected error for invalid format")
	}
	if !strings.Contains(err.Error(), "format") {
		t.Errorf("error = %v, want mention of 'format'", err)
	}
}

func TestSyndicateSetNoTagsOrFeeds(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{}

	err := (&SyndicateSetCmd{Name: "foo", Format: "rss"}).Run()
	if err == nil {
		t.Error("expected error when neither tags nor feeds specified")
	}
}

func TestSyndicateSetUnknownFeedID(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a"},
	}

	err := (&SyndicateSetCmd{Name: "foo", Format: "rss", FeedIDs: []int{999}}).Run()
	if err == nil {
		t.Error("expected error for unknown feed id 999")
	}
	if !strings.Contains(err.Error(), "999") {
		t.Errorf("error = %v, want mention of feed id", err)
	}
}

func TestSyndicateSetDefaultLimit(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	// Limit 0 → default applied
	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if db2.core.Out[0].Limit != outDefaultLimit {
		t.Errorf("Limit = %d, want outDefaultLimit (%d)", db2.core.Out[0].Limit, outDefaultLimit)
	}
}

// TestSyndicateRmCleansOutFile verifies that rm attempts to delete the out/ key
// even when the store is empty (silent-on-missing).
func TestSyndicateRmCleansOutFile(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "myfeed", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}
	// rm should succeed even if no out/ file exists in store (silent-on-missing)
	if err := (&SyndicateRmCmd{Name: "myfeed"}).Run(); err != nil {
		t.Fatalf("syndicate rm: %v", err)
	}
}

// TestSyndicateSetNameValidation verifies that unsafe names (path traversal,
// empty, ".", "..") are rejected and that a valid name still works.
func TestSyndicateSetNameValidation(t *testing.T) {
	unsafeNames := []string{
		"../../db",
		"../idx/0",
		"a/b",
		"..",
		".",
		"",
		"foo bar",
		"foo\x00bar",
	}
	for _, name := range unsafeNames {
		t.Run("reject_"+name, func(t *testing.T) {
			_, c, _ := setupTestDB(t)
			c.Feeds = map[int]*Feed{
				1: {id: 1, URL: "http://a", Tag: "x"},
			}
			err := (&SyndicateSetCmd{
				Name:   name,
				Format: "rss",
				Tags:   []string{"x"},
			}).Run()
			if err == nil {
				t.Errorf("syndicate set %q: expected error, got nil", name)
			}
		})
	}

	// A valid name must succeed and persist.
	t.Run("accept_valid", func(t *testing.T) {
		_, c, _ := setupTestDB(t)
		c.Feeds = map[int]*Feed{
			1: {id: 1, URL: "http://a", Tag: "x"},
		}
		if err := (&SyndicateSetCmd{
			Name:   "valid-feed_1.0",
			Format: "rss",
			Tags:   []string{"x"},
		}).Run(); err != nil {
			t.Fatalf("syndicate set valid name: %v", err)
		}
	})
}

// Verify io.Reader is io.ReadCloser compliant when used in tests via strings.NewReader.
var _ io.Reader = strings.NewReader("")
