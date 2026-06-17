package ingest

import (
	"fmt"
	"strings"
	"testing"

	"srrb/mod"
)

func collectFeed(t *testing.T, data string) []*mod.RawItem {
	t.Helper()
	var items []*mod.RawItem
	err := ParseFeed([]byte(data), func(item *mod.RawItem) error {
		items = append(items, item)
		return nil
	})
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	return items
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

func TestParseGUIDFallbackToLink(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>No GUID</title>
      <link>http://example.com/fallback</link>
    </item>
  </feed></rss>`)

	if items[0].GUID != hash("http://example.com/fallback") {
		t.Errorf("guid should fall back to link hash")
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

func TestParseStopFeed(t *testing.T) {
	count := 0
	err := ParseFeed([]byte(`<rss version="2.0"><feed>
    <item><title>A</title></item>
    <item><title>B</title></item>
    <item><title>C</title></item>
  </feed></rss>`), func(item *mod.RawItem) error {
		count++
		if count == 2 {
			return ErrStopFeed
		}
		return nil
	})

	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if count != 2 {
		t.Errorf("callback called %d times, want 2", count)
	}
}

func TestParseUnsupportedFormat(t *testing.T) {
	err := ParseFeed([]byte(`<html><body>Not a feed</body></html>`), func(*mod.RawItem) error {
		t.Fatal("callback should not be called")
		return nil
	})
	if err == nil {
		t.Error("expected error for unsupported format")
	}
}

func TestParseInvalidXML(t *testing.T) {
	err := ParseFeed([]byte(`not xml at all`), func(*mod.RawItem) error {
		return nil
	})
	if err == nil {
		t.Error("expected error for invalid XML")
	}
}

func TestHashDeterministic(t *testing.T) {
	h1 := hash("test-guid-12345")
	h2 := hash("test-guid-12345")
	if h1 != h2 {
		t.Errorf("hash not deterministic: %d != %d", h1, h2)
	}
}

func TestHashDistinct(t *testing.T) {
	h1 := hash("guid-a")
	h2 := hash("guid-b")
	if h1 == h2 {
		t.Errorf("different inputs produced same hash: %d", h1)
	}
}

func TestHashEmptyString(t *testing.T) {
	h := hash("")
	if h == 0 {
		t.Error("hash of empty string should not be 0 (FNV offset basis)")
	}
	if h != hash("") {
		t.Error("hash of empty string not deterministic")
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
	err := ParseFeed([]byte(`<rss version="2.0"><feed>
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

func TestParseLinkRSSText(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Text Link</title>
      <link>http://example.com/text</link>
    </item>
  </feed></rss>`)

	if items[0].Link != "http://example.com/text" {
		t.Errorf("link = %q", items[0].Link)
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

func TestParseEmptyXML(t *testing.T) {
	err := ParseFeed([]byte(""), func(*mod.RawItem) error {
		return nil
	})
	if err == nil {
		t.Error("expected error for empty input")
	}
}

func TestParseRawFieldPreserved(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Raw Test</title>
      <customField>custom value</customField>
    </item>
  </feed></rss>`)

	if items[0].Raw == nil {
		t.Error("Raw field should be preserved")
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

func TestParseRSSItemGUIDFallbackChain(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><feed>
    <item>
      <title>Only Link</title>
      <guid></guid>
      <link>http://example.com/linkonly</link>
    </item>
  </feed></rss>`)

	if items[0].GUID != hash("http://example.com/linkonly") {
		t.Errorf("GUID should fall back to link hash when guid is empty")
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
