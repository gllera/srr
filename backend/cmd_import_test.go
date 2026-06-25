package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newImportWalker builds a walker with the seen-set initialized, mirroring
// ImportCmd.Run.
func newImportWalker(selectedIDs []string) *importWalker {
	return &importWalker{w: io.Discard, selectedIDs: selectedIDs, seen: map[string]bool{}}
}

// resolveImportFeeds resolves #feed feeds, skips external-ingest ones, and
// partitions into kept (with resolved URLs) and failed.
func TestResolveImportFeedsPartial(t *testing.T) {
	setupEmptyDB(t)
	resolveFeedURL = func(_ context.Context, url string) (string, error) {
		if strings.Contains(url, "bad") {
			return "", fmt.Errorf("no feed found")
		}
		return url + "/feed.xml", nil
	}
	feeds := []*Feed{
		{Title: "Good", URL: "https://good.example.com"},
		{Title: "Bad", URL: "https://bad.example.com"},
		{Title: "Ext", URL: "https://ext.example.com", Recipe: "ext"},
	}
	recipes := map[string]Recipe{
		"default": {},
		"ext":     {Ingest: "my-fetcher"},
	}
	kept, failed := resolveImportFeeds(context.Background(), feeds, recipes)

	if len(kept) != 2 {
		t.Fatalf("kept = %d, want 2 (Good resolved, Ext unchanged)", len(kept))
	}
	if len(failed) != 1 || failed[0].URL != "https://bad.example.com" {
		t.Fatalf("failed = %+v, want exactly Bad", failed)
	}
	got := map[string]string{}
	for _, c := range kept {
		got[c.Title] = c.URL
	}
	if got["Good"] != "https://good.example.com/feed.xml" {
		t.Errorf("Good URL = %q, want resolved feed URL", got["Good"])
	}
	if got["Ext"] != "https://ext.example.com" {
		t.Errorf("Ext URL = %q, want unchanged (external ingest skips resolve)", got["Ext"])
	}
}

// feed import imports the resolvable feeds and reports the unresolvable ones,
// without aborting the whole batch.
func TestImportRunPartialSuccess(t *testing.T) {
	setupEmptyDB(t)
	resolveFeedURL = func(_ context.Context, url string) (string, error) {
		if strings.Contains(url, "bad") {
			return "", fmt.Errorf("no feed found")
		}
		return url, nil
	}
	opml := `<?xml version="1.0"?><opml version="2.0"><body>
<outline title="Good" text="Good" xmlUrl="https://good.example.com/feed"/>
<outline title="Bad" text="Bad" xmlUrl="https://bad.example.com/feed"/>
</body></opml>`
	path := filepath.Join(t.TempDir(), "feeds.opml")
	if err := os.WriteFile(path, []byte(opml), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	stdout = &out
	t.Cleanup(func() { stdout = os.Stdout })

	if err := (&ImportCmd{Path: path, All: true}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	db := reopenDB(t)
	if len(db.Feeds()) != 1 {
		t.Fatalf("Feeds = %d, want 1 (only Good imported)", len(db.Feeds()))
	}
	if db.Feeds()[0].Title != "Good" {
		t.Errorf("imported %q, want Good", db.Feeds()[0].Title)
	}
	if !strings.Contains(out.String(), "bad.example.com") {
		t.Errorf("report %q should name the skipped URL", out.String())
	}
}

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
		iw := newImportWalker(tt.selectedIDs)
		got := iw.isSelected(tt.id, tt.importAll)
		if got != tt.want {
			t.Errorf("isSelected(%q, selected=%v, all=%v) = %v, want %v",
				tt.id, tt.selectedIDs, tt.importAll, got, tt.want)
		}
	}
}

func TestImportWalkerBasic(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Feed A", Feed: &Feed{Title: "Feed A", URL: "http://example.com/a"}},
		{Name: "Feed B", Feed: &Feed{Title: "Feed B", URL: "http://example.com/b"}},
	}

	iw := newImportWalker(nil)
	feeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(feeds) != 2 {
		t.Fatalf("got %d feeds, want 2", len(feeds))
	}
}

func TestImportWalkerSelectiveImport(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Feed A", Feed: &Feed{Title: "Feed A", URL: "http://example.com/a"}},
		{Name: "Feed B", Feed: &Feed{Title: "Feed B", URL: "http://example.com/b"}},
		{Name: "Feed C", Feed: &Feed{Title: "Feed C", URL: "http://example.com/c"}},
	}

	// Nodes are sorted case-insensitively, so order is A=1, B=2, C=3
	iw := newImportWalker([]string{"2"})
	feeds, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(feeds) != 1 {
		t.Fatalf("got %d feeds, want 1", len(feeds))
	}
	if feeds[0].Title != "Feed B" {
		t.Errorf("selected feed = %q, want %q", feeds[0].Title, "Feed B")
	}
}

func TestImportWalkerNestedGroup(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog", Feed: &Feed{Title: "Blog", URL: "http://example.com/blog"}},
			},
		},
	}

	iw := newImportWalker(nil)
	feeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(feeds) != 1 {
		t.Fatalf("got %d feeds, want 1", len(feeds))
	}
	if feeds[0].Tag != "tech" {
		t.Errorf("tag = %q, want %q", feeds[0].Tag, "tech")
	}
}

func TestImportWalkerNoSelection(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Feed A", Feed: &Feed{Title: "Feed A", URL: "http://example.com/a"}},
	}

	iw := newImportWalker(nil)
	feeds, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(feeds) != 0 {
		t.Errorf("got %d feeds, want 0 (nothing selected)", len(feeds))
	}
}

func TestImportWalkerGroupSelectsChildren(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Feed: &Feed{Title: "Blog A", URL: "http://example.com/a"}},
				{Name: "Blog B", Feed: &Feed{Title: "Blog B", URL: "http://example.com/b"}},
			},
		},
	}

	// Selecting the group "1" imports each child as its own feed.
	iw := newImportWalker([]string{"1"})
	feeds, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(feeds) != 2 {
		t.Errorf("got %d feeds, want 2 (group selection expands to children)", len(feeds))
	}
}

func TestImportWalkerSorting(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Zebra", Feed: &Feed{Title: "Zebra", URL: "http://example.com/z"}},
		{Name: "alpha", Feed: &Feed{Title: "alpha", URL: "http://example.com/a"}},
		{Name: "Beta", Feed: &Feed{Title: "Beta", URL: "http://example.com/b"}},
	}

	iw := newImportWalker(nil)
	feeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	// Should be sorted case-insensitively: alpha, Beta, Zebra
	if len(feeds) != 3 {
		t.Fatalf("got %d feeds, want 3", len(feeds))
	}
	if feeds[0].Title != "alpha" {
		t.Errorf("feeds[0] = %q, want %q", feeds[0].Title, "alpha")
	}
	if feeds[1].Title != "Beta" {
		t.Errorf("feeds[1] = %q, want %q", feeds[1].Title, "Beta")
	}
	if feeds[2].Title != "Zebra" {
		t.Errorf("feeds[2] = %q, want %q", feeds[2].Title, "Zebra")
	}
}

// A URL cross-listed in several folders yields exactly one feed. First
// folder visited wins the tag (folders are walked in case-insensitive name
// order, so "AAA" precedes "BBB").
func TestImportDedupCrossFolder(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "AAA",
			Children: []*OPMLNode{
				{Name: "Shared", Feed: &Feed{Title: "Shared", URL: "http://example.com/shared"}},
			},
		},
		{
			Name: "BBB",
			Children: []*OPMLNode{
				{Name: "Shared", Feed: &Feed{Title: "Shared", URL: "http://example.com/shared"}},
			},
		},
	}

	iw := newImportWalker(nil)
	feeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(feeds) != 1 {
		t.Fatalf("got %d feeds, want 1 (cross-folder URL deduped)", len(feeds))
	}
	if feeds[0].Tag != "aaa" {
		t.Errorf("tag = %q, want %q (first folder wins)", feeds[0].Tag, "aaa")
	}
}

func TestApplyImportDefaultsNothingSet(t *testing.T) {
	feeds := []*Feed{
		{Title: "A", Tag: "auto", Recipe: "keep"},
		{Title: "B"},
	}
	applyImportDefaults(feeds, nil, nil)
	// Untouched: existing Tag / Recipe preserved.
	if feeds[0].Tag != "auto" {
		t.Errorf("feeds[0].Tag = %q, want %q", feeds[0].Tag, "auto")
	}
	if feeds[0].Recipe != "keep" {
		t.Errorf("feeds[0].Recipe = %q, want %q", feeds[0].Recipe, "keep")
	}
}

func TestApplyImportDefaultsTagOverride(t *testing.T) {
	feeds := []*Feed{{Title: "A", Tag: "auto"}, {Title: "B", Tag: "other"}}
	tag := "explicit"
	applyImportDefaults(feeds, nil, &tag)
	for _, c := range feeds {
		if c.Tag != "explicit" {
			t.Errorf("c.Tag = %q, want %q", c.Tag, "explicit")
		}
	}
}

func TestApplyImportDefaultsTagClearsToEmpty(t *testing.T) {
	feeds := []*Feed{{Title: "A", Tag: "auto"}}
	empty := ""
	applyImportDefaults(feeds, nil, &empty)
	if feeds[0].Tag != "" {
		t.Errorf("c.Tag = %q, want empty", feeds[0].Tag)
	}
}

func TestApplyImportDefaultsRecipeApplied(t *testing.T) {
	feeds := []*Feed{{Title: "A"}, {Title: "B"}}
	recipe := "read"
	applyImportDefaults(feeds, &recipe, nil)
	for _, c := range feeds {
		if c.Recipe != "read" {
			t.Errorf("c.Recipe = %q, want %q", c.Recipe, "read")
		}
	}
}

func TestApplyImportDefaultsRecipeClearsToEmpty(t *testing.T) {
	feeds := []*Feed{{Title: "A", Recipe: "read"}}
	empty := ""
	applyImportDefaults(feeds, &empty, nil)
	if feeds[0].Recipe != "" {
		t.Errorf("c.Recipe = %q, want empty", feeds[0].Recipe)
	}
}

func TestImportRunFlagsThreadIntoFeeds(t *testing.T) {
	// Drive applyImportDefaults via the same call site Run uses, with
	// fields populated from an ImportCmd. Guards the wiring after the
	// rename / refactor.
	recipe := "read"
	tag := "news"
	o := &ImportCmd{Recipe: &recipe, Tag: &tag}

	feeds := []*Feed{{Title: "A"}}
	applyImportDefaults(feeds, o.Recipe, o.Tag)

	if feeds[0].Recipe != "read" {
		t.Errorf("Recipe = %q", feeds[0].Recipe)
	}
	if feeds[0].Tag != "news" {
		t.Errorf("Tag = %q", feeds[0].Tag)
	}
}
