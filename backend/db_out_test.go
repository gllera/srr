package main

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// rssRoot is the minimal RSS 2.0 envelope for test parsing.
type rssRoot struct {
	XMLName xml.Name   `xml:"rss"`
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Title string    `xml:"title"`
	Items []rssItem `xml:"item"`
}

type rssItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	GUID        string `xml:"guid"`
	PubDate     string `xml:"pubDate"`
	Description string `xml:"description"`
}

// jsonFeed1 is the minimal JSON Feed 1.1 shape for test parsing.
type jsonFeed1 struct {
	Version string          `json:"version"`
	Title   string          `json:"title"`
	FeedURL string          `json:"feed_url"`
	Items   []jsonFeedItem1 `json:"items"`
}

type jsonFeedItem1 struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	ContentHTML string `json:"content_html"`
	DatePub     string `json:"date_published"`
}

// setupOutFeedDB creates a small store with two feeds tagged "news" and "tech"
// and returns the DB, dir, and the two Feed values.
func setupOutFeedDB(t *testing.T) (*DB, string, *Feed, *Feed) {
	t.Helper()
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch1 := &Feed{id: 0, URL: "http://a", Tag: "news"}
	ch2 := &Feed{id: 1, URL: "http://b", Tag: "tech"}
	c.Feeds = map[int]*Feed{
		ch1.id: ch1,
		ch2.id: ch2,
	}

	// Write several articles spread across both feeds.
	for i := 1; i <= 5; i++ {
		var ch *Feed
		if i%2 == 0 {
			ch = ch2
		} else {
			ch = ch1
		}
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: ch, Title: fmt.Sprintf("Art%d", i), Content: fmt.Sprintf("<p>Body%d</p>", i),
				Link: fmt.Sprintf("http://example.com/%d", i), Published: int64(i * 1000)},
		}); err != nil {
			t.Fatalf("PutArticles #%d: %v", i, err)
		}
	}
	return db, dir, ch1, ch2
}

// TestSyncOutFeedsNopWhenEmpty verifies SyncOutFeeds is a no-op when Out is nil.
func TestSyncOutFeedsNopWhenEmpty(t *testing.T) {
	db, dir, _, _ := setupOutFeedDB(t)
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds (empty Out): %v", err)
	}
	// No out/ directory should have been created.
	if entries, _ := os.ReadDir(filepath.Join(dir, "out")); len(entries) > 0 {
		t.Errorf("expected no out/ files, got %v", entries)
	}
}

// TestSyncOutFeedsNopWhenCdnURLUnset verifies SyncOutFeeds skips when CdnURL="".
func TestSyncOutFeedsNopWhenCdnURLUnset(t *testing.T) {
	db, dir, _, _ := setupOutFeedDB(t)
	globals.CdnURL = "" // explicitly unset

	db.core.Out = []OutFeed{
		{Name: "news", Format: "rss", Tags: []string{"news"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds (no CdnURL): %v", err)
	}
	// No out/ file should be written.
	if _, err := os.Stat(filepath.Join(dir, "out/news.rss")); !os.IsNotExist(err) {
		t.Error("out/news.rss should not exist when CdnURL is empty")
	}
}

// TestSyncOutFeedsReturnsErrorOnWriteFailure verifies SyncOutFeeds signals a
// per-output write failure to its caller (so cmd_fetch leaves lastOutSig
// unadvanced and retries next cycle) instead of silently swallowing it. A file
// where the out/ directory belongs makes the Put fail deterministically.
func TestSyncOutFeedsReturnsErrorOnWriteFailure(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000
	ch := &Feed{id: 0, URL: "http://a", Tag: "news"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "Art1", Content: "<p>b</p>", Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	// Occupy "out" with a regular file so writing out/good.rss can't create the dir.
	if err := os.WriteFile(filepath.Join(dir, "out"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	db.core.Out = []OutFeed{{Name: "good", Format: "rss", Tags: []string{"news"}, Limit: 10}}
	if err := db.SyncOutFeeds(ctx); err == nil {
		t.Fatal("SyncOutFeeds should return an error when an out-feed write fails")
	}
}

// TestSyncOutFeedsUnsafeNameSkipped verifies the defense-in-depth guard in
// syncOneOutFeed: an Out entry whose Name bypasses the command gate (e.g. from
// a hand-edited/corrupted db.gz) is skipped with a warning and no file is
// written, while a valid-named entry in the same Out slice is still written.
func TestSyncOutFeedsUnsafeNameSkipped(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch := &Feed{id: 0, URL: "http://a", Tag: "news"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "Art1", Content: "<p>body</p>", Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	// Inject an unsafe name directly into core.Out, bypassing the command gate.
	// A local/SFTP backend would resolve "out/../../db.gz" outside out/ without
	// the guard. The valid entry must still be written.
	db.core.Out = []OutFeed{
		{Name: "../../db", Format: "rss", Tags: []string{"news"}, Limit: 10},
		{Name: "good", Format: "rss", Tags: []string{"news"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	// The unsafe entry must NOT have been written. On local backend the path
	// "../../db.rss" relative to the store dir would escape the store; we verify
	// no such path exists and that no file named "db.rss" was clobbered.
	unsafePath := filepath.Join(dir, "../../db.rss")
	if _, err := os.Stat(unsafePath); !os.IsNotExist(err) {
		t.Errorf("unsafe out file %q should not exist", unsafePath)
	}
	// Also verify no "out/../../db.rss" sub-path inside the store was created.
	if _, err := os.Stat(filepath.Join(dir, "out", "../../db.rss")); !os.IsNotExist(err) {
		t.Errorf("unsafe out file inside store dir should not exist")
	}

	// The valid entry must have been written normally.
	if _, err := os.Stat(filepath.Join(dir, "out/good.rss")); os.IsNotExist(err) {
		t.Error("out/good.rss should have been written for the valid entry")
	}
}

// TestSyncOutFeedsRSS verifies RSS 2.0 output: valid XML, correct items (only
// matching tag), newest-first order, and Limit cap.
func TestSyncOutFeedsRSS(t *testing.T) {
	db, dir, _, _ := setupOutFeedDB(t)
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	// "news" tag → feeds whose Tag == "news" → ch1 (id 0)
	// Articles from ch1: Art1 (pub 1000), Art3 (pub 3000), Art5 (pub 5000)
	db.core.Out = []OutFeed{
		{Name: "news", Format: "rss", Tags: []string{"news"}, Limit: 2},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	rssPath := filepath.Join(dir, "out/news.rss")
	data, err := os.ReadFile(rssPath)
	if err != nil {
		t.Fatalf("read out/news.rss: %v", err)
	}

	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS: %v (raw: %s)", err, data)
	}

	// Limit 2: should get Art5, Art3 (newest first).
	if len(feed.Channel.Items) != 2 {
		t.Fatalf("items = %d, want 2 (Limit)", len(feed.Channel.Items))
	}
	if feed.Channel.Items[0].Title != "Art5" {
		t.Errorf("item[0].Title = %q, want Art5", feed.Channel.Items[0].Title)
	}
	if feed.Channel.Items[1].Title != "Art3" {
		t.Errorf("item[1].Title = %q, want Art3", feed.Channel.Items[1].Title)
	}

	// Confirm pubDate parses.
	if _, err := time.Parse(time.RFC1123Z, feed.Channel.Items[0].PubDate); err != nil {
		t.Errorf("pubDate %q: %v", feed.Channel.Items[0].PubDate, err)
	}

	// XML must begin with the XML declaration.
	if !strings.HasPrefix(strings.TrimSpace(string(data)), "<?xml") {
		t.Errorf("RSS missing XML declaration: %s", string(data)[:min(80, len(data))])
	}
}

// TestSyncOutFeedsJSONFeed verifies JSON Feed 1.1 output: valid JSON,
// correct fields, newest-first order.
func TestSyncOutFeedsJSONFeed(t *testing.T) {
	db, dir, _, _ := setupOutFeedDB(t)
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	// Use feed-id selector instead of tag, for ch2 (id 1): Art2, Art4.
	db.core.Out = []OutFeed{
		{Name: "tech", Format: "json", Feeds: []int{1}, Limit: 10, Title: "Tech Feed"},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	jsonPath := filepath.Join(dir, "out/tech.json")
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("read out/tech.json: %v", err)
	}

	var feed jsonFeed1
	if err := json.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse JSON Feed: %v (raw: %s)", err, data)
	}

	if feed.Version != "https://jsonfeed.org/version/1.1" {
		t.Errorf("version = %q", feed.Version)
	}
	if feed.Title != "Tech Feed" {
		t.Errorf("title = %q, want Tech Feed", feed.Title)
	}
	if !strings.Contains(feed.FeedURL, "tech.json") {
		t.Errorf("feed_url = %q, want ...tech.json", feed.FeedURL)
	}
	// Art4 (pub 4000) > Art2 (pub 2000)
	if len(feed.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(feed.Items))
	}
	if feed.Items[0].Title != "Art4" {
		t.Errorf("item[0] = %q, want Art4", feed.Items[0].Title)
	}
	if feed.Items[1].Title != "Art2" {
		t.Errorf("item[1] = %q, want Art2", feed.Items[1].Title)
	}
	// date_published must be RFC3339.
	if _, err := time.Parse(time.RFC3339, feed.Items[0].DatePub); err != nil {
		t.Errorf("date_published %q: %v", feed.Items[0].DatePub, err)
	}
}

// TestSyncOutFeedsTagAndFeedUnion verifies that tags and feeds are unioned.
func TestSyncOutFeedsTagAndFeedUnion(t *testing.T) {
	db, dir, _, _ := setupOutFeedDB(t)
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	// Tags:"news" (ch1) ∪ FeedIDs:[1] (ch2) = all articles
	db.core.Out = []OutFeed{
		{Name: "all", Format: "rss", Tags: []string{"news"}, Feeds: []int{1}, Limit: 100},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/all.rss"))
	if err != nil {
		t.Fatalf("read out/all.rss: %v", err)
	}
	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS: %v", err)
	}
	if len(feed.Channel.Items) != 5 {
		t.Errorf("items = %d, want 5 (all articles)", len(feed.Channel.Items))
	}
}

// TestSyncOutFeedsRSSEscapesHTML verifies that HTML content in RSS description
// is properly escaped (no bare < or > outside CDATA that would break XML) AND
// that the title and content round-trip verbatim through the encode/decode.
func TestSyncOutFeedsRSSEscapesHTML(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch := &Feed{id: 0, URL: "http://a", Tag: "esc"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "Esc<Art>", Content: `<p>a &amp; b</p>`, Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "esc", Format: "rss", Tags: []string{"esc"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/esc.rss"))
	if err != nil {
		t.Fatalf("read out/esc.rss: %v", err)
	}

	// Must be parseable as valid XML.
	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS with HTML content: %v\n%s", err, data)
	}
	if len(feed.Channel.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(feed.Channel.Items))
	}
	// The title's <>-bearing text survives the XML entity-encode round-trip.
	if got := feed.Channel.Items[0].Title; got != "Esc<Art>" {
		t.Errorf("decoded title = %q, want %q (round-trip)", got, "Esc<Art>")
	}
	// The HTML content rides through CDATA verbatim (the &amp; entity stays a
	// literal five characters, the markup intact).
	if got := feed.Channel.Items[0].Description; got != `<p>a &amp; b</p>` {
		t.Errorf("decoded content = %q, want %q (verbatim through CDATA)", got, `<p>a &amp; b</p>`)
	}
}

// TestSyncOutFeedsCDATATerminator verifies that article content containing the
// CDATA terminator "]]>" is escaped so the RSS output remains well-formed XML
// and the text round-trips correctly through an XML decoder.
func TestSyncOutFeedsCDATATerminator(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch := &Feed{id: 0, URL: "http://a", Tag: "cdata"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	// Content contains the CDATA terminator – would break naive CDATA wrapping.
	content := `<p>a ]]> b</p>`
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "CDataArt", Content: content, Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "cdata", Format: "rss", Tags: []string{"cdata"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/cdata.rss"))
	if err != nil {
		t.Fatalf("read out/cdata.rss: %v", err)
	}

	// Must parse as valid XML — the terminator must not break the document.
	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS with CDATA terminator: %v\n%s", err, data)
	}
	if len(feed.Channel.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(feed.Channel.Items))
	}
	// The decoded description must contain the original "]]>" text.
	if !strings.Contains(feed.Channel.Items[0].Description, "]]>") {
		t.Errorf("description = %q, want to contain ]]>", feed.Channel.Items[0].Description)
	}
}

// TestSyncOutFeedsWindowWidening verifies the tail-window-then-widen branch.
//
// Setup: limit=5, scanMultiple=10 → initial tail window k=50. We build a store
// with 5 "rare" articles at chron 0-4 (published 100-500) followed by 65
// "noise" articles (chron 5-69, published 1001-1065), for total=70. The tail
// window covers [70-50, 70) = [20, 70), which is entirely noise — the first
// walk collects 0 rare matches (< limit=5), from=20>0, so the widen branch
// fires and walks [0, 70), picking up all 5 rare articles.
func TestSyncOutFeedsWindowWidening(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	// Two feeds: "rare" (id 0, tag "rare") with 5 early articles, and "noise"
	// (id 1, tag "noise") with 65 later articles that dominate the tail window.
	rare := &Feed{id: 0, URL: "http://rare", Tag: "rare"}
	noise := &Feed{id: 1, URL: "http://noise", Tag: "noise"}
	c.Feeds = map[int]*Feed{rare.id: rare, noise.id: noise}

	const limit = 5
	// Insert the 5 rare articles first (low published timestamps → low chron).
	for i := 1; i <= 5; i++ {
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: rare, Title: fmt.Sprintf("Rare%d", i), Content: "r",
				Link: fmt.Sprintf("http://rare/%d", i), Published: int64(i * 100)},
		}); err != nil {
			t.Fatalf("PutArticles rare#%d: %v", i, err)
		}
	}
	// Insert 65 noise articles after (higher published timestamps → higher chron).
	// total = 5 + 65 = 70; k = min(5*10, 70) = 50; from = 70-50 = 20 > 0.
	// The tail window [20, 70) covers chron 20-69, all noise → 0 rare matches →
	// widen branch fires.
	for i := 1; i <= 65; i++ {
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: noise, Title: fmt.Sprintf("Noise%d", i), Content: "n",
				Link: fmt.Sprintf("http://noise/%d", i), Published: int64(1000 + i)},
		}); err != nil {
			t.Fatalf("PutArticles noise#%d: %v", i, err)
		}
	}

	// Sanity: confirm total and from > 0 so the widen branch is exercised.
	total := db.core.TotalArticles
	if total != 70 {
		t.Fatalf("total articles = %d, want 70", total)
	}
	k := limit * 10 // scanMultiple=10
	if k > total {
		k = total
	}
	from := total - k
	if from <= 0 {
		t.Fatalf("from = %d, want >0: widen branch would not fire", from)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "rare", Format: "rss", Tags: []string{"rare"}, Limit: limit},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/rare.rss"))
	if err != nil {
		t.Fatalf("read out/rare.rss: %v", err)
	}

	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS: %v\n%s", err, data)
	}

	// All 5 rare articles should appear (equals limit), collected via the widen
	// branch since the initial tail window [20, 70) missed them entirely.
	if len(feed.Channel.Items) != limit {
		t.Fatalf("items = %d, want %d (rare articles via widen)", len(feed.Channel.Items), limit)
	}
	// Newest-first: Rare5 (pub 500) … Rare1 (pub 100).
	for i := 0; i < limit; i++ {
		want := fmt.Sprintf("Rare%d", limit-i)
		if feed.Channel.Items[i].Title != want {
			t.Errorf("item[%d].Title = %q, want %q", i, feed.Channel.Items[i].Title, want)
		}
	}
}

// TestSyncOutFeedsAtomSelfLink verifies that the RSS output contains the atom
// self-link element with the correct namespace URI and that the document parses
// as valid XML. The dead xmlns:atom attr was removed; the atom:link carries its
// own namespace declaration.
func TestSyncOutFeedsAtomSelfLink(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch := &Feed{id: 0, URL: "http://a", Tag: "atom"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "AtomArt", Content: "<p>body</p>", Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "atomtest", Format: "rss", Tags: []string{"atom"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/atomtest.rss"))
	if err != nil {
		t.Fatalf("read out/atomtest.rss: %v", err)
	}

	// Must be valid XML.
	type atomLink struct {
		Href string `xml:"href,attr"`
		Rel  string `xml:"rel,attr"`
		Type string `xml:"type,attr"`
	}
	type channel struct {
		AtomLink atomLink `xml:"http://www.w3.org/2005/Atom link"`
	}
	type rssDoc struct {
		XMLName xml.Name `xml:"rss"`
		Channel channel  `xml:"channel"`
	}
	var doc rssDoc
	if err := xml.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse RSS for atom self-link: %v\n%s", err, data)
	}
	// The atom:link self element must carry the correct namespace URI.
	if doc.Channel.AtomLink.Href == "" {
		t.Errorf("atom:link href is empty; expected CDN URL\n%s", data)
	}
	if !strings.Contains(doc.Channel.AtomLink.Href, "atomtest.rss") {
		t.Errorf("atom:link href = %q, want ...atomtest.rss", doc.Channel.AtomLink.Href)
	}
	if doc.Channel.AtomLink.Rel != "self" {
		t.Errorf("atom:link rel = %q, want self", doc.Channel.AtomLink.Rel)
	}
	// The namespace URI must appear literally in the raw output (as an xmlns
	// declaration on the element itself, since we removed the outer xmlns:atom).
	const atomNS = "http://www.w3.org/2005/Atom"
	if !strings.Contains(string(data), atomNS) {
		t.Errorf("atom namespace %q missing from output:\n%s", atomNS, data)
	}
}

// TestSyncOutFeedsAbsoluteURLUnchanged verifies that an absolute URL in content
// (e.g. https://other.com/x.jpg) is left untouched by the asset rewrite step —
// only relative refs get the CDN prefix.
func TestSyncOutFeedsAbsoluteURLUnchanged(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch := &Feed{id: 0, URL: "http://a", Tag: "abs"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	absURL := "https://other.com/x.jpg"
	content := `<p><img src="` + absURL + `"> and <img src="assets/ab/0123456789abcdef.jpg"></p>`
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "AbsArt", Content: content, Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "absfeed", Format: "rss", Tags: []string{"abs"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/absfeed.rss"))
	if err != nil {
		t.Fatalf("read out/absfeed.rss: %v", err)
	}

	raw := string(data)
	// The absolute URL must be preserved as-is.
	if !strings.Contains(raw, absURL) {
		t.Errorf("absolute URL %q was modified in output:\n%s", absURL, raw)
	}
	// The relative asset ref must have been rewritten to CDN.
	if strings.Contains(raw, `src="assets/`) {
		t.Errorf("relative asset ref still present in output:\n%s", raw)
	}
	if !strings.Contains(raw, "https://cdn.example.com/assets/ab/0123456789abcdef.jpg") {
		t.Errorf("CDN-prefixed asset URL missing from output:\n%s", raw)
	}
}

func TestRewriteAssetURLsAudio(t *testing.T) {
	got, err := rewriteAssetURLs(`<audio src="assets/ab/0123456789abcdef.mp3"></audio>`, "https://cdn.example.com")
	if err != nil {
		t.Fatalf("rewriteAssetURLs: %v", err)
	}
	if !strings.Contains(got, "https://cdn.example.com/assets/ab/0123456789abcdef.mp3") {
		t.Errorf("audio src not absolutized:\n%s", got)
	}
	if strings.Contains(got, `src="assets/`) {
		t.Errorf("relative audio src still present:\n%s", got)
	}
}

// TestSyncOutFeedsSkipsExpired verifies syndication honors AddIdx: an article
// expired by retention (chron < its feed's AddIdx) must not be emitted into
// the out file — its assets are already deleted, so a stale item would
// syndicate 404s.
func TestSyncOutFeedsSkipsExpired(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	ch := &Feed{id: 0, URL: "http://a", Tag: "exp"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	// Three articles at chron 0..2 (oldest→newest).
	for i := 1; i <= 3; i++ {
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: ch, Title: fmt.Sprintf("Exp%d", i), Content: "<p>b</p>",
				Link: fmt.Sprintf("http://x/%d", i), Published: int64(i * 1000)},
		}); err != nil {
			t.Fatalf("PutArticles #%d: %v", i, err)
		}
	}

	// Simulate an expiration run having bumped past chron 0 and 1.
	ch.AddIdx = 2
	ch.Expired = 2

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "exp", Format: "rss", Tags: []string{"exp"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/exp.rss"))
	if err != nil {
		t.Fatalf("read out/exp.rss: %v", err)
	}
	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS: %v\n%s", err, data)
	}
	if len(feed.Channel.Items) != 1 {
		t.Fatalf("items = %d, want 1 (only the live article)", len(feed.Channel.Items))
	}
	if feed.Channel.Items[0].Title != "Exp3" {
		t.Errorf("item[0].Title = %q, want Exp3", feed.Channel.Items[0].Title)
	}
	for _, gone := range []string{"Exp1", "Exp2"} {
		if strings.Contains(string(data), gone) {
			t.Errorf("expired article %s still present in output:\n%s", gone, data)
		}
	}
}

// TestSyncOutFeedsSkipsExpiredInWidenedWalk verifies the AddIdx filter also
// applies on the widened full-store walk (the second pass, when the tail
// window doesn't fill the limit). Same store shape as
// TestSyncOutFeedsWindowWidening, but the rare feed's first article is
// expired: the widen pass must not resurrect it.
func TestSyncOutFeedsSkipsExpiredInWidenedWalk(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000

	rare := &Feed{id: 0, URL: "http://rare", Tag: "rare"}
	noise := &Feed{id: 1, URL: "http://noise", Tag: "noise"}
	c.Feeds = map[int]*Feed{rare.id: rare, noise.id: noise}

	const limit = 5
	// 5 rare articles at chron 0-4, then 65 noise articles: the tail window
	// [20, 70) is all noise, so the widen branch fires (see
	// TestSyncOutFeedsWindowWidening for the math).
	for i := 1; i <= 5; i++ {
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: rare, Title: fmt.Sprintf("Rare%d", i), Content: "r",
				Link: fmt.Sprintf("http://rare/%d", i), Published: int64(i * 100)},
		}); err != nil {
			t.Fatalf("PutArticles rare#%d: %v", i, err)
		}
	}
	for i := 1; i <= 65; i++ {
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: noise, Title: fmt.Sprintf("Noise%d", i), Content: "n",
				Link: fmt.Sprintf("http://noise/%d", i), Published: int64(1000 + i)},
		}); err != nil {
			t.Fatalf("PutArticles noise#%d: %v", i, err)
		}
	}

	// Expire Rare1 (chron 0).
	rare.AddIdx = 1
	rare.Expired = 1

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "rare", Format: "rss", Tags: []string{"rare"}, Limit: limit},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "out/rare.rss"))
	if err != nil {
		t.Fatalf("read out/rare.rss: %v", err)
	}
	var feed rssRoot
	if err := xml.Unmarshal(data, &feed); err != nil {
		t.Fatalf("parse RSS: %v\n%s", err, data)
	}
	// Only the 4 live rare articles, newest-first: Rare5 … Rare2.
	if len(feed.Channel.Items) != 4 {
		t.Fatalf("items = %d, want 4 (Rare1 expired)", len(feed.Channel.Items))
	}
	for i := 0; i < 4; i++ {
		want := fmt.Sprintf("Rare%d", 5-i)
		if feed.Channel.Items[i].Title != want {
			t.Errorf("item[%d].Title = %q, want %q", i, feed.Channel.Items[i].Title, want)
		}
	}
	if strings.Contains(string(data), "Rare1<") {
		t.Errorf("expired Rare1 still present in output:\n%s", data)
	}
}

// TestOutFeedsSigChangesOnAddIdx verifies an expiration-driven AddIdx bump
// flips the syndication signature, un-gating the next SyncOutFeeds so a quiet
// store doesn't serve stale output containing expired articles forever.
func TestOutFeedsSigChangesOnAddIdx(t *testing.T) {
	db, c, _ := setupTestDB(t)
	ch := &Feed{id: 0, URL: "http://a", Tag: "news"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	db.core.Out = []OutFeed{
		{Name: "news", Format: "rss", Tags: []string{"news"}, Limit: 10},
	}

	before := db.outFeedsSig()
	if again := db.outFeedsSig(); again != before {
		t.Fatalf("sig not stable: %q vs %q", before, again)
	}
	ch.AddIdx = 2
	if after := db.outFeedsSig(); after == before {
		t.Errorf("sig unchanged after AddIdx bump: %q", after)
	}
}

// TestOutFeedsSigChangesOnTag verifies a feed's tag edit flips the syndication
// signature: a tag change alters which feeds a tag-scoped out feed includes, so
// an otherwise-idle cycle must re-run SyncOutFeeds. (100% line coverage of
// outFeedsSig otherwise masks that only the AddIdx term was exercised.)
func TestOutFeedsSigChangesOnTag(t *testing.T) {
	db, c, _ := setupTestDB(t)
	ch := &Feed{id: 0, URL: "http://a", Tag: "news"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	db.core.Out = []OutFeed{
		{Name: "news", Format: "rss", Tags: []string{"news"}, Limit: 10},
	}

	before := db.outFeedsSig()
	ch.Tag = "tech" // re-tagging changes the tag→feed membership the sig tracks
	if after := db.outFeedsSig(); after == before {
		t.Errorf("sig unchanged after feed tag change: %q", after)
	}
}

// TestSyncOutFeedsMultipleOutputs verifies multiple OutFeed entries all write
// their own file in one call.
func TestSyncOutFeedsMultipleOutputs(t *testing.T) {
	db, dir, _, _ := setupOutFeedDB(t)
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "news-rss", Format: "rss", Tags: []string{"news"}, Limit: 10},
		{Name: "tech-json", Format: "json", Tags: []string{"tech"}, Limit: 10},
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	for _, key := range []string{"out/news-rss.rss", "out/tech-json.json"} {
		if _, err := os.Stat(filepath.Join(dir, key)); os.IsNotExist(err) {
			t.Errorf("%s was not written", key)
		}
	}
}

// TestSyncOutFeedsLinklessGUID pins the linkless-article path (dmz's X/nitter +
// Telegram feeds carry no Link): RSS must emit a synthetic <guid
// isPermaLink="false">urn:srr:…</guid> with no <link>, and JSON Feed must fall
// its `id` back to the same synthetic id with `url` omitted. (Exercises
// stableGUID + the marshalRSS / marshalJSONFeed linkless branches, dead in
// every other out-feed test since they all set Link.)
func TestSyncOutFeedsLinklessGUID(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000
	ch := &Feed{id: 0, URL: "http://a", Tag: "micro"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "no link here", Content: "<p>body</p>", Published: 1000}, // Link empty
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "rss", Format: "rss", Tags: []string{"micro"}, Limit: 10},
		{Name: "json", Format: "json", Tags: []string{"micro"}, Limit: 10},
	}
	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	want := stableGUID(ArticleData{FeedID: 0, Published: 1000, Title: "no link here"})
	if !strings.HasPrefix(want, "urn:srr:") {
		t.Fatalf("stableGUID = %q, want a urn:srr: id", want)
	}

	// RSS: <guid isPermaLink="false">urn:srr:…</guid>, no <link>.
	type guidX struct {
		Value       string `xml:",chardata"`
		IsPermaLink string `xml:"isPermaLink,attr"`
	}
	type itemX struct {
		Link string `xml:"link"`
		GUID guidX  `xml:"guid"`
	}
	var rssDoc struct {
		XMLName xml.Name `xml:"rss"`
		Items   []itemX  `xml:"channel>item"`
	}
	rssData, err := os.ReadFile(filepath.Join(dir, "out/rss.rss"))
	if err != nil {
		t.Fatalf("read out/rss.rss: %v", err)
	}
	if err := xml.Unmarshal(rssData, &rssDoc); err != nil {
		t.Fatalf("parse RSS: %v\n%s", err, rssData)
	}
	if len(rssDoc.Items) != 1 {
		t.Fatalf("RSS items = %d, want 1", len(rssDoc.Items))
	}
	if rssDoc.Items[0].GUID.IsPermaLink != "false" {
		t.Errorf("isPermaLink = %q, want false (synthetic id)", rssDoc.Items[0].GUID.IsPermaLink)
	}
	if rssDoc.Items[0].GUID.Value != want {
		t.Errorf("guid = %q, want %q", rssDoc.Items[0].GUID.Value, want)
	}
	if rssDoc.Items[0].Link != "" {
		t.Errorf("link = %q, want empty (linkless article)", rssDoc.Items[0].Link)
	}

	// JSON Feed: id falls back to the same synthetic id, url omitted.
	jsonData, err := os.ReadFile(filepath.Join(dir, "out/json.json"))
	if err != nil {
		t.Fatalf("read out/json.json: %v", err)
	}
	var jf jsonFeed1
	if err := json.Unmarshal(jsonData, &jf); err != nil {
		t.Fatalf("parse JSON Feed: %v\n%s", err, jsonData)
	}
	if len(jf.Items) != 1 {
		t.Fatalf("JSON items = %d, want 1", len(jf.Items))
	}
	if jf.Items[0].ID != want {
		t.Errorf("json id = %q, want %q (same synthetic id)", jf.Items[0].ID, want)
	}
	if jf.Items[0].URL != "" {
		t.Errorf("json url = %q, want empty (linkless)", jf.Items[0].URL)
	}
}

// TestSyncOutFeedsDatelessUsesFetchedAt verifies the pub==0 → FetchedAt fallback
// in BOTH marshalers: a dateless article's emitted timestamp is its fetched_at.
func TestSyncOutFeedsDatelessUsesFetchedAt(t *testing.T) {
	db, c, dir := setupTestDB(t)
	const fetched = int64(1700000000)
	c.FetchedAt = fetched
	ch := &Feed{id: 0, URL: "http://a", Tag: "d"}
	c.Feeds = map[int]*Feed{ch.id: ch}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "dateless", Content: "<p>b</p>", Link: "http://x/1", Published: 0},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{
		{Name: "rss", Format: "rss", Tags: []string{"d"}, Limit: 10},
		{Name: "json", Format: "json", Tags: []string{"d"}, Limit: 10},
	}
	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	rssData, err := os.ReadFile(filepath.Join(dir, "out/rss.rss"))
	if err != nil {
		t.Fatalf("read out/rss.rss: %v", err)
	}
	var feed rssRoot
	if err := xml.Unmarshal(rssData, &feed); err != nil {
		t.Fatalf("parse RSS: %v", err)
	}
	if wantRSS := time.Unix(fetched, 0).UTC().Format(time.RFC1123Z); feed.Channel.Items[0].PubDate != wantRSS {
		t.Errorf("RSS pubDate = %q, want fetched_at fallback %q", feed.Channel.Items[0].PubDate, wantRSS)
	}

	jsonData, err := os.ReadFile(filepath.Join(dir, "out/json.json"))
	if err != nil {
		t.Fatalf("read out/json.json: %v", err)
	}
	var jf jsonFeed1
	if err := json.Unmarshal(jsonData, &jf); err != nil {
		t.Fatalf("parse JSON: %v", err)
	}
	if wantJSON := time.Unix(fetched, 0).UTC().Format(time.RFC3339); jf.Items[0].DatePub != wantJSON {
		t.Errorf("JSON date_published = %q, want fetched_at fallback %q", jf.Items[0].DatePub, wantJSON)
	}
}

// TestSyncOutFeedsEmptyTagMatchesNothing verifies the empty-tag guard: a Tags:[""]
// selector must NOT match every untagged feed (the footgun), so no file is written.
func TestSyncOutFeedsEmptyTagMatchesNothing(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000
	ch := &Feed{id: 0, URL: "http://a"} // untagged (Tag == "")
	c.Feeds = map[int]*Feed{ch.id: ch}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A1", Content: "<p>b</p>", Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	db.core.Out = []OutFeed{{Name: "empty", Format: "rss", Tags: []string{""}, Limit: 10}}
	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "out/empty.rss")); !os.IsNotExist(err) {
		t.Error("out/empty.rss written for an empty-tag selector; empty tag must match nothing")
	}
}

// TestSyncOutFeedsNoMatchingFeedsSkips verifies the no-matching-feeds skip: a
// tag selector matching no feed writes no file and is not an error.
func TestSyncOutFeedsNoMatchingFeedsSkips(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.FetchedAt = 1700000000
	ch := &Feed{id: 0, URL: "http://a", Tag: "news"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A1", Content: "<p>b</p>", Link: "http://x/1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()

	// Only a tag selector (no explicit Feeds ids, which would populate the include
	// set unconditionally) matching no feed → include stays empty → skip.
	db.core.Out = []OutFeed{{Name: "ghost", Format: "rss", Tags: []string{"nope"}, Limit: 10}}
	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds should skip, not error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "out/ghost.rss")); !os.IsNotExist(err) {
		t.Error("out/ghost.rss written for a no-match selector")
	}
}
