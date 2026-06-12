package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"srrb/ingest"
	"srrb/mod"
)

func fetchOnce(t *testing.T, feed *Feed, ch *Channel, srv *httptest.Server) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	feed.ETag, feed.LastModified = "", ""
	// Far enough in the future that test-fixture pubDates of 2024 always pass
	// the future-clamp without affecting the dedup expectations the tests check.
	const fetchedAt int64 = 4_102_444_800 // 2100-01-01
	items, err := feed.fetch(context.Background(), srv.Client(), buf, mod.New(nil), ingest.New(), ch, fetchedAt, ch.Pipe, ingest.Select(ch.Ingest, ""))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}

// Items the publisher gave no parseable date for must be stored with
// Published=0 so the frontend renders an empty date (its `p ?? 0` fallback).
func TestFetchDatelessItemHasZeroPublished(t *testing.T) {
	feed := `<rss version="2.0"><channel>
		<item><title>Dateless</title><guid>a</guid></item>
	</channel></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	items := fetchOnce(t, f, ch, srv)
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Published != 0 {
		t.Errorf("Published = %d, want 0", items[0].Published)
	}
}

// Same (pub, guid) appearing twice in one response must be collapsed to one
// stored article.
func TestFetchWithinFetchDuplicateDeduped(t *testing.T) {
	feed := `<rss version="2.0"><channel>
		<item><title>Dup</title><guid>same</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>Dup</title><guid>same</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	items := fetchOnce(t, f, ch, srv)
	if len(items) != 1 {
		t.Errorf("got %d items, want 1", len(items))
	}
}

// A brand-new GUID published at the same second as a prior boundary item must
// be ingested. The earlier tuple-watermark scheme dropped same-second items
// whose GUID hash sorted below the boundary; the boundary-set model has no
// hash dependency.
func TestFetchSameSecondDifferentGUIDIsIngested(t *testing.T) {
	feed1 := `<rss version="2.0"><channel>
		<item><title>First</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	feed2 := `<rss version="2.0"><channel>
		<item><title>Second</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d items, want 1", len(got))
	}

	current = feed2
	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Errorf("fetch2: got %d items, want 1 (same-second item with new GUID dropped)", len(got))
	}
}

// Once a dateless GUID lands in BoundaryGUIDs, future occurrences must stay
// deduped even if the publisher later adds a date — there's no other dedup
// path for items the publisher initially ships dateless.
func TestFetchDatelessRemainsSkippedWhenLaterDated(t *testing.T) {
	feedWithoutDate := `<rss version="2.0"><channel>
		<item><title>D</title><guid>permanent</guid></item>
	</channel></rss>`
	feedWithDate := `<rss version="2.0"><channel>
		<item><title>D</title><guid>permanent</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`

	current := feedWithoutDate
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = feedWithDate
	if got := fetchOnce(t, f, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0 (re-ingested previously-dateless item once it gained a date)", len(got))
	}
}

// Items at the prior watermark second that were already in BoundaryGUIDs must
// be skipped on subsequent fetches.
func TestFetchPriorBoundaryStillDedupes(t *testing.T) {
	feed := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>B</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 2 {
		t.Fatalf("fetch1: got %d, want 2", len(got))
	}
	if len(f.BoundaryGUIDs) != 2 {
		t.Errorf("BoundaryGUIDs = %v, want 2", f.BoundaryGUIDs)
	}
	if got := fetchOnce(t, f, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0", len(got))
	}
}

// When the new fetch contains both the prior boundary item and a new sibling
// at the same watermark second, both must end up in the snapshot boundary.
func TestFetchSiblingsAtBoundarySecondBothInBoundary(t *testing.T) {
	feed1 := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	feed2 := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>B</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}

	current = feed2
	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Errorf("fetch2: got %d, want 1 (B is new at the same second)", len(got))
	}
	if len(f.BoundaryGUIDs) != 2 {
		t.Errorf("BoundaryGUIDs = %v, want 2", f.BoundaryGUIDs)
	}
}

// A transient empty fetch must preserve prior dedup state — Watermark and
// BoundaryGUIDs — otherwise items at the watermark second get re-ingested
// when the feed recovers.
func TestFetchEmptyResponsePreservesDedupState(t *testing.T) {
	feedWithItem := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	feedEmpty := `<rss version="2.0"><channel></channel></rss>`

	current := feedWithItem
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	priorWatermark := f.Watermark
	priorBoundary := append([]uint32(nil), f.BoundaryGUIDs...)

	current = feedEmpty
	if got := fetchOnce(t, f, ch, srv); len(got) != 0 {
		t.Fatalf("fetch2: got %d, want 0", len(got))
	}
	if f.Watermark != priorWatermark {
		t.Errorf("Watermark = %d, want %d (preserved across empty fetch)", f.Watermark, priorWatermark)
	}
	if !slices.Equal(f.BoundaryGUIDs, priorBoundary) {
		t.Errorf("BoundaryGUIDs = %v, want %v (preserved across empty fetch)", f.BoundaryGUIDs, priorBoundary)
	}

	current = feedWithItem
	if got := fetchOnce(t, f, ch, srv); len(got) != 0 {
		t.Errorf("fetch3: got %d, want 0 (item re-ingested after empty fetch)", len(got))
	}
}

// A within-fetch duplicate GUID with a lower pub on the later occurrence must
// not corrupt BoundaryGUIDs. The first occurrence wins for boundary state, so
// the GUID stays in the snapshot and subsequent fetches still dedup it.
func TestFetchWithinFetchDuplicateLowerPubKeepsBoundary(t *testing.T) {
	feed := `<rss version="2.0"><channel>
		<item><title>A1</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:05:00 GMT</pubDate></item>
		<item><title>A2</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	if len(f.BoundaryGUIDs) != 1 {
		t.Errorf("BoundaryGUIDs = %v, want 1 entry (GUID dropped → re-ingestion next fetch)", f.BoundaryGUIDs)
	}
	if got := fetchOnce(t, f, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0 (dup ingested because boundary lost the GUID)", len(got))
	}
}

// A within-fetch duplicate GUID with a higher pub on the later occurrence must
// not advance Watermark past the first occurrence's pub. Otherwise a legit
// item between the two pubs gets permanently skipped on later fetches.
func TestFetchWithinFetchDuplicateHigherPubKeepsWatermark(t *testing.T) {
	feed1 := `<rss version="2.0"><channel>
		<item><title>A1</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>A2</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:10:00 GMT</pubDate></item>
	</channel></rss>`
	feed2 := `<rss version="2.0"><channel>
		<item><title>B</title><guid>y</guid><pubDate>Mon, 01 Jan 2024 00:05:00 GMT</pubDate></item>
	</channel></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}

	current = feed2
	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Errorf("fetch2: got %d, want 1 (B at 00:05 skipped because watermark jumped to 00:10 on a dup)", len(got))
	}
}

// A publisher bug that ships a far-future pubDate must not push Watermark
// past fetchedAt — otherwise every subsequent real item is silently skipped
// for years. The clamp also guarantees the stored Published value never
// exceeds the moment we fetched.
func TestFetchFutureDatedItemClampedToFetchedAt(t *testing.T) {
	feed := `<rss version="2.0"><channel>
		<item><title>FromTheFuture</title><guid>fut</guid><pubDate>Fri, 01 Jan 2999 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	const fetchedAt int64 = 1_700_000_000
	buf := make([]byte, 1<<20)
	items, err := f.fetch(context.Background(), srv.Client(), buf, mod.New(nil), ingest.New(), ch, fetchedAt, ch.Pipe, ingest.Select(ch.Ingest, ""))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Published != fetchedAt {
		t.Errorf("Published = %d, want %d (clamped to fetchedAt)", items[0].Published, fetchedAt)
	}
	if f.Watermark != fetchedAt {
		t.Errorf("Watermark = %d, want %d (clamped)", f.Watermark, fetchedAt)
	}
}

func TestChannelLogValue(t *testing.T) {
	ch := &Channel{id: 7, Title: "My Title", Feeds: []*Feed{{URL: "http://x"}}}
	val := ch.LogValue()
	attrs := val.Group()
	got := map[string]any{}
	for _, a := range attrs {
		got[a.Key] = a.Value.Any()
	}
	if got["id"] != int64(7) {
		t.Errorf("LogValue id = %v, want 7", got["id"])
	}
	if got["title"] != "My Title" {
		t.Errorf("LogValue title = %v, want %q", got["title"], "My Title")
	}
	// Feeds intentionally omitted to keep per-feed log lines compact.
	if _, ok := got["feeds"]; ok {
		t.Errorf("LogValue should not include feeds, got %v", got)
	}
}

func TestStripControl(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello world", "helloworld"},    // space is <= ' ', removed
		{"hello\tworld", "helloworld"},   // tab removed
		{"hello\nworld", "helloworld"},   // newline removed
		{"hello\x00world", "helloworld"}, // null byte removed
		{"hello\x7fworld", "helloworld"}, // DEL removed
		{"hello\x01world", "helloworld"}, // control char removed
		{"café", "café"},                 // non-ASCII preserved
		{"", ""},                         // empty string
		{"nocontrol", "nocontrol"},       // no changes needed
		{"\t\n\r ", ""},                  // all control/whitespace
		{"a\x1fb", "ab"},                 // unit separator removed
		{"ab", "ab"},                    // C1 PAD removed
		{"ab", "ab"},                    // C1 CSI removed
		{"ab", "ab"},                    // C1 APC removed
		{"a b", "a b"},                   // NBSP (just above C1) preserved
	}

	for _, tt := range tests {
		got := strings.Map(stripControl, tt.input)
		if got != tt.want {
			t.Errorf("stripControl(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestStripControlKeepWS(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello\tworld", "hello\tworld"}, // tab preserved
		{"hello\nworld", "hello\nworld"}, // newline preserved
		{"hello\rworld", "hello\rworld"}, // carriage return preserved
		{"hello\x00world", "helloworld"}, // null byte removed
		{"hello\x01world", "helloworld"}, // SOH removed
		{"hello\x1fworld", "helloworld"}, // unit separator removed
		{"café", "café"},                 // non-ASCII preserved
		{"", ""},                         // empty string
		{"\t\n\r", "\t\n\r"},             // all kept whitespace
		{"a\x0bb", "ab"},                 // vertical tab removed
		{"hello world", "hello world"},   // space preserved (>= ' ')
		{"a\x7fb", "ab"},                 // DEL removed (kept-WS variant must drop it too)
		{"ab", "ab"},                    // C1 PAD removed
		{"ab", "ab"},                    // C1 CSI removed
		{"ab", "ab"},                    // C1 APC removed
		{"a b", "a b"},                   // NBSP (just above C1) preserved
	}

	for _, tt := range tests {
		got := strings.Map(stripControlKeepWS, tt.input)
		if got != tt.want {
			t.Errorf("stripControlKeepWS(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// A publisher re-dating an existing post (same GUID, higher pub) on a later
// fetch must NOT advance the persisted Watermark — otherwise a genuinely-new
// article dated between the old and bumped value is permanently dropped.
func TestFetchRedatedDuplicateDoesNotPoisonWatermark(t *testing.T) {
	feed1 := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</channel></rss>`
	// A re-dated to 00:10 (publisher bumped/edited it).
	feed2 := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:10:00 GMT</pubDate></item>
	</channel></rss>`
	// A still re-dated, plus a genuinely-new B dated BETWEEN the old (00:00) and
	// bumped (00:10) watermark.
	feed3 := `<rss version="2.0"><channel>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:10:00 GMT</pubDate></item>
		<item><title>B</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:05:00 GMT</pubDate></item>
	</channel></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	f := &Feed{URL: srv.URL}
	ch := &Channel{Title: "T", Feeds: []*Feed{f}}

	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = feed2
	if got := fetchOnce(t, f, ch, srv); len(got) != 0 {
		t.Fatalf("fetch2: got %d, want 0 (re-dated A is a dup)", len(got))
	}
	current = feed3
	if got := fetchOnce(t, f, ch, srv); len(got) != 1 {
		t.Errorf("fetch3: got %d, want 1 — B at 00:05 dropped because a re-dated dup poisoned the watermark", len(got))
	}
}
