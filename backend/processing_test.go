package main

import (
	"context"
	"testing"
	"time"

	"srrb/mod"
)

func init() {
	mod.Register("test-mutate-guid", func() func(*mod.RawItem) error {
		return func(i *mod.RawItem) error {
			i.GUID++
			return nil
		}
	})
	mod.Register("test-mutate-published", func() func(*mod.RawItem) error {
		return func(i *mod.RawItem) error {
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
			err := processItem(context.Background(), mod.New(), []string{tt.module}, item)
			wantErr(t, err, tt.want)
		})
	}
}
