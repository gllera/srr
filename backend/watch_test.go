package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"

	"srr/store"
)

// Keyword watchlists (FMT5) — the per-article axis over a chron-aligned bitmap
// sidecar. What these tests are for, in order of how much they matter:
//
//  1. ALIGNMENT. Bit i of the object at position p means chron p*watchPackSize+i
//     and nothing else, across a pack split, across the pack↔delta seam, and
//     across both operations that remove articles without renumbering them
//     (expiration, `srr store compact`). That is invariant M8 wearing this feature's
//     clothes, and it is the property everything else is built on.
//  2. COVERAGE. A rule's lane starts where the operator declared it and ends
//     where the last successful sync reached — never wider, in either direction.
//  3. DEGRADATION. An absent or damaged sidecar costs watch lanes and nothing
//     else: never an article, never a misattribution.

// withWatchPackSize shrinks the stride so a test can actually CROSS a region
// boundary — the arithmetic is identical at 8 and at 50,000, and at 50,000 each
// crossing would cost 100k articles. Returns the restore func rather than using
// t.Cleanup so the intent reads at the call site.
func withWatchPackSize(t *testing.T, n int) func() {
	t.Helper()
	prev := watchPackSize
	watchPackSize = n
	return func() { watchPackSize = prev }
}

// watchFeed seeds one feed on a fresh store.
func watchFeed(t *testing.T, db *DB, title, url string) *Feed {
	t.Helper()
	f := &Feed{Title: title, URL: url}
	if err := db.AddFeed(f); err != nil {
		t.Fatalf("AddFeed %s: %v", title, err)
	}
	return f
}

// watchPut writes one batch through the production path and syncs the bitmaps,
// exactly as a fetch cycle does (PutArticles → … → SyncWatch → Commit).
func watchPut(t *testing.T, db *DB, f *Feed, titles ...string) {
	t.Helper()
	items := make([]*Item, len(titles))
	for i, title := range titles {
		items[i] = &Item{Feed: f, Title: title, Content: "<p>" + title + "</p>", Link: "l"}
	}
	written, err := db.PutArticles(ctx, items)
	if err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.SyncWatch(ctx, written); err != nil {
		t.Fatalf("SyncWatch: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

// watchSet declares a rule the way the CLI does: pattern into config.gz,
// coverage floor into the manifest, both in one locked commit.
func watchSet(t *testing.T, db *DB, name, spec string) {
	t.Helper()
	if err := setWatchRule(ctx, db, name, spec); err != nil {
		t.Fatalf("setWatchRule %s: %v", name, err)
	}
}

// watchHits reads the published bitmaps back and returns the chrons a rule
// claims, THROUGH the coverage gate — which is the only way anything is ever
// allowed to read them: a zero bit outside [from, covered) means "never
// evaluated", not "no match".
func watchHits(t *testing.T, db *DB, rule string) []int {
	t.Helper()
	c := &db.core
	from, ok := c.WatchFrom[rule]
	if !ok {
		t.Fatalf("watch rule %q is not in the roster", rule)
	}
	var out []int
	for chron := from; chron < c.WatchCovered; {
		planes, base, err := db.loadWatchRegion(ctx, chron)
		if err != nil {
			t.Fatalf("loadWatchRegion(%d): %v", chron, err)
		}
		end := min(base+watchPackSize, c.WatchCovered)
		for ; chron < end; chron++ {
			if planes.watched(rule, chron-base) {
				out = append(out, chron)
			}
		}
	}
	return out
}

func eqInts(a, b []int) bool { return slices.Equal(a, b) }

// captureIssues runs a checker with its report swallowed, returning only the
// issue count — the checkers print to stdout by design and the noise would
// bury the assertions.
func captureIssues(t *testing.T, fn func() int) int {
	t.Helper()
	var issues int
	captureStdout(t, func() { issues = fn() })
	return issues
}

// --- the bitmap body itself -------------------------------------------------

// TestWatchPlanesRoundTrip pins the bit layout as an independent statement of
// the contract: chron base+i lives in byte i>>3 at bit i&7, LSB-first. Every
// other test in this file trusts it, and a reader in another language will
// mirror exactly this.
func TestWatchPlanesRoundTrip(t *testing.T) {
	const n = 20
	p := watchPlanes{}
	for _, i := range []int{0, 1, 7, 8, 19} {
		p.set("cve", i, n)
	}
	p.set("price", 3, n)

	doc := p.encode(1000, n)
	if doc.Base != 1000 || doc.N != n || doc.Version != watchDocVersion {
		t.Fatalf("encode header = %+v", doc)
	}
	// The plane is exactly ceil(n/8) bytes and the bit order is LSB-first.
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	back, err := parseWatchDoc(raw, 1000, n)
	if err != nil {
		t.Fatalf("parseWatchDoc: %v", err)
	}
	for i := range n {
		want := i == 0 || i == 1 || i == 7 || i == 8 || i == 19
		if got := back.watched("cve", i); got != want {
			t.Errorf("cve bit %d = %v, want %v", i, got, want)
		}
	}
	if !back.watched("price", 3) || back.watched("price", 4) {
		t.Error("the price plane did not round-trip independently of cve's")
	}
	if len(back["cve"]) != 3 {
		t.Errorf("plane is %d bytes, want ceil(20/8) = 3", len(back["cve"]))
	}
}

// TestWatchPlanesDropsEmpty: a rule with no hit in a region contributes no
// plane, so an object carries only the lanes that actually fired in it. That is
// what keeps a store with a dozen idle rules from writing a dozen zero-filled
// planes on every cycle.
func TestWatchPlanesDropsEmpty(t *testing.T) {
	p := watchPlanes{}
	p.set("hit", 2, 16)
	p["idle"] = make([]byte, 2) // allocated but never set
	doc := p.encode(0, 16)
	if _, ok := doc.Bits["idle"]; ok {
		t.Error("an all-zero plane was published")
	}
	if _, ok := doc.Bits["hit"]; !ok {
		t.Error("a plane with a hit was dropped")
	}
}

// TestParseWatchDocRejects: STRICT, like parseAssetRefs. The caller's answer to
// "this object is damaged" (rebuild the region from the data packs) is correct
// and cheap; adopting a half-understood body would carry wrong bits forward
// into objects that are immutable.
func TestParseWatchDocRejects(t *testing.T) {
	cases := []struct {
		name, body, want string
		base, n          int
	}{
		{name: "not json", body: `{`, base: 0, n: 8, want: "unexpected end"},
		{name: "unknown version", body: `{"v":99,"base":0,"n":8}`, base: 0, n: 8, want: "unsupported version"},
		{name: "wrong base", body: `{"v":1,"base":50000,"n":8}`, base: 0, n: 8, want: "describes chrons from 50000"},
		{name: "claims more chrons than the region holds", body: `{"v":1,"base":0,"n":99}`, base: 0, n: 8, want: "covers 99 chron"},
		{name: "plane is not base64", body: `{"v":1,"base":0,"n":8,"bits":{"r":"!!"}}`, base: 0, n: 8, want: `rule "r"`},
		{name: "plane is the wrong length", body: `{"v":1,"base":0,"n":8,"bits":{"r":"AAAA"}}`, base: 0, n: 8, want: "plane byte"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseWatchDoc([]byte(tc.body), tc.base, tc.n)
			if err == nil {
				t.Fatal("want an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

// TestParseWatchDocGrowsTheTail: the tail region grows between cycles, so a
// read-back legitimately covers FEWER chrons than the caller is about to write.
// The plane grows with zeros — "no hits yet in the chrons that just arrived".
func TestParseWatchDocGrowsTheTail(t *testing.T) {
	p := watchPlanes{}
	p.set("r", 3, 8)
	raw, err := json.Marshal(p.encode(0, 8))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	back, err := parseWatchDoc(raw, 0, 20)
	if err != nil {
		t.Fatalf("parseWatchDoc into a grown region: %v", err)
	}
	if len(back["r"]) != 3 {
		t.Fatalf("plane is %d bytes, want ceil(20/8) = 3", len(back["r"]))
	}
	if !back.watched("r", 3) || back.watched("r", 19) {
		t.Error("growing the plane changed which chrons it claims")
	}
}

// --- rules, CRUD and coverage ----------------------------------------------

// TestWatchRuleCRUD is the round-trip through the verbs the operator actually
// types, including the two properties that are decisions rather than plumbing:
// re-declaring an identical rule is a no-op (the lane must not restart), and
// removing the last rule returns the store to having never had any.
func TestWatchRuleCRUD(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchPut(t, db, f, "a", "b", "c")

	watchSet(t, db, "cve", "title=/cve/i")
	if c.Watch["cve"] != "title=/cve/i" {
		t.Fatalf("rule spec = %q", c.Watch["cve"])
	}
	// Apply-forward-only: the lane starts at the store's CURRENT head, so the
	// three articles that predate the declaration are outside it.
	if c.WatchFrom["cve"] != 3 {
		t.Fatalf("coverage floor = %d, want the store's article count 3", c.WatchFrom["cve"])
	}

	// Re-declaring the identical rule must not restart the lane.
	watchPut(t, db, f, "d", "e")
	watchSet(t, db, "cve", "title=/cve/i")
	if c.WatchFrom["cve"] != 3 {
		t.Fatalf("an identical `watch set` moved the floor to %d", c.WatchFrom["cve"])
	}

	// A CHANGED spec DOES restart it: the published bits describe a predicate
	// that no longer exists, and re-stamping is how the store says so.
	watchSet(t, db, "cve", "title=/cve/")
	if c.WatchFrom["cve"] != 5 {
		t.Fatalf("a changed spec left the floor at %d, want the current head 5", c.WatchFrom["cve"])
	}

	// ls/show project both halves together.
	views := watchViews(c)
	if len(views) != 1 || views[0].Name != "cve" || views[0].From != 5 {
		t.Fatalf("watchViews = %+v", views)
	}

	if err := removeWatchRule(ctx, db, "nope"); err == nil {
		t.Fatal("removing an unknown rule succeeded")
	}
	if err := removeWatchRule(ctx, db, "cve"); err != nil {
		t.Fatalf("removeWatchRule: %v", err)
	}
	if len(c.Watch) != 0 || len(c.WatchFrom) != 0 || c.WatchCovered != 0 {
		t.Fatalf("after removing the last rule: watch=%v from=%v covered=%d", c.Watch, c.WatchFrom, c.WatchCovered)
	}
	if c.Names.Series[watchSeries] != nil {
		t.Fatal("the watch series row survived the last rule's removal, so its objects can never be reclaimed")
	}
}

// TestWatchSurvivesAReopen: the axis SPLITS across two objects — patterns into
// the backend-only config.gz, roster and coverage into the manifest — so the
// one thing worth proving beyond the in-memory CRUD is that both halves come
// back, and come back TOGETHER, from a store reopened cold.
func TestWatchSurvivesAReopen(t *testing.T) {
	db, _, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "cve", "title=/cve/i")
	watchPut(t, db, f, "CVE roundup", "quiet")

	fresh, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer fresh.Close(ctx)

	if got := fresh.core.Watch["cve"]; got != "title=/cve/i" {
		t.Fatalf("the pattern did not survive config.gz: %q", got)
	}
	if got, ok := fresh.core.WatchFrom["cve"]; !ok || got != 0 {
		t.Fatalf("the coverage floor did not survive the manifest: %d (present=%v)", got, ok)
	}
	if fresh.core.WatchCovered != 2 {
		t.Fatalf("coverage = %d, want 2", fresh.core.WatchCovered)
	}
	if got, want := watchHits(t, fresh, "cve"), []int{0}; !eqInts(got, want) {
		t.Fatalf("lane read from a cold store = %v, want %v", got, want)
	}
}

// TestWatchConfigExportRoundTrip: the patterns are configuration and belong in
// the config backup; the coverage floor is derived state belonging to whichever
// store the rules land in, so an import stamps it apply-forward THERE.
func TestWatchConfigExportRoundTrip(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "cve", "title=/cve/i")
	watchPut(t, db, f, "a", "b")

	doc := buildConfigDoc(db)
	if doc.Watch["cve"] != "title=/cve/i" {
		t.Fatalf("export carries watch=%v", doc.Watch)
	}

	// Import into a store that already has articles: the floor must be that
	// store's head, never the source's.
	dst, dc, _ := setupTestDB(t)
	g := watchFeed(t, dst, "G", "https://f.example/x")
	watchPut(t, dst, g, "x", "y", "z")
	if err := applyConfigDoc(ctx, dst, &doc); err != nil {
		t.Fatalf("applyConfigDoc: %v", err)
	}
	if got := dc.WatchFrom["cve"]; got != 3 {
		t.Fatalf("imported floor = %d, want the destination's head 3 (source's was %d)", got, c.WatchFrom["cve"])
	}

	// A spec that will not compile fails the whole import rather than landing in
	// config.gz to warn on every cycle from then on.
	doc.Watch["broken"] = "title=/[/"
	if err := applyConfigDoc(ctx, dst, &doc); err == nil {
		t.Fatal("an uncompilable watch rule imported cleanly")
	}
}

// TestWatchRuleValidation: a malformed rule is rejected at declaration, not
// discovered per-article at fetch time. That is the whole point of parsing in
// the constructor.
func TestWatchRuleValidation(t *testing.T) {
	db, _, _ := setupTestDB(t)
	cases := []struct{ name, spec, want string }{
		{"", "title=/x/", "name is required"},
		{"a b", "title=/x/", "must not contain whitespace"},
		{`a"b`, "title=/x/", "must not contain whitespace"},
		{strings.Repeat("x", 65), "title=/x/", "longer than 64 bytes"},
		{"ok", "", "at least one condition"},
		{"ok", "title=/[/", "invalid regex"},
		{"ok", "nope=1", "unknown parameter"},
	}
	for _, tc := range cases {
		if err := setWatchRule(ctx, db, tc.name, tc.spec); err == nil {
			t.Errorf("setWatchRule(%q, %q) succeeded", tc.name, tc.spec)
		} else if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("setWatchRule(%q, %q) error = %q, want it to mention %q", tc.name, tc.spec, err, tc.want)
		}
	}
	if len(db.core.Watch) != 0 {
		t.Fatalf("a rejected rule was stored anyway: %v", db.core.Watch)
	}
}

// TestWatchEvaluatesAtIngest is the core behaviour: articles written after the
// rule was declared are classified as they are stored, and articles written
// before it are not claimed at all.
func TestWatchEvaluatesAtIngest(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")

	watchPut(t, db, f, "CVE-2026-0001 in the wild") // chron 0 — predates the rule
	watchSet(t, db, "cve", `title=/CVE-\d{4}/`)
	watchPut(t, db, f, "quiet day", "CVE-2026-0002 patched", "another quiet day")
	watchPut(t, db, f, "CVE-2026-0003 disclosed")

	if got, want := watchHits(t, db, "cve"), []int{2, 4}; !eqInts(got, want) {
		t.Fatalf("cve lane = %v, want %v (chron 0 predates the rule's floor)", got, want)
	}
	if c.WatchCovered != c.TotalArticles {
		t.Fatalf("coverage = %d, want the store's %d article(s)", c.WatchCovered, c.TotalArticles)
	}
}

// TestWatchLanesAreIndependent: two rules over the same articles produce two
// planes in the same object, each answering only for itself.
func TestWatchLanesAreIndependent(t *testing.T) {
	db, _, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "cve", "title=/cve/i")
	watchSet(t, db, "price", "any=/discount/")
	watchPut(t, db, f, "CVE roundup", "a discount today", "CVE and discount", "neither")

	if got, want := watchHits(t, db, "cve"), []int{0, 2}; !eqInts(got, want) {
		t.Fatalf("cve lane = %v, want %v", got, want)
	}
	if got, want := watchHits(t, db, "price"), []int{1, 2}; !eqInts(got, want) {
		t.Fatalf("price lane = %v, want %v", got, want)
	}
}

// TestWatchNoRulesWritesNothing: absence is legal and free. A store with no
// rules behaves exactly as one from before this feature existed — no series, no
// object, no manifest fields.
func TestWatchNoRulesWritesNothing(t *testing.T) {
	db, c, dir := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchPut(t, db, f, "a", "b")

	if c.WatchCovered != 0 || c.WatchFrom != nil || c.Names.Series[watchSeries] != nil {
		t.Fatalf("a store with no watch rules published watch state: covered=%d from=%v", c.WatchCovered, c.WatchFrom)
	}
	keys, err := db.List(ctx, watchSeries+"/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("%s holds %v (dir %s)", watchSeries, keys, dir)
	}
}

// --- alignment: the invariant everything rests on ---------------------------

// TestWatchAlignmentAcrossARegionSplit drives the store past a watchPackSize
// boundary and asserts that every claimed chron is the article that actually
// matched — with the objects re-read from the store, so the assertion runs
// through the same base/offset arithmetic a reader would.
//
// watchPackSize is shrunk for the test the way pack-split tests shrink
// PackSize: the arithmetic is the same at 8 as at 50,000, and at 50,000 the
// test would need 100k articles to reach the boundary at all.
func TestWatchAlignmentAcrossARegionSplit(t *testing.T) {
	defer withWatchPackSize(t, 8)()

	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "odd", "title=/odd/")

	// 21 articles across three cycles, straddling positions 0, 1 and 2.
	var want []int
	chron := 0
	for _, batch := range [][]int{{0, 1, 2, 3, 4}, {5, 6, 7, 8, 9, 10, 11, 12}, {13, 14, 15, 16, 17, 18, 19, 20}} {
		titles := make([]string, len(batch))
		for i := range batch {
			if chron%2 == 1 {
				titles[i] = fmt.Sprintf("odd %d", chron)
				want = append(want, chron)
			} else {
				titles[i] = fmt.Sprintf("even %d", chron)
			}
			chron++
		}
		watchPut(t, db, f, titles...)
	}

	if got := watchHits(t, db, "odd"); !eqInts(got, want) {
		t.Fatalf("odd lane = %v, want %v", got, want)
	}
	// Three regions, the last one the tail, dense from base 0.
	s := c.Names.Series[watchSeries]
	if s == nil || s.Base != 0 || len(s.Stems) != 3 || s.Tail != 2 {
		t.Fatalf("watch series = %+v, want 3 dense positions from 0 with the tail at 2", s)
	}
	// And each object states the region it describes, independently of its name.
	for p := range 3 {
		planes, base, err := db.loadWatchRegion(ctx, p*8)
		if err != nil {
			t.Fatalf("region %d: %v", p, err)
		}
		if base != p*8 {
			t.Fatalf("region %d has base %d", p, base)
		}
		for i := range min(8, c.TotalArticles-base) {
			if got, w := planes.watched("odd", i), (base+i)%2 == 1; got != w {
				t.Errorf("region %d bit %d (chron %d) = %v, want %v", p, i, base+i, got, w)
			}
		}
	}
}

// TestWatchAlignmentAcrossTheDeltaSeam: the hot tail rides delta segments that
// are consolidated lazily, so a chron's bits and its data live in different
// object classes for a while. The watch axis is driven by chron alone and must
// not notice — which this proves by running BOTH a delta cycle and the
// consolidation that swallows it, then reading the lane back.
func TestWatchAlignmentAcrossTheDeltaSeam(t *testing.T) {
	defer withWatchPackSize(t, 8)()

	db, c, _ := setupTestDB(t)
	// globals is rebuilt per test, so set the delta triggers after setupTestDB:
	// a chain of at most 3 segments, with the byte cap out of the way.
	globals.MaxDeltas, globals.MaxDeltaBytes = 3, 1<<20
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "hit", "title=/hit/")

	var want []int
	chron := 0
	for cycle := range 5 {
		titles := make([]string, 3)
		for i := range titles {
			if (chron+cycle)%3 == 0 {
				titles[i] = fmt.Sprintf("hit %d", chron)
				want = append(want, chron)
			} else {
				titles[i] = fmt.Sprintf("miss %d", chron)
			}
			chron++
		}
		watchPut(t, db, f, titles...)
	}
	// Both sides of the seam must actually be populated, or the test proves
	// nothing: a consolidated pack region below tailCovered AND a live chain
	// above it.
	if tailCovered(c) == 0 || c.DeltaArticles == 0 {
		t.Fatalf("the test did not straddle the seam: tailCovered=%d na=%d segments=%d",
			tailCovered(c), c.DeltaArticles, c.numDeltas())
	}
	if got := watchHits(t, db, "hit"); !eqInts(got, want) {
		t.Fatalf("hit lane across the seam = %v, want %v", got, want)
	}
}

// TestWatchSurvivesExpirationAndCompaction: the two operations that remove
// articles without renumbering them. Expiration is logical (add_idx advances,
// chrons stay); compaction rewrites payloads under fresh stems and leaves idx/
// — and this series — untouched. Either way bit i still means chron base+i.
func TestWatchSurvivesExpirationAndCompaction(t *testing.T) {
	defer withWatchPackSize(t, 8)()

	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "hit", "title=/hit/")

	c.FetchedAt = 1_000_000
	watchPut(t, db, f, "hit one", "miss", "hit two") // chrons 0,1,2 — the old batch
	c.FetchedAt = 1_000_000 + 10*86400
	watchPut(t, db, f, "miss", "hit three") // chrons 3,4 — recent

	before := watchHits(t, db, "hit")
	if want := []int{0, 2, 4}; !eqInts(before, want) {
		t.Fatalf("lane before expiration = %v, want %v", before, want)
	}
	namesBefore := c.Names.Series[watchSeries].Stems[0]

	// Expire the first batch.
	f.ExpireDays = 5
	if err := db.ExpireArticles(ctx, c.FetchedAt); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if f.AddIdx != 3 {
		t.Fatalf("AddIdx = %d, want the expired prefix 3", f.AddIdx)
	}
	if got := watchHits(t, db, "hit"); !eqInts(got, before) {
		t.Fatalf("expiration moved bits: %v, want the unchanged %v (chrons are permanent, M8)", got, before)
	}

	// Compact: it must reclaim payload bytes without touching this series.
	if err := db.Compact(ctx, false); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if got := c.Names.Series[watchSeries].Stems[0]; got != namesBefore {
		t.Fatalf("compaction rewrote the watch object (stem %d → %d); it must leave the series alone", namesBefore, got)
	}
	if got := watchHits(t, db, "hit"); !eqInts(got, before) {
		t.Fatalf("compaction moved bits: %v, want the unchanged %v", got, before)
	}
}

// --- degradation ------------------------------------------------------------

// TestWatchRebuildsAnUnreadableRegion: a read-back that fails is neither fatal
// nor silently accepted. The region is rebuilt from its own base out of the
// data packs, which re-derives exactly the bits that were there — the
// alternative is permanently publishing an object missing bits it used to
// carry.
func TestWatchRebuildsAnUnreadableRegion(t *testing.T) {
	defer withWatchPackSize(t, 16)()

	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "hit", "title=/hit/")
	watchPut(t, db, f, "hit a", "miss", "hit b")

	// Corrupt the published tail bitmap in place.
	key, err := c.Names.key(watchSeries, 0)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	if err := db.AtomicPut(ctx, key, strings.NewReader("not a gzip stream"), store.ObjectMeta{}); err != nil {
		t.Fatalf("corrupt %s: %v", key, err)
	}

	watchPut(t, db, f, "hit c")
	if got, want := watchHits(t, db, "hit"), []int{0, 2, 3}; !eqInts(got, want) {
		t.Fatalf("lane after the rebuild = %v, want %v — the pre-corruption bits must come back", got, want)
	}
}

// TestWatchSelfHealsAFailedSync: SyncWatch is warn-only, so a failed run leaves
// a committed batch whose bits were never written. WatchCovered advances only
// on success, and the next run re-evaluates precisely the gap — from the packs,
// since this cycle's batch no longer covers it.
func TestWatchSelfHealsAFailedSync(t *testing.T) {
	defer withWatchPackSize(t, 16)()

	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "hit", "title=/hit/")

	// A cycle whose SyncWatch never ran: articles are durable, coverage is not.
	items := []*Item{
		{Feed: f, Title: "hit a", Content: "x", Link: "l"},
		{Feed: f, Title: "miss", Content: "x", Link: "l"},
		{Feed: f, Title: "hit b", Content: "x", Link: "l"},
	}
	if _, err := db.PutArticles(ctx, items); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if c.WatchCovered != 0 {
		t.Fatalf("coverage advanced past a sync that never ran: %d", c.WatchCovered)
	}

	// The next cycle catches up over the whole gap, not just its own batch.
	watchPut(t, db, f, "hit c")
	if got, want := watchHits(t, db, "hit"), []int{0, 2, 3}; !eqInts(got, want) {
		t.Fatalf("lane after the catch-up = %v, want %v", got, want)
	}
	if c.WatchCovered != 4 {
		t.Fatalf("coverage = %d, want 4", c.WatchCovered)
	}
}

// TestWatchUncompilableRuleDoesNotStopTheCycle: reaching SyncWatch with a spec
// that will not compile means a hand-edited config.gz (the CLI rejects it), and
// one bad rule must stop neither the other lanes nor a cycle whose articles are
// already durable.
func TestWatchUncompilableRuleDoesNotStopTheCycle(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "good", "title=/hit/")
	c.Watch["broken"] = "title=/[/" // as a hand edit would leave it
	c.WatchFrom["broken"] = 0

	watchPut(t, db, f, "hit a", "miss")
	if got, want := watchHits(t, db, "good"), []int{0}; !eqInts(got, want) {
		t.Fatalf("the healthy lane = %v, want %v", got, want)
	}
	// The unreadable rule is dropped from the ROSTER, not published with nothing
	// maintaining it: bits produced by a predicate nobody can read describe
	// nothing, so the lane must not appear at all. Fixing the spec restarts it.
	if _, ok := c.WatchFrom["broken"]; ok {
		t.Fatal("an uncompilable rule stayed in the published roster")
	}
	if _, ok := c.WatchFrom["good"]; !ok {
		t.Fatal("one bad rule took the healthy lane down with it")
	}
}

// TestWatchRemovedLanePlaneStopsBeingRepublished: a removed rule's plane must
// leave the tail object at the next sync rather than riding along forever, and
// a rule re-declared under the same name must start on a CLEAN plane instead of
// inheriting its predecessor's bits.
func TestWatchRemovedLanePlaneStopsBeingRepublished(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "old", "title=/hit/")
	watchSet(t, db, "keep", "title=/hit/")
	watchPut(t, db, f, "hit a")

	planes, _, err := db.loadWatchRegion(ctx, 0)
	if err != nil {
		t.Fatalf("loadWatchRegion: %v", err)
	}
	if !planes.watched("old", 0) {
		t.Fatal("the lane never had a bit to begin with")
	}

	// Remove it WITHOUT resetting the axis (a second rule survives), then sync.
	delete(c.Watch, "old")
	delete(c.WatchFrom, "old")
	watchPut(t, db, f, "hit b")

	planes, _, err = db.loadWatchRegion(ctx, 0)
	if err != nil {
		t.Fatalf("loadWatchRegion after removal: %v", err)
	}
	if _, ok := planes["old"]; ok {
		t.Error("the removed rule's plane was republished")
	}
	if !planes.watched("keep", 0) || !planes.watched("keep", 1) {
		t.Error("removing one lane disturbed another's bits")
	}

	// Re-declare the name: the floor restarts, and the old bits must not show
	// through beneath it.
	watchSet(t, db, "old", "title=/never/")
	watchPut(t, db, f, "hit c")
	if got := c.WatchFrom["old"]; got != 2 {
		t.Fatalf("the re-declared floor = %d, want the head at declaration (2)", got)
	}
	planes, _, err = db.loadWatchRegion(ctx, 0)
	if err != nil {
		t.Fatalf("loadWatchRegion after re-declaration: %v", err)
	}
	if planes.watched("old", 0) {
		t.Error("a re-declared rule inherited its predecessor's bits")
	}
}

// TestWatchRosterReconciliation covers both ways the two objects one Commit
// writes (config.gz and the manifest) can be left disagreeing by a crash: a
// roster entry with no pattern, and a pattern with no roster entry.
func TestWatchRosterReconciliation(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "kept", "title=/hit/")
	watchPut(t, db, f, "hit a")

	// A lane whose pattern the config lost: forget it.
	c.WatchFrom["ghost"] = 0
	// A pattern the manifest lost: stamp it here, at the same apply-forward
	// answer `srr watch set` would have given.
	c.Watch["fresh"] = "title=/hit/"

	watchPut(t, db, f, "hit b")
	if _, ok := c.WatchFrom["ghost"]; ok {
		t.Error("a roster entry with no pattern survived reconciliation")
	}
	if got := c.WatchFrom["fresh"]; got != 1 {
		t.Errorf("a pattern with no roster entry was stamped at %d, want the head as of that cycle (1)", got)
	}
	if got, want := watchHits(t, db, "fresh"), []int{1}; !eqInts(got, want) {
		t.Errorf("the recovered lane = %v, want %v", got, want)
	}
}

// TestWatchGCKeepsTheLiveBitmaps: the objects are reclaimed by §7's one rule
// and nothing else — the live ones are named by the manifest this cycle
// publishes, so they survive; the superseded ones go once the window passes.
func TestWatchGCKeepsTheLiveBitmaps(t *testing.T) {
	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "hit", "title=/hit/")

	for i := range 5 {
		watchPut(t, db, f, fmt.Sprintf("hit %d", i))
		if err := db.GC(ctx, 1); err != nil {
			t.Fatalf("GC: %v", err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("Commit: %v", err)
		}
	}
	// The live bitmap is still readable through the manifest's name.
	if got, want := watchHits(t, db, "hit"), []int{0, 1, 2, 3, 4}; !eqInts(got, want) {
		t.Fatalf("lane after five GC passes = %v, want %v", got, want)
	}
	// And the superseded ones did not accumulate one-per-cycle forever.
	keys, err := db.List(ctx, watchSeries+"/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(keys) >= 5 {
		t.Fatalf("%d watch objects survive a K=1 window: %v", len(keys), keys)
	}
	if len(keys) == 0 {
		t.Fatal("the GC reclaimed the live bitmap")
	}
	if _, err := c.Names.key(watchSeries, 0); err != nil {
		t.Fatalf("the manifest stopped naming the live bitmap: %v", err)
	}
}

// --- the checker ------------------------------------------------------------

// TestCheckWatchNames pins what `srr inspect --validate` says about this axis.
// The property being defended is the one an operator cannot see for themselves:
// a roster claiming coverage the name list cannot address reads as an EMPTY
// lane, silently, because a missing bit and a missing object look identical to
// anything that does not check.
func TestCheckWatchNames(t *testing.T) {
	defer withWatchPackSize(t, 8)()

	db, c, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "https://f.example/x")
	watchSet(t, db, "hit", "title=/hit/")
	watchPut(t, db, f, "hit a", "miss", "hit b")

	// Each case mutates a COPY of the loaded state, so the cases stay
	// independent and none of them has to undo itself.
	run := func(mutate func()) []string {
		saved := *c
		defer func() { *c = saved }()
		c.Names = saved.Names.clone()
		c.WatchFrom = maps.Clone(saved.WatchFrom)
		c.Watch = maps.Clone(saved.Watch)
		mutate()
		var got []string
		(&InspectCmd{}).checkWatchNames(func(format string, args ...any) {
			got = append(got, fmt.Sprintf(format, args...))
		}, c.Names, c)
		return got
	}

	if got := run(func() {}); len(got) != 0 {
		t.Fatalf("a healthy store reported %v", got)
	}

	// The whole manifest check, not just this one function: the (3b) body probe
	// that parses every named bitmap lives there, and a healthy store must be
	// silent through all four of its layers.
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	if issues := captureIssues(t, func() int { return (&InspectCmd{}).checkManifest(fetch, c) }); issues != 0 {
		t.Fatalf("checkManifest reported %d issue(s) on a healthy watch-carrying store", issues)
	}
	// A bitmap that does not describe the region its position claims is exactly
	// what the body probe exists to catch: nothing above it would notice, and a
	// consumer would read another region's bits as this one's.
	key, err := c.Names.key(watchSeries, 0)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	body, err := gzipJSON(watchDoc{Version: watchDocVersion, Base: 999, N: 1})
	if err != nil {
		t.Fatalf("gzipJSON: %v", err)
	}
	if err := db.AtomicPut(ctx, key, bytes.NewReader(body), store.ObjectMeta{}); err != nil {
		t.Fatalf("overwrite %s: %v", key, err)
	}
	if issues := captureIssues(t, func() int { return (&InspectCmd{}).checkManifest(fetch, c) }); issues == 0 {
		t.Fatal("checkManifest passed a bitmap that describes the wrong chrons")
	}

	cases := []struct {
		name   string
		mutate func()
		want   string
	}{{
		name:   "coverage past the store's own head",
		mutate: func() { c.WatchCovered = c.TotalArticles + 1 },
		want:   "past the store's",
	}, {
		name:   "a floor outside the store",
		mutate: func() { c.WatchFrom["hit"] = -1 },
		want:   "outside [0,",
	}, {
		name:   "a lane with no pattern behind it",
		mutate: func() { delete(c.Watch, "hit") },
		want:   "config.gz carries no pattern",
	}, {
		name:   "coverage with no series at all",
		mutate: func() { c.Names.dropSeries(watchSeries) },
		want:   "lists no watch series",
	}, {
		name: "the series stops short of the coverage it claims",
		mutate: func() {
			s := c.Names.Series[watchSeries]
			s.Stems, s.Tail = s.Stems[:0], -1
		},
		want: "lists positions up to",
	}, {
		name:   "an empty roster beside a live series",
		mutate: func() { c.WatchFrom, c.WatchCovered = nil, 0 },
		want:   "still lists",
	}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := run(tc.mutate)
			if len(got) == 0 {
				t.Fatal("no issue reported")
			}
			if !strings.Contains(strings.Join(got, "\n"), tc.want) {
				t.Fatalf("issues = %v, want one mentioning %q", got, tc.want)
			}
		})
	}
}

// The roster and the patterns live in TWO objects — the floors in the manifest,
// the specs in the mutable config.gz — so they can legitimately arrive one
// without the other. The documented rollback (`{"v":3,"m":<older>}` over db.gz)
// rewinds the manifest and leaves the sidecar alone; §6.4's commit window can
// leave the same shape. What must not happen is what used to: `start` is only
// lowered by the rules that ALREADY have a floor, so an all-unstamped roster
// left it at TotalArticles, the early return discarded the freshly computed
// stamps, and every later cycle re-derived the same nothing. The lane was dead
// forever, silently — SyncWatch is warn-only.
func TestWatchRosterRecoversWhenEveryRuleIsUnstamped(t *testing.T) {
	defer withWatchPackSize(t, 8)()
	db, _, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "http://f")
	watchSet(t, db, "cve", "title=/CVE/i")
	watchPut(t, db, f, "CVE-1 alpha", "beta")

	// The roster is lost; config.gz keeps the rules.
	db.core.WatchFrom, db.core.WatchCovered = nil, 0

	watchPut(t, db, f, "CVE-2 gamma", "delta")

	from, ok := db.core.WatchFrom["cve"]
	if !ok {
		t.Fatalf("roster not restored: WatchFrom=%v (the lane can never begin)", db.core.WatchFrom)
	}
	if db.core.WatchCovered != db.core.TotalArticles {
		t.Errorf("WatchCovered = %d, want %d", db.core.WatchCovered, db.core.TotalArticles)
	}
	// The floor is the batch in hand, not the head: stamping at TotalArticles
	// would skip the very articles the run already held in memory.
	if want := db.core.TotalArticles - 2; from != want {
		t.Errorf("recovered floor = %d, want %d (the batch this run evaluated)", from, want)
	}
	if got := watchHits(t, db, "cve"); !slices.Contains(got, 2) {
		t.Errorf("chron 2 (CVE-2) not claimed after recovery: hits=%v", got)
	}
}

// The same divergence, on an IDLE cycle: nothing new to describe, so the run
// takes the early return. It must still adopt the roster — that branch is
// precisely where a recovering store lands when its rollback happened between
// article-producing cycles.
func TestWatchRosterAdoptedOnIdleCycle(t *testing.T) {
	defer withWatchPackSize(t, 8)()
	db, _, _ := setupTestDB(t)
	f := watchFeed(t, db, "F", "http://f")
	watchSet(t, db, "cve", "title=/CVE/i")
	watchPut(t, db, f, "CVE-1 alpha")

	db.core.WatchFrom, db.core.WatchCovered = nil, 0

	if err := db.SyncWatch(ctx, nil); err != nil { // no batch: the idle path
		t.Fatalf("SyncWatch: %v", err)
	}
	if _, ok := db.core.WatchFrom["cve"]; !ok {
		t.Fatalf("idle cycle dropped the recovered roster: WatchFrom=%v", db.core.WatchFrom)
	}
	if db.core.WatchCovered != db.core.TotalArticles {
		t.Errorf("WatchCovered = %d, want %d", db.core.WatchCovered, db.core.TotalArticles)
	}
}
