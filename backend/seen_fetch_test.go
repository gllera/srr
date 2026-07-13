package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"srr/ingest"
	"srr/mod"
)

// fetchWithPool runs one fetchURL cycle threading a shared seenPool and a store
// dedup-days default, then merges the feed's collected stamps into the pool at
// `day` — exactly what cmd_fetch does after g.Wait(). It deliberately does NOT
// evict (age/cap eviction is exercised directly on the pool in seen_test.go), so
// a stamp survives regardless of `day` and the cross-fetch dedup is unambiguous.
func fetchWithPool(t *testing.T, ch *Feed, srv *httptest.Server, pool *seenPool, storeDedupDays int, day uint16) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	ch.URL = srv.URL
	ch.ETag, ch.LastModified = "", ""
	const fetchedAt int64 = 4_102_444_800 // 2100-01-01, past every fixture pubDate
	run := &fetchRun{
		client:    srv.Client(),
		engine:    ingest.New(),
		fetchedAt: fetchedAt,
		seen:      pool,
		dedupDays: storeDedupDays,
	}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), nil, ingest.Select("", ""))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	for _, h := range ch.seenStamps {
		pool.stamp(ch.id, h, day)
	}
	return items
}

// T1 — the reported re-promotion bug. A feed re-publishes an old item with a
// fresh pubDate but a stable GUID after that GUID has fallen out of the small bg
// snapshot: today it re-ingests as a duplicate; the pool must remember it and
// suppress it. Three fetches on one feed:
//
//	X{guid=x,pub=Jan01} → 1 ; Y{guid=y,pub=Jan02} (X gone) → 1 ;
//	X{guid=x,pub=Jan03} (re-promoted, fresh date, X back) → 0.
func TestFetchSeenPoolSuppressesRepromotion(t *testing.T) {
	itemX := func(day string) string {
		return fmt.Sprintf(`<item><title>Offer</title><guid>x</guid><pubDate>%s 00:00:00 GMT</pubDate></item>`, day)
	}
	itemY := `<item><title>News</title><guid>y</guid><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>`

	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `<rss version="2.0"><feed>%s</feed></rss>`, current)
	}))
	defer srv.Close()

	pool := newSeenPool()
	ch := &Feed{Title: "T"}

	current = itemX("Mon, 01 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1 (X is new)", len(got))
	}
	current = itemY
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch2: got %d, want 1 (Y is new; X absent)", len(got))
	}
	current = itemX("Wed, 03 Jan 2024") // re-promoted: fresh date, stable guid, X back
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 0 {
		t.Errorf("fetch3: got %d, want 0 (pool remembers x; re-promotion suppressed)", len(got))
	}
}

// End-to-end through the real runFetch cycle. Each fetchLoop call opens a fresh
// DB, so dedup state survives ONLY via db.gz + seen.gz on the store — this
// exercises the full load → fan-out → merge → evict → Commit → SyncSeen → reload
// chain, not just fetchURL. The re-promotion that duplicates today (cycle 3) is
// suppressed once the pool has persisted the GUID.
func TestFetchCycleSeenPoolSuppressesRepromotionEndToEnd(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)

	itemX := func(day string) string {
		return fmt.Sprintf(`<item><title>Offer</title><guid>x</guid><link>https://e.example/x</link><pubDate>%s 00:00:00 GMT</pubDate></item>`, day)
	}
	const itemY = `<item><title>News</title><guid>y</guid><link>https://e.example/y</link><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>`
	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `<?xml version="1.0"?><rss version="2.0"><channel><title>S</title>%s</channel></rss>`, current)
	}))
	t.Cleanup(srv.Close)
	seedFeed(t, db, &Feed{Title: "Deals", URL: srv.URL})

	runCycle := func() {
		if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
			t.Fatalf("fetchLoop: %v", err)
		}
	}
	total := func() int {
		var n int
		if err := withDB(false, func(_ context.Context, d *DB) error { n = d.core.TotalArticles; return nil }); err != nil {
			t.Fatalf("read total: %v", err)
		}
		return n
	}

	current = itemX("Mon, 01 Jan 2024")
	runCycle()
	if got := total(); got != 1 {
		t.Fatalf("after cycle 1: TotalArticles = %d, want 1 (X new)", got)
	}
	current = itemY // X gone from the window
	runCycle()
	if got := total(); got != 2 {
		t.Fatalf("after cycle 2: TotalArticles = %d, want 2 (Y new)", got)
	}
	current = itemX("Wed, 03 Jan 2024") // X re-promoted: fresh date, stable guid, out of bg
	runCycle()
	if got := total(); got != 2 {
		t.Errorf("after cycle 3: TotalArticles = %d, want 2 (re-promotion suppressed by seen.gz)", got)
	}
}

// End-to-end guard for the id-reuse hazard: remove a feed, then add a new feed
// for the SAME source that reuses the freed id (AddFeed picks the smallest free
// id, with no fetch cycle between). The reused id must start with no dedup
// history, so the same item re-ingests — RemoveFeed's synchronous pool purge
// (dropFeed), persisted via commitState, is what makes this hold.
func TestFetchCycleReusedFeedIdStartsClean(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)

	const item = `<item><title>Offer</title><guid>x</guid><link>https://e.example/x</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `<?xml version="1.0"?><rss version="2.0"><channel><title>S</title>%s</channel></rss>`, item)
	}))
	t.Cleanup(srv.Close)

	seedFeed(t, db, &Feed{Title: "A", URL: srv.URL})
	runCycle := func() {
		if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
			t.Fatalf("fetchLoop: %v", err)
		}
	}
	total := func() int {
		var n int
		if err := withDB(false, func(_ context.Context, d *DB) error { n = d.core.TotalArticles; return nil }); err != nil {
			t.Fatalf("read total: %v", err)
		}
		return n
	}

	runCycle()
	if got := total(); got != 1 {
		t.Fatalf("cycle 1: TotalArticles = %d, want 1", got)
	}

	// Remove feed 0, then add a new feed for the same source — it reuses id 0.
	if err := (&RmCmd{ID: []int{0}}).Run(); err != nil {
		t.Fatalf("rm: %v", err)
	}
	stubPassthroughResolve()
	if err := (&AddCmd{Title: strPtr("B"), URL: strPtr(srv.URL)}).Run(); err != nil {
		t.Fatalf("add: %v", err)
	}

	// The reused-id feed re-fetches the same guid: it must INGEST (no inherited
	// history), so the store gains a second article.
	runCycle()
	if got := total(); got != 2 {
		t.Errorf("cycle 2: TotalArticles = %d, want 2 (reused id must not inherit feed A's dedup history)", got)
	}
}

// T2 — title dedup on a `dt` feed catches the other re-promotion variant: a new
// GUID minted for the same headline. With DedupTitle it suppresses; without it,
// the new GUID ingests.
func TestFetchSeenPoolTitleDedup(t *testing.T) {
	build := func(guid, day string) string {
		return fmt.Sprintf(`<rss version="2.0"><feed><item><title>Same Headline</title><guid>%s</guid><pubDate>%s 00:00:00 GMT</pubDate></item></feed></rss>`, guid, day)
	}
	run := func(dedupTitle bool) int {
		var current string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, current)
		}))
		defer srv.Close()
		pool := newSeenPool()
		ch := &Feed{Title: "T", DedupTitle: dedupTitle}
		current = build("g1", "Mon, 01 Jan 2024")
		if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
			t.Fatalf("fetch1: got %d, want 1", len(got))
		}
		current = build("g2", "Tue, 02 Jan 2024") // new guid, same title, fresh date
		return len(fetchWithPool(t, ch, srv, pool, 30, 100))
	}

	if n := run(true); n != 0 {
		t.Errorf("DedupTitle=true: fetch2 ingested %d, want 0 (same headline, new guid)", n)
	}
	if n := run(false); n != 1 {
		t.Errorf("DedupTitle=false: fetch2 ingested %d, want 1 (title axis off)", n)
	}
}

// T3 — an `nt` (NoTitle microblog) feed ignores the title axis even with
// DedupTitle set: a same-title/new-guid item still ingests (guid axis only).
func TestFetchSeenPoolTitleDedupSkippedForNoTitle(t *testing.T) {
	build := func(guid, day string) string {
		return fmt.Sprintf(`<rss version="2.0"><feed><item><title>Same Headline</title><guid>%s</guid><pubDate>%s 00:00:00 GMT</pubDate></item></feed></rss>`, guid, day)
	}
	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, current)
	}))
	defer srv.Close()
	pool := newSeenPool()
	ch := &Feed{Title: "T", DedupTitle: true, NoTitle: true}

	current = build("g1", "Mon, 01 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = build("g2", "Tue, 02 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Errorf("nt feed: fetch2 ingested %d, want 1 (title axis must not fire)", len(got))
	}
}

// The title axis must NOT fire on an EMPTY title. foldSearchText("") is "" and
// titleHash("") is a single fixed value, so without a guard every titleless item
// on a DedupTitle feed collides on that one hash — a deterministic, silent,
// indefinite drop of all-but-one titleless item. A titled feed (not NoTitle) can
// still carry occasional titleless posts (photo/link-only), so this is real. The
// guid axis must still ingest each distinct titleless item.
func TestFetchSeenPoolEmptyTitleNotDeduped(t *testing.T) {
	build := func(guid string) string { // no <title> ⇒ empty title
		return fmt.Sprintf(`<rss version="2.0"><feed><item><guid>%s</guid><link>https://e/%s</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></feed></rss>`, guid, guid)
	}
	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, current)
	}))
	defer srv.Close()
	pool := newSeenPool()
	ch := &Feed{Title: "T", DedupTitle: true} // title axis ON, but NOT NoTitle

	current = build("g1") // first titleless item
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = build("g2") // distinct titleless item; g1 gone from the window
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Errorf("fetch2 ingested %d, want 1 (empty titles must not collide on the title axis)", len(got))
	}
}

// T4 — a feed that legitimately recurs a headline with a fresh GUID each time
// (e.g. a weekly column), dt OFF (the default), must NOT over-suppress: every
// new GUID ingests. Guards against accidental blanket title-dedup.
func TestFetchSeenPoolRecurringTitleNotSuppressedByDefault(t *testing.T) {
	build := func(guid, day string) string {
		return fmt.Sprintf(`<rss version="2.0"><feed><item><title>Weekly Roundup</title><guid>%s</guid><pubDate>%s 00:00:00 GMT</pubDate></item></feed></rss>`, guid, day)
	}
	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, current)
	}))
	defer srv.Close()
	pool := newSeenPool()
	ch := &Feed{Title: "T"} // DedupTitle false (default)

	current = build("w1", "Mon, 01 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = build("w2", "Mon, 08 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Errorf("recurring title, dt off: fetch2 ingested %d, want 1 (must not suppress)", len(got))
	}
}

// T8 — a per-feed disabled pool (DedupDays == -1) falls back to exact bg-only
// behavior: the T1 re-promotion is NOT suppressed (it re-ingests, today's
// behavior), and the feed stamps nothing into the pool.
func TestFetchSeenPoolDisabledFallsBackToBg(t *testing.T) {
	itemX := func(day string) string {
		return fmt.Sprintf(`<rss version="2.0"><feed><item><title>Offer</title><guid>x</guid><pubDate>%s 00:00:00 GMT</pubDate></item></feed></rss>`, day)
	}
	itemY := `<rss version="2.0"><feed><item><title>News</title><guid>y</guid><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item></feed></rss>`
	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, current)
	}))
	defer srv.Close()
	pool := newSeenPool()
	ch := &Feed{Title: "T", DedupDays: -1} // pool disabled for this feed

	current = itemX("Mon, 01 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1", len(got))
	}
	current = itemY
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch2: got %d, want 1", len(got))
	}
	current = itemX("Wed, 03 Jan 2024")
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Errorf("disabled feed: fetch3 ingested %d, want 1 (bg-only; no pool suppression)", len(got))
	}
	if len(pool.m) != 0 {
		t.Errorf("disabled feed stamped %d pool entries, want 0", len(pool.m))
	}
}

// T12 — a stale-response-guarded fetch and a transient empty fetch each leave
// the pool untouched: no stamps are collected, so the merge adds nothing and the
// serialized pool is byte-identical.
func TestFetchSeenPoolStaleAndEmptyDoNotStamp(t *testing.T) {
	feedFresh := `<rss version="2.0"><feed>
		<item><title>NEW</title><guid>new</guid><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>OLD</title><guid>old</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feedStale := `<rss version="2.0"><feed>
		<item><title>OLD</title><guid>old</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
	</feed></rss>`
	feedEmpty := `<rss version="2.0"><feed></feed></rss>`

	for _, tc := range []struct {
		name  string
		after string
	}{
		{"stale", feedStale},
		{"empty", feedEmpty},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var current string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, current)
			}))
			defer srv.Close()
			pool := newSeenPool()
			ch := &Feed{Title: "T"}

			current = feedFresh
			if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 2 {
				t.Fatalf("fetch1: got %d, want 2", len(got))
			}
			before := string(pool.marshal())

			current = tc.after
			got := fetchWithPool(t, ch, srv, pool, 30, 100)
			if len(got) != 0 {
				t.Fatalf("fetch2 (%s): got %d items, want 0", tc.name, len(got))
			}
			if len(ch.seenStamps) != 0 {
				t.Errorf("fetch2 (%s): collected %d stamps, want 0", tc.name, len(ch.seenStamps))
			}
			if after := string(pool.marshal()); after != before {
				t.Errorf("fetch2 (%s): pool changed, want byte-identical", tc.name)
			}
		})
	}
}

// An over-cap `must` item skipped from ingestion must NOT be stamped into the
// pool. The boundary cap deliberately drops over-cap `must` items from ingestion
// so they retry once the feed window shrinks below the cap (feed.go's over-cap
// comment). If the pool stamped them, seenBefore would suppress them forever —
// turning skip-and-retry into skip-forever, a silent article loss. The
// construction pins the dropped item deterministically: maxBoundaryGUIDs already
// stored A-items fill the cap as `prior`, so a single new B-item is the sole
// `dropped` one. The behavioral proof is the third fetch: with B never stamped,
// it ingests once its window has room; a stamped B would stay suppressed.
func TestFetchSeenPoolOverCapDroppedItemNotSuppressed(t *testing.T) {
	item := func(guid string) string { // dateless ⇒ always `must`
		return fmt.Sprintf(`<item><title>%s</title><guid>%s</guid><link>https://e/%s</link></item>`, guid, guid, guid)
	}
	var a strings.Builder
	for i := range maxBoundaryGUIDs {
		a.WriteString(item(fmt.Sprintf("a%d", i)))
	}
	itemsA := a.String()
	bItem := item("b-new")

	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `<rss version="2.0"><feed>%s</feed></rss>`, current)
	}))
	defer srv.Close()

	pool := newSeenPool()
	ch := &Feed{Title: "T"}

	current = itemsA
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != maxBoundaryGUIDs {
		t.Fatalf("fetch1: got %d, want %d (all A-items new)", len(got), maxBoundaryGUIDs)
	}
	current = itemsA + bItem // over cap by one: the A-items are `prior`, B is the sole dropped item
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 0 {
		t.Fatalf("fetch2: got %d, want 0 (A-items dedup; B is over-cap, skipped from ingestion)", len(got))
	}
	current = bItem // window shrinks to just B; the A-items aged out, so B now has room
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Errorf("fetch3: got %d, want 1 (B was never ingested nor stamped, so it must ingest now)", len(got))
	}
}

// The dual of the case above: an over-cap `dropped` item that the pool ALREADY
// remembers (a re-promotion whose GUID aged out of bg but not the pool) must
// keep its clock refreshed. The pool only ever holds stored GUIDs, so a dropped
// pool-hit is genuinely stored — un-stamping it would let its entry age out and
// re-ingest as a duplicate later. So the rule is "skip a dropped item ONLY when
// the pool doesn't already know it". Construction: R is stored+pooled, falls out
// of bg while staying pooled, then re-promotes into a >cap `must` window where
// the bg-resident W items are `prior` and R is the sole dropped one — yet a
// pool-hit, so its stamp day must advance to the latest fetch.
func TestFetchSeenPoolOverCapPoolHitStaysRemembered(t *testing.T) {
	item := func(guid string) string { // dateless ⇒ always `must`
		return fmt.Sprintf(`<item><title>%s</title><guid>%s</guid><link>https://e/%s</link></item>`, guid, guid, guid)
	}
	var sb strings.Builder
	for i := range maxBoundaryGUIDs {
		sb.WriteString(item(fmt.Sprintf("w%d", i)))
	}
	itemsW := sb.String()
	rItem := item("r")

	var current string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `<rss version="2.0"><feed>%s</feed></rss>`, current)
	}))
	defer srv.Close()

	pool := newSeenPool()
	ch := &Feed{Title: "T"}

	current = rItem // R alone: stored + pooled at day 100
	if got := fetchWithPool(t, ch, srv, pool, 30, 100); len(got) != 1 {
		t.Fatalf("fetch1: got %d, want 1 (R new)", len(got))
	}
	if len(pool.m) != 1 {
		t.Fatalf("after fetch1: pool has %d entries, want 1 (R only)", len(pool.m))
	}
	var rKey uint64
	for k := range pool.m {
		rKey = k // R's pool key, captured while it's the only entry
	}

	current = itemsW // R falls out of the window; bg rebuilds to the W items only
	if got := fetchWithPool(t, ch, srv, pool, 30, 110); len(got) != maxBoundaryGUIDs {
		t.Fatalf("fetch2: got %d, want %d (all W new; R absent)", len(got), maxBoundaryGUIDs)
	}

	current = itemsW + rItem // R re-promoted into a >cap must window: W are `prior`, R the sole dropped
	if got := fetchWithPool(t, ch, srv, pool, 30, 130); len(got) != 0 {
		t.Fatalf("fetch3: got %d, want 0 (W dedup; R is a pool-hit, suppressed)", len(got))
	}
	if got := pool.m[rKey]; got != 130 {
		t.Errorf("R's pool clock = %d, want 130 (a pooled over-cap item must stay remembered, not age out)", got)
	}
}
