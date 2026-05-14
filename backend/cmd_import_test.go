package main

import (
	"io"
	"slices"
	"strings"
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

func TestApplyImportDefaultsNothingSet(t *testing.T) {
	channels := []*Channel{
		{Title: "A", Tag: "auto", Pipe: []string{"#sanitize"}, Ingest: "#rss"},
		{Title: "B"},
	}
	applyImportDefaults(channels, nil, nil, nil)
	// Untouched: existing Tag / Pipe / Ingest preserved.
	if channels[0].Tag != "auto" {
		t.Errorf("channels[0].Tag = %q, want %q", channels[0].Tag, "auto")
	}
	if !slices.Equal(channels[0].Pipe, []string{"#sanitize"}) {
		t.Errorf("channels[0].Pipe = %v, want [#sanitize]", channels[0].Pipe)
	}
	if channels[0].Ingest != "#rss" {
		t.Errorf("channels[0].Ingest = %q, want %q", channels[0].Ingest, "#rss")
	}
}

func TestApplyImportDefaultsTagOverride(t *testing.T) {
	channels := []*Channel{{Title: "A", Tag: "auto"}, {Title: "B", Tag: "other"}}
	tag := "explicit"
	applyImportDefaults(channels, nil, nil, &tag)
	for _, c := range channels {
		if c.Tag != "explicit" {
			t.Errorf("c.Tag = %q, want %q", c.Tag, "explicit")
		}
	}
}

func TestApplyImportDefaultsTagClearsToEmpty(t *testing.T) {
	channels := []*Channel{{Title: "A", Tag: "auto"}}
	empty := ""
	applyImportDefaults(channels, nil, nil, &empty)
	if channels[0].Tag != "" {
		t.Errorf("c.Tag = %q, want empty", channels[0].Tag)
	}
}

func TestApplyImportDefaultsPipeApplied(t *testing.T) {
	channels := []*Channel{{Title: "A"}, {Title: "B"}}
	parsers := []string{"#sanitize", "#minify"}
	applyImportDefaults(channels, &parsers, nil, nil)
	for _, c := range channels {
		if !slices.Equal(c.Pipe, []string{"#sanitize", "#minify"}) {
			t.Errorf("c.Pipe = %v, want [#sanitize #minify]", c.Pipe)
		}
	}
}

func TestApplyImportDefaultsPipeEmptyClears(t *testing.T) {
	channels := []*Channel{{Title: "A", Pipe: []string{"#sanitize"}}}
	parsers := []string{""}
	applyImportDefaults(channels, &parsers, nil, nil)
	if channels[0].Pipe != nil {
		t.Errorf("c.Pipe = %v, want nil (filterPipe drops empties)", channels[0].Pipe)
	}
}

func TestApplyImportDefaultsPipeFiltersEmpty(t *testing.T) {
	channels := []*Channel{{Title: "A"}}
	parsers := []string{"#sanitize", "", "#minify"}
	applyImportDefaults(channels, &parsers, nil, nil)
	if !slices.Equal(channels[0].Pipe, []string{"#sanitize", "#minify"}) {
		t.Errorf("c.Pipe = %v, want [#sanitize #minify]", channels[0].Pipe)
	}
}

func TestApplyImportDefaultsIngestApplied(t *testing.T) {
	channels := []*Channel{{Title: "A"}, {Title: "B"}}
	ingest := "#telegram"
	applyImportDefaults(channels, nil, &ingest, nil)
	for _, c := range channels {
		if c.Ingest != "#telegram" {
			t.Errorf("c.Ingest = %q, want %q", c.Ingest, "#telegram")
		}
	}
}

func TestApplyImportDefaultsIngestClearsToEmpty(t *testing.T) {
	channels := []*Channel{{Title: "A", Ingest: "#telegram"}}
	empty := ""
	applyImportDefaults(channels, nil, &empty, nil)
	if channels[0].Ingest != "" {
		t.Errorf("c.Ingest = %q, want empty", channels[0].Ingest)
	}
}

func TestImportRunFlagsThreadIntoChannels(t *testing.T) {
	// Drive applyImportDefaults via the same call site Run uses, with
	// fields populated from an ImportCmd. Guards the wiring after the
	// rename / refactor.
	parsers := []string{"#sanitize", "#minify"}
	ingest := "#telegram"
	tag := "news"
	o := &ImportCmd{Parsers: &parsers, Ingest: &ingest, Tag: &tag}

	channels := []*Channel{{Title: "A"}}
	applyImportDefaults(channels, o.Parsers, o.Ingest, o.Tag)

	if !slices.Equal(channels[0].Pipe, []string{"#sanitize", "#minify"}) {
		t.Errorf("Pipe = %v", channels[0].Pipe)
	}
	if channels[0].Ingest != "#telegram" {
		t.Errorf("Ingest = %q", channels[0].Ingest)
	}
	if channels[0].Tag != "news" {
		t.Errorf("Tag = %q", channels[0].Tag)
	}
}

func TestImportRunEmptyTitleErrors(t *testing.T) {
	empty := ""
	cmd := &ImportCmd{Path: "irrelevant.opml", All: true, Title: &empty}
	err := cmd.Run()
	if err == nil || !strings.Contains(err.Error(), "title must be non-empty") {
		t.Errorf("got err=%v, want error about empty title", err)
	}
}

func TestImportRunTitleWithoutSelectionErrors(t *testing.T) {
	title := "X"
	cmd := &ImportCmd{Path: "irrelevant.opml", Title: &title}
	err := cmd.Run()
	if err == nil || !strings.Contains(err.Error(), "merge requires -a or -i") {
		t.Errorf("got err=%v, want error about missing selection", err)
	}
}

func TestWalkerMergeFlatLeaves(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Alpha", Channel: &Channel{Title: "Alpha", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
		{Name: "Beta", Channel: &Channel{Title: "Beta", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
		{Name: "Gamma", Channel: &Channel{Title: "Gamma", Feeds: []*Feed{{URL: "http://example.com/g"}}}},
	}
	iw := &importWalker{w: io.Discard, merge: true}
	channels, err := iw.walk(nodes, "", "", nil, true /* importAll */)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("merge mode returned %d channels, want 0", len(channels))
	}
	if len(iw.mergedFeeds) != 3 {
		t.Fatalf("mergedFeeds len = %d, want 3", len(iw.mergedFeeds))
	}
	wantURLs := []string{"http://example.com/a", "http://example.com/b", "http://example.com/g"}
	for i, f := range iw.mergedFeeds {
		if f.URL != wantURLs[i] {
			t.Errorf("mergedFeeds[%d].URL = %q, want %q", i, f.URL, wantURLs[i])
		}
	}
}

func TestWalkerMergeGroupCollectsSubtree(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	channels, err := iw.walk(nodes, "", "", nil, false /* importAll */)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("got %d channels, want 0 (merge)", len(channels))
	}
	if len(iw.mergedFeeds) != 2 {
		t.Fatalf("mergedFeeds len = %d, want 2", len(iw.mergedFeeds))
	}
}

func TestWalkerMergeDeepNested(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{
					Name: "Rust",
					Children: []*OPMLNode{
						{Name: "R1", Channel: &Channel{Title: "R1", Feeds: []*Feed{{URL: "http://example.com/r1"}}}},
						{Name: "R2", Channel: &Channel{Title: "R2", Feeds: []*Feed{{URL: "http://example.com/r2"}}}},
					},
				},
				{
					Name: "Go",
					Children: []*OPMLNode{
						{Name: "G1", Channel: &Channel{Title: "G1", Feeds: []*Feed{{URL: "http://example.com/g1"}}}},
					},
				},
			},
		},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 3 {
		t.Errorf("got %d feeds, want 3 (R1, R2, G1)", len(iw.mergedFeeds))
	}
}

func TestWalkerMergeGroupWithSelfFeed(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name:    "Self",
			Channel: &Channel{Title: "Self", Feeds: []*Feed{{URL: "http://example.com/self"}}},
			Children: []*OPMLNode{
				{Name: "Child", Channel: &Channel{Title: "Child", Feeds: []*Feed{{URL: "http://example.com/child"}}}},
			},
		},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 2 {
		t.Fatalf("got %d feeds, want 2 (self + child)", len(iw.mergedFeeds))
	}
	// Self feed contributes first (group node visited before children).
	if iw.mergedFeeds[0].URL != "http://example.com/self" {
		t.Errorf("mergedFeeds[0].URL = %q, want self feed", iw.mergedFeeds[0].URL)
	}
}

func TestWalkerMergeMixedLeafAndGroup(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
		{Name: "Standalone", Channel: &Channel{Title: "Standalone", Feeds: []*Feed{{URL: "http://example.com/s"}}}},
	}
	// Select group 1 (Tech) and leaf 2 (Standalone).
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1", "2"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 3 {
		t.Errorf("got %d feeds, want 3", len(iw.mergedFeeds))
	}
}

func TestWalkerMergeSingleLeaf(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Solo", Channel: &Channel{Title: "Solo", Feeds: []*Feed{{URL: "http://example.com/solo"}}}},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 1 {
		t.Errorf("got %d feeds, want 1", len(iw.mergedFeeds))
	}
}
