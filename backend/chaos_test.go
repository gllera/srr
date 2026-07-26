package main

// chaos_test.go — the seeded chaos-store generator (TST6).
//
// Every other writer↔reader fixture in this repo is CURATED: each test script
// is a shape somebody thought of. The bugs that actually shipped were not those
// shapes — they were the combinatorics between them. The as-of-chron header
// rewind (delta_test.go's TestConsolidationEquivalence) needed a consolidation
// replay across a feed whose id had been reused; the id-reuse drain needed a
// removal while that feed's articles sat in a live chain. Nobody scripts those
// on purpose; a seeded random walk over the axes does, thousands of times a
// night, for free.
//
// So this is a chaos driver, not a test case. One seed produces ONE exact
// store: every decision (batch size, consolidation trigger, retention window,
// feed churn, GC window, compaction, session boundary) is drawn up-front from a
// splitmix64 stream keyed on the seed, and every article's bytes are a pure
// function of its absolute index. Re-running a seed re-walks the same path, so
// a nightly red is reproducible locally with one command:
//
//	make chaos-be CHAOS_SEED=<the seed the failure printed>
//
// The seed is printed for every seed on every run (the Makefile passes -v), and
// again, prominently, next to the repro line when one fails.
//
// It drives the REAL production write path — PutArticles → SyncIdxSummary →
// SyncMeta → ExpireArticles → SyncSeen → GC → Commit, cmd_fetch.go's order and
// cmd_fetch.go's functions, with RemoveFeed/AddFeed and `srr store compact` woven in
// — exactly as genbig_test.go does. Nothing here hand-writes a pack byte.
//
// Gated, like genbig_test.go and gen_expire_test.go: SRR_CHAOS must be set, so
// `go test ./...` and `make verify` never run it. `make chaos-be` is the entry
// point and `.github/workflows/chaos.yml` runs it nightly.
//
// ── The axes it randomizes ───────────────────────────────────────────────────
//
//   - batch size — 0 (an idle cycle: no manifest is minted, only the ~60-byte
//     root moves), a handful, or a burst that rolls several data packs.
//   - delta-chain length and consolidation trigger — --max-deltas re-drawn per
//     cycle over {0 (the kill switch), 1, 2, 3, 6, 12} and --max-delta-bytes
//     over {1, 2, 4, 16, 1024} KB, so the chain cap, the byte cap and the 5k
//     meta-stratum crossing all take turns forcing the consolidation.
//   - per-feed expiration windows — each subscription draws `exp` from
//     {0 (keep forever), 1, 2, 3, 7, 30} days, and cycles advance 1–72 h, so
//     ExpireArticles fires on an irregular schedule against overlapping windows.
//   - feed add/remove churn — including the two cases the format review found
//     the hard way: a removal while that feed's articles are in the LIVE delta
//     chain (RemoveFeed → DrainDeltas), and the id reuse that follows it, whose
//     replayed idx headers are what the drain protects. Both are counted and
//     reported per seed (chaosCoverage), so an axis that stops firing becomes
//     visible instead of silently absent.
//   - manifest generations — every step Commits; whether that MINTS a
//     generation is the writer's own call (an idle cycle does not), so `m`
//     advances irregularly, which is what the GC window below is measured in.
//   - GC keep-window — --keep-manifests re-drawn per step from {32, 8, 3, 2, 1,
//     0}: at 0 the sweep is the harshest the rule allows (everything the current
//     generation does not name is fair game), which is what turns "GC deleted a
//     live object" from a rare race into a per-step assertion. Both directions —
//     WIDENING a live store's window is the ordinary operator action, and it is
//     the one that used to break the sweep outright; see chaosKeep.
//   - physical compaction — `srr store compact` on ~1 cycle in 11 of a CHURN seed.
//     Whether a seed churns at all is drawn once per seed (roughly half do): a
//     churn seed adds, removes and reuses feed ids and compacts, a stable one
//     subscribes its whole feed set up front and leaves it. Both are real
//     deployment shapes and both get every other axis.
//   - session boundaries — ~1 step in 4 closes the DB and reopens it, so the
//     cross-cycle resume path (re-read the root, reload the tail pack, recover
//     the idx footer boundaries, re-derive the cursors) is exercised throughout
//     rather than only in genbig's fixed session count.
//
// ── The invariants it asserts, after EVERY step, on BOTH runs ────────────────
//
//  1. `srr inspect --validate` is clean — the whole sweep: bounds-vs-data,
//     db↔meta, feed-count continuity, the delta chain (I1/I2), the manifest
//     (M2/M3/M4/M5 — M4 is what makes "the GC deleted a live object" a
//     per-step assertion) and chron permanence (M8) across the grace window.
//  2. Chron permanence, checked against the SCRIPT rather than against the
//     store's own history: chron c still indexes the feed it was written under,
//     and still resolves to the article the driver wrote there. This is the
//     half `checkChronPermanence` structurally cannot do — it compares the
//     store to itself; this compares it to an independent oracle.
//  3. Every live chron is readable and its data line is the one its idx entry
//     addresses: the feed_id in the idx entry equals the `f` of the JSONL line
//     at the (packID, offset) that entry resolves to, and that line's whole
//     payload (t/l/c/p/a) is what the script wrote there.
//  4. Compaction tombstones EXACTLY the expired set — every expired chron
//     loses t/l/c/g and keeps f/a/p, every live one keeps its bytes verbatim.
//
// And once, at the end of each seed:
//
//  5. Consolidation equivalence against the same script replayed with
//     --max-deltas pinned at 0 — the kill switch IS the pre-delta writer. See
//     runChaosSeed for the five comparisons and, in particular, for exactly
//     which byte compare holds and which one provably does not.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//
//	make chaos-be                                   # 4 random seeds, printed
//	make chaos-be CHAOS_SEEDS=32 CHAOS_ARTICLES=900 # a nightly-sized budget
//	make chaos-be CHAOS_SEED=8143766251288091       # replay ONE seed
//
// Raw, from backend/ (always -count=1, or a repeat run is a cached no-op):
//
//	SRR_CHAOS=1 SRR_CHAOS_SEED=8143766251288091 \
//	  go test -run '^TestChaosStore$' -count=1 -timeout 3600s -v .
//
// Env knobs:
//
//	SRR_CHAOS          required; any non-empty value enables the driver
//	SRR_CHAOS_SEEDS    seeds to walk                       (default 4)
//	SRR_CHAOS_SEED     replay exactly this seed (overrides SRR_CHAOS_SEEDS)
//	SRR_CHAOS_ARTICLES article budget per seed             (default 600)
//	SRR_CHAOS_OUT      keep the delta-driven store of each seed here instead of
//	                   a temp dir, so a failing seed's store survives the run
//	                   (the CI artifact, and the input to the jsdom contract
//	                   pass frontend/e2e/contract/chaos.e2e.test.ts, which reads
//	                   the chaos-oracle.json this driver drops beside db.gz). A
//	                   failure also drops a chaos-repro.sh there. Both are
//	                   store-root files, outside the pack grammar, so nothing in
//	                   the writer, the GC or the reader can see them.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	chaosDefaultSeeds    = 4
	chaosDefaultArticles = 600
	// chaosBaseTime is the script's clock origin; steps advance it in hours, so
	// the retention windows below span a realistic number of cycles.
	chaosBaseTime = 1_700_000_000
	// chaosOracleFile is the writer's record of what it wrote, dropped beside
	// db.gz when SRR_CHAOS_OUT keeps the store. It is what makes the jsdom
	// contract pass a writer↔READER check rather than a store↔itself one.
	chaosOracleFile = "chaos-oracle.json"
)

// The per-cycle draw pools. Each is a knob a real deployment sets once and this
// driver re-draws every cycle, which is the point: the interesting states are
// the transitions between settings, not the settings.
var (
	chaosMaxDeltas  = []int{0, 0, 1, 2, 3, 6, 12}
	chaosMaxDeltaKB = []int{1, 2, 4, 16, 1024}
	chaosExpireDays = []int{0, 0, 1, 2, 3, 7, 30}
	// chaosKeep is the GC grace window, drawn at RANDOM each step so the sweep is
	// exercised narrowing AND widening. Narrowing is the harsher direction — 0 is
	// the harshest the rule allows, since GC clamps its own cutoff to m−1 so the
	// current generation is never swept (delta_test.go's TestGCKeepsTheLiveChain
	// uses the same value for the same reason) — but WIDENING is the one an
	// operator actually performs on a live store, and it used to walk into a real
	// defect this pool was shaped to avoid: `GC` derived the oldest in-window
	// manifest without clamping to `GCManifest+1`, so a widened window asked for a
	// manifest an earlier narrower sweep had already reclaimed and hard-errored
	// (`gc: reading manifest 5 for the reachable set: … file does not exist`) —
	// warn-only at every call site, so the store silently stopped being swept
	// until m outgrew the new window. Fixed in manifest.go; the random draw is
	// what keeps it fixed.
	chaosKeep = []int{keepManifests, 8, 3, 2, 1, 0}
)

// chaosStep is one scripted round: at most one feed removal, some
// subscriptions, one batch, the maintenance chain, one Commit, and optionally a
// compaction. Every field is drawn from the seed BEFORE anything runs, which is
// what lets the delta-driven and kill-switch runs execute the identical logical
// script and be compared afterwards.
type chaosStep struct {
	// Reopen closes the DB and opens a fresh one before the step, modelling the
	// process boundary between two `srr fetch` invocations.
	Reopen bool
	// RemoveFeed removes the live feed at RemovePick (mod the live count) before
	// anything else, so a freed id is available for AddFeeds to reuse in the
	// SAME step — the id-reuse-against-a-live-chain case.
	RemoveFeed bool
	RemovePick int
	AddFeeds   int
	ExpDays    []int // one per feed AddFeeds subscribes
	// Articles is this cycle's batch size; 0 is an idle cycle.
	Articles int
	// Picks[i] chooses (mod the live count) the feed article i is written under.
	// A raw draw rather than a resolved id: the live set is only known at run
	// time, and it must resolve identically in both runs.
	Picks      []int
	MaxDeltas  int
	MaxDeltaKB int
	Keep       int
	Advance    int64 // seconds added to fetched_at
	Compact    bool
}

// chaosArticle is the driver's independent oracle for one chron: everything it
// wrote there, remembered by position. The store is never asked what it thinks
// it wrote — that is the whole point of an oracle.
type chaosArticle struct {
	feedID    int
	title     string
	link      string
	content   string
	published int64
	fetchedAt int64
}

// chaosCoverage counts what a run actually exercised. A randomized driver whose
// interesting axes quietly stop firing — because a pool changed, or a
// probability drifted — still passes every assertion, so the counts are printed
// per seed and the two that keep the equivalence compare from being vacuous are
// asserted outright.
type chaosCoverage struct {
	Reopens     int
	IdleCycles  int
	Removals    int
	DrainingRms int // removals of a feed whose articles sat in the LIVE chain
	Reuses      int // AddFeed handed back an id that already has idx entries
	Compactions int
	DeltaCycles int // cycles that grew the chain instead of consolidating
	Consolids   int // consolidations that folded a non-empty chain
	MaxChain    int
}

func chaosEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// chaosAlnum draws n incompressible alphanumeric bytes. Data packs roll on
// COMPRESSED size (db_pack.go, PackSize=1 KB here), so lorem-ipsum bodies would
// never split one — the same reason frontend/e2e/fixtures.ts seeds alphanumeric.
func chaosAlnum(r *genRand, n int) string {
	const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = alnum[r.intn(len(alnum))]
	}
	return string(b)
}

// chaosArticleAt is the article at absolute index gidx within a seed — a PURE
// function of (seed, gidx), so the two runs write identical bytes and a replay
// of the seed reproduces them exactly. (genRand is genbig_test.go's splitmix64,
// reused rather than re-implemented.)
func chaosArticleAt(seed uint64, gidx int) (title, content string) {
	r := &genRand{s: seed ^ (uint64(gidx+1) * 0xff51afd7ed558ccd)}
	title = fmt.Sprintf("chaos %d %s", gidx, chaosAlnum(r, 8))
	return title, chaosAlnum(r, 200+r.intn(600))
}

// chaosLinkAt is the article link, likewise a pure function of the chron.
func chaosLinkAt(gidx int) string { return fmt.Sprintf("https://example.com/chaos/a/%d", gidx) }

// chaosPlan draws the whole script for one seed. It models the live feed COUNT
// as it goes (adds and removes are deterministic, so the count the plan assumes
// is the count both runs will have) — enough to know whether a removal is legal
// without knowing which id it will take.
//
// One decision is made per SEED rather than per cycle: whether this is a CHURN
// seed (feeds come and go, ids get reused, `srr store compact` runs) or a STABLE one
// (every feed subscribed up front, none ever added or removed, no compaction).
// The split exists because it is exactly the line along which the byte-level
// deployment shapes divide: a store whose subscription list is stable, and one
// an operator keeps editing. Both get every other axis and the whole assertion
// set; roughly half the seeds take each side, so a nightly run over N seeds
// exercises both.
func chaosPlan(seed uint64, budget int) []chaosStep {
	r := &genRand{s: seed*0x2545f4914f6cdd1d + 0x9e3779b9}
	choose := func(xs []int) int { return xs[r.intn(len(xs))] }
	churn := r.intn(2) == 0

	var steps []chaosStep
	produced, feeds := 0, 0
	for produced < budget {
		st := chaosStep{
			Reopen:     len(steps) > 0 && r.intn(4) == 0,
			MaxDeltas:  choose(chaosMaxDeltas),
			MaxDeltaKB: choose(chaosMaxDeltaKB),
			Keep:       choose(chaosKeep), // both directions — see chaosKeep
			Advance:    int64(1+r.intn(72)) * 3600,
			Compact:    r.intn(11) == 0 && churn,
		}
		// Nothing can be written before a feed exists, so the first step (and any
		// step that follows the removal of the last one) always subscribes.
		switch {
		case feeds == 0:
			st.AddFeeds = 1 + r.intn(3)
			if !churn {
				st.AddFeeds += r.intn(3) // a stable seed's whole feed set, up front
			}
		case churn:
			if feeds > 1 && r.intn(9) == 0 {
				st.RemoveFeed, st.RemovePick = true, r.intn(1<<20)
				feeds--
			}
			if r.intn(7) == 0 {
				st.AddFeeds = 1 + r.intn(2)
			}
		}
		st.ExpDays = make([]int, st.AddFeeds)
		for i := range st.ExpDays {
			st.ExpDays[i] = choose(chaosExpireDays)
		}
		feeds += st.AddFeeds

		switch r.intn(12) {
		case 0:
			st.Articles = 0 // an idle cycle: no generation is minted at all
		case 1:
			st.Articles = 30 + r.intn(120) // a burst that rolls several data packs
		default:
			st.Articles = 1 + r.intn(8)
		}
		st.Articles = min(st.Articles, budget-produced)
		produced += st.Articles
		st.Picks = make([]int, st.Articles)
		for i := range st.Picks {
			st.Picks[i] = r.intn(1 << 20)
		}
		steps = append(steps, st)
	}
	return steps
}

// chaosRun is one execution of a plan against one store. Two of them run per
// seed — the delta-driven store and the killSwitch reference — and what they
// published is compared at the end.
type chaosRun struct {
	t     *testing.T
	label string
	seed  uint64
	dir   string
	cache string
	db    *DB
	// killSwitch pins --max-deltas at 0 for every step: every dirty cycle
	// rewrites the tail packs, which IS the pre-delta writer.
	killSwitch bool

	want []chaosArticle // the oracle, indexed by chron
	tomb map[int]bool   // chrons a compaction has emptied into tombstones
	// bornAt records, per LIVE feed id, the chron the current incarnation was
	// subscribed at — which is what tells an ordinary feed apart from a REUSED
	// id whose predecessor's entries sit below it. Two `inspect --validate`
	// checks answer non-zero on those by design (see validate), so the oracle
	// has to know which ids they are.
	bornAt map[int]int
	// perFeed counts the oracle's entries per feed id, live or not: the cheap
	// way to notice that AddFeed just handed back an id that already has idx
	// entries, and to census the orphans a removal leaves behind.
	perFeed map[int]int
	next    int64 // this run's fetched_at cursor
	cov     chaosCoverage
}

func newChaosRun(t *testing.T, label string, seed uint64, dir string, killSwitch bool) *chaosRun {
	t.Helper()
	return &chaosRun{
		t: t, label: label, seed: seed, dir: dir, cache: t.TempDir(),
		killSwitch: killSwitch,
		tomb:       map[int]bool{}, bornAt: map[int]int{}, perFeed: map[int]int{},
		next: chaosBaseTime,
	}
}

// applyGlobals points the process globals at this run's store with this step's
// knobs. Fresh per step: --max-deltas, --max-delta-bytes and --keep-manifests
// are all re-drawn, and `srr store compact` reads globals.KeepManifests itself.
func (c *chaosRun) applyGlobals(st chaosStep) {
	maxDeltas := st.MaxDeltas
	if c.killSwitch {
		maxDeltas = 0
	}
	globals = &Globals{
		PackSize:      1, // KB — roll data packs aggressively
		Store:         c.dir,
		Workers:       2,
		MaxFeedSize:   defaultMaxFeedSize,
		CacheDir:      c.cache,
		MaxDeltas:     maxDeltas,
		MaxDeltaBytes: st.MaxDeltaKB,
		KeepManifests: st.Keep,
	}
}

func (c *chaosRun) open() {
	c.t.Helper()
	db, err := NewDB(ctx, false)
	if err != nil {
		c.t.Fatalf("%s: NewDB: %v", c.label, err)
	}
	c.db = db
}

// reopen models the process boundary between two fetch invocations: the handle
// is closed, the store is re-read from db.gz, and the process-global meta-tail
// memo is dropped — trusting one the previous handle populated would hide the
// read-back path a real resume depends on. (The delta-chain memo needs no
// reset: it hangs off the DB handle and dies with it.)
func (c *chaosRun) reopen(step int) {
	c.t.Helper()
	if err := c.db.Close(ctx); err != nil {
		c.t.Fatalf("%s step %d: Close: %v", c.label, step, err)
	}
	metaTailMemo.reset()
	c.open()
	c.cov.Reopens++
}

// liveFeedIDs is the live feed set in a STABLE order, so a plan's raw draw
// resolves to the same feed in both runs.
func (c *chaosRun) liveFeedIDs() []int {
	return slices.Sorted(maps.Keys(c.db.core.Feeds))
}

// runStep replays one scripted round in cmd_fetch.go's order and with
// cmd_fetch.go's error contract inverted: the derived steps are warn-only
// there, but a chaos run has no reason to tolerate one — a failure of any of
// them here is a finding, so every error is fatal.
func (c *chaosRun) runStep(step int, st chaosStep) {
	t := c.t
	t.Helper()
	c.applyGlobals(st)
	if st.Reopen {
		c.reopen(step)
	}

	if st.RemoveFeed {
		c.removeFeed(step, st)
	}
	for i := range st.AddFeeds {
		f := &Feed{
			// The URL is keyed on the step rather than on a per-run counter, so an
			// id reused by a later incarnation still carries a DIFFERENT url —
			// which is what checkChronPermanence keys its per-feed comparison on,
			// and what makes reuse legible in a dump.
			Title:      fmt.Sprintf("chaos feed s%d-%d", step, i),
			URL:        fmt.Sprintf("https://example.com/chaos/%d/%d", step, i),
			ExpireDays: st.ExpDays[i],
		}
		if err := c.db.AddFeed(f); err != nil {
			t.Fatalf("%s step %d: AddFeed: %v", c.label, step, err)
		}
		// AddFeed takes the lowest free id, so this is where a reuse happens; the
		// batch has not been written yet, so len(want) is the store's TotalArt.
		c.bornAt[f.id] = len(c.want)
		if c.perFeed[f.id] > 0 {
			c.cov.Reuses++
		}
	}

	c.next += st.Advance
	c.db.core.FetchedAt = c.next
	today := uint16(c.next / 86400)

	ndBefore := c.db.core.numDeltas()
	if st.Articles > 0 {
		ids := c.liveFeedIDs()
		items := make([]*Item, st.Articles)
		for i := range items {
			gidx := len(c.want) + i
			id := ids[st.Picks[i]%len(ids)]
			title, content := chaosArticleAt(c.seed, gidx)
			items[i] = &Item{
				Feed:      c.db.core.Feeds[id],
				Title:     title,
				Content:   content,
				Link:      chaosLinkAt(gidx),
				Published: c.next + int64(i),
			}
			// One dedup stamp per article keeps the seen pool dirty every cycle, so
			// SyncSeen actually publishes an object for the GC to reason about.
			c.db.seen.stamp(id, uint32(gidx+1), today)
		}
		written, err := c.db.PutArticles(ctx, items)
		if err != nil {
			t.Fatalf("%s step %d: PutArticles: %v", c.label, step, err)
		}
		if len(written) != len(items) {
			t.Fatalf("%s step %d: PutArticles persisted %d of %d articles", c.label, step, len(written), len(items))
		}
		// The oracle records what the SCRIPT wrote, taken from the items — never
		// from the writer's own return value, which would make the check circular.
		for _, it := range items {
			c.want = append(c.want, chaosArticle{
				feedID: it.Feed.id, title: it.Title, link: it.Link,
				content: it.Content, published: it.Published, fetchedAt: c.next,
			})
			c.perFeed[it.Feed.id]++
		}
	} else {
		c.cov.IdleCycles++
	}

	if err := c.db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("%s step %d: SyncIdxSummary: %v", c.label, step, err)
	}
	if err := c.db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("%s step %d: SyncMeta: %v", c.label, step, err)
	}
	if err := c.db.ExpireArticles(ctx, c.next); err != nil {
		t.Fatalf("%s step %d: ExpireArticles: %v", c.label, step, err)
	}
	if err := c.db.SyncSeen(ctx); err != nil {
		t.Fatalf("%s step %d: SyncSeen: %v", c.label, step, err)
	}
	if err := c.db.GC(ctx, st.Keep); err != nil {
		t.Fatalf("%s step %d: GC(keep=%d): %v", c.label, step, st.Keep, err)
	}
	if err := c.db.Commit(ctx); err != nil {
		t.Fatalf("%s step %d: Commit: %v", c.label, step, err)
	}
	c.trackChain(ndBefore)

	if st.Compact {
		c.compact(step)
	}
	c.verify(step)
}

// trackChain reads the consolidation decision off the chain length rather than
// off the plan: `shouldConsolidate` weighs three triggers plus the kill switch,
// and the point of the coverage counters is to observe what the WRITER did.
func (c *chaosRun) trackChain(ndBefore int) {
	nd := c.db.core.numDeltas()
	c.cov.MaxChain = max(c.cov.MaxChain, nd)
	switch {
	case nd > ndBefore:
		c.cov.DeltaCycles++
	case ndBefore > 0 && nd == 0:
		c.cov.Consolids++
	}
}

// removeFeed drops one live feed, recording whether the removal had to drain a
// live chain first. That case — a feed removed while its articles sit in the
// live delta chain, whose id the next AddFeed can then reuse — is the format
// review's HIGH and the whole reason RemoveFeed reads the chain at all; the
// counter is how a nightly proves it kept happening.
func (c *chaosRun) removeFeed(step int, st chaosStep) {
	t := c.t
	t.Helper()
	ids := c.liveFeedIDs()
	if len(ids) == 0 {
		return
	}
	gone := ids[st.RemovePick%len(ids)]
	if c.db.core.numDeltas() > 0 {
		arts, err := c.db.loadDeltaArticles(ctx)
		if err != nil {
			t.Fatalf("%s step %d: read the live chain before RemoveFeed: %v", c.label, step, err)
		}
		if slices.ContainsFunc(arts, func(a ArticleData) bool { return a.FeedID == gone }) {
			c.cov.DrainingRms++
		}
	}
	if err := c.db.RemoveFeed(ctx, gone); err != nil {
		t.Fatalf("%s step %d: RemoveFeed: %v", c.label, step, err)
	}
	delete(c.bornAt, gone)
	c.cov.Removals++
}

// compact drains the chain, then runs the real `srr store compact`.
//
// The drain is deliberate and it is what keeps the equivalence compare honest:
// compaction touches the CONSOLIDATED region only (docs/MANIFEST-SPEC.md §9.2 —
// the live delta region holds the newest articles, which are essentially never
// expired), so compacting a delta-driven store mid-chain would legitimately
// reclaim a smaller set than the kill-switch reference and the two would
// diverge for a reason that is not a bug. Draining first puts both runs on the
// same set. It is also what an operator would do.
func (c *chaosRun) compact(step int) {
	t := c.t
	t.Helper()
	if err := c.db.DrainDeltas(ctx); err != nil {
		t.Fatalf("%s step %d: DrainDeltas before compact: %v", c.label, step, err)
	}
	// The tombstone set, computed exactly as DB.Compact plans it: an article is
	// expired iff its feed still exists and its chron sits below that feed's
	// AddIdx. A REMOVED feed's orphans keep their content ([DELETED] but still
	// loadable); a REUSED id's do not, which is the case worth having an oracle
	// for. The drain above put tailCovered at total_art, so the whole store is
	// in range.
	for chron, want := range c.want {
		if f := c.db.core.Feeds[want.feedID]; f != nil && chron < f.AddIdx {
			c.tomb[chron] = true
		}
	}
	if err := c.db.Compact(ctx, false); err != nil {
		t.Fatalf("%s step %d: Compact: %v", c.label, step, err)
	}
	// Compact commits only when it rewrote something; commit unconditionally so
	// the drain above is published on this step in BOTH runs and the generation
	// counters stay in step.
	if err := c.db.Commit(ctx); err != nil {
		t.Fatalf("%s step %d: Commit after compact: %v", c.label, step, err)
	}
	c.cov.Compactions++
}

// verify runs the whole per-step assertion set against the committed store.
func (c *chaosRun) verify(step int) {
	c.t.Helper()
	c.validate(step)
	c.verifyChrons(step)
}

// orphanFeedCount is the oracle's count of DISTINCT feed ids that have idx
// entries but no live subscription — the census `checkUnknownFeedIDs` reports
// (one issue per distinct id). The plan removes feeds on purpose, so those
// entries are an EXPECTED state (packs are immutable and chronIdx is permanent:
// the frontend renders them "[DELETED]" and a ★-Saved chron keeps loading), and
// `--validate` reports them as issues by design — see
// frontend/e2e/contract/tombstone.e2e.test.ts.
func (c *chaosRun) orphanFeedCount() int {
	orphans := 0
	for id, n := range c.perFeed {
		if _, live := c.db.core.Feeds[id]; !live && n > 0 {
			orphans++
		}
	}
	return orphans
}

// reusedFeedIDs is the oracle's set of live ids whose PREDECESSOR incarnation
// also has entries in the packs — a chron written under the id before the
// current subscription was born.
func (c *chaosRun) reusedFeedIDs() map[int]bool {
	reused := map[int]bool{}
	for chron, w := range c.want {
		if born, live := c.bornAt[w.feedID]; live && chron < born {
			reused[w.feedID] = true
		}
	}
	return reused
}

// chaosDBMetaAllTime matches checkDBMeta's per-feed ALL-TIME count line, the one
// report that is a documented false positive under feed-id reuse: the check
// compares a feed's total_art against every idx entry carrying its id, and a
// reused id carries its predecessor's too (cmd_inspect_check.go states the
// limitation in place — "the all-time total_art check above still assumes no id
// reuse — a known, pre-existing limitation"; the reuse-PROOF live-count
// cross-check right below it is the one that actually guards the counting
// contract, and it must stay silent).
var chaosDBMetaAllTime = regexp.MustCompile(`^\[db-meta\] sub (\d+) \(.*\): total_art=`)

// dbMetaTolerated is how many of a [db-meta] report's lines are that known
// limitation firing on an id THIS oracle knows was reused. Any other line makes
// the count disagree with the check's own issue tally, which fails the step.
func (c *chaosRun) dbMetaTolerated(detail string) int {
	reused := c.reusedFeedIDs()
	n := 0
	for _, line := range strings.Split(detail, "\n") {
		m := chaosDBMetaAllTime.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if id, err := strconv.Atoi(m[1]); err == nil && reused[id] {
			n++
		}
	}
	return n
}

// validate runs the full `srr inspect --validate` sweep over the committed
// store — a SECOND, read-only handle opened from globals.Store, exactly as the
// CLI would, so the checks read what is on disk rather than what this handle
// holds in memory.
//
// It asks for --json and asserts PER CHECK rather than on the exit code,
// because two checks can answer non-zero for reasons that are not store
// defects:
//
//   - unknown-feed-ids — the orphaned-entry census a removal leaves behind
//     (packs are immutable, so a removed feed's entries stay and the reader
//     renders them "[DELETED]"). It must equal the oracle's own orphan count.
//   - db-meta's per-feed ALL-TIME count line — a reused id carries its
//     predecessor's entries, which cmd_inspect_check.go calls out in place as a
//     known limitation of that one comparison. Tolerated ONLY for ids the
//     oracle knows were reused, and only for that exact line.
//
// Every other check, and every other line of those two, must be silent. The
// `manifest` check used to need a third tolerance — the idle-cycle fetched_at
// skew, a checker defect this file could only work around — which is fixed in
// cmd_inspect_manifest.go: fetched_at is now held out of the state comparison
// exactly as manifestSig holds it out of the publish decision.
func (c *chaosRun) validate(step int) {
	t := c.t
	t.Helper()
	var buf bytes.Buffer
	// JSON mode returns an error whenever any check reported, so the document —
	// not the error — is the result; a run error only matters when it produced
	// no parsable document.
	runErr := (&InspectCmd{Chron: -1, Validate: true, JSON: true, out: &buf}).Run()
	var doc struct {
		OK     bool           `json:"ok"`
		Issues []inspectIssue `json:"issues"`
	}
	if err := json.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatalf("%s step %d: inspect --validate --json produced no document: %v (run error: %v)\n%s",
			c.label, step, err, runErr, buf.String())
	}
	for _, iss := range doc.Issues {
		tolerated := 0
		switch iss.Check {
		case "unknown-feed-ids":
			tolerated = c.orphanFeedCount()
		case "db-meta":
			tolerated = c.dbMetaTolerated(iss.Detail)
		}
		if iss.Issues != tolerated {
			t.Fatalf("%s step %d: inspect --validate [%s]: %d issue(s), %d expected from feed churn:\n%s",
				c.label, step, iss.Check, iss.Issues, tolerated, iss.Detail)
		}
	}
}

// verifyChrons is the oracle check: every chron the script wrote is still
// indexed under the feed it was written under (M8, against an independent
// record rather than against the store's own history), still resolves through
// its idx entry to a data line that agrees about the feed, and still holds
// either the payload that was written there or — iff a compaction emptied it —
// a tombstone that kept f/a/p and dropped the rest.
//
// It RETURNS the resolved record per chron. That sequence — read through each
// store's OWN idx entries, so it is what a reader would see — is the article
// equivalence runChaosSeed compares between the two runs, and unlike a byte
// compare it is immune to which data pack physically holds a line.
func (c *chaosRun) verifyChrons(step int) []ArticleData {
	t := c.t
	t.Helper()
	core := &c.db.core
	if core.TotalArticles != len(c.want) {
		t.Fatalf("%s step %d: store holds %d articles, the script wrote %d", c.label, step, core.TotalArticles, len(c.want))
	}
	if core.TotalArticles == 0 {
		return nil
	}
	fetch := func(key string) ([]byte, error) { return c.db.readGz(ctx, key) }
	packs, deltas, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("%s step %d: loadIdxPacks: %v", c.label, step, err)
	}
	pr := newPackReader(ctx, c.db, deltas)
	got := make([]ArticleData, len(c.want))
	for chron, want := range c.want {
		p := packIdxFor(chron, len(packs))
		pack := packs[p]
		idxFeed := int(pack.feedIDs[chron-p*idxPackSize])
		if idxFeed != want.feedID {
			t.Fatalf("%s step %d: chron %d indexes feed %d, written under feed %d — a chron was renumbered (M8)",
				c.label, step, chron, idxFeed, want.feedID)
		}
		pid, off := pack.getPackRef(chron)
		ad, ok, err := pr.at(pid, off)
		if err != nil {
			t.Fatalf("%s step %d: chron %d resolves to (pack %d, offset %d), which failed to read: %v",
				c.label, step, chron, pid, off, err)
		}
		if !ok {
			t.Fatalf("%s step %d: chron %d addresses (pack %d, offset %d), past the end of that data pack",
				c.label, step, chron, pid, off)
		}
		if ad.FeedID != idxFeed {
			t.Fatalf("%s step %d: chron %d: the idx entry says feed %d, the data line it addresses says %d",
				c.label, step, chron, idxFeed, ad.FeedID)
		}
		got[chron] = ad
		// f/a/p survive a compaction and t/l/c/g do not (§9.3 — the absent `c` is
		// the reader's "no longer stored" sentinel), so the first pair is asserted
		// either way and the payload per state.
		if ad.FetchedAt != want.fetchedAt || ad.Published != want.published {
			t.Fatalf("%s step %d: chron %d has a=%d p=%d, the script wrote a=%d p=%d",
				c.label, step, chron, ad.FetchedAt, ad.Published, want.fetchedAt, want.published)
		}
		if c.tomb[chron] {
			if ad.Title != "" || ad.Link != "" || ad.Content != "" || ad.Lang != "" {
				t.Fatalf("%s step %d: chron %d was compacted but its payload survives (title %q, link %q, %d content bytes, lang %q)",
					c.label, step, chron, ad.Title, ad.Link, len(ad.Content), ad.Lang)
			}
			continue
		}
		if ad.Title != want.title || ad.Link != want.link || ad.Content != want.content {
			t.Fatalf("%s step %d: chron %d holds (%q, %q, %d content bytes), the script wrote (%q, %q, %d)",
				c.label, step, chron, ad.Title, ad.Link, len(ad.Content), want.title, want.link, len(want.content))
		}
	}
	return got
}

// finish forces a final consolidation so a delta-driven store ends in the same
// SHAPE as the kill-switch reference, then returns the chron-ordered article
// sequence the two runs are compared on.
func (c *chaosRun) finish(steps int) []ArticleData {
	t := c.t
	t.Helper()
	globals.MaxDeltas = 0
	if err := c.db.DrainDeltas(ctx); err != nil {
		t.Fatalf("%s: final DrainDeltas: %v", c.label, err)
	}
	if err := c.db.Commit(ctx); err != nil {
		t.Fatalf("%s: final Commit: %v", c.label, err)
	}
	c.validate(steps)
	if c.db.core.DeltaArticles != 0 || c.db.core.numDeltas() != 0 {
		t.Fatalf("%s: the final drain left a live chain: nd=%d na=%d",
			c.label, c.db.core.numDeltas(), c.db.core.DeltaArticles)
	}
	return c.verifyChrons(steps)
}

// chaosState is the published state the two runs must agree on. Deliberately
// NOT the whole DBCore: the name table holds opaque stems drawn from a monotone
// counter, so two runs that reached the same store through a different number
// of consolidations legitimately hold different names for the same positions;
// the writer-only trigger state (dby, gcm) describes how each run got here
// rather than where it is; and the writer cursors next_pid/pack_off ride the
// data-pack roll point (runChaosSeed 5e) rather than the content.
type chaosState struct {
	State ManifestState
	Feeds map[int]FeedPublic
}

func chaosStateOf(c *DBCore) chaosState {
	st := chaosState{State: c.ManifestState, Feeds: map[int]FeedPublic{}}
	for id, f := range c.Feeds {
		st.Feeds[id] = feedPublicOf(f)
	}
	return st
}

// chaosRepro is the one line that turns a nightly red into a local repro.
func chaosRepro(seed uint64, articles int) string {
	return fmt.Sprintf("make chaos-be CHAOS_SEED=%d CHAOS_ARTICLES=%d", seed, articles)
}

// writeChaosRepro drops the repro command next to db.gz in the kept store, so
// the CI artifact says how to reproduce itself. A store-root file is outside
// the pack grammar (store.ParsePackKey) and outside every series prefix the GC
// and `inspect`'s orphan report list, so nothing in the writer or the reader
// can see it.
func writeChaosRepro(t *testing.T, dir string, seed uint64, articles int) {
	t.Helper()
	if dir == "" {
		return
	}
	body := "#!/bin/sh\n# Reproduce the chaos-store failure this artifact captured.\n" +
		"# Run from the repo root.\n" + chaosRepro(seed, articles) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "chaos-repro.sh"), []byte(body), 0o755); err != nil {
		t.Logf("could not write the repro script: %v", err)
	}
}

// chaosOracle is what the driver hands the jsdom contract pass
// (frontend/e2e/contract/chaos.e2e.test.ts): the WRITER's record of every chron
// a reader should be able to open, so that suite compares the reader against
// the script rather than against the store's own idx — the same reason
// verifyChrons keeps an oracle at all. Only LIVE chrons are listed: a removed
// feed's orphans and an expired prefix are deliberately unreachable through
// normal navigation, and a compacted chron has no payload left to check.
type chaosOracle struct {
	Seed     uint64             `json:"seed"`
	Articles int                `json:"articles"`
	TotalArt int                `json:"total_art"`
	Feeds    map[string]int     `json:"feeds"` // live entry count per feed id
	Live     []chaosOracleEntry `json:"live"`
}

type chaosOracleEntry struct {
	Chron     int    `json:"c"`
	FeedID    int    `json:"f"`
	Title     string `json:"t"`
	Link      string `json:"l"`
	Published int64  `json:"p"`
}

// writeChaosOracle publishes that record beside db.gz. Best-effort: the Go
// assertions are the driver's product, and a sidecar failure must not turn a
// green walk red.
func (c *chaosRun) writeChaosOracle(articles int) {
	if c.dir == "" {
		return
	}
	o := chaosOracle{Seed: c.seed, Articles: articles, TotalArt: len(c.want), Feeds: map[string]int{}}
	for chron, w := range c.want {
		f := c.db.core.Feeds[w.feedID]
		if f == nil || chron < f.AddIdx {
			continue // removed feed, or expired below the frontier
		}
		o.Feeds[strconv.Itoa(w.feedID)]++
		o.Live = append(o.Live, chaosOracleEntry{
			Chron: chron, FeedID: w.feedID, Title: w.title, Link: w.link, Published: w.published,
		})
	}
	body, err := json.Marshal(o)
	if err != nil {
		c.t.Logf("could not encode the chaos oracle: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(c.dir, chaosOracleFile), body, 0o644); err != nil {
		c.t.Logf("could not write the chaos oracle: %v", err)
	}
}

// chaosSeeds resolves the seed list: an explicit SRR_CHAOS_SEED replays exactly
// one, otherwise SRR_CHAOS_SEEDS seeds start from a wall-clock base. A random
// base is the point of a NIGHTLY chaos job — a fixed one would re-walk the same
// paths forever — and it is only safe because every seed is printed.
func chaosSeeds(t *testing.T) []uint64 {
	t.Helper()
	if v := os.Getenv("SRR_CHAOS_SEED"); v != "" {
		seed, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			t.Fatalf("SRR_CHAOS_SEED=%q is not a uint64: %v", v, err)
		}
		return []uint64{seed}
	}
	n := chaosEnvInt("SRR_CHAOS_SEEDS", chaosDefaultSeeds)
	base := uint64(time.Now().UnixNano())
	seeds := make([]uint64, n)
	for i := range seeds {
		seeds[i] = base + uint64(i)
	}
	return seeds
}

func TestChaosStore(t *testing.T) {
	if os.Getenv("SRR_CHAOS") == "" {
		t.Skip("set SRR_CHAOS=1 to run the seeded chaos-store driver (see `make chaos-be`)")
	}
	articles := chaosEnvInt("SRR_CHAOS_ARTICLES", chaosDefaultArticles)
	out := os.Getenv("SRR_CHAOS_OUT")
	seeds := chaosSeeds(t)

	// Print the seeds BEFORE walking them: a run killed by a CI timeout must
	// still say what it was walking.
	t.Logf("chaos: %d seed(s) × %d articles: %v", len(seeds), articles, seeds)

	// Finalized packs recompress with zopfli in production; identity keeps the
	// bytes the assertions read back exactly what savePack produced and saves
	// seconds per finalized pack, which at this seed count is the whole run.
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	t.Cleanup(func() { finalGzip = gzipBest })

	var total chaosCoverage
	for _, seed := range seeds {
		ok := t.Run(fmt.Sprintf("seed_%d", seed), func(t *testing.T) {
			t.Logf("seed %d — replay with: %s", seed, chaosRepro(seed, articles))
			t.Cleanup(func() {
				if t.Failed() {
					t.Errorf("CHAOS SEED %d FAILED — reproduce with:\n\t%s", seed, chaosRepro(seed, articles))
					writeChaosRepro(t, out, seed, articles)
				}
			})
			total = addChaosCoverage(total, runChaosSeed(t, seed, articles, out))
		})
		// Stop at the first failing seed: SRR_CHAOS_OUT must keep THAT seed's
		// store for the CI artifact, and a later seed would overwrite it.
		if !ok {
			break
		}
	}
	t.Logf("chaos coverage over %d seed(s): %+v", len(seeds), total)
}

func addChaosCoverage(a, b chaosCoverage) chaosCoverage {
	return chaosCoverage{
		Reopens: a.Reopens + b.Reopens, IdleCycles: a.IdleCycles + b.IdleCycles,
		Removals: a.Removals + b.Removals, DrainingRms: a.DrainingRms + b.DrainingRms,
		Reuses: a.Reuses + b.Reuses, Compactions: a.Compactions + b.Compactions,
		DeltaCycles: a.DeltaCycles + b.DeltaCycles, Consolids: a.Consolids + b.Consolids,
		MaxChain: max(a.MaxChain, b.MaxChain),
	}
}

// runChaosSeed walks one seed's plan twice — once through the delta path with
// the plan's own consolidation triggers, once with --max-deltas pinned at 0 —
// and compares what the two published.
func runChaosSeed(t *testing.T, seed uint64, articles int, out string) chaosCoverage {
	plan := chaosPlan(seed, articles)

	// The delta-driven store. SRR_CHAOS_OUT keeps it (wiped first, so a resumed
	// directory can never make a run non-reproducible); otherwise it is a temp
	// dir the test framework reclaims.
	dirA := out
	if dirA == "" {
		dirA = t.TempDir()
	} else {
		if err := os.RemoveAll(dirA); err != nil {
			t.Fatalf("wipe SRR_CHAOS_OUT=%q: %v", dirA, err)
		}
		if err := os.MkdirAll(dirA, 0o755); err != nil {
			t.Fatalf("mkdir SRR_CHAOS_OUT=%q: %v", dirA, err)
		}
	}

	metaTailMemo.reset()
	a := newChaosRun(t, "delta", seed, dirA, false)
	a.applyGlobals(plan[0])
	a.open()
	defer a.db.Close(ctx)
	for i, st := range plan {
		a.runStep(i, st)
	}
	artsA := a.finish(len(plan))
	a.writeChaosOracle(articles)

	metaTailMemo.reset()
	b := newChaosRun(t, "killswitch", seed, t.TempDir(), true)
	b.applyGlobals(plan[0])
	b.open()
	defer b.db.Close(ctx)
	for i, st := range plan {
		b.runStep(i, st)
	}
	artsB := b.finish(len(plan))

	t.Logf("seed %d: %d step(s), %d article(s), m=%d/%d, %d tombstone(s), coverage %+v",
		seed, len(plan), len(a.want), a.db.core.ManifestNum, b.db.core.ManifestNum, len(a.tomb), a.cov)

	// Sanity: a plan whose delta path never ran, or that never folded a
	// non-empty chain back into the packs, would make the equivalence compare
	// vacuous — it would be comparing the kill switch against itself.
	if a.cov.DeltaCycles == 0 || a.cov.Consolids == 0 {
		t.Fatalf("seed %d never ran a delta cycle followed by a consolidation (%+v) — the equivalence compare is vacuous",
			seed, a.cov)
	}

	// (5a) Consolidation equivalence, the published STATE — unconditional:
	// whatever route a store took to get here, the counters and the per-feed
	// projection a reader sees must be the same.
	sa, err := jsonEncode(chaosStateOf(&a.db.core))
	if err != nil {
		t.Fatal(err)
	}
	sb, err := jsonEncode(chaosStateOf(&b.db.core))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sa, sb) {
		t.Errorf("published state differs between the delta path and the kill switch:\ndelta:      %s\nkillswitch: %s", sa, sb)
	}

	// (5b) …and the ARTICLE SEQUENCE — also unconditional, and the half that
	// actually says "the delta path stored what the pre-delta writer would have".
	// Each side is resolved through its OWN idx entries, so this is what a reader
	// gets: same chron, same record, field for field.
	if len(artsA) != len(artsB) {
		t.Fatalf("article sequences differ in length: delta %d, killswitch %d", len(artsA), len(artsB))
	}
	for chron := range artsA {
		if artsA[chron] != artsB[chron] {
			t.Fatalf("chron %d resolves differently:\ndelta:      %+v\nkillswitch: %+v", chron, artsA[chron], artsB[chron])
		}
	}

	// (5c) …the idx HEADERS, semantically: every pack's as-of-chron cumulative
	// count per feed must agree. This is what the equivalence test exists for —
	// consolidateTail rewinds a count vector to the replay's first chron
	// ("⚠ The as-of-chron header subtlety" in db_pack.go) and getting that wrong
	// is the header-rewind bug class. Compared through feedCount(), which is the
	// reader's own accessor and bounds-guards a slot past numSlots to 0, so a
	// header that is merely a different WIDTH still compares equal (§12.1's
	// documented mid-chain-feed-add carve-out) while one that MISCOUNTS does not.
	chaosCompareIdxHeaders(t, a, b)

	// (5d) …the meta series, byte for byte, per position. meta/ is strided by
	// chron (metaPackSize), not by compressed size, so its shard boundaries are
	// position-determined and immune to the roll drift below; a byte difference
	// here is a real divergence.
	chaosCompareMeta(t, a, b)

	// (5e) …and the data series' BYTES — concatenated in position order rather
	// than compared per object, because that is the level at which byte identity
	// actually holds. This is the byte compare, NOT a weakening of it: it pins
	// every JSONL line's exact encoding and its exact place in the chron stream,
	// so a writer that re-encodes, reorders, drops, duplicates or corrupts a line
	// fails here even where (5b) would not — (5b) compares parsed records, this
	// compares bytes.
	//
	// What must NOT be asserted is byte identity per OBJECT, and the reason is
	// physical, proven and reader-invisible. docs/DELTA-TAIL-SPEC.md §12.1 claims
	// per-object identity on the grounds that "the writer is deterministic
	// (stdlib gzip + zopfli on fixed input)". The input is fixed; the roll
	// predicate is not a function of it:
	//
	//	db_pack.go rolls a data pack on `data.Len() >= globals.PackSize<<10`, and
	//	pack.Len() is `p.buf.Len()` — the bytes the gzip.Writer has FLUSHED, not
	//	the bytes written to it. compress/flate runs a deflate() pass per Write
	//	CALL, so the flushed count at a given prefix depends on how many Write
	//	calls carried that prefix. packFromBytes re-delivers the whole existing
	//	tail in ONE Write and each replayed article is its own Write, so a long
	//	consolidation replay and a reload-per-cycle arrive at the same prefix
	//	having flushed different amounts, and the roll fires an article apart.
	//
	// Measured, on seed 1785065944378150381 (stable feed set, no compaction): at
	// the identical 20667-byte prefix the delta run had made 12 Write calls and
	// flushed 12490 bytes, the kill switch 1 call and flushed 10 — so the delta
	// store rolled at chron 334 and the kill switch at 335, and every later pack
	// stayed one article offset with an identical article sequence. Reduced: an
	// identical 20670-byte prefix through compress/gzip yields buf.Len() 10 in
	// ≤3 Write calls and 12250 in ≥6.
	//
	// None of it is reader-visible: a chron resolves to a data pack through the
	// idx footer's boundary list, never through position arithmetic, so which
	// pack holds a line is not part of the contract — and next_pid/pack_off ride
	// the shift with it, which is why (5a) does not compare them either. §12.1
	// already carves out the OTHER divergence in this class (a feed added
	// mid-chain widens the consolidation-time numSlots snapshot); the roll point
	// is a second one it does not mention, and it needs no fix — it needs the
	// claim stated at the level where it is true, which is this comparison.
	chaosCompareDataStream(t, a, b)

	return a.cov
}

// chaosCompareIdxHeaders asserts the two runs agree on every idx pack's
// as-of-chron cumulative count per feed — through feedCount(), the reader's own
// bounds-guarded accessor, so a header of a different WIDTH still compares equal
// (see runChaosSeed 5c) while one that miscounts does not. The entries
// themselves are compared verbatim: those ARE position-determined.
func chaosCompareIdxHeaders(t *testing.T, a, b *chaosRun) {
	t.Helper()
	packsA := chaosIdxPacks(t, a)
	packsB := chaosIdxPacks(t, b)
	if len(packsA) != len(packsB) {
		t.Fatalf("idx pack counts differ: delta %d, killswitch %d", len(packsA), len(packsB))
	}
	// Widest slot space across both sides, so a slot present in only one is
	// compared against the other's guarded 0 rather than skipped.
	slots := 0
	for _, p := range append(append([]*idxPack{}, packsA...), packsB...) {
		slots = max(slots, p.numSlots)
	}
	for i := range packsA {
		pa, pb := packsA[i], packsB[i]
		if pa.packSize != pb.packSize {
			t.Errorf("idx pack %d holds %d entries in the delta store, %d in the kill switch", i, pa.packSize, pb.packSize)
			continue
		}
		for id := range slots {
			if pa.feedCount(id) != pb.feedCount(id) {
				t.Errorf("idx pack %d: feed %d's as-of-chron cumulative count is %d in the delta store, %d in the kill switch — the consolidation replay's count vector rewound wrong",
					i, id, pa.feedCount(id), pb.feedCount(id))
			}
		}
		if !slices.Equal(pa.feedIDs, pb.feedIDs) {
			t.Errorf("idx pack %d: the entry sequence differs between the two runs", i)
		}
	}
}

func chaosIdxPacks(t *testing.T, c *chaosRun) []*idxPack {
	t.Helper()
	packs, _, err := loadIdxPacks(func(key string) ([]byte, error) { return c.db.readGz(ctx, key) }, &c.db.core)
	if err != nil {
		t.Fatalf("%s: loadIdxPacks: %v", c.label, err)
	}
	return packs
}

// chaosSeriesBytes returns one series' DECOMPRESSED objects in position order.
// Positional, deliberately: stems are opaque, so two runs legitimately hold
// different names for the same position (docs/MANIFEST-SPEC.md §13 — the same
// reason delta_test.go's storeFingerprint keys on position).
func chaosSeriesBytes(t *testing.T, c *chaosRun, series string) [][]byte {
	t.Helper()
	s := c.db.core.Names.series(series)
	out := make([][]byte, 0, len(s.Stems))
	for _, stem := range s.Stems {
		name := fmt.Sprintf("%s/%d.gz", series, stem)
		raw, err := os.ReadFile(filepath.Join(c.dir, name))
		if err != nil {
			t.Fatalf("%s: read %s: %v", c.label, name, err)
		}
		body, err := gunzip(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("%s: gunzip %s: %v", c.label, name, err)
		}
		out = append(out, body)
	}
	return out
}

// chaosCompareMeta asserts the meta series matches shard for shard. The stride
// is chron-based, so both runs must hold the same number of shards with the
// same bytes in each.
func chaosCompareMeta(t *testing.T, a, b *chaosRun) {
	t.Helper()
	ma := chaosSeriesBytes(t, a, metaSeries)
	mb := chaosSeriesBytes(t, b, metaSeries)
	if len(ma) != len(mb) {
		t.Fatalf("meta shard counts differ: delta %d, killswitch %d", len(ma), len(mb))
	}
	for i := range ma {
		if !bytes.Equal(ma[i], mb[i]) {
			t.Errorf("meta shard at position %d differs (%d vs %d bytes)%s",
				i, len(ma[i]), len(mb[i]), chaosDiffDetail(ma[i], mb[i]))
		}
	}
}

// chaosCompareDataStream asserts the data series' whole JSONL stream is
// byte-identical between the two runs — see runChaosSeed (5e) for why this, and
// not a per-object compare, is the honest form of the byte assertion.
func chaosCompareDataStream(t *testing.T, a, b *chaosRun) {
	t.Helper()
	sa := bytes.Join(chaosSeriesBytes(t, a, dataSeries), nil)
	sb := bytes.Join(chaosSeriesBytes(t, b, dataSeries), nil)
	if !bytes.Equal(sa, sb) {
		t.Errorf("the data series' JSONL stream differs between the delta path and the kill switch (%d vs %d bytes)%s",
			len(sa), len(sb), chaosDiffDetail(sa, sb))
	}
}

// chaosDiffDetail turns "these two blobs differ" into something a human can act
// on: for a JSONL stream it names the first record that differs and what each
// side holds there. A chaos harness whose failure message is a byte count costs
// an afternoon of bisecting; this is the afternoon.
func chaosDiffDetail(got, want []byte) string {
	if len(got) == 0 || got[0] != '{' {
		return fmt.Sprintf("\n  (binary; %d vs %d bytes)", len(got), len(want))
	}
	gl := bytes.Split(bytes.TrimRight(got, "\n"), []byte("\n"))
	wl := bytes.Split(bytes.TrimRight(want, "\n"), []byte("\n"))
	for i := range max(len(gl), len(wl)) {
		var g, w []byte
		if i < len(gl) {
			g = gl[i]
		}
		if i < len(wl) {
			w = wl[i]
		}
		if bytes.Equal(g, w) {
			continue
		}
		return fmt.Sprintf("\n  %d vs %d line(s); first difference at line %d:\n    delta:      %s\n    killswitch: %s",
			len(gl), len(wl), i, chaosClip(g), chaosClip(w))
	}
	return fmt.Sprintf("\n  %d vs %d line(s), all common lines equal", len(gl), len(wl))
}

func chaosClip(b []byte) string {
	if len(b) > 160 {
		return string(b[:160]) + "…"
	}
	return string(b)
}
