package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"srr/ingest"
	"srr/mod"
	"srr/store"
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
func fetchOnce(t *testing.T, ch *Feed, srv *httptest.Server, pipe ...string) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	ch.URL = srv.URL
	ch.ETag, ch.LastModified = "", ""
	// Far enough in the future that test-fixture pubDates of 2024 always pass
	// the future-clamp without affecting the dedup expectations the tests check.
	const fetchedAt int64 = 4_102_444_800 // 2100-01-01
	run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), pipe, ingest.Select("", ""))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}

// dispatchStub runs one fetchURL cycle against the engine's registry (no HTTP
// server) with an explicit ingest name — the URL is irrelevant since test-stub
// ignores it.
func dispatchStub(t *testing.T, ch *Feed, ingestName string) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	const fetchedAt int64 = 4_102_444_800
	run := &fetchRun{engine: ingest.New(), fetchedAt: fetchedAt}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), nil, ingestName)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}

// fetchURL dispatches through the engine's registry by the passed ingest name.
func TestFetchURLDispatchesByIngestName(t *testing.T) {
	ch := &Feed{Title: "T", URL: "irrelevant://value"}
	items := dispatchStub(t, ch, "#test-stub")
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2 (resolved ingest used)", len(items))
	}
}

// Feed.Fetch (the production path) selects the ingest from the feed's recipe
// via run.recipes, not from any feed-level field.
func TestFeedFetchSelectsRecipeIngest(t *testing.T) {
	const fetchedAt int64 = 4_102_444_800
	buf := make([]byte, 1<<20)
	// recipe "stub" supplies the ingest; default supplies the (empty) pipe.
	run := &fetchRun{
		engine:    ingest.New(),
		fetchedAt: fetchedAt,
		recipes: map[string]Recipe{
			defaultRecipeName: {},
			"stub":            {Ingest: "#test-stub"},
		},
	}
	ch := &Feed{Title: "T", URL: "irrelevant://value", Recipe: "stub"}
	ch.Fetch(context.Background(), run, buf, mod.New())
	if ch.FetchError != "" {
		t.Fatalf("FetchError = %q, want empty", ch.FetchError)
	}
	if len(ch.newItems) != 2 {
		t.Fatalf("got %d items, want 2 (recipe ingest #test-stub selected)", len(ch.newItems))
	}
}

// Feed.Fetch falls back to the default recipe's ingest when the feed's recipe
// sets only a pipe — proving axis-independent fallback through run.recipes.
func TestFeedFetchFallsBackToDefaultIngest(t *testing.T) {
	const fetchedAt int64 = 4_102_444_800
	buf := make([]byte, 1<<20)
	run := &fetchRun{
		engine:    ingest.New(),
		fetchedAt: fetchedAt,
		recipes: map[string]Recipe{
			defaultRecipeName: {Ingest: "#test-stub"},
			"onlypipe":        {Pipe: []string{"#sanitize"}}, // no ingest ⇒ inherit default's
		},
	}
	ch := &Feed{Title: "T", URL: "irrelevant://value", Recipe: "onlypipe"}
	ch.Fetch(context.Background(), run, buf, mod.New())
	if ch.FetchError != "" {
		t.Fatalf("FetchError = %q, want empty", ch.FetchError)
	}
	if len(ch.newItems) != 2 {
		t.Fatalf("got %d items, want 2 (fell back to default's #test-stub ingest)", len(ch.newItems))
	}
}

// A feed-level Ingest override wins over both the recipe's ingest and the
// default's: the recipe names an unknown built-in that would fail the fetch,
// so items arriving proves the feed's #test-stub was selected instead.
func TestFeedFetchFeedIngestOverridesRecipe(t *testing.T) {
	const fetchedAt int64 = 4_102_444_800
	buf := make([]byte, 1<<20)
	run := &fetchRun{
		engine:    ingest.New(),
		fetchedAt: fetchedAt,
		recipes: map[string]Recipe{
			defaultRecipeName: {},
			"bad":             {Ingest: "#no-such-builtin"},
		},
	}
	ch := &Feed{Title: "T", URL: "irrelevant://value", Recipe: "bad", Ingest: "#test-stub"}
	ch.Fetch(context.Background(), run, buf, mod.New())
	if ch.FetchError != "" {
		t.Fatalf("FetchError = %q, want empty", ch.FetchError)
	}
	if len(ch.newItems) != 2 {
		t.Fatalf("got %d items, want 2 (feed-level ingest override selected)", len(ch.newItems))
	}
}

// A feed-level Pipe override REPLACES the recipe's effective pipe (it does not
// append): the recipe's filter would drop stub-2, the feed's drops stub-1 —
// exactly one survivor proves only the feed's pipe ran.
func TestFeedFetchFeedPipeReplacesRecipePipe(t *testing.T) {
	const fetchedAt int64 = 4_102_444_800
	buf := make([]byte, 1<<20)
	run := &fetchRun{
		engine:    ingest.New(),
		fetchedAt: fetchedAt,
		recipes: map[string]Recipe{
			defaultRecipeName: {Ingest: "#test-stub"},
			"r":               {Pipe: []string{"#filter drop_title=/stub-2/"}},
		},
	}
	ch := &Feed{Title: "T", URL: "irrelevant://value", Recipe: "r",
		Pipe: []string{"#filter drop_title=/stub-1/"}}
	ch.Fetch(context.Background(), run, buf, mod.New())
	if ch.FetchError != "" {
		t.Fatalf("FetchError = %q, want empty", ch.FetchError)
	}
	if len(ch.newItems) != 1 || ch.newItems[0].Title != "stub-2" {
		t.Fatalf("newItems = %+v, want exactly [stub-2] (feed pipe replaced recipe pipe)", ch.newItems)
	}
}

// #default inside a feed-level Pipe expands to the feed's effective recipe
// pipe: with the feed pipe [#default, drop stub-1] both filters run and drop
// everything — proving the recipe's filter was spliced in, not discarded.
func TestFeedFetchFeedPipeDefaultExpandsToRecipePipe(t *testing.T) {
	const fetchedAt int64 = 4_102_444_800
	buf := make([]byte, 1<<20)
	run := &fetchRun{
		engine:    ingest.New(),
		fetchedAt: fetchedAt,
		recipes: map[string]Recipe{
			defaultRecipeName: {Ingest: "#test-stub"},
			"r":               {Pipe: []string{"#filter drop_title=/stub-2/"}},
		},
	}
	ch := &Feed{Title: "T", URL: "irrelevant://value", Recipe: "r",
		Pipe: []string{"#default", "#filter drop_title=/stub-1/"}}
	ch.Fetch(context.Background(), run, buf, mod.New())
	if ch.FetchError != "" {
		t.Fatalf("FetchError = %q, want empty", ch.FetchError)
	}
	if len(ch.newItems) != 0 {
		t.Fatalf("got %d items, want 0 (recipe pipe spliced in via #default drops the rest)", len(ch.newItems))
	}
}

// The pipe fallback chain composes per level: recipe over default, feed over
// recipe — an empty feed pipe inherits, a non-empty one replaces with #default
// splicing in the recipe's effective pipe.
func TestResolvePipeChainsPerLevel(t *testing.T) {
	def := []string{"#sanitize", "#minify"}
	recipe := []string{"#readability", "#default"}
	effRecipe := resolvePipe(def, recipe)
	if want := []string{"#readability", "#sanitize", "#minify"}; !slices.Equal(effRecipe, want) {
		t.Fatalf("recipe level = %v, want %v", effRecipe, want)
	}
	// Empty feed pipe inherits the recipe's effective pipe untouched.
	if got := resolvePipe(effRecipe, nil); !slices.Equal(got, effRecipe) {
		t.Errorf("empty feed pipe = %v, want inherited %v", got, effRecipe)
	}
	// Non-empty feed pipe replaces it; #default expands to the recipe's
	// effective (already default-expanded) pipe.
	got := resolvePipe(effRecipe, []string{"#filter drop_title=/x/", "#default"})
	want := []string{"#filter drop_title=/x/", "#readability", "#sanitize", "#minify"}
	if !slices.Equal(got, want) {
		t.Errorf("feed level = %v, want %v", got, want)
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

// A "deals" feed that re-dates its whole window to ~now on every rebuild
// (stable GUIDs, fresh pubDates) must not re-ingest the same articles. The
// watermark can't help — re-dated items always sit above it — so
// BoundaryGUIDs must remember the whole recent window, not only the newest
// item(s) at the watermark second. Real case: blog.ofertitas.es bumps every
// post's pubDate to the fetch minute, so ~half its stored feed was duplicates.
func TestFetchRedatedWholeWindowDedupes(t *testing.T) {
	build := func(day string) string {
		return fmt.Sprintf(`<rss version="2.0"><feed>
			<item><title>A</title><guid>a</guid><pubDate>%s 00:02:00 GMT</pubDate></item>
			<item><title>B</title><guid>b</guid><pubDate>%s 00:01:00 GMT</pubDate></item>
			<item><title>C</title><guid>c</guid><pubDate>%s 00:00:00 GMT</pubDate></item>
		</feed></rss>`, day, day, day)
	}
	current := build("Mon, 01 Jan 2024")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 3 {
		t.Fatalf("fetch1: got %d, want 3 (all new)", len(got))
	}
	// Publisher rebuilds the feed, re-dating every item a day later; GUIDs
	// unchanged. Nothing is actually new.
	current = build("Tue, 02 Jan 2024")
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch2: got %d, want 0 (re-dated window re-ingested — bg forgot every item below the newest)", len(got))
	}
	// Again, further ahead — dedup must hold across repeated rebuilds.
	current = build("Wed, 03 Jan 2024")
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch3: got %d, want 0 (re-dated window re-ingested again)", len(got))
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

// A stale cache copy of the feed — every dated item strictly below the
// watermark — must be ignored wholesale, preserving dedup state. Rebuilding
// the boundary snapshot from it evicts the watermark item's GUID, so the
// fresh copy one cycle later re-ingests that item as a duplicate (observed
// with YouTube's flappy feed CDN: a new video flickers out of one response
// and comes back the next).
func TestFetchStaleResponsePreservesDedupState(t *testing.T) {
	feedFresh := `<rss version="2.0"><feed>
		<item><title>NEW</title><guid>new</guid><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>OLD</title><guid>old</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feedStale := `<rss version="2.0"><feed>
		<item><title>OLD</title><guid>old</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`

	current := feedFresh
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 2 {
		t.Fatalf("fetch1: got %d, want 2", len(got))
	}
	priorWatermark := ch.Watermark
	priorBoundary := append([]uint32(nil), ch.BoundaryGUIDs...)

	current = feedStale
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Fatalf("fetch2 (stale): got %d, want 0", len(got))
	}
	if ch.Watermark != priorWatermark {
		t.Errorf("Watermark = %d, want %d (preserved across stale fetch)", ch.Watermark, priorWatermark)
	}
	if !slices.Equal(ch.BoundaryGUIDs, priorBoundary) {
		t.Errorf("BoundaryGUIDs = %v, want %v (preserved across stale fetch)", ch.BoundaryGUIDs, priorBoundary)
	}

	current = feedFresh
	if got := fetchOnce(t, ch, srv); len(got) != 0 {
		t.Errorf("fetch3: got %d, want 0 (watermark item re-ingested after stale fetch)", len(got))
	}
}

// The stale-response guard must stand down when the response carries any
// dateless item: dateless items bypass the watermark by design, so a response
// whose dated items all sit below the watermark can still hold new content.
func TestFetchStaleGuardStandsDownForDatelessItems(t *testing.T) {
	feedFresh := `<rss version="2.0"><feed>
		<item><title>NEW</title><guid>new</guid><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feedMixed := `<rss version="2.0"><feed>
		<item><title>DATELESS</title><guid>dateless</guid></item>
		<item><title>OLD</title><guid>old</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`

	current := feedFresh
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(current))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}

	if got := fetchOnce(t, ch, srv); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}

	current = feedMixed
	got := fetchOnce(t, ch, srv)
	if len(got) != 1 || got[0].Title != "DATELESS" {
		t.Errorf("fetch2: got %d items %v, want just DATELESS (guard swallowed a dateless item)", len(got), got)
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
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), nil, ingest.Select("", ""))
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

// Vitals (LastOK, FailStreak, LastNew) bump rules:
//   - A fetch that ingests ≥1 new articles sets LastOK, resets FailStreak, and
//     sets LastNew.
//   - A 304 / success-with-zero-new-items sets LastOK + resets FailStreak but
//     leaves LastNew unchanged.
//   - An error increments FailStreak and leaves LastOK / LastNew unchanged.
func TestFetchVitals(t *testing.T) {
	const fetchedAt int64 = 4_102_444_800 // 2100-01-01

	feedWithItem := `<rss version="2.0"><feed>
		<item><title>A</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feedEmpty := `<rss version="2.0"><feed></feed></rss>`

	t.Run("real_items_sets_all_three", func(t *testing.T) {
		current := feedWithItem
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte(current))
		}))
		defer srv.Close()

		ch := &Feed{Title: "T", URL: srv.URL}
		buf := make([]byte, 1<<20)
		run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
		processor := mod.New()

		ch.Fetch(context.Background(), run, buf, processor)
		if ch.FetchError != "" {
			t.Fatalf("unexpected error: %s", ch.FetchError)
		}
		if ch.LastOK != fetchedAt {
			t.Errorf("LastOK = %d, want %d (set on success with items)", ch.LastOK, fetchedAt)
		}
		if ch.FailStreak != 0 {
			t.Errorf("FailStreak = %d, want 0 (reset on success)", ch.FailStreak)
		}
		if ch.LastNew != fetchedAt {
			t.Errorf("LastNew = %d, want %d (set when ≥1 new item ingested)", ch.LastNew, fetchedAt)
		}
	})

	t.Run("success_with_zero_new_items_sets_lastok_not_lastnew", func(t *testing.T) {
		// First fetch stores the item; second fetch sees same item → 0 new items.
		current := feedWithItem
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte(current))
		}))
		defer srv.Close()

		ch := &Feed{Title: "T", URL: srv.URL}
		buf := make([]byte, 1<<20)
		const firstAt int64 = 1_000_000
		run1 := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: firstAt}
		ch.Fetch(context.Background(), run1, buf, mod.New())
		if ch.FetchError != "" {
			t.Fatalf("fetch1 error: %s", ch.FetchError)
		}

		// Second fetch: same body, no new items.
		const secondAt int64 = 2_000_000
		run2 := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: secondAt}
		ch.Fetch(context.Background(), run2, buf, mod.New())
		if ch.FetchError != "" {
			t.Fatalf("fetch2 error: %s", ch.FetchError)
		}

		if ch.LastOK != secondAt {
			t.Errorf("LastOK = %d, want %d (updated on success with 0 new items)", ch.LastOK, secondAt)
		}
		if ch.FailStreak != 0 {
			t.Errorf("FailStreak = %d, want 0 (still reset on success)", ch.FailStreak)
		}
		if ch.LastNew != firstAt {
			t.Errorf("LastNew = %d, want %d (unchanged when 0 new items ingested)", ch.LastNew, firstAt)
		}
	})

	t.Run("success_with_empty_feed_sets_lastok_not_lastnew", func(t *testing.T) {
		// Empty feed response (0 items) is a success but sets no LastNew.
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte(feedEmpty))
		}))
		defer srv.Close()

		ch := &Feed{Title: "T", URL: srv.URL}
		buf := make([]byte, 1<<20)
		run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
		ch.Fetch(context.Background(), run, buf, mod.New())

		if ch.LastOK != fetchedAt {
			t.Errorf("LastOK = %d, want %d (set on empty-feed success)", ch.LastOK, fetchedAt)
		}
		if ch.FailStreak != 0 {
			t.Errorf("FailStreak = %d, want 0", ch.FailStreak)
		}
		if ch.LastNew != 0 {
			t.Errorf("LastNew = %d, want 0 (never set on empty feed)", ch.LastNew)
		}
	})

	t.Run("error_increments_failstreak_leaves_lastok_lastnew", func(t *testing.T) {
		// Set up a feed with known prior vitals.
		// Point at a server that returns an HTTP 500 → hard error.
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()

		ch := &Feed{Title: "T", URL: srv.URL, LastOK: 999, LastNew: 888, FailStreak: 2}
		buf := make([]byte, 1<<20)
		run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
		ch.Fetch(context.Background(), run, buf, mod.New())

		if ch.FetchError == "" {
			t.Fatal("expected a FetchError after server error")
		}
		if ch.LastOK != 999 {
			t.Errorf("LastOK = %d, want 999 (unchanged on error)", ch.LastOK)
		}
		if ch.LastNew != 888 {
			t.Errorf("LastNew = %d, want 888 (unchanged on error)", ch.LastNew)
		}
		if ch.FailStreak != 3 {
			t.Errorf("FailStreak = %d, want 3 (incremented on error)", ch.FailStreak)
		}
	})

	t.Run("not_modified_304_sets_lastok_resets_failstreak_leaves_lastnew", func(t *testing.T) {
		// Server responds 304 when the conditional header (If-None-Match) is
		// present, unconditionally otherwise — ensures the real #feed path fires
		// the Not-Modified branch.
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("If-None-Match") != "" {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			// Fallback: should not be reached in this test.
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()

		const sentinelLastNew int64 = 777
		ch := &Feed{
			Title:      "T",
			URL:        srv.URL,
			ETag:       `"etag-token"`, // triggers If-None-Match on the request
			LastOK:     555,
			LastNew:    sentinelLastNew,
			FailStreak: 3,
		}
		buf := make([]byte, 1<<20)
		run := &fetchRun{client: srv.Client(), engine: ingest.New(), fetchedAt: fetchedAt}
		ch.Fetch(context.Background(), run, buf, mod.New())

		if ch.FetchError != "" {
			t.Fatalf("unexpected FetchError on 304: %s", ch.FetchError)
		}
		if ch.LastOK != fetchedAt {
			t.Errorf("LastOK = %d, want %d (set to fetchedAt on 304)", ch.LastOK, fetchedAt)
		}
		if ch.FailStreak != 0 {
			t.Errorf("FailStreak = %d, want 0 (reset on 304)", ch.FailStreak)
		}
		if ch.LastNew != sentinelLastNew {
			t.Errorf("LastNew = %d, want %d (unchanged on 304 — no new articles)", ch.LastNew, sentinelLastNew)
		}
	})
}

// TestFetchDroppedItemNotInStore verifies that when a pipeline step drops an
// item, the item is NOT added to the returned slice (i.e. never stored), but
// its GUID IS recorded in BoundaryGUIDs so a second identical fetch ingests
// nothing new (no re-drop churn).
func TestFetchDroppedItemNotInStore(t *testing.T) {
	// Feed with two items: one that matches the drop_title filter and one that
	// doesn't. The kept item must be ingested; the dropped item must not.
	feed := `<rss version="2.0"><feed>
		<item><title>Sponsored: buy now</title><guid>sponsored-1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>Real news today</title><guid>news-1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}
	const dropPipe = "#filter drop_title=/^sponsored/i"

	// First fetch: 2 items in feed, 1 dropped, 1 stored.
	items := fetchOnce(t, ch, srv, dropPipe)
	if len(items) != 1 {
		t.Fatalf("fetch1: got %d items, want 1 (dropped item must not be stored)", len(items))
	}
	if items[0].Title == "Sponsored: buy now" {
		t.Error("fetch1: dropped item appeared in stored items")
	}

	// The dropped item's GUID must be in BoundaryGUIDs so it won't be re-evaluated.
	// We use the FNV-32a hash that the ingest/feed.go `hash` function uses.
	// Rather than recomputing the hash here, check that a second fetch sees 0 new items
	// (which proves the GUID was retained in the boundary set).
	ch.ETag, ch.LastModified = "", ""
	items2 := fetchOnce(t, ch, srv, dropPipe)
	if len(items2) != 0 {
		t.Errorf("fetch2: got %d items, want 0 (dropped item re-evaluated — GUID not in boundary)", len(items2))
	}
}

// TestFetchDroppedItemGUIDInBoundary is a tighter version: asserts the dropped
// GUID appears literally in BoundaryGUIDs after the first fetch.
func TestFetchDroppedItemGUIDInBoundary(t *testing.T) {
	feed := `<rss version="2.0"><feed>
		<item><title>Sponsored post</title><guid>ad-item</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(feed))
	}))
	defer srv.Close()

	ch := &Feed{Title: "T"}
	items := fetchOnce(t, ch, srv, "#filter drop_title=/sponsored/i")

	if len(items) != 0 {
		t.Fatalf("fetch1: got %d items, want 0 (item should be dropped)", len(items))
	}

	// BoundaryGUIDs must be non-empty: the dropped item's GUID must be recorded.
	if len(ch.BoundaryGUIDs) == 0 {
		t.Error("BoundaryGUIDs is empty after a drop — dropped GUID not retained")
	}
}

func TestSelfhostMarkerRoundTripsToAssetsKey(t *testing.T) {
	// Allow the loopback test server through the mod's SSRF guard.
	allowLoopback(t)

	const body = "\xff\xd8\xff\xe0\x00\x10JFIF-some-jpeg-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	be := tempStore(t)
	af := newAssetFetcher(be, 1<<20, "") // no SRR_ASSET_PROCESS: store source bytes
	cacheDir := t.TempDir()
	ctx := mod.WithCacheDir(context.Background(), cacheDir)

	// 1) #selfhost downloads the remote image and rewrites src to a "#"-marker.
	item := &mod.RawItem{Content: `<p><img src="` + srv.URL + `/x.jpg"></p>`}
	m := mod.New()
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("selfhost: %v", err)
	}
	if !strings.Contains(item.Content, `src="#`) {
		t.Fatalf("expected an upload marker, got %q", item.Content)
	}

	// 2) The upload step (mirrors feed.go fetchURL): marker -> assets/ key.
	out, err := mod.RewriteAttrs(item.Content, func(local string) (string, bool, error) {
		key, _, err := af.UploadCacheRef(ctx, cacheDir, local)
		if err != nil {
			return "", false, err
		}
		return key, true, nil
	})
	if err != nil {
		t.Fatalf("upload step: %v", err)
	}

	sum := sha256.Sum256([]byte(body))
	wantKey := contentHashKey(".jpg", sum)
	if !strings.Contains(out, wantKey) {
		t.Fatalf("content %q missing assets key %q", out, wantKey)
	}
	if got := string(readKey(t, be, wantKey)); got != body {
		t.Errorf("stored bytes = %q, want %q", got, body)
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

// gateBackend wraps a store.Backend to make AtomicPut block on a per-call
// release, so a test can drive exactly how many uploads run concurrently and
// assert the observed peak never exceeds the semaphore cap. Deterministic: no
// sleeps — the test releases jobs one at a time and watches arrivals.
type gateBackend struct {
	store.Backend
	mu      sync.Mutex
	cur     int
	max     int
	arrived chan struct{} // one send per AtomicPut entry
	release chan struct{} // one receive unblocks one AtomicPut
}

func (g *gateBackend) AtomicPut(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta) error {
	g.mu.Lock()
	g.cur++
	if g.cur > g.max {
		g.max = g.cur
	}
	g.mu.Unlock()
	g.arrived <- struct{}{}
	<-g.release
	g.mu.Lock()
	g.cur--
	g.mu.Unlock()
	return g.Backend.AtomicPut(ctx, key, r, meta)
}

// ctxGateBackend blocks AtomicPut until released OR the passed ctx is cancelled,
// so a test can prove WHICH context the singleflight body runs under: cancelling
// the body's ctx aborts the store, cancelling an unrelated caller's ctx does not.
// (Only S3-class stores thread ctx into AtomicPut; this models that.)
type ctxGateBackend struct {
	store.Backend
	arrived chan struct{} // buffered; one send per AtomicPut entry
	release chan struct{} // buffered; one receive unblocks the store
	stored  chan struct{} // signalled after a real (non-aborted) AtomicPut
}

func (g *ctxGateBackend) AtomicPut(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta) error {
	g.arrived <- struct{}{}
	select {
	case <-g.release:
		err := g.Backend.AtomicPut(ctx, key, r, meta)
		if err == nil {
			g.stored <- struct{}{}
		}
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// A shared asset's singleflight body runs under the run ctx (a.baseCtx), NOT the
// leader feed's caller ctx: cancelling the LEADER caller must not fail a FOLLOWER
// feed coalescing on the same bytes. Regression for the cross-feed cancellation
// bug — pre-fix the body ran under the leader's per-feed ctx and broadcast its
// context.Canceled to every waiter.
func TestUploadCacheRefLeaderCancelDoesNotPoisonFollower(t *testing.T) {
	gate := &ctxGateBackend{
		Backend: tempStore(t),
		arrived: make(chan struct{}, 4),
		release: make(chan struct{}, 1),
		stored:  make(chan struct{}, 1),
	}
	af := testAssetFetcher(gate, 1<<20, "", 4) // baseCtx defaults to Background (the run ctx)
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "shared.jpg", jpegBytes)

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderDone := make(chan struct{})
	go func() {
		_, _, _ = af.UploadCacheRef(leaderCtx, cacheDir, "shared.jpg") // leader; may bail on cancel
		close(leaderDone)
	}()
	<-gate.arrived // leader is in-flight, blocked at AtomicPut(baseCtx)

	followerRes := make(chan error, 1)
	go func() {
		_, _, err := af.UploadCacheRef(context.Background(), cacheDir, "shared.jpg") // follower, healthy ctx
		followerRes <- err
	}()

	cancelLeader()             // the leader feed cancels mid-flight
	gate.release <- struct{}{} // the body (under baseCtx) proceeds and stores once
	select {
	case <-gate.stored:
	case <-time.After(2 * time.Second):
		t.Fatal("body did not store under the run ctx — leader cancel aborted the shared upload")
	}

	if err := <-followerRes; err != nil {
		t.Fatalf("follower feed poisoned by the leader's cancel: %v", err)
	}
	<-leaderDone
	select { // coalesced: no second AtomicPut arrival
	case <-gate.arrived:
		t.Error("asset uploaded more than once (singleflight did not coalesce)")
	default:
	}
}

// A follower coalescing on an in-flight shared upload honours its OWN ctx: when
// its feed cancels it returns promptly (DoChan caller-select) without waiting on
// the leader — and never held a worker slot. Covers the slot-pinning fix.
func TestUploadCacheRefFollowerBailsOnOwnCtx(t *testing.T) {
	gate := &gateBackend{
		Backend: tempStore(t),
		arrived: make(chan struct{}, 4),
		release: make(chan struct{}),
	}
	af := testAssetFetcher(gate, 1<<20, "", 4)
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "shared.jpg", jpegBytes)

	leaderDone := make(chan struct{})
	go func() {
		if _, _, err := af.UploadCacheRef(context.Background(), cacheDir, "shared.jpg"); err != nil {
			t.Errorf("leader failed: %v", err)
		}
		close(leaderDone)
	}()
	<-gate.arrived // leader blocked at the gate

	followerCtx, cancelFollower := context.WithCancel(context.Background())
	followerRes := make(chan error, 1)
	go func() {
		_, _, err := af.UploadCacheRef(followerCtx, cacheDir, "shared.jpg")
		followerRes <- err
	}()
	cancelFollower() // the follower's feed cancels; it must not wait for the leader
	select {
	case err := <-followerRes:
		if err != context.Canceled {
			t.Fatalf("follower err = %v, want context.Canceled (bailed on own ctx)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("follower blocked on the leader instead of honouring its own ctx")
	}
	gate.release <- struct{}{} // let the leader finish
	<-leaderDone
}

// testAssetFetcher builds an assetFetcher wired the way FetchCmd.fetch does: a
// run/shutdown baseCtx and a worker pool of the given size (cap >= 1), which the
// singleflight leader job holds. Tests that drive uploadAssets construct the
// fetcher through this so the pool/ctx live where production puts them.
func testAssetFetcher(be store.Backend, maxKB int, procCmd string, workers int) *assetFetcher {
	a := newAssetFetcher(be, maxKB, procCmd)
	a.sem = make(chan struct{}, max(1, workers))
	return a
}

// assetItems builds n items each referencing a distinct cache file (distinct
// bytes ⇒ distinct source hash ⇒ no seen/existence dedup), plus the cache dir.
func assetItems(t *testing.T, n int) (string, []*Item) {
	t.Helper()
	cacheDir := t.TempDir()
	items := make([]*Item, n)
	for k := 0; k < n; k++ {
		name := fmt.Sprintf("a%d.jpg", k)
		writeCacheFile(t, cacheDir, name, fmt.Sprintf("BYTES-%d", k))
		items[k] = &Item{Content: fmt.Sprintf(`<p><img src="#/%s"></p>`, name)}
	}
	return cacheDir, items
}

func TestUploadAssetsConcurrencyBound(t *testing.T) {
	const limit, n = 2, 3
	gate := &gateBackend{
		Backend: tempStore(t),
		arrived: make(chan struct{}),
		release: make(chan struct{}),
	}
	cacheDir, items := assetItems(t, n)
	run := &fetchRun{
		assets:   testAssetFetcher(gate, 1<<20, "", limit),
		cacheDir: cacheDir,
	}

	done := make(chan error, 1)
	go func() { done <- run.uploadAssets(context.Background(), &Feed{}, items) }()

	// Exactly `limit` jobs reach AtomicPut and block.
	for k := 0; k < limit; k++ {
		<-gate.arrived
	}
	// Release one → frees a slot → the (limit+1)-th job now arrives. Proves the
	// cap both holds (only `limit` arrived first) and makes progress.
	gate.release <- struct{}{}
	<-gate.arrived
	// Release the rest.
	for k := 0; k < n-1; k++ {
		gate.release <- struct{}{}
	}
	if err := <-done; err != nil {
		t.Fatalf("uploadAssets: %v", err)
	}
	if gate.max > limit {
		t.Errorf("peak concurrency = %d, want <= %d", gate.max, limit)
	}
	for k, it := range items {
		if strings.Contains(it.Content, "#/") {
			t.Errorf("item %d not rewritten: %q", k, it.Content)
		}
		if !strings.Contains(it.Content, "assets/") {
			t.Errorf("item %d missing assets/ key: %q", k, it.Content)
		}
	}
}

func TestUploadAssetsRewritesAndSkipsMarkerless(t *testing.T) {
	be := tempStore(t)
	cacheDir, marked := assetItems(t, 2)
	plain := &Item{Content: `<p>no markers, cost #1</p>`}
	items := append(marked, plain)
	run := &fetchRun{
		assets:   testAssetFetcher(be, 1<<20, "", 4),
		cacheDir: cacheDir,
	}
	if err := run.uploadAssets(context.Background(), &Feed{}, items); err != nil {
		t.Fatalf("uploadAssets: %v", err)
	}
	for k := 0; k < 2; k++ {
		if !strings.Contains(items[k].Content, "assets/") {
			t.Errorf("marked item %d not rewritten: %q", k, items[k].Content)
		}
	}
	if plain.Content != `<p>no markers, cost #1</p>` {
		t.Errorf("marker-less item mutated: %q", plain.Content)
	}
}

func TestUploadAssetsFailsFeedOnUploadError(t *testing.T) {
	be := &failMidWriteBackend{Backend: tempStore(t), writeOK: 2}
	cacheDir, items := assetItems(t, 2)
	run := &fetchRun{
		assets:   testAssetFetcher(be, 1<<20, "", 4),
		cacheDir: cacheDir,
	}
	if err := run.uploadAssets(context.Background(), &Feed{}, items); err == nil {
		t.Fatal("expected uploadAssets to fail the feed, got nil")
	}
}

// assetStubItems is the per-call result of the "asset-stub" ingest strategy; a
// test sets it before driving fetchURL. Registered once below.
var assetStubItems []*mod.RawItem

func init() {
	ingest.Register("asset-stub", func(_ context.Context, _ *http.Client, _ []byte, _ ingest.Request) (ingest.Result, error) {
		return ingest.Result{Items: assetStubItems}, nil
	})
}

// TestFetchDoesNotReconvertAlreadySeenArticleAsset reproduces the user's report
// — "article assets are processed even when already seen / converted every fetch."
// It drives two full fetchURL cycles over the SAME feed (dedup state carried on
// ch), each with a fresh assetFetcher against ONE persistent store, exactly as
// production does (a new fetcher per run, one durable backend). The marker-bearing
// item is new in cycle 1 (asset converted once) and an already-seen duplicate in
// cycle 2 (deduped before the pipeline, so never re-converted). asset-process must
// run exactly once across both fetches.
func TestFetchDoesNotReconvertAlreadySeenArticleAsset(t *testing.T) {
	proc, processRuns := procCounter(t)

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "shared.jpg", jpegBytes)
	pub := time.Unix(1700000000, 0)
	assetStubItems = []*mod.RawItem{
		{GUID: 42, Title: "msg", Link: "https://tg/42", Published: &pub,
			Content: `<p><img src="#/shared.jpg"></p>`},
	}

	be := tempStore(t) // one persistent store across both cycles
	ch := &Feed{Title: "tg", URL: "irrelevant://value"}
	buf := make([]byte, 1<<20)
	const fetchedAt int64 = 4_102_444_800

	fetchCycle := func() []*Item {
		run := &fetchRun{
			engine:    ingest.New(),
			fetchedAt: fetchedAt,
			assets:    testAssetFetcher(be, 1<<20, proc, 4), // fresh fetcher per run
			cacheDir:  cacheDir,
		}
		items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), nil, "#asset-stub")
		if err != nil {
			t.Fatalf("fetch: %v", err)
		}
		return items
	}

	first := fetchCycle()
	if len(first) != 1 {
		t.Fatalf("cycle 1: got %d new items, want 1", len(first))
	}
	// The full fetchURL path charges the feed for the stored payload (the
	// procCounter command is a pass-through, so payload == source bytes).
	if want := int64(len(jpegBytes)); ch.AssetBytes != want {
		t.Errorf("cycle 1 AssetBytes = %d, want %d", ch.AssetBytes, want)
	}
	second := fetchCycle()
	if len(second) != 0 {
		t.Fatalf("cycle 2: got %d new items, want 0 (article already seen)", len(second))
	}
	if want := int64(len(jpegBytes)); ch.AssetBytes != want {
		t.Errorf("cycle 2 AssetBytes = %d, want %d (no double charge across cycles)", ch.AssetBytes, want)
	}

	if n := processRuns(); n != 1 {
		t.Errorf("asset-process ran %d times across two fetches of one article, want 1", n)
	}
}

// TestUploadAssetsProcessesSharedAssetOnce pins the within-run dedup guarantee
// under the parallel upload path: when several of a feed's articles reference
// the SAME asset (identical bytes ⇒ identical source hash), the asset-process
// command must run exactly once across the whole fetch, not once per article.
// The serial path always hit the memo/store-existence check; the parallel path
// must not regress that into N concurrent transcodes of one already-seen asset.
func TestUploadAssetsProcessesSharedAssetOnce(t *testing.T) {
	const n = 6
	proc, processRuns := procCounter(t)

	// One cache file, n items all referencing it ⇒ one source hash, n markers.
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "shared.jpg", jpegBytes)
	items := make([]*Item, n)
	for k := range items {
		items[k] = &Item{Content: `<p><img src="#/shared.jpg"></p>`}
	}

	ch := &Feed{}
	run := &fetchRun{
		assets:   testAssetFetcher(tempStore(t), 1<<20, proc, n), // all items run concurrently
		cacheDir: cacheDir,
	}
	if err := run.uploadAssets(context.Background(), ch, items); err != nil {
		t.Fatalf("uploadAssets: %v", err)
	}

	if n := processRuns(); n != 1 {
		t.Errorf("asset-process ran %d times for one shared asset, want 1", n)
	}
	// One stored object ⇒ one charge, however many concurrent markers raced.
	if want := int64(len(jpegBytes)); ch.AssetBytes != want {
		t.Errorf("AssetBytes = %d, want %d (one charge for one stored object)", ch.AssetBytes, want)
	}
	for k, it := range items {
		if !strings.Contains(it.Content, "assets/") {
			t.Errorf("item %d not rewritten: %q", k, it.Content)
		}
	}
}

// A corrupt asset (errCorruptAsset from UploadCacheRef) must not fail the feed:
// the marker is declined — the article publishes without working media — and
// the run counts it for the cycle-level warning.
func TestRewriteItemAssetsDeclinesCorrupt(t *testing.T) {
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "clip.mp4", "NOT-A-REAL-MP4")
	af := testAssetFetcher(tempStore(t), 1024, "", 1)
	af.peek = strings.Fields(fakePeek(t, `{"mimetype":"application/octet-stream","extension":"","supported":false}`))
	run := &fetchRun{assets: af, cacheDir: cacheDir}

	item := &Item{Content: `<p><video src="#/clip.mp4"></video></p>`}
	if err := run.rewriteItemAssets(context.Background(), item, new(atomic.Int64)); err != nil {
		t.Fatalf("rewriteItemAssets: %v (corrupt must decline, not fail the feed)", err)
	}
	if !strings.Contains(item.Content, `src="#/clip.mp4"`) {
		t.Errorf("marker rewritten despite corrupt source: %s", item.Content)
	}
}

// AssetBytes accounting: a feed is charged each stored object's bytes exactly
// once — a marker repeated across the feed's items adds nothing beyond the one
// upload, and a later run whose assets already sit in the store adds nothing.
func TestUploadAssetsCountsBytesOncePerStoredObject(t *testing.T) {
	be := tempStore(t)
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "a.jpg", "AAAA")     // 4 bytes
	writeCacheFile(t, cacheDir, "b.jpg", "BBBBBBBB") // 8 bytes
	items := []*Item{
		{Content: `<p><img src="#/a.jpg"></p>`},
		{Content: `<p><img src="#/b.jpg"><img src="#/a.jpg"></p>`}, // a.jpg repeated
	}
	ch := &Feed{}
	run := &fetchRun{assets: testAssetFetcher(be, 1<<20, "", 4), cacheDir: cacheDir}
	if err := run.uploadAssets(context.Background(), ch, items); err != nil {
		t.Fatalf("uploadAssets: %v", err)
	}
	if ch.AssetBytes != 12 {
		t.Fatalf("AssetBytes = %d, want 12 (each stored object charged once)", ch.AssetBytes)
	}

	// Fresh fetcher (no memo), same store: both keys dedup on the existence
	// check — nothing added, nothing charged.
	ch2 := &Feed{}
	run2 := &fetchRun{assets: testAssetFetcher(be, 1<<20, "", 4), cacheDir: cacheDir}
	items2 := []*Item{{Content: `<p><img src="#/a.jpg"><img src="#/b.jpg"></p>`}}
	if err := run2.uploadAssets(context.Background(), ch2, items2); err != nil {
		t.Fatalf("uploadAssets 2: %v", err)
	}
	if ch2.AssetBytes != 0 {
		t.Fatalf("AssetBytes on dedup-hit run = %d, want 0", ch2.AssetBytes)
	}
}

// The run-global fetcher is shared across feeds; when several feeds' fetches
// reference the SAME asset concurrently, exactly one of them (the singleflight
// leader's) is charged — the total across feeds equals the stored size once.
func TestUploadAssetsSharedAcrossFeedsChargesOnce(t *testing.T) {
	const feeds = 4
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "shared.jpg", jpegBytes)
	run := &fetchRun{assets: testAssetFetcher(tempStore(t), 1<<20, "", feeds), cacheDir: cacheDir}

	chs := make([]*Feed, feeds)
	errs := make([]error, feeds)
	var wg sync.WaitGroup
	for k := range chs {
		chs[k] = &Feed{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			items := []*Item{{Content: `<p><img src="#/shared.jpg"></p>`}}
			errs[k] = run.uploadAssets(context.Background(), chs[k], items)
		}()
	}
	wg.Wait()

	var total int64
	for k, ch := range chs {
		if errs[k] != nil {
			t.Fatalf("uploadAssets[%d]: %v", k, errs[k])
		}
		total += ch.AssetBytes
	}
	if want := int64(len(jpegBytes)); total != want {
		t.Fatalf("total AssetBytes across feeds = %d, want %d (charged exactly once)", total, want)
	}
}

// failAfterNPutsBackend lets okPuts AtomicPuts through to the inner backend,
// then fails every subsequent one.
type failAfterNPutsBackend struct {
	store.Backend
	mu     sync.Mutex
	okPuts int
}

func (f *failAfterNPutsBackend) AtomicPut(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta) error {
	f.mu.Lock()
	ok := f.okPuts > 0
	if ok {
		f.okPuts--
	}
	f.mu.Unlock()
	if !ok {
		return io.ErrUnexpectedEOF
	}
	return f.Backend.AtomicPut(ctx, key, r, meta)
}

// A batch that fails mid-way still charges the feed for the Puts that DID
// complete: those bytes are in the store regardless, and the retry next fetch
// dedups against them (adding nothing), so skipping the charge would lose
// them forever.
func TestUploadAssetsPartialFailureChargesCompletedPuts(t *testing.T) {
	be := &failAfterNPutsBackend{Backend: tempStore(t), okPuts: 1}
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "a.jpg", "AAAA")     // 4 bytes — first Put, succeeds
	writeCacheFile(t, cacheDir, "b.jpg", "BBBBBBBB") // second Put, fails
	// One item, two markers: RewriteAttrs uploads sequentially in document
	// order, so the success/failure split is deterministic.
	items := []*Item{{Content: `<p><img src="#/a.jpg"><img src="#/b.jpg"></p>`}}
	ch := &Feed{}
	run := &fetchRun{assets: testAssetFetcher(be, 1<<20, "", 1), cacheDir: cacheDir}
	if err := run.uploadAssets(context.Background(), ch, items); err == nil {
		t.Fatal("expected uploadAssets to fail on the second Put")
	}
	if ch.AssetBytes != 4 {
		t.Fatalf("AssetBytes = %d, want 4 (the completed a.jpg Put)", ch.AssetBytes)
	}
}
