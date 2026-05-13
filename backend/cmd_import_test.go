package main

import (
	"io"
	"testing"
)

func TestIsSelected(t *testing.T) {
	tests := []struct {
		id          string
		selectedIDs []string
		importAll   bool
		want        bool
	}{
		// importAll overrides everything
		{"1", nil, true, true},
		{"1.2.3", nil, true, true},

		// Exact match
		{"1", []string{"1"}, false, true},
		{"1.2", []string{"1.2"}, false, true},

		// Prefix match: selecting "1" also selects "1.1", "1.2", etc.
		{"1.1", []string{"1"}, false, true},
		{"1.2.3", []string{"1"}, false, true},
		{"1.2.3", []string{"1.2"}, false, true},

		// No match
		{"2", []string{"1"}, false, false},
		{"1", []string{"1.1"}, false, false}, // "1.1" does not select parent "1"
		{"12", []string{"1"}, false, false},  // "12" is not a child of "1"
		{"2.1", []string{"1"}, false, false},

		// Multiple selections
		{"3", []string{"1", "3"}, false, true},
		{"2", []string{"1", "3"}, false, false},

		// Empty selections
		{"1", nil, false, false},
		{"1", []string{}, false, false},
	}

	for _, tt := range tests {
		iw := &importWalker{w: io.Discard, selectedIDs: tt.selectedIDs}
		got := iw.isSelected(tt.id, tt.importAll)
		if got != tt.want {
			t.Errorf("isSelected(%q, selected=%v, all=%v) = %v, want %v",
				tt.id, tt.selectedIDs, tt.importAll, got, tt.want)
		}
	}
}

func TestImportWalkerBasic(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Feed A", Channel: &Channel{Title: "Feed A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
		{Name: "Feed B", Channel: &Channel{Title: "Feed B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
	}

	iw := &importWalker{w: io.Discard, selectedIDs: nil}
	channels, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 2 {
		t.Fatalf("got %d channels, want 2", len(channels))
	}
}

func TestImportWalkerSelectiveImport(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Feed A", Channel: &Channel{Title: "Feed A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
		{Name: "Feed B", Channel: &Channel{Title: "Feed B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
		{Name: "Feed C", Channel: &Channel{Title: "Feed C", Feeds: []*Feed{{URL: "http://example.com/c"}}}},
	}

	// Nodes are sorted case-insensitively, so order is A=1, B=2, C=3
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"2"}}
	channels, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 1 {
		t.Fatalf("got %d channels, want 1", len(channels))
	}
	if channels[0].Title != "Feed B" {
		t.Errorf("selected channel = %q, want %q", channels[0].Title, "Feed B")
	}
}

func TestImportWalkerNestedGroup(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog", Channel: &Channel{Title: "Blog", Feeds: []*Feed{{URL: "http://example.com/blog"}}}},
			},
		},
	}

	iw := &importWalker{w: io.Discard, selectedIDs: nil}
	channels, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 1 {
		t.Fatalf("got %d channels, want 1", len(channels))
	}
	if channels[0].Tag != "tech" {
		t.Errorf("tag = %q, want %q", channels[0].Tag, "tech")
	}
}

func TestImportWalkerNoSelection(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Feed A", Channel: &Channel{Title: "Feed A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
	}

	iw := &importWalker{w: io.Discard, selectedIDs: nil}
	channels, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 0 {
		t.Errorf("got %d channels, want 0 (nothing selected)", len(channels))
	}
}

func TestImportWalkerGroupSelectsChildren(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
	}

	// Selecting the group "1" should import all children
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}}
	channels, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 2 {
		t.Errorf("got %d channels, want 2 (selecting group imports all children)", len(channels))
	}
}

func TestImportWalkerSorting(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Zebra", Channel: &Channel{Title: "Zebra", Feeds: []*Feed{{URL: "http://example.com/z"}}}},
		{Name: "alpha", Channel: &Channel{Title: "alpha", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
		{Name: "Beta", Channel: &Channel{Title: "Beta", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
	}

	iw := &importWalker{w: io.Discard, selectedIDs: nil}
	channels, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	// Should be sorted case-insensitively: alpha, Beta, Zebra
	if len(channels) != 3 {
		t.Fatalf("got %d channels, want 3", len(channels))
	}
	if channels[0].Title != "alpha" {
		t.Errorf("channels[0] = %q, want %q", channels[0].Title, "alpha")
	}
	if channels[1].Title != "Beta" {
		t.Errorf("channels[1] = %q, want %q", channels[1].Title, "Beta")
	}
	if channels[2].Title != "Zebra" {
		t.Errorf("channels[2] = %q, want %q", channels[2].Title, "Zebra")
	}
}
