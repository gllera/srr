package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"srrb/ingest"
	"srrb/mod"
)

// The "test-stub" ingest strategy returns a fixed result for every URL —
// used to confirm Feed.fetchURL dispatches through the ingest registry
// rather than hard-coding the RSS path.
func init() {
	// Registered once at init; safe because tests use distinct names.
	pub := time.Unix(1700000000, 0)
	items := []*mod.RawItem{
		{GUID: 1, Title: "stub-1", Link: "https://stub/1", Published: &pub},
		{GUID: 2, Title: "stub-2", Link: "https://stub/2", Published: &pub},
	}
	ingest.Register("test-stub", func(_ context.Context, _ *http.Client, _ []byte, _ ingest.Request) (ingest.Result, error) {
		return ingest.Result{Items: items}, nil
	})
}

// fetchOnce points ch at the test server and runs one fetchURL cycle. ETag /
// LastModified are cleared each call so a re-fetch from the same server is not
// answered with a 304 — the dedup tests rely on every fetch seeing the body.
func fetchOnce(t *testing.T, ch *Feed, srv *httptest.Server) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	ch.URL = srv.URL
	ch.ETag, ch.LastModified = "", ""
	// Far enough in the future that test-fixture pubDates of 2024 always pass
	// the future-clamp without affecting the dedup expectations the tests check.
	const fetchedAt int64 = 4_102_444_800 // 2100-01-01
	run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), ch.Pipe, ingest.Select(ch.Ingest, ""))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}

// dispatchStub runs one fetchURL cycle against the engine's registry (no HTTP
// server) — the URL is irrelevant since test-stub ignores it.
func dispatchStub(t *testing.T, ch *Feed, rootIngest string) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	const fetchedAt int64 = 4_102_444_800
	ingestName := ingest.Select(ch.Ingest, rootIngest)
	run := &fetchRun{engine: ingest.New(), fetchedAt: fetchedAt}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), ch.Pipe, ingestName)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}

// A feed-level ingest strategy is used by fetchURL.
func TestFetchInheritsIngestFromFeed(t *testing.T) {
	ch := &Feed{Title: "T", URL: "irrelevant://value", Ingest: "#test-stub"}
	items := dispatchStub(t, ch, "")
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2 (feed-level ingest used)", len(items))
	}
}

// The db.gz root Ingest applies when the feed has no override.
func TestFetchUsesRootIngest(t *testing.T) {
	ch := &Feed{Title: "T", URL: "irrelevant://value"}
	items := dispatchStub(t, ch, "#test-stub")
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2 (root ingest applied)", len(items))
	}
}

// Items the publisher gave no parseable date for must be stored with
// Published=0 so the frontend renders an empty date (its `p ?? 0` fallback).
func TestFetchDatelessItemHasZeroPublished(t *testing.T) {
	feed := `<rss version="2.0"><feed>
		<item><title>Dateless</title><guid>a</guid></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	items := fetchOnce(t, ch, srv)
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
	feed := `<rss version="2.0"><feed>
		<item><title>Dup</title><guid>same</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>Dup</title><guid>same</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	items := fetchOnce(t, ch, srv)
	if len(items) != 1 {
		t.Errorf("got %d items, want 1", len(items))
	}
}

// A brand-new GUID published at the same second as a prior boundary item must
// be ingested. The earlier tuple-watermark scheme dropped same-second items
// whose GUID hash sorted below the boundary; the boundary-set model has no
// hash dependency.
func TestFetchSameSecondDifferentGUIDIsIngested(t *testing.T) {
	feed1 := `<rss version="2.0"><feed>
		<item><title>First</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feed2 := `<rss version="2.0"><feed>
		<item><title>Second</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d items, want 1", len(got))
	}

	current = feed2
	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Errorf("fetch2: got %d items, want 1 (same-second item with new GUID dropped)", len(got))
	}
}

// Once a dateless GUID lands in BoundaryGUIDs, future occurrences must stay
// deduped even if the publisher later adds a date — there's no other dedup
// path for items the publisher initially ships dateless.
func TestFetchDatelessRemainsSkippedWhenLaterDated(t *testing.T) {
	feedWithoutDate := `<rss version="2.0"><feed>
		<item><title>D</title><guid>permanent</guid></item>
	</feed></rss>`
	feedWithDate := `<rss version="2.0"><feed>
		<item><title>D</title><guid>permanent</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`

	current := feedWithoutDate
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = feedWithDate
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0 (re-ingested previously-dateless item once it gained a date)", len(got))
	}
}

// Items at the prior watermark second that were already in BoundaryGUIDs must
// be skipped on subsequent fetches.
func TestFetchPriorBoundaryStillDedupes(t *testing.T) {
	feed := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>B</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 2 {
		t.Fatalf("fetch1: got %d, want 2", len(got))
	}
	if len(ch.BoundaryGUIDs) != 2 {
		t.Errorf("BoundaryGUIDs = %v, want 2", ch.BoundaryGUIDs)
	}
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0", len(got))
	}
}

// When the new fetch contains both the prior boundary item and a new sibling
// at the same watermark second, both must end up in the snapshot boundary.
func TestFetchSiblingsAtBoundarySecondBothInBoundary(t *testing.T) {
	feed1 := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feed2 := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>B</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}

	current = feed2
	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Errorf("fetch2: got %d, want 1 (B is new at the same second)", len(got))
	}
	if len(ch.BoundaryGUIDs) != 2 {
		t.Errorf("BoundaryGUIDs = %v, want 2", ch.BoundaryGUIDs)
	}
}

// A transient empty fetch must preserve prior dedup state — Watermark and
// BoundaryGUIDs — otherwise items at the watermark second get re-ingested
// when the feed recovers.
func TestFetchEmptyResponsePreservesDedupState(t *testing.T) {
	feedWithItem := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feedEmpty := `<rss version="2.0"><feed></feed></rss>`

	current := feedWithItem
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	priorWatermark := ch.Watermark
	priorBoundary := append([]uint32(nil), ch.BoundaryGUIDs...)

	current = feedEmpty
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Fatalf("fetch2: got %d, want 0", len(got))
	}
	if ch.Watermark != priorWatermark {
		t.Errorf("Watermark = %d, want %d (preserved across empty fetch)", ch.Watermark, priorWatermark)
	}
	if !slices.Equal(ch.BoundaryGUIDs, priorBoundary) {
		t.Errorf("BoundaryGUIDs = %v, want %v (preserved across empty fetch)", ch.BoundaryGUIDs, priorBoundary)
	}

	current = feedWithItem
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch3: got %d, want 0 (item re-ingested after empty fetch)", len(got))
	}
}

// A within-fetch duplicate GUID with a lower pub on the later occurrence must
// not corrupt BoundaryGUIDs. The first occurrence wins for boundary state, so
// the GUID stays in the snapshot and subsequent fetches still dedup it.
func TestFetchWithinFetchDuplicateLowerPubKeepsBoundary(t *testing.T) {
	feed := `<rss version="2.0"><feed>
		<item><title>A1</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:05:00 GMT</pubDate></item>
		<item><title>A2</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	if len(ch.BoundaryGUIDs) != 1 {
		t.Errorf("BoundaryGUIDs = %v, want 1 entry (GUID dropped → re-ingestion next fetch)", ch.BoundaryGUIDs)
	}
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0 (dup ingested because boundary lost the GUID)", len(got))
	}
}

// A within-fetch duplicate GUID with a higher pub on the later occurrence must
// not advance Watermark past the first occurrence's pub. Otherwise a legit
// item between the two pubs gets permanently skipped on later fetches.
func TestFetchWithinFetchDuplicateHigherPubKeepsWatermark(t *testing.T) {
	feed1 := `<rss version="2.0"><feed>
		<item><title>A1</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>A2</title><guid>x</guid><pubDate>Mon, 01 Jan 2024 00:10:00 GMT</pubDate></item>
	</feed></rss>`
	feed2 := `<rss version="2.0"><feed>
		<item><title>B</title><guid>y</guid><pubDate>Mon, 01 Jan 2024 00:05:00 GMT</pubDate></item>
	</feed></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}

	current = feed2
	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Errorf("fetch2: got %d, want 1 (B at 00:05 skipped because watermark jumped to 00:10 on a dup)", len(got))
	}
}

// A publisher bug that ships a far-future pubDate must not push Watermark
// past fetchedAt — otherwise every subsequent real item is silently skipped
// for years. The clamp also guarantees the stored Published value never
// exceeds the moment we fetched.
func TestFetchFutureDatedItemClampedToFetchedAt(t *testing.T) {
	feed := `<rss version="2.0"><feed>
		<item><title>FromTheFuture</title><guid>fut</guid><pubDate>Fri, 01 Jan 2999 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T", URL: srv.URL}

	const fetchedAt int64 = 1_700_000_000
	buf := make([]byte, 1<<20)
	run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), ch.Pipe, ingest.Select(ch.Ingest, ""))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Published != fetchedAt {
		t.Errorf("Published = %d, want %d (clamped to fetchedAt)", items[0].Published, fetchedAt)
	}
	if ch.Watermark != fetchedAt {
		t.Errorf("Watermark = %d, want %d (clamped)", ch.Watermark, fetchedAt)
	}
}

func TestFeedLogValue(t *testing.T) {
	ch := &Feed{id: 7, Title: "My Title", URL: "http://x"}
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
	// URL intentionally omitted to keep per-feed log lines compact.
	if _, ok := got["url"]; ok {
		t.Errorf("LogValue should not include url, got %v", got)
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

// A response with more boundary-class items than maxBoundaryGUIDs (here: all
// dateless) must cap the persisted bg array AND skip the over-cap items
// entirely. Ingesting an item whose GUID isn't remembered would make it look
// new again on every subsequent fetch — fetch2 returning 0 is the guard
// against that duplicate-forever failure mode.
func TestFetchBoundaryGUIDsCapped(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<rss version="2.0"><feed>`)
	for i := range maxBoundaryGUIDs + 100 {
		fmt.Fprintf(&b, `<item><title>T%d</title><guid>g%d</guid></item>`, i, i)
	}
	b.WriteString(`</feed></rss>`)
	feed := b.String()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != maxBoundaryGUIDs {
		t.Fatalf("fetch1: got %d items, want %d (only kept items ingested)", len(got), maxBoundaryGUIDs)
	}
	if len(ch.BoundaryGUIDs) != maxBoundaryGUIDs {
		t.Errorf("BoundaryGUIDs = %d entries, want %d (capped)", len(ch.BoundaryGUIDs), maxBoundaryGUIDs)
	}
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0 (over-cap items re-ingested as duplicates)", len(got))
	}
}

// When a second fetch adds new items whose hashes are smaller than some of the
// already-stored items, the cap must prefer retaining stored GUIDs over the
// pure smallest-hash rule. Without this, already-stored high-hash items are
// evicted from bg and look new again on the next fetch, causing duplicates.
//
// Scenario (all items are dateless so all are boundary-class):
//
//   - fetch1: 924 items (g0..g923) → all ingested, bg has 924 entries
//
//   - fetch2: 1124 items (g0..g1123) — 924 original + 200 new.
//     Under the old pure-smallest-hash cap: 1024 kept = 825 originals + 199
//     new; 99 high-hash originals are evicted and 199 new items are ingested.
//     Under the fix: all 924 originals are kept (they fit within cap), then
//     the 100 smallest-hash new items fill the remaining 100 slots; the other
//     100 new items are over-cap and skipped → 100 new items ingested.
//
//   - fetch3: 924 items (g0..g923) → must ingest 0.
//     Without the fix the 99 evicted originals look new and are re-ingested.
//     The fix keeps all originals in bg so fetch3 sees 0 new items.
func TestFetchBoundaryGUIDsCapPreservesStoredGUIDs(t *testing.T) {
	const nOrig = maxBoundaryGUIDs - 100        // 924 — fits under cap even after fix
	const nNew = 200                            // g924..g1123; 100 fit under cap, 100 dropped
	const wantFetch2 = maxBoundaryGUIDs - nOrig // 100 new items ingested under fix

	buildFeed := func(lo, hi int) string {
		var b strings.Builder
		b.WriteString(`<rss version="2.0"><feed>`)
		for i := lo; i < hi; i++ {
			fmt.Fprintf(&b, `<item><title>T%d</title><guid>g%d</guid></item>`, i, i)
		}
		b.WriteString(`</feed></rss>`)
		return b.String()
	}

	feed1 := buildFeed(0, nOrig)      // g0..g923
	feed2 := buildFeed(0, nOrig+nNew) // g0..g1123
	feed3 := buildFeed(0, nOrig)      // g0..g923 again
	current := feed1

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	// fetch1: all 924 items ingested, bg below cap
	if got := fetchOnce(t, ch, srv); len(got) != nOrig {
		t.Fatalf("fetch1: got %d items, want %d", len(got), nOrig)
	}
	if len(ch.BoundaryGUIDs) != nOrig {
		t.Fatalf("fetch1 BoundaryGUIDs = %d, want %d", len(ch.BoundaryGUIDs), nOrig)
	}

	// fetch2: 200 new items, total 1124 > cap. Under the fix all 924 stored
	// originals keep their bg slots; the remaining 100 cap slots go to the 100
	// smallest-hash new items. The other 100 new items are over-cap and dropped.
	current = feed2
	if got := fetchOnce(t, ch, srv); len(got) != wantFetch2 {
		t.Fatalf("fetch2: got %d items, want %d (100 new items ingested)", len(got), wantFetch2)
	}
	if len(ch.BoundaryGUIDs) != maxBoundaryGUIDs {
		t.Fatalf("fetch2 BoundaryGUIDs = %d, want %d (at cap)", len(ch.BoundaryGUIDs), maxBoundaryGUIDs)
	}

	// fetch3: original 924 items return — none should be re-ingested.
	// Without the fix the 99 high-hash originals that were evicted from bg by
	// the old smallest-hash rule would look new and be re-ingested as dupes.
	current = feed3
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch3: got %d items, want 0 (stored GUIDs re-ingested after cap eviction)", len(got))
	}
}

// A publisher re-dating an existing post (same GUID, higher pub) on a later
// fetch must NOT advance the persisted Watermark — otherwise a genuinely-new
// article dated between the old and bumped value is permanently dropped.
func TestFetchRedatedDuplicateDoesNotPoisonWatermark(t *testing.T) {
	feed1 := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	// A re-dated to 00:10 (publisher bumped/edited it).
	feed2 := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:10:00 GMT</pubDate></item>
	</feed></rss>`
	// A still re-dated, plus a genuinely-new B dated BETWEEN the old (00:00) and
	// bumped (00:10) watermark.
	feed3 := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:10:00 GMT</pubDate></item>
		<item><title>B</title><guid>b</guid><pubDate>Mon, 01 Jan 2024 00:05:00 GMT</pubDate></item>
	</feed></rss>`

	current := feed1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = feed2
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Fatalf("fetch2: got %d, want 0 (re-dated A is a dup)", len(got))
	}
	current = feed3
	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Errorf("fetch3: got %d, want 1 — B at 00:05 dropped because a re-dated dup poisoned the watermark", len(got))
	}
}
