package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"srrb/mod"
)

func init() {
	mod.Register("test-mutate-guid", func(_ mod.Assets) mod.Processor {
		return func(_ context.Context, _ mod.Params, i *mod.RawItem) error {
			i.GUID++
			return nil
		}
	})
	mod.Register("test-mutate-published", func(_ mod.Assets) mod.Processor {
		return func(_ context.Context, _ mod.Params, i *mod.RawItem) error {
			t := time.Unix(1, 0)
			i.Published = &t
			return nil
		}
	})
}

// processItem must reject any module that mutates GUID or Published —
// downstream dedup, ordering, and storage assume those two fields are
// stable for the lifetime of the item. The same rule applies whether
// the module is built-in or external.
func TestProcessItemRejectsImmutableFieldChange(t *testing.T) {
	now := time.Unix(1700000000, 0)
	tests := []struct {
		name   string
		module string
		want   string
	}{
		{"internal GUID", "#test-mutate-guid", "changed GUID"},
		{"internal Published", "#test-mutate-published", "changed Published"},
		{"external GUID", `jq -c '.guid = 99999'`, "changed GUID"},
		{"external Published", `jq -c '.published = "2000-01-01T00:00:00Z"'`, "changed Published"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			item := &mod.RawItem{GUID: 42, Title: "t", Content: "c", Link: "http://example.com", Published: &now}
			err := processItem(context.Background(), mod.New(nil), []string{tt.module}, item)
			wantErr(t, err, tt.want)
		})
	}
}

const hostileHTML = `<p>safe text</p><script>window.x=1</script><img src=x onerror="window.x=1">`

// Sanitization is NOT implicit: dangerous markup is only neutralized when the
// resolved pipe actually contains #sanitize. processItem normalizes/strips
// control chars but does not sanitize HTML on its own, so a pipe that omits
// #sanitize ships executable markup straight to the reader. This pins the
// trust boundary — the default root pipe ["#sanitize","#minify"] is the guard.
func TestProcessItemSanitizeIsExplicit(t *testing.T) {
	ctx := context.Background()

	// No #sanitize → hostile nodes survive verbatim.
	for _, pipe := range [][]string{nil, {"#minify"}} {
		item := &mod.RawItem{Content: hostileHTML, Link: "http://example.com"}
		if err := processItem(ctx, mod.New(nil), pipe, item); err != nil {
			t.Fatalf("processItem(pipe=%v): %v", pipe, err)
		}
		if !strings.Contains(item.Content, "<script") || !strings.Contains(item.Content, "onerror") {
			t.Errorf("pipe %v unexpectedly neutralized hostile content: %q", pipe, item.Content)
		}
	}

	// With #sanitize → script element and event handler are gone, safe text stays.
	item := &mod.RawItem{Content: hostileHTML, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(nil), []string{"#sanitize"}, item); err != nil {
		t.Fatalf("processItem(#sanitize): %v", err)
	}
	if strings.Contains(item.Content, "<script") || strings.Contains(item.Content, "onerror") {
		t.Errorf("#sanitize left dangerous content: %q", item.Content)
	}
	if !strings.Contains(item.Content, "safe text") {
		t.Errorf("#sanitize dropped safe content: %q", item.Content)
	}
}

// A content-mutating mod placed AFTER #sanitize can reintroduce dangerous
// markup, because processItem does not re-sanitize at the end. This documents
// and guards the ordering invariant: #sanitize must be the LAST content-
// mutating mod in any pipe. If a future change adds a final sanitize pass,
// this test will fail and should be updated to assert the markup is stripped.
func TestProcessItemSanitizeOrderingHazard(t *testing.T) {
	item := &mod.RawItem{Content: "<p>safe</p>", Link: "http://example.com"}
	pipe := []string{"#sanitize", `jq -c '.content="<script>evil</script>"'`}
	if err := processItem(context.Background(), mod.New(nil), pipe, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if !strings.Contains(item.Content, "<script>evil</script>") {
		t.Fatalf("post-#sanitize shell mod output should survive unsanitized (ordering hazard), got %q", item.Content)
	}
}
