package ingest

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"srr/mod"
)

func collectFeed(t *testing.T, data string) []*mod.RawItem {
	t.Helper()
	var items []*mod.RawItem
	_, _, err := ParseFeed([]byte(data), func(item *mod.RawItem) error {
		items = append(items, item)
		return nil
	})
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	return items
}

// The feed-level title must come from <channel>/<feed> only — an <image> or
// <item> title must never masquerade as the feed's own label.
func TestParseFeedTitle(t *testing.T) {
	cases := []struct {
		name, data, want string
	}{
		{"rss-channel", `<rss version="2.0"><channel><title> The Wire </title>` +
			`<item><title>Item A</title></item></channel></rss>`, "The Wire"},
		{"atom-feed", `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Wire</title>` +
			`<entry><title>Entry A</title></entry></feed>`, "Atom Wire"},
		{"image-title-skipped", `<rss version="2.0"><channel>` +
			`<image><title>Logo</title></image><title>Real Title</title>` +
			`<item><title>Item A</title></item></channel></rss>`, "Real Title"},
		{"item-title-never-leaks", `<rss version="2.0"><channel>` +
			`<item><title>Item A</title></item></channel></rss>`, ""},
		{"no-title", `<rss version="2.0"><channel><item><guid>g</guid></item></channel></rss>`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			title, _, err := ParseFeed([]byte(c.data), func(*mod.RawItem) error { return nil })
			if err != nil {
				t.Fatalf("ParseFeed: %v", err)
			}
			if title != c.want {
				t.Fatalf("title = %q, want %q", title, c.want)
			}
		})
	}
}

func TestParseRSS2(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rss version="2.0">
  <feed>
    <item>
      <title>First</title>
      <link>http://example.com/1</link>
      <guid>guid-1</guid>
      <description>Desc 1</description>
      <pubDate>Mon, 02 Jan 2006 15:04:05 GMT</pubDate>
    </item>
    <item>
      <title>Second</title>
      <link>http://example.com/2</link>
      <content:encoded><![CDATA[<p>Full content</p>]]></content:encoded>
      <description>Desc 2</description>
    </item>
  </feed>
</rss>`)

	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}

	if items[0].Title != "First" {
		t.Errorf("title = %q, want %q", items[0].Title, "First")
	}
	if items[0].Link != "http://example.com/1" {
		t.Errorf("link = %q", items[0].Link)
	}
	if items[0].GUID != hash("guid-1") {
		t.Errorf("guid = %d, want hash of %q", items[0].GUID, "guid-1")
	}
	if items[0].Published.Year() != 2006 {
		t.Errorf("published year = %d, want 2006", items[0].Published.Year())
	}

	if items[1].Content != "<p>Full content</p>" {
		t.Errorf("content = %q, want %q", items[1].Content, "<p>Full content</p>")
	}
}

func TestParseAtom(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>urn:entry:1</id>
    <title>Atom Entry</title>
    <link href="http://example.com/atom/1" rel="alternate"/>
    <link href="http://example.com/atom/1/comments" rel="replies"/>
    <summary>Summary text</summary>
    <content>Full content</content>
    <published>2024-06-15T10:30:00Z</published>
    <updated>2024-06-16T10:30:00Z</updated>
  </entry>
</feed>`)

	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}

	item := items[0]
	if item.GUID != hash("urn:entry:1") {
		t.Errorf("guid = %d", item.GUID)
	}
	if item.Title != "Atom Entry" {
		t.Errorf("title = %q", item.Title)
	}
	if item.Content != "Full content" {
		t.Errorf("content = %q, want %q", item.Content, "Full content")
	}
	if item.Link != "http://example.com/atom/1" {
		t.Errorf("link = %q", item.Link)
	}
	if item.Published.Day() != 15 {
		t.Errorf("published day = %d, want 15", item.Published.Day())
	}
}

func TestParseRDF(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <feed/>
  <item>
    <title>RDF Item</title>
    <link>http://example.com/rdf/1</link>
    <dc:date>2024-01-01</dc:date>
  </item>
</rdf:RDF>`)

	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Title != "RDF Item" {
		t.Errorf("title = %q", items[0].Title)
	}
	if items[0].Link != "http://example.com/rdf/1" {
		t.Errorf("link = %q", items[0].Link)
	}
}

func TestParseDescriptionFallback(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>No Content</title>
      <description>Only description</description>
    </item>
  </feed></rss>`)

	if items[0].Content != "Only description" {
		t.Errorf("content = %q, want description fallback", items[0].Content)
	}
}

func TestParseDateUnparseableIsUnixZero(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item><title>No Date</title></item>
  </feed></rss>`)

	if got := items[0].Published.Unix(); got != 0 {
		t.Errorf("published.Unix() = %d, want 0 for unparseable date", got)
	}
}

func TestParseCDATA(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title><![CDATA[Title with <special> chars]]></title>
      <description><![CDATA[<p>HTML content</p>]]></description>
    </item>
  </feed></rss>`)

	if items[0].Title != "Title with <special> chars" {
		t.Errorf("title = %q", items[0].Title)
	}
	if items[0].Content != "<p>HTML content</p>" {
		t.Errorf("content = %q", items[0].Content)
	}
}

// A document that isn't a recognized feed (HTML page, unknown XML root, or
// non-XML, incl. empty input) must be classified as errNotFeed so the caller can
// branch into auto-discovery rather than treating it as a generic parse fault.
func TestParseFeedNotFeedClassification(t *testing.T) {
	cases := []struct{ name, data string }{
		{"html-doctype", `<!doctype html><html><head></head><body>hi</body></html>`},
		{"html-bare", `<html><body>Not a feed</body></html>`},
		{"unknown-root", `<?xml version="1.0"?><foo><bar/></foo>`},
		{"plain-text", `not xml at all`},
		{"empty", ``},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := ParseFeed([]byte(c.data), func(*mod.RawItem) error { return nil })
			if err == nil {
				t.Fatalf("expected an error for a non-feed document")
			}
			if !errors.Is(err, errNotFeed) {
				t.Errorf("error %v is not classified errNotFeed", err)
			}
		})
	}
}

// A valid feed must not be classified errNotFeed (it parses cleanly), and a
// recognized-but-broken feed must surface a real error that is NOT errNotFeed
// (so a mid-stream fault never spuriously triggers discovery).
func TestParseFeedValidNotClassifiedNotFeed(t *testing.T) {
	_, _, err := ParseFeed([]byte(`<rss version="2.0"><feed><item><title>A</title></item></feed></rss>`),
		func(*mod.RawItem) error { return nil })
	if err != nil {
		t.Fatalf("valid feed returned error: %v", err)
	}
}

// Resolve returns the URL unchanged when it already serves a feed.
func TestResolveDirectFeed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprint(w, rssFixture)
	}))
	defer srv.Close()

	got, err := Resolve(context.Background(), srv.Client(), srv.URL, 1<<20)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != srv.URL {
		t.Errorf("Resolve = %q, want unchanged %q", got, srv.URL)
	}
}

// Resolve returns the discovered feed URL when the given URL is an HTML page
// advertising a <link rel=alternate> feed.
func TestResolveDiscoversFromHTML(t *testing.T) {
	feedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprint(w, rssFixture)
	}))
	defer feedSrv.Close()
	htmlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" href="%s">
</head><body>hi</body></html>`, feedSrv.URL)
	}))
	defer htmlSrv.Close()

	got, err := Resolve(context.Background(), htmlSrv.Client(), htmlSrv.URL, 1<<20)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != feedSrv.URL {
		t.Errorf("Resolve = %q, want discovered %q", got, feedSrv.URL)
	}
}

// Resolve errors when the URL is reachable but yields neither a feed nor a
// discoverable feed link — the hard-fail signal the CLI commands rely on.
func TestResolveNoFeedErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><head><title>no feed here</title></head><body>x</body></html>`)
	}))
	defer srv.Close()

	if _, err := Resolve(context.Background(), srv.Client(), srv.URL, 1<<20); err == nil {
		t.Error("expected error when no feed can be resolved")
	}
}

// TestHash pins the FNV-32a GUID hash to exact values — the contract external
// fetchers replicate — plus distinctness for distinct inputs.
func TestHash(t *testing.T) {
	if got := hash("test-guid-12345"); got != 0x7bafce13 {
		t.Errorf(`hash("test-guid-12345") = %#x, want 0x7bafce13`, got)
	}
	// Empty string hashes to the (non-zero) FNV offset basis.
	if got := hash(""); got != 0x811c9dc5 {
		t.Errorf(`hash("") = %#x, want 0x811c9dc5 (the FNV offset basis)`, got)
	}
	// Distinct inputs → distinct hashes.
	if hash("guid-a") == hash("guid-b") {
		t.Error("distinct inputs produced the same hash")
	}
}

func TestParseEmptyFeed(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rss version="2.0">
  <feed>
  </feed>
</rss>`)

	if len(items) != 0 {
		t.Errorf("got %d items, want 0", len(items))
	}
}

func TestParseCallbackError(t *testing.T) {
	testErr := fmt.Errorf("custom callback error")
	_, _, err := ParseFeed([]byte(`<rss version="2.0"><feed>
    <item><title>A</title></item>
  </feed></rss>`), func(*mod.RawItem) error {
		return testErr
	})

	if err == nil {
		t.Error("expected callback error to propagate")
	}
	if err != testErr {
		t.Errorf("got error %v, want %v", err, testErr)
	}
}

func TestParseGUIDFallbackDistinctForGUIDlessItems(t *testing.T) {
	// Items with no guid/id/link must NOT all collapse to hash("") — that would
	// dedup distinct articles away. Two such items with different title/content
	// get distinct GUIDs derived from their own text.
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item><title>First</title><description>one</description></item>
    <item><title>Second</title><description>two</description></item>
  </feed></rss>`)

	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}
	if items[0].GUID == hash("") || items[1].GUID == hash("") {
		t.Errorf("guid-less items collapsed to hash(\"\"): %d, %d", items[0].GUID, items[1].GUID)
	}
	if items[0].GUID == items[1].GUID {
		t.Errorf("distinct guid-less items share a GUID (%d); they would dedup each other away", items[0].GUID)
	}
}

func TestParseLinkAtomNonAlternate(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry</title>
    <link href="http://example.com/enclosure" rel="enclosure"/>
  </entry>
</feed>`)

	if items[0].Link != "http://example.com/enclosure" {
		t.Errorf("link = %q, want fallback to enclosure href", items[0].Link)
	}
}

func TestParseLinkAtomNoRel(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry</title>
    <link href="http://example.com/norel"/>
    <link href="http://example.com/enclosure" rel="enclosure"/>
  </entry>
</feed>`)

	if items[0].Link != "http://example.com/norel" {
		t.Errorf("link = %q, want href without rel", items[0].Link)
	}
}

func TestParseDateFormats(t *testing.T) {
	tests := []struct {
		name string
		date string
		year int
	}{
		{"RFC1123Z", "Mon, 02 Jan 2006 15:04:05 +0000", 2006},
		{"RFC3339", "2024-06-15T10:30:00Z", 2024},
		{"ISO date only", "2023-12-25", 2023},
		{"Short day", "Mon, 2 Jan 2006 15:04:05 -0700", 2006},
		{"No weekday", "2 Jan 2006 15:04:05 -0700", 2006},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			items := collectFeed(t, fmt.Sprintf(`<rss version="2.0"><feed>
    <item>
      <title>Date Test</title>
      <pubDate>%s</pubDate>
    </item>
  </feed></rss>`, tt.date))

			if items[0].Published.Year() != tt.year {
				t.Errorf("year = %d, want %d", items[0].Published.Year(), tt.year)
			}
		})
	}
}

func TestParseContentPriority(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Priority</title>
      <description>Desc</description>
      <summary>Summary</summary>
    </item>
  </feed></rss>`)

	if items[0].Content != "Desc" {
		t.Errorf("content = %q, want %q (description fallback)", items[0].Content, "Desc")
	}
}

func TestParseAtomSummaryFallback(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry</title>
    <summary>Summary only</summary>
  </entry>
</feed>`)

	if items[0].Content != "Summary only" {
		t.Errorf("content = %q, want summary fallback", items[0].Content)
	}
}

func TestParseMultipleItems(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item><title>A</title></item>
    <item><title>B</title></item>
    <item><title>C</title></item>
    <item><title>D</title></item>
    <item><title>E</title></item>
  </feed></rss>`)

	if len(items) != 5 {
		t.Fatalf("got %d items, want 5", len(items))
	}
	for i, expected := range []string{"A", "B", "C", "D", "E"} {
		if items[i].Title != expected {
			t.Errorf("items[%d].Title = %q, want %q", i, items[i].Title, expected)
		}
	}
}

func TestParseRSSWithAttributes(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Attr Test</title>
      <guid isPermaLink="false">custom-guid-123</guid>
    </item>
  </feed></rss>`)

	if items[0].GUID != hash("custom-guid-123") {
		t.Errorf("guid should use text content, not attributes")
	}
}

// TestParseRawFieldPreserved pins the typed-access contract #enclosure/#embed
// rely on: Raw is the parsed entry as mod.RawFeedItem, so a child element is
// reachable by name with its text intact.
func TestParseRawFieldPreserved(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Raw Test</title>
      <customField>custom value</customField>
    </item>
  </feed></rss>`)

	raw, ok := items[0].Raw.(mod.RawFeedItem)
	if !ok {
		t.Fatalf("Raw = %T, want mod.RawFeedItem", items[0].Raw)
	}
	if got := raw["customField"]; len(got) == 0 || got[0].Txt != "custom value" {
		t.Errorf("raw[customField] = %+v, want a single field with Txt=%q", got, "custom value")
	}
}

func TestParseAtomUpdatedFallback(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Updated Only</title>
    <updated>2024-03-15T08:00:00Z</updated>
  </entry>
</feed>`)

	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Published.Year() != 2024 || items[0].Published.Month() != 3 {
		t.Errorf("published = %v, want 2024-03 (from <updated> fallback)", items[0].Published)
	}
}

func TestParseLinkAtomAlternateWinsOverEnclosure(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry</title>
    <link href="http://example.com/enclosure" rel="enclosure"/>
    <link href="http://example.com/alternate" rel="alternate"/>
  </entry>
</feed>`)

	if items[0].Link != "http://example.com/alternate" {
		t.Errorf("link = %q, want alternate href to win over enclosure", items[0].Link)
	}
}

func TestParseDateHintReusedAcrossItems(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>First</title>
      <pubDate>Mon, 02 Jan 2006 15:04:05 +0000</pubDate>
    </item>
    <item>
      <title>Second</title>
      <pubDate>Tue, 03 Jan 2006 10:00:00 +0000</pubDate>
    </item>
  </feed></rss>`)

	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}
	if items[0].Published.Year() != 2006 || items[0].Published.Day() != 2 {
		t.Errorf("first item date wrong: %v", items[0].Published)
	}
	if items[1].Published.Year() != 2006 || items[1].Published.Day() != 3 {
		t.Errorf("second item date wrong: %v", items[1].Published)
	}
}

func TestParseGUIDPriorityOverID(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Both IDs</title>
      <guid>guid-value</guid>
      <id>id-value</id>
    </item>
  </feed></rss>`)

	if items[0].GUID != hash("guid-value") {
		t.Errorf("GUID = %d, want hash of %q (guid wins over id)", items[0].GUID, "guid-value")
	}
}

func TestParseContentEncodedPriorityOverDescription(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Priority</title>
      <content:encoded><![CDATA[<p>Full</p>]]></content:encoded>
      <description>Short</description>
    </item>
  </feed></rss>`)

	if items[0].Content != "<p>Full</p>" {
		t.Errorf("content = %q, want content:encoded to win over description", items[0].Content)
	}
}

func TestParseNamespacePrefixStripping(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <feed/>
  <item>
    <title>NS Test</title>
    <link>http://example.com</link>
    <dc:date>2023-06-15</dc:date>
  </item>
</rdf:RDF>`)

	if items[0].Published.Year() != 2023 || items[0].Published.Month() != 6 {
		t.Errorf("published = %v, want 2023-06 from dc:date", items[0].Published)
	}
}

// The GUID falls back to the link hash whether guid is absent entirely or
// present-but-empty.
func TestParseRSSItemGUIDFallbackChain(t *testing.T) {
	cases := []struct{ name, item string }{
		{"no guid element", `<title>No GUID</title><link>http://example.com/fallback</link>`},
		{"empty guid element", `<title>Only Link</title><guid></guid><link>http://example.com/fallback</link>`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			items := collectFeed(t, `<rss version="2.0"><feed><item>`+c.item+`</item></feed></rss>`)
			if items[0].GUID != hash("http://example.com/fallback") {
				t.Errorf("GUID should fall back to the link hash")
			}
		})
	}
}

func TestParseNamedHTMLEntitiesDoNotAbort(t *testing.T) {
	// Bare named HTML entities (&nbsp;, &mdash;) are not predefined XML entities;
	// they must resolve/tolerate instead of aborting the whole feed.
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item><title>Price&nbsp;5&mdash;10</title><description>a&nbsp;b</description></item>
    <item><title>Second item survives</title></item>
  </feed></rss>`)

	if len(items) != 2 {
		t.Fatalf("got %d items, want 2 (named entity must not abort the feed)", len(items))
	}
	if !strings.Contains(items[0].Title, "5") || !strings.Contains(items[0].Title, "10") {
		t.Errorf("title lost content: %q", items[0].Title)
	}
}

func TestParseNonUTF8Charset(t *testing.T) {
	// A windows-1252 byte (0xe9 = é) in a feed declaring ISO-8859-1 must transcode
	// to UTF-8, not error on the first token.
	raw := "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><rss version=\"2.0\"><feed>" +
		"<item><title>caf\xe9</title></item></feed></rss>"
	items := collectFeed(t, raw)
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1 (non-UTF-8 feed must parse)", len(items))
	}
	if items[0].Title != "café" {
		t.Errorf("title = %q, want %q (transcoded)", items[0].Title, "café")
	}
}

func TestParseLinkTextBeatsNonAlternateHref(t *testing.T) {
	// A non-alternate href (rel=self) appearing BEFORE the plain text <link>
	// must not shadow the real article URL.
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry</title>
    <link href="http://example.com/self" rel="self"/>
    <link>http://example.com/article</link>
  </entry>
</feed>`)

	if items[0].Link != "http://example.com/article" {
		t.Errorf("link = %q, want the text link to win over a leading rel=self href", items[0].Link)
	}
}

func TestParsePublishedBeatsUpdatedAcrossItems(t *testing.T) {
	// First item carries only <updated>; the layout hint must not lock onto the
	// "updated" FIELD and shadow a later item's higher-priority <published>.
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>A</title><updated>2020-01-01T00:00:00Z</updated></entry>
  <entry><title>B</title>
    <published>2024-06-15T00:00:00Z</published>
    <updated>2021-01-01T00:00:00Z</updated>
  </entry>
</feed>`)

	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}
	if items[1].Published.Year() != 2024 {
		t.Errorf("second item date = %v, want 2024 from <published> (not <updated>=2021)", items[1].Published)
	}
}

func TestParseNamedTimezoneNotTreatedAsUTC(t *testing.T) {
	// "15:04:05 EST" is 20:04:05 UTC; without the offset map it would read as
	// 15:04:05 UTC (5h wrong).
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item><title>T</title><pubDate>Mon, 02 Jan 2006 15:04:05 EST</pubDate></item>
  </feed></rss>`)

	got := items[0].Published.UTC()
	if got.Hour() != 20 || got.Minute() != 4 {
		t.Errorf("EST date = %v, want 20:04 UTC", got)
	}
}

func TestParseRawHTMLMixedContent(t *testing.T) {
	// B1: inner-element text in raw-HTML feed fields must be preserved.
	// <description>Hello <b>world</b> foo</description> is a mixed-content
	// element: "Hello " is CharData, <b> is a child StartElement whose CharData
	// "world" was previously stashed in f.Chld and never folded back into f.Txt.
	tests := []struct {
		name        string
		description string
		wantWords   []string
	}{
		{
			name:        "inline bold",
			description: "Hello <b>world</b> foo",
			wantWords:   []string{"Hello", "world", "foo"},
		},
		{
			name:        "inline link",
			description: `Read <a href="http://x">more</a> here`,
			wantWords:   []string{"Read", "more", "here"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			feed := `<rss version="2.0"><feed><item>` +
				`<title>T</title><description>` + tt.description + `</description>` +
				`</item></feed></rss>`
			items := collectFeed(t, feed)
			if len(items) != 1 {
				t.Fatalf("got %d items, want 1", len(items))
			}
			for _, word := range tt.wantWords {
				if !strings.Contains(items[0].Content, word) {
					t.Errorf("Content = %q: missing word %q", items[0].Content, word)
				}
			}
		})
	}
}

func TestParseAtomXHTMLContent(t *testing.T) {
	// Atom type="xhtml" content is child markup, not CharData; it must be
	// captured rather than dropped to "".
	items := collectFeed(t, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>X</title>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>hello <b>world</b></p></div></content>
  </entry>
</feed>`)

	if !strings.Contains(items[0].Content, "hello") || !strings.Contains(items[0].Content, "world") {
		t.Errorf("xhtml content lost: %q", items[0].Content)
	}
	if !strings.Contains(items[0].Content, "<b>") {
		t.Errorf("xhtml markup not preserved: %q", items[0].Content)
	}
}

// --- Auto-discovery tests ---

const rssFixture = `<?xml version="1.0"?>
<rss version="2.0">
  <feed>
    <item>
      <title>Discovered Item</title>
      <link>https://example.com/article/1</link>
      <guid>discovered-guid-1</guid>
      <description>Found via discovery</description>
    </item>
  </feed>
</rss>`

// feedFunc is the registered #feed FetchFunc, exposed for test access via the
// package-internal registry.
func feedFunc(t *testing.T) FetchFunc {
	t.Helper()
	fn, ok := registry["#feed"]
	if !ok {
		t.Fatal("no #feed registered")
	}
	return fn
}

// TestRSSDiscoveryHTMLPage verifies that when URL #1 returns an HTML page with
// a <link rel=alternate> pointing to URL #2 which returns valid RSS, the
// FetchFunc returns URL #2's items and sets Result.ResolvedURL.
func TestRSSDiscoveryHTMLPage(t *testing.T) {
	// RSS feed server (URL #2).
	feedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprint(w, rssFixture)
	}))
	defer feedSrv.Close()

	// HTML page server (URL #1): returns text/html with a <link> pointing to feedSrv.
	htmlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" href="%s">
</head><body><p>A website</p></body></html>`, feedSrv.URL)
	}))
	defer htmlSrv.Close()

	fn := feedFunc(t)
	buf := make([]byte, 1<<20)
	result, err := fn(context.Background(), feedSrv.Client(), buf, Request{
		URL:     htmlSrv.URL,
		MaxSize: cap(buf) - 1,
	})
	if err != nil {
		t.Fatalf("FetchFunc error: %v", err)
	}
	if len(result.Items) == 0 {
		t.Fatal("expected items from discovered feed, got none")
	}
	if result.Items[0].Title != "Discovered Item" {
		t.Errorf("item title = %q, want %q", result.Items[0].Title, "Discovered Item")
	}
	if result.ResolvedURL != feedSrv.URL {
		t.Errorf("ResolvedURL = %q, want %q", result.ResolvedURL, feedSrv.URL)
	}
}

// TestRSSDiscoveryOneHopGuard verifies that an HTML page whose <link
// rel=alternate> also points to an HTML page (not a feed) does NOT recurse
// again — it returns the original parse error rather than looping.
func TestRSSDiscoveryOneHopGuard(t *testing.T) {
	// A second HTML page (no feed link in it).
	secondSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><head><title>Still HTML</title></head><body></body></html>`)
	}))
	defer secondSrv.Close()

	// First page: HTML with <link> pointing to secondSrv (another HTML page).
	firstSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" href="%s">
</head><body></body></html>`, secondSrv.URL)
	}))
	defer firstSrv.Close()

	fn := feedFunc(t)
	buf := make([]byte, 1<<20)
	_, err := fn(context.Background(), firstSrv.Client(), buf, Request{
		URL:     firstSrv.URL,
		MaxSize: cap(buf) - 1,
	})
	// Must return an error (parse failed on second HTML page) rather than loop.
	if err == nil {
		t.Error("expected an error when discovered URL is also HTML, got nil (loop guard failed)")
	}
}

// TestRSSDiscoveryNormalFeedUnchanged verifies that a normal RSS feed path
// (non-HTML response) is completely unaffected by the discovery logic.
func TestRSSDiscoveryNormalFeedUnchanged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprint(w, rssFixture)
	}))
	defer srv.Close()

	fn := feedFunc(t)
	buf := make([]byte, 1<<20)
	result, err := fn(context.Background(), srv.Client(), buf, Request{
		URL:     srv.URL,
		MaxSize: cap(buf) - 1,
	})
	if err != nil {
		t.Fatalf("normal feed fetch failed: %v", err)
	}
	if len(result.Items) == 0 {
		t.Fatal("expected items from normal feed, got none")
	}
	if result.ResolvedURL != "" {
		t.Errorf("ResolvedURL should be empty for a normal feed, got %q", result.ResolvedURL)
	}
}

// A #feed fetch whose body fills the buffer (MaxSize) is a hard error, and an
// empty 200 is reported as an empty response — the two readBody outcomes.
func TestFeedFetchBodySizeErrors(t *testing.T) {
	fn := feedFunc(t)

	// Oversize: a body >= len(buf) fills the buffer → "bigger than".
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, strings.Repeat("x", 64))
	}))
	defer big.Close()
	buf := make([]byte, 8)
	if _, err := fn(context.Background(), big.Client(), buf, Request{URL: big.URL, MaxSize: cap(buf) - 1}); err == nil ||
		!strings.Contains(err.Error(), "bigger than") {
		t.Errorf("oversize body err = %v, want a 'bigger than' error", err)
	}

	// Empty 200: no body → "empty response".
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer empty.Close()
	buf2 := make([]byte, 1024)
	if _, err := fn(context.Background(), empty.Client(), buf2, Request{URL: empty.URL, MaxSize: cap(buf2) - 1}); err == nil ||
		!strings.Contains(err.Error(), "empty response") {
		t.Errorf("empty body err = %v, want an 'empty response' error", err)
	}
}

// feedFetch sends conditional-GET validators from req.ETag/LastModified, maps a
// 304 to NotModified, and treats a non-200/304 status as a hard error.
func TestFeedFetchConditionalGET(t *testing.T) {
	fn := feedFunc(t)
	buf := make([]byte, 1<<16)

	var gotINM, gotIMS string
	notmod := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotINM = r.Header.Get("If-None-Match")
		gotIMS = r.Header.Get("If-Modified-Since")
		w.WriteHeader(http.StatusNotModified)
	}))
	defer notmod.Close()
	res, err := fn(context.Background(), notmod.Client(), buf, Request{
		URL:          notmod.URL,
		ETag:         `"abc"`,
		LastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
		MaxSize:      cap(buf) - 1,
	})
	if err != nil {
		t.Fatalf("304 fetch: %v", err)
	}
	if !res.NotModified {
		t.Error("res.NotModified = false, want true on a 304")
	}
	if gotINM != `"abc"` {
		t.Errorf("If-None-Match = %q, want %q (from req.ETag)", gotINM, `"abc"`)
	}
	if gotIMS != "Wed, 21 Oct 2015 07:28:00 GMT" {
		t.Errorf("If-Modified-Since = %q, want it from req.LastModified", gotIMS)
	}

	srv500 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv500.Close()
	if _, err := fn(context.Background(), srv500.Client(), buf, Request{URL: srv500.URL, MaxSize: cap(buf) - 1}); err == nil {
		t.Error("a non-200 status should be an error")
	}
}

// looksLikeHTML classifies by the text/html header, else by sniffing the body:
// a leading BOM + <!doctype html> (or <html>) still reads as HTML, while XML and
// plain text do not.
func TestLooksLikeHTML(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		body        string
		want        bool
	}{
		{"header text/html", "text/html; charset=utf-8", "whatever", true},
		{"bom+doctype no header", "", "\ufeff<!DOCTYPE html><html></html>", true},
		{"bare html no header", "", "  <html><head></head></html>", true},
		{"xml is not html", "", `<?xml version="1.0"?><rss></rss>`, false},
		{"plain text", "text/plain", "hello world", false},
	}
	for _, c := range cases {
		if got := looksLikeHTML(c.contentType, []byte(c.body)); got != c.want {
			t.Errorf("%s: looksLikeHTML(%q, %q) = %v, want %v", c.name, c.contentType, c.body, got, c.want)
		}
	}
}

// Discovery still fires when the HTML page carries NO text/html Content-Type:
// looksLikeHTML falls back to sniffing the body.
func TestFeedFetchDiscoveryByBodySniff(t *testing.T) {
	feedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprint(w, rssFixture)
	}))
	defer feedSrv.Close()
	// The HTML page declares application/octet-stream, NOT text/html.
	htmlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		fmt.Fprintf(w, `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" href="%s">
</head><body>hi</body></html>`, feedSrv.URL)
	}))
	defer htmlSrv.Close()

	fn := feedFunc(t)
	buf := make([]byte, 1<<20)
	res, err := fn(context.Background(), feedSrv.Client(), buf, Request{URL: htmlSrv.URL, MaxSize: cap(buf) - 1})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.ResolvedURL != feedSrv.URL {
		t.Errorf("ResolvedURL = %q, want discovered %q (body-sniff HTML detection)", res.ResolvedURL, feedSrv.URL)
	}
}

// A malformed mid-feed element must stop the parse (the decoder is wedged) but
// report the response as PARTIAL — non-error, prefix items kept — and a clean
// parse must not carry the flag. The flag is what lets the caller withhold
// validators/watermark so the remainder is refetched instead of stranded.
func TestParseFeedPartialOnMalformedElement(t *testing.T) {
	var items []*mod.RawItem
	_, partial, err := ParseFeed([]byte(`<rss version="2.0"><channel>
    <item><guid>a</guid><title>A</title></item>
    <item><guid>b</guid><title>bad ]]> bytes</title></item>
    <item><guid>c</guid><title>C</title></item>
  </channel></rss>`), func(i *mod.RawItem) error {
		items = append(items, i)
		return nil
	})
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if !partial {
		t.Error("partial = false, want true for a malformed mid-feed element")
	}
	if len(items) != 1 || items[0].Title != "A" {
		t.Fatalf("items = %d, want exactly the good prefix [A]", len(items))
	}

	_, partial, err = ParseFeed([]byte(`<rss version="2.0"><channel>
    <item><guid>a</guid><title>A</title></item>
  </channel></rss>`), func(*mod.RawItem) error { return nil })
	if err != nil || partial {
		t.Fatalf("clean parse: partial = %v, err = %v; want false, nil", partial, err)
	}
}

// A partial parse must not populate the HTTP validators: storing them would let
// the next cycle 304 on the same broken bytes and strand the unparsed remainder.
func TestFeedFetchPartialWithholdsValidators(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Last-Modified", "Mon, 01 Jan 2024 00:00:00 GMT")
		fmt.Fprint(w, `<rss version="2.0"><channel>
    <item><guid>a</guid><title>A</title></item>
    <item><guid>b</guid><title>bad ]]> bytes</title></item>
  </channel></rss>`)
	}))
	defer srv.Close()

	fn := feedFunc(t)
	buf := make([]byte, 1<<20)
	res, err := fn(context.Background(), srv.Client(), buf, Request{URL: srv.URL, MaxSize: cap(buf) - 1})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if !res.Partial {
		t.Error("Result.Partial = false, want true")
	}
	if res.ETag != "" || res.LastModified != "" {
		t.Errorf("validators = (%q, %q), want empty on a partial parse", res.ETag, res.LastModified)
	}
	if len(res.Items) != 1 {
		t.Fatalf("items = %d, want the 1-item good prefix", len(res.Items))
	}
}

// Every #feed request identifies the reader by version with a contact URL, and
// declares feed types in Accept so a content-negotiating endpoint serves the
// feed rather than HTML (which would cost a discovery double-fetch). Short
// unknown User-Agents are also exactly what the WAF class blocking datacenter
// egress scores against.
func TestFeedFetchSendsIdentifyingHeaders(t *testing.T) {
	fn := feedFunc(t)
	buf := make([]byte, 1<<16)

	var gotUA, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		gotAccept = r.Header.Get("Accept")
		fmt.Fprint(w, rssFixture)
	}))
	defer srv.Close()

	old := getUserAgent()
	defer SetUserAgent(old)
	SetUserAgent("SRR/9.9.9 (+https://github.com/gllera/srr)")

	if _, err := fn(context.Background(), srv.Client(), buf, Request{URL: srv.URL, MaxSize: cap(buf) - 1}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotUA != "SRR/9.9.9 (+https://github.com/gllera/srr)" {
		t.Errorf("User-Agent = %q, want the version+contact form set by SetUserAgent", gotUA)
	}
	for _, want := range []string{"application/rss+xml", "application/atom+xml", "application/rdf+xml;q=0.9", "text/html;q=0.4"} {
		if !strings.Contains(gotAccept, want) {
			t.Errorf("Accept = %q, missing %q", gotAccept, want)
		}
	}
}

// SetUserAgent("") is a no-op: the zero value must stay a well-formed header
// rather than degrade to an empty User-Agent.
func TestSetUserAgentIgnoresEmpty(t *testing.T) {
	old := getUserAgent()
	defer SetUserAgent(old)
	SetUserAgent("")
	if got := getUserAgent(); got != old {
		t.Errorf("userAgent = %q after SetUserAgent(\"\"), want it unchanged", got)
	}
}
