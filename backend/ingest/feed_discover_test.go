package ingest

import (
	"testing"
)

func TestDiscoverFeedLinkAbsolute(t *testing.T) {
	html := `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" href="https://example.com/feed.xml">
</head><body></body></html>`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if !ok {
		t.Fatal("expected to find a feed link, got false")
	}
	if got != "https://example.com/feed.xml" {
		t.Errorf("got %q, want %q", got, "https://example.com/feed.xml")
	}
}

func TestDiscoverFeedLinkRelativeResolvedAgainstBase(t *testing.T) {
	html := `<html><head>
<link rel="alternate" type="application/rss+xml" href="/feeds/rss">
</head></html>`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/blog/")
	if !ok {
		t.Fatal("expected to find a feed link, got false")
	}
	if got != "https://example.com/feeds/rss" {
		t.Errorf("got %q, want %q", got, "https://example.com/feeds/rss")
	}
}

func TestDiscoverFeedLinkAtomType(t *testing.T) {
	html := `<html><head>
<link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
</head></html>`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if !ok {
		t.Fatal("expected to find atom feed link, got false")
	}
	if got != "https://example.com/atom.xml" {
		t.Errorf("got %q, want %q", got, "https://example.com/atom.xml")
	}
}

func TestDiscoverFeedLinkJSONFeedIgnored(t *testing.T) {
	// application/feed+json is NOT discoverable: the #feed parser reads only XML
	// feeds, so discovering a JSON-only feed would repoint to an unparseable URL.
	html := `<html><head>
<link rel="alternate" type="application/feed+json" href="https://example.com/feed.json">
</head></html>`
	if _, ok := discoverFeedLink([]byte(html), "https://example.com/"); ok {
		t.Error("expected false: application/feed+json is not a parseable feed type")
	}
}

func TestDiscoverFeedLinkFirstWins(t *testing.T) {
	html := `<html><head>
<link rel="alternate" type="application/rss+xml" href="https://example.com/first.xml">
<link rel="alternate" type="application/atom+xml" href="https://example.com/second.xml">
</head></html>`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if !ok {
		t.Fatal("expected to find a feed link, got false")
	}
	if got != "https://example.com/first.xml" {
		t.Errorf("got %q, want %q (first match should win)", got, "https://example.com/first.xml")
	}
}

func TestDiscoverFeedLinkNoMatch(t *testing.T) {
	html := `<html><head><title>No feed here</title></head><body></body></html>`
	_, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if ok {
		t.Error("expected false when no feed link is present")
	}
}

func TestDiscoverFeedLinkWrongRelIgnored(t *testing.T) {
	html := `<html><head>
<link rel="stylesheet" type="application/rss+xml" href="https://example.com/notafeed.xml">
</head></html>`
	_, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if ok {
		t.Error("expected false: rel!=alternate should be ignored")
	}
}

func TestDiscoverFeedLinkWrongTypeIgnored(t *testing.T) {
	html := `<html><head>
<link rel="alternate" type="text/html" href="https://example.com/page.html">
</head></html>`
	_, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if ok {
		t.Error("expected false: non-feed type should be ignored")
	}
}

func TestDiscoverFeedLinkMalformedHTML(t *testing.T) {
	// Truncated document, but the feed <link> tag itself is complete and present
	// (no </head></html>): the tokenizer is robust to the cut-off tail and must
	// still return the link.
	html := `<html><head><link rel="alternate" type="application/rss+xml" href="https://example.com/feed.xml">`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if !ok {
		t.Fatal("expected the present-but-truncated markup to still yield the feed link")
	}
	if got != "https://example.com/feed.xml" {
		t.Errorf("got %q, want %q", got, "https://example.com/feed.xml")
	}
}

func TestDiscoverFeedLinkCaseInsensitiveRel(t *testing.T) {
	html := `<html><head>
<link REL="Alternate" type="application/rss+xml" HREF="https://example.com/feed.xml">
</head></html>`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if !ok {
		t.Fatal("expected to find a feed link with case-insensitive rel, got false")
	}
	if got != "https://example.com/feed.xml" {
		t.Errorf("got %q, want %q", got, "https://example.com/feed.xml")
	}
}

func TestDiscoverFeedLinkMultiValuedRel(t *testing.T) {
	// rel may be multi-valued (space-separated per spec).
	html := `<html><head>
<link rel="alternate stylesheet" type="application/rss+xml" href="https://example.com/feed.xml">
</head></html>`
	got, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if !ok {
		t.Fatal("expected to find a feed link with multi-valued rel, got false")
	}
	if got != "https://example.com/feed.xml" {
		t.Errorf("got %q, want %q", got, "https://example.com/feed.xml")
	}
}

func TestDiscoverFeedLinkEmptyHTML(t *testing.T) {
	_, ok := discoverFeedLink([]byte{}, "https://example.com/")
	if ok {
		t.Error("expected false for empty input")
	}
}

func TestDiscoverFeedLinkApplicationJSONNotMatched(t *testing.T) {
	// application/json is intentionally NOT a recognised feed type — oEmbed,
	// WordPress, and YouTube pages commonly emit <link rel="alternate"
	// type="application/json"> for non-feed JSON endpoints, so accepting it
	// would cause a guaranteed wasted discovery fetch every cycle.
	html := `<html><head>
<link rel="alternate" type="application/json" href="https://example.com/oembed.json">
</head></html>`
	_, ok := discoverFeedLink([]byte(html), "https://example.com/")
	if ok {
		t.Error("expected false: application/json must not be treated as a feed type")
	}
}
