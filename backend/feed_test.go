package main

import (
	"fmt"
	"testing"
	"time"

	"srrb/mod"
)

func collectFeed(t *testing.T, data string) []*mod.RawItem {
	t.Helper()
	var items []*mod.RawItem
	err := parseFeed([]byte(data), func(item *mod.RawItem) error {
		items = append(items, item)
		return nil
	})
	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	return items
}

func TestParseRSS2(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
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
  </channel>
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
  <channel/>
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
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>No Content</title>
      <description>Only description</description>
    </item>
  </channel></rss>`)

	if items[0].Content != "Only description" {
		t.Errorf("content = %q, want description fallback", items[0].Content)
	}
}

func TestParseGUIDFallbackToLink(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>No GUID</title>
      <link>http://example.com/fallback</link>
    </item>
  </channel></rss>`)

	if items[0].GUID != hash("http://example.com/fallback") {
		t.Errorf("guid should fall back to link hash")
	}
}

func TestParseDateFallbackToNow(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item><title>No Date</title></item>
  </channel></rss>`)

	if time.Since(*items[0].Published) > time.Second {
		t.Errorf("published = %v, expected ~now", items[0].Published)
	}
}

func TestParseCDATA(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title><![CDATA[Title with <special> chars]]></title>
      <description><![CDATA[<p>HTML content</p>]]></description>
    </item>
  </channel></rss>`)

	if items[0].Title != "Title with <special> chars" {
		t.Errorf("title = %q", items[0].Title)
	}
	if items[0].Content != "<p>HTML content</p>" {
		t.Errorf("content = %q", items[0].Content)
	}
}

func TestParseStopFeed(t *testing.T) {
	count := 0
	err := parseFeed([]byte(`<rss version="2.0"><channel>
    <item><title>A</title></item>
    <item><title>B</title></item>
    <item><title>C</title></item>
  </channel></rss>`), func(item *mod.RawItem) error {
		count++
		if count == 2 {
			return ErrStopFeed
		}
		return nil
	})

	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	if count != 2 {
		t.Errorf("callback called %d times, want 2", count)
	}
}

func TestParseUnsupportedFormat(t *testing.T) {
	err := parseFeed([]byte(`<html><body>Not a feed</body></html>`), func(*mod.RawItem) error {
		t.Fatal("callback should not be called")
		return nil
	})
	if err == nil {
		t.Error("expected error for unsupported format")
	}
}

func TestParseInvalidXML(t *testing.T) {
	err := parseFeed([]byte(`not xml at all`), func(*mod.RawItem) error {
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
	// Should be deterministic
	if h != hash("") {
		t.Error("hash of empty string not deterministic")
	}
}

func TestParseEmptyFeed(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
  </channel>
</rss>`)

	if len(items) != 0 {
		t.Errorf("got %d items, want 0", len(items))
	}
}

func TestParseCallbackError(t *testing.T) {
	testErr := fmt.Errorf("custom callback error")
	err := parseFeed([]byte(`<rss version="2.0"><channel>
    <item><title>A</title></item>
  </channel></rss>`), func(*mod.RawItem) error {
		return testErr
	})

	if err == nil {
		t.Error("expected callback error to propagate")
	}
	if err != testErr {
		t.Errorf("got error %v, want %v", err, testErr)
	}
}

func TestParseGUIDFallbackToEmptyHash(t *testing.T) {
	// No guid, no link → hash of empty string
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item><title>No ID</title></item>
  </channel></rss>`)

	if items[0].GUID != hash("") {
		t.Errorf("guid = %d, want hash of empty string (%d)", items[0].GUID, hash(""))
	}
}

func TestParseLinkAtomNonAlternate(t *testing.T) {
	// Only non-alternate link → should use as fallback
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
	// Link with href but no rel → should be preferred (treated as alternate)
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
	// RSS link as text content
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Text Link</title>
      <link>http://example.com/text</link>
    </item>
  </channel></rss>`)

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
			items := collectFeed(t, fmt.Sprintf(`<rss version="2.0"><channel>
    <item>
      <title>Date Test</title>
      <pubDate>%s</pubDate>
    </item>
  </channel></rss>`, tt.date))

			if items[0].Published.Year() != tt.year {
				t.Errorf("year = %d, want %d", items[0].Published.Year(), tt.year)
			}
		})
	}
}

func TestParseContentPriority(t *testing.T) {
	// content:encoded should take priority over description when both present
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Priority</title>
      <description>Desc</description>
      <summary>Summary</summary>
    </item>
  </channel></rss>`)

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
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item><title>A</title></item>
    <item><title>B</title></item>
    <item><title>C</title></item>
    <item><title>D</title></item>
    <item><title>E</title></item>
  </channel></rss>`)

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
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Attr Test</title>
      <guid isPermaLink="false">custom-guid-123</guid>
    </item>
  </channel></rss>`)

	if items[0].GUID != hash("custom-guid-123") {
		t.Errorf("guid should use text content, not attributes")
	}
}

func TestParseEmptyXML(t *testing.T) {
	err := parseFeed([]byte(""), func(*mod.RawItem) error {
		return nil
	})
	if err == nil {
		t.Error("expected error for empty input")
	}
}

func TestParseRawFieldPreserved(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Raw Test</title>
      <customField>custom value</customField>
    </item>
  </channel></rss>`)

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
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>First</title>
      <pubDate>Mon, 02 Jan 2006 15:04:05 +0000</pubDate>
    </item>
    <item>
      <title>Second</title>
      <pubDate>Tue, 03 Jan 2006 10:00:00 +0000</pubDate>
    </item>
  </channel></rss>`)

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
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Both IDs</title>
      <guid>guid-value</guid>
      <id>id-value</id>
    </item>
  </channel></rss>`)

	if items[0].GUID != hash("guid-value") {
		t.Errorf("GUID = %d, want hash of %q (guid wins over id)", items[0].GUID, "guid-value")
	}
}

func TestParseContentEncodedPriorityOverDescription(t *testing.T) {
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Priority</title>
      <content:encoded><![CDATA[<p>Full</p>]]></content:encoded>
      <description>Short</description>
    </item>
  </channel></rss>`)

	if items[0].Content != "<p>Full</p>" {
		t.Errorf("content = %q, want content:encoded to win over description", items[0].Content)
	}
}

func TestParseNamespacePrefixStripping(t *testing.T) {
	items := collectFeed(t, `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel/>
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
	items := collectFeed(t, `<rss version="2.0"><channel>
    <item>
      <title>Only Link</title>
      <guid></guid>
      <link>http://example.com/linkonly</link>
    </item>
  </channel></rss>`)

	if items[0].GUID != hash("http://example.com/linkonly") {
		t.Errorf("GUID should fall back to link hash when guid is empty")
	}
}
