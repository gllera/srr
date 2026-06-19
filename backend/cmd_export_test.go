package main

import (
	"bytes"
	"context"
	"encoding/xml"
	"sort"
	"strings"
	"testing"
)

// runExport captures `feed export` output for the current globals.Store.
func runExport(t *testing.T, cmd *ExportCmd) string {
	t.Helper()
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })
	if err := cmd.Run(); err != nil {
		t.Fatalf("export: %v", err)
	}
	return out.String()
}

// parseExport re-parses export output through the import-side parser — the
// round-trip contract every export must satisfy.
func parseExport(t *testing.T, opml string) []*OPMLNode {
	t.Helper()
	nodes, err := ParseOPMLTree(writeTempFile(t, opml))
	if err != nil {
		t.Fatalf("ParseOPMLTree on export output: %v", err)
	}
	return nodes
}

func seedFeeds(t *testing.T, feeds ...*Feed) {
	t.Helper()
	setupEmptyDB(t)
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	for _, ch := range feeds {
		if err := db.AddFeed(ch); err != nil {
			t.Fatalf("AddFeed %q: %v", ch.Title, err)
		}
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	db.Close(ctx)
}

func feedOf(title, tag, url string) *Feed {
	return &Feed{Title: title, Tag: tag, URL: url}
}

func TestExportEmptyDB(t *testing.T) {
	setupEmptyDB(t)
	out := runExport(t, &ExportCmd{})
	if !strings.Contains(out, `<?xml`) || !strings.Contains(out, `<opml version="2.0">`) {
		t.Errorf("output missing OPML 2.0 envelope:\n%s", out)
	}
	if nodes := parseExport(t, out); len(nodes) != 0 {
		t.Errorf("nodes = %d, want 0", len(nodes))
	}
}

func TestExportUntaggedTopLevel(t *testing.T) {
	seedFeeds(t, feedOf("News", "", "https://news.example.com/rss"))
	nodes := parseExport(t, runExport(t, &ExportCmd{}))
	if len(nodes) != 1 {
		t.Fatalf("top-level nodes = %d, want 1", len(nodes))
	}
	if nodes[0].Feed == nil || len(nodes[0].Children) != 0 {
		t.Fatalf("node = %+v, want bare leaf feed", nodes[0])
	}
	if nodes[0].Feed.Title != "News" || nodes[0].Feed.URL != "https://news.example.com/rss" {
		t.Errorf("leaf = %q %q", nodes[0].Feed.Title, nodes[0].Feed.URL)
	}
}

func TestExportNestedTagGroups(t *testing.T) {
	seedFeeds(t, feedOf("Go Blog", "tech/go_blogs", "https://go.example.com/rss"))
	nodes := parseExport(t, runExport(t, &ExportCmd{}))
	if len(nodes) != 1 || nodes[0].Name != "tech" || nodes[0].Feed != nil {
		t.Fatalf("top level = %+v, want single tech group", nodes)
	}
	mid := nodes[0].Children
	if len(mid) != 1 || mid[0].Name != "go_blogs" {
		t.Fatalf("second level = %+v, want go_blogs group", mid)
	}
	leaves := mid[0].Children
	if len(leaves) != 1 || leaves[0].Feed == nil || leaves[0].Feed.Title != "Go Blog" {
		t.Fatalf("leaves = %+v, want Go Blog feed", leaves)
	}
}

func TestExportMergesSharedPrefix(t *testing.T) {
	seedFeeds(t,
		feedOf("Go Blog", "tech/go_blogs", "https://go.example.com/rss"),
		feedOf("Rust Blog", "tech/rust", "https://rust.example.com/rss"),
	)
	nodes := parseExport(t, runExport(t, &ExportCmd{}))
	if len(nodes) != 1 || nodes[0].Name != "tech" {
		t.Fatalf("top level = %+v, want single merged tech group", nodes)
	}
	if len(nodes[0].Children) != 2 {
		t.Fatalf("tech children = %d, want 2 subgroups", len(nodes[0].Children))
	}
}

// One feed = one leaf carrying its single URL.
func TestExportOneLeafPerFeed(t *testing.T) {
	seedFeeds(t,
		feedOf("A", "", "https://a.example.com/rss"),
		feedOf("B", "", "https://b.example.com/rss"),
	)
	nodes := parseExport(t, runExport(t, &ExportCmd{}))
	if len(nodes) != 2 {
		t.Fatalf("top-level nodes = %d, want 2 leaves", len(nodes))
	}
	urls := []string{}
	for _, n := range nodes {
		if n.Feed == nil {
			t.Fatalf("node = %+v, want a leaf feed", n)
		}
		urls = append(urls, n.Feed.URL)
	}
	sort.Strings(urls)
	want := []string{"https://a.example.com/rss", "https://b.example.com/rss"}
	if urls[0] != want[0] || urls[1] != want[1] {
		t.Errorf("urls = %v, want %v", urls, want)
	}
}

func TestExportTagFilter(t *testing.T) {
	seedFeeds(t,
		feedOf("Go Blog", "tech", "https://go.example.com/rss"),
		feedOf("News", "news", "https://news.example.com/rss"),
	)
	nodes := parseExport(t, runExport(t, &ExportCmd{Tag: strPtr("tech")}))
	if len(nodes) != 1 || nodes[0].Name != "tech" {
		t.Fatalf("top level = %+v, want only the tech group", nodes)
	}
}

// The load-bearing invariant: export → import -a reproduces the same
// titles/tags/feeds (stored tags re-normalize to themselves).
func TestExportImportRoundTrip(t *testing.T) {
	orig := []*Feed{
		feedOf("Go Blog", "tech/go_blogs", "https://go.example.com/rss"),
		feedOf("News", "", "https://news.example.com/rss"),
		feedOf("Rust Blog", "tech/rust", "https://rust.example.com/rss"),
	}
	seedFeeds(t, orig...)
	out := runExport(t, &ExportCmd{})

	// Import the export into a fresh store.
	setupEmptyDB(t)
	if err := (&ImportCmd{Path: writeTempFile(t, out), All: true}).Run(); err != nil {
		t.Fatalf("import of export: %v", err)
	}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())

	got := map[string]*Feed{}
	for _, ch := range db.Feeds() {
		got[ch.Title] = ch
	}
	if len(got) != len(orig) {
		t.Fatalf("imported %d feeds, want %d", len(got), len(orig))
	}
	for _, want := range orig {
		ch := got[want.Title]
		if ch == nil {
			t.Fatalf("feed %q missing after round-trip", want.Title)
		}
		if ch.Tag != want.Tag {
			t.Errorf("%q tag = %q, want %q", want.Title, ch.Tag, want.Tag)
		}
		if ch.URL != want.URL {
			t.Errorf("%q url = %q, want %q", want.Title, ch.URL, want.URL)
		}
	}
}

// TestExportImportRoundTripTagIdentity verifies that export → import -a
// preserves tags byte-for-byte, covering the B2 fix: only already-normalized
// tags are storable, so the import side cannot mutate them.
func TestExportImportRoundTripTagIdentity(t *testing.T) {
	orig := []*Feed{
		feedOf("Go Blog", "tech/news", "https://go.example.com/rss"),
	}
	seedFeeds(t, orig...)
	out := runExport(t, &ExportCmd{})

	// Import into a fresh store.
	setupEmptyDB(t)
	if err := (&ImportCmd{Path: writeTempFile(t, out), All: true}).Run(); err != nil {
		t.Fatalf("import of export: %v", err)
	}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())

	feeds := db.Feeds()
	if len(feeds) != 1 {
		t.Fatalf("imported %d feeds, want 1", len(feeds))
	}
	ch := feeds[0]
	if ch.Tag != "tech/news" {
		t.Errorf("tag after round-trip = %q, want %q (identity broken)", ch.Tag, "tech/news")
	}
}

// Guards the marshal-side struct additions (XMLName/version/head) against
// regressions in both directions.
func TestOPMLMarshalRoundTrip(t *testing.T) {
	in := OPML{
		Version: "2.0",
		Head:    Head{Title: "SRR feeds"},
		Body: Body{Outlines: []Outline{
			{Title: "tech", Text: "tech", Outlines: []Outline{
				{Title: "Go Blog", Text: "Go Blog", XMLURL: "https://go.example.com/rss"},
			}},
		}},
	}
	b, err := xml.MarshalIndent(in, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent: %v", err)
	}
	raw := string(b)
	if !strings.Contains(raw, `<opml version="2.0">`) || !strings.Contains(raw, "<title>SRR feeds</title>") {
		t.Fatalf("marshalled OPML missing envelope:\n%s", raw)
	}
	// Group outlines must not carry an empty xmlUrl attribute.
	if strings.Contains(raw, `xmlUrl=""`) {
		t.Errorf("group outline emitted empty xmlUrl:\n%s", raw)
	}
	nodes := parseExport(t, raw)
	if len(nodes) != 1 || nodes[0].Name != "tech" || len(nodes[0].Children) != 1 {
		t.Fatalf("re-parse = %+v, want tech > Go Blog", nodes)
	}
}
