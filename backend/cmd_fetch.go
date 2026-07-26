package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"srr/ingest"
	"srr/mod"

	"golang.org/x/sync/errgroup"
)

// feedFilter restricts a fetch cycle to a subset of feeds by tag and/or feed
// id, with both include and exclude logic. It is embedded in FetchCmd (backs
// `srr art fetch`) and ServeCmd (backs `srr serve --interval`) so the same
// SRR_FETCH_* env reaches the persistent loop. All four are sep:"," slices, so
// each accepts comma-separated values AND repeats (`--tag a,b` ≡ `--tag a
// --tag b`), and kong splits env values on the same separator. Tag selectors
// match hierarchically (see matchTag). Empty = no restriction (fetch every
// feed), the historical default.
type feedFilter struct {
	Tag         []string `short:"g" sep:"," env:"SRR_FETCH_TAG" help:"Only fetch feeds whose tag is (or is under) one of these; comma-separated or repeated. Hierarchical: 'news' also matches 'news/tech'."`
	Feed        []int    `short:"i" sep:"," env:"SRR_FETCH_FEED" help:"Only fetch these feed ids; comma-separated or repeated."`
	ExcludeTag  []string `sep:"," env:"SRR_FETCH_EXCLUDE_TAG" help:"Skip feeds whose tag is (or is under) one of these; comma-separated or repeated. Hierarchical, like --tag."`
	ExcludeFeed []int    `sep:"," env:"SRR_FETCH_EXCLUDE_FEED" help:"Skip these feed ids; comma-separated or repeated."`
}

// shutdownGrace bounds how long an in-flight --interval cycle may keep running
// AFTER SIGTERM/SIGINT — and only then. The loop stops starting new cycles at
// once, but letting the current one finish is what keeps a fetched-but-uncommitted
// batch (and the packs it is mid-write on) from being thrown away by every
// graceful restart; the bound only stops a cycle that is already wedged from
// blocking shutdown forever, and a second signal still hard-kills. A cycle in
// NORMAL operation (no shutdown pending) runs uncapped — a legitimately long
// cycle (a big consolidation, slow asset transcodes) must not be guillotined
// mid-commit and rolled back. A var, not a const, so tests can shrink it.
var shutdownGrace = 30 * time.Second

type FetchCmd struct {
	Interval time.Duration `help:"Run fetch in a loop with this interval." default:"0" env:"SRR_FETCH_INTERVAL"`

	// Spool / InboxProducers are the two halves of the inbox pattern, which
	// splits fetch EGRESS from the single writer so a box with better network
	// reach can fetch feeds the lock-holder cannot. See docs/INBOX-SPEC.md.
	// Kong has no optional-value flags, so producer mode is a bool plus a name
	// that defaults to this host's.
	Spool          bool     `help:"Producer mode: fetch the selected feeds WITHOUT the store lock and spool the cycle to inbox/<name>.gz for a consolidator to drain, instead of writing packs. Requires an explicit --tag/--feed selector." env:"SRR_SPOOL"`
	SpoolName      string   `name:"spool-name" help:"Producer slot name for --spool (default: this host's name)." env:"SRR_SPOOL_NAME"`
	InboxProducers []string `name:"inbox-producers" sep:"," help:"Consolidator mode: drain these producers' inbox/<name>.gz spools into each cycle's batch." env:"SRR_INBOX_PRODUCERS"`

	feedFilter

	// lastOutSig is the syndication-input signature (db.outFeedsSig) at the last
	// SyncOutFeeds call, carried across --interval cycles so an idle cycle whose
	// out config + feed tags are unchanged can skip the redundant store walk.
	lastOutSig string

	// lastAttempt records, per feed id, the cycle time at which this process
	// last selected that feed — the clock the failure backoff below counts
	// from, since a failing feed's LastOK is frozen by definition. In-memory
	// only: it matters solely in the long-running --interval loop (the one path
	// where backoffActive() is true), and a restart deliberately clears it so a
	// human restarting the loop gets one full poll before backoff resumes.
	lastAttempt map[int]int64

	// only restricts the cycle to these feed ids (empty = every feed). Set by
	// the serve SSE handler for the GUI's single-feed fetch; an unknown id
	// fails the cycle. Distinct from the feedFilter above: this is the GUI's
	// exact-id path with a hard-error-on-unknown contract. Not a CLI flag.
	only []int

	// pools holds the fan-out's per-worker resources, built on first use and
	// then reused by every cycle this command runs. See fetchPools.
	pools *fetchPools
}

// fetchPools is the fan-out's reusable worker state, scoped to the COMMAND
// rather than the cycle: an --interval loop runs thousands of cycles through
// one FetchCmd, and rebuilding these every five minutes rebuilt the ingest
// engine's dispatch map and re-seeded pools whose payloads are expensive to
// make — a feed buffer is --max-feed-size (5 MB by default) per worker, and
// each mod.Module compiles two bluemonday policies plus a minifier (FET14).
//
// The pools stay sync.Pools, so an idle loop still returns that memory to the
// runtime at the next GC; what the hoist removes is the guaranteed rebuild.
type fetchPools struct {
	// buf: one feed-read buffer per worker. Pointer-like payload (SA6002): a
	// bare slice header would be boxed into a fresh interface allocation on
	// every Put.
	buf sync.Pool
	// proc: one module processor per worker. Built-in processors hold mutable
	// state (minify reuses internal buffers and is not goroutine-safe), so a
	// single shared *mod.Module across workers is unsafe.
	proc sync.Pool
	// engine is SHARED, not pooled: built-in FetchFuncs are concurrent-safe
	// (HTTP built-ins are stateless; external shell fetchers spawn per-call
	// subprocesses).
	engine *ingest.Fetcher
}

// workerPools returns the command's fan-out pools, building them on first use.
// Cycles are serial within one FetchCmd — the --interval loop, a one-shot run,
// one GUI/MCP request each construct their own — so this needs no locking.
func (o *FetchCmd) workerPools() *fetchPools {
	if o.pools == nil {
		o.pools = &fetchPools{
			buf: sync.Pool{New: func() any {
				buf := make([]byte, globals.MaxFeedSize*(1<<10)+1)
				return &buf
			}},
			proc:   sync.Pool{New: func() any { return mod.New() }},
			engine: ingest.New(),
		}
	}
	return o.pools
}

// matchTag reports whether a feed's tag satisfies a hierarchical tag selector:
// an exact match, or the tag sitting under the selector's subtree. The trailing
// "/" guards against false prefixes, so selector "news" matches "news" and
// "news/tech" but not the sibling "news2".
func matchTag(feedTag, sel string) bool {
	return feedTag == sel || strings.HasPrefix(feedTag, sel+"/")
}

// apply selects feeds from all per the include/exclude filter. The candidate
// set is the union of feeds matching any include tag (prefix) or include feed
// id — or every feed when no include selector is given — with any feed matching
// an exclude tag (prefix) or exclude feed id then removed. Selected feeds are
// returned sorted by id (deterministic). It never errors: a selector matching
// no feed in the store, and an empty result, are reported as human-readable
// warnings for the caller to log (typo detection without aborting a shared
// per-box config). Match tracking scans the whole store per selector,
// independent of the include/exclude interplay, so the warning means "this
// selector names nothing that exists", not "this selector changed the result".
func (f feedFilter) apply(all map[int]*Feed) (selected []*Feed, warnings []string) {
	hasInclude := len(f.Tag) > 0 || len(f.Feed) > 0

	ids := slices.Sorted(maps.Keys(all))

	for _, id := range ids {
		ch := all[id]
		if !hasInclude || feedMatchesTag(ch.Tag, f.Tag) || slices.Contains(f.Feed, id) {
			if !feedMatchesTag(ch.Tag, f.ExcludeTag) && !slices.Contains(f.ExcludeFeed, id) {
				selected = append(selected, ch)
			}
		}
	}

	tagExists := func(sel string) bool {
		for _, id := range ids {
			if matchTag(all[id].Tag, sel) {
				return true
			}
		}
		return false
	}
	for _, t := range f.Tag {
		if !tagExists(t) {
			warnings = append(warnings, fmt.Sprintf("--tag %q matched no feeds", t))
		}
	}
	for _, id := range f.Feed {
		if _, ok := all[id]; !ok {
			warnings = append(warnings, fmt.Sprintf("--feed %d matched no feeds", id))
		}
	}
	for _, t := range f.ExcludeTag {
		if !tagExists(t) {
			warnings = append(warnings, fmt.Sprintf("--exclude-tag %q matched no feeds", t))
		}
	}
	for _, id := range f.ExcludeFeed {
		if _, ok := all[id]; !ok {
			warnings = append(warnings, fmt.Sprintf("--exclude-feed %d matched no feeds", id))
		}
	}
	if len(selected) == 0 {
		warnings = append(warnings, "feed filter selected no feeds this cycle (maintenance still runs)")
	}
	return selected, warnings
}

func feedMatchesTag(feedTag string, sels []string) bool {
	for _, sel := range sels {
		if matchTag(feedTag, sel) {
			return true
		}
	}
	return false
}

// selectFeeds resolves the feeds a cycle should fetch. The GUI single-feed path
// (o.only) resolves exact ids and hard-errors on an unknown one; otherwise the
// include/exclude filter runs over every feed, logging (never erroring on) any
// no-match selector or an empty result.
func (o *FetchCmd) selectFeeds(db *DB) ([]*Feed, error) {
	if len(o.only) > 0 {
		feeds := make([]*Feed, 0, len(o.only))
		seen := make(map[int]struct{}, len(o.only))
		for _, id := range o.only {
			// Dedup: a repeated id (e.g. a crafted /api/fetch?id=5&id=5) would
			// otherwise resolve to the SAME *Feed twice — the fan-out then races
			// two goroutines on it and the aggregation writes its new articles
			// into the immutable packs twice.
			if _, dup := seen[id]; dup {
				continue
			}
			ch, err := db.FeedByID(id)
			if err != nil {
				return nil, err
			}
			seen[id] = struct{}{}
			feeds = append(feeds, ch)
		}
		return feeds, nil
	}
	feeds, warnings := o.apply(db.Feeds())
	for _, w := range warnings {
		slog.Warn("feed filter: " + w)
	}
	if o.backoffActive() {
		now := db.core.FetchedAt
		feeds = filterDue(feeds, o.lastAttempt, now,
			int64(o.Interval/time.Second), int64(globals.FetchBackoffMax/time.Second))
		// Stamp the attempt clock for everything this cycle selected, so the
		// failure backoff has something to count from next cycle.
		if o.lastAttempt == nil {
			o.lastAttempt = make(map[int]int64, len(feeds))
		}
		for _, ch := range feeds {
			o.lastAttempt[ch.id] = now
		}
	}
	return feeds, nil
}

// spoolSlot resolves this producer's slot name: --spool-name, else the host's
// name. It also enforces the deliberate-partition rule — a producer must carry
// an explicit include selector, or it would spool the whole store and duplicate
// the consolidator's own fetching.
func (o *FetchCmd) spoolSlot() (string, error) {
	if len(o.Tag) == 0 && len(o.Feed) == 0 {
		return "", fmt.Errorf("--spool requires an explicit --tag or --feed selector (a spooled partition must be deliberate)")
	}
	name := o.SpoolName
	if name == "" {
		h, err := os.Hostname()
		if err != nil {
			return "", fmt.Errorf("resolve spool name: %w", err)
		}
		name = h
	}
	if !validSpoolName(name) {
		return "", fmt.Errorf("invalid spool name %q: use letters, digits, '-', '_' or '.'", name)
	}
	return name, nil
}

// validSpoolName keeps a producer name inside one store key segment — the name
// is operator-supplied and lands in a store key, so it must not be able to
// escape the inbox/ prefix.
func validSpoolName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// backoffActive gates the dormancy backoff to the unattended full-set loop:
// one-shot runs (Interval == 0), the GUI single-feed path (o.only, which
// returns before this is consulted), and any explicit include selector are a
// human asking for those feeds NOW, so they always poll at full rate. The
// env kill-switch (SRR_FETCH_BACKOFF_MAX=0) disables it without a redeploy.
func (o *FetchCmd) backoffActive() bool {
	return o.Interval > 0 && globals.FetchBackoffMax > 0 &&
		len(o.Tag) == 0 && len(o.Feed) == 0
}

// targetInterval is a feed's current poll interval: the loop base for an
// active feed, drifting up as time-since-last-new-article/8 once it goes
// quiet (≥40 min quiet at a 5-min base before the first skip), capped at
// maxT. LastNew == 0 (never produced here) stays at the base — a fresh feed
// must not start life backed off.
func targetInterval(ch *Feed, now, base, maxT int64) int64 {
	if ch.LastNew <= 0 || now <= ch.LastNew {
		return base
	}
	t := (now - ch.LastNew) / 8
	if t < base {
		return base
	}
	if t > maxT {
		return maxT
	}
	return t
}

// retryInterval is a failing feed's retry cadence: the loop base doubled once
// per consecutive failure and capped at maxT (the streak is clamped first so
// the shift can't run away). Never below base — a failing feed must not be
// polled more eagerly than a healthy one.
func retryInterval(streak int, base, maxT int64) int64 {
	if streak > 10 {
		streak = 10
	}
	t := base << streak
	if t <= 0 || t > maxT { // t <= 0 == shift overflow
		t = maxT
	}
	if t < base {
		return base
	}
	return t
}

// filterDue keeps the feeds whose target interval has elapsed since their last
// poll. The clock differs by health, because the two states have different
// evidence available:
//
//   - Healthy (FailStreak == 0): dormancy backoff off LastOK — stamped on every
//     success incl. 304, so it is the real poll clock. A feed that produces an
//     article snaps back to the base automatically: LastNew moves to ~now, so
//     targetInterval collapses to base on the next cycle.
//   - Failing: LastOK is frozen by definition, so `now - LastOK` is always past
//     due and a dead feed would be retried every single cycle forever (16 dead
//     feeds at a 5-min cadence = ~4,600 doomed requests/day). Count from this
//     process's own lastAttempt clock instead, on an exponential cadence.
//
// Backoff only delays retries — it never hides the outage: ferr/fail_streak
// keep reporting it, and the first success resets the streak so the feed snaps
// straight back to the healthy path.
func filterDue(feeds []*Feed, lastAttempt map[int]int64, now, base, maxT int64) []*Feed {
	out := feeds[:0]
	for _, ch := range feeds {
		var due bool
		if ch.FailStreak > 0 {
			due = now-lastAttempt[ch.id] >= retryInterval(ch.FailStreak, base, maxT)
		} else {
			due = now-ch.LastOK >= targetInterval(ch, now, base, maxT)
		}
		if due {
			out = append(out, ch)
		}
	}
	return out
}

// runCycleSafe runs one fetch cycle, converting a panic anywhere in it (outside
// the per-feed fan-out, which recovers itself via runFeedFetch) into an error so
// the long-running `srr serve` --interval loop and the SSE fetch goroutine
// survive a bad cycle instead of crashing the whole process. A normal cycle
// error passes through unchanged.
func runCycleSafe(cycle func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("fetch cycle panicked: %v", r)
			slog.Error("fetch cycle panicked; recovered", "panic", r, "stack", string(debug.Stack()))
		}
	}()
	return cycle()
}

// runFeedFetch runs one feed's fetch and converts a panic in the (third-party,
// attacker-influenced) content pipeline into a recorded feed error, so a single
// feed can never crash the whole fetch process. The fan-out goroutines below —
// and the `srr serve` --interval loop and SSE fetch that drive runFetch — run
// OUTSIDE net/http's per-request panic recovery, so an unrecovered panic there
// would terminate the admin GUI and the fetch loop together. A recovered feed
// is marked failed (like any fetch error) and the cycle continues.
func runFeedFetch(ch *Feed, fetch func()) {
	defer func() {
		if r := recover(); r != nil {
			ch.FetchError = fmt.Sprintf("panic: %v", r)
			ch.FailStreak++
			slog.Error("feed fetch panicked; recovered", "feed", ch, "panic", r, "stack", string(debug.Stack()))
		}
	}()
	fetch()
}

// perHostConns caps how many feeds of one hostname are fetched at the same
// time. Feed sets cluster hard on a few hosts (16 nitter feeds here, every
// YouTube feed on one host), so an unbounded fan-out opens `--workers`
// simultaneous connections to a single origin at a fixed 5-minute phase —
// exactly the burst shape a datacenter-IP WAF scores as a bot. 2 keeps a
// single-host cluster politely serialized; against a 5-minute interval the
// extra wall-time is irrelevant.
const perHostConns = 2

// hostGate hands out per-hostname concurrency slots for the feed fan-out.
// Scope is the feed-level fetch only: the per-item second pass (#readability,
// #selfhost) targets article hosts and is deliberately left ungated.
//
// This bounds request *initiation*; the transport's MaxConnsPerHost only pools
// the resulting connections, which is why both exist.
type hostGate struct {
	mu    sync.Mutex
	slots map[string]chan struct{}
}

// acquire blocks until a slot for u's host is free and returns its release
// func. A URL that does not parse (or carries no host) is not gated — the
// fetch will fail on its own terms rather than be silently held up here.
func (g *hostGate) acquire(u string) func() {
	p, err := url.Parse(u)
	if err != nil || p.Hostname() == "" {
		return func() {}
	}
	host := p.Hostname()

	g.mu.Lock()
	if g.slots == nil {
		g.slots = map[string]chan struct{}{}
	}
	ch, ok := g.slots[host]
	if !ok {
		ch = make(chan struct{}, perHostConns)
		g.slots[host] = ch
	}
	g.mu.Unlock()

	ch <- struct{}{}
	return func() { <-ch }
}

// fetchedFeed pairs a fan-out feed (the read-only snapshot object the workers
// mutated) with the pre-fan-out values the locked write phase guards on: the
// URL the live store should still hold, the fetch state that must not have
// advanced underneath, and the AssetBytes baseline the upload delta is
// measured from.
type fetchedFeed struct {
	feed            *Feed
	priorURL        string
	priorState      inboxState
	priorAssetBytes int64
}

// applyFetched folds the lock-free fan-out's per-feed results onto the freshly
// (re-)loaded DB — the local sibling of applyInbox, with the same discard
// discipline (unknown feed, repointed URL) plus one guard applyInbox does not
// need: another fetch of the SAME feed may have committed between the snapshot
// and this write phase (a GUI single-feed fetch racing the interval loop —
// spooled partitions are disjoint by rule, overlapping local cycles are not).
// Its fold advanced the live fetch state, so our items were deduped against a
// superseded bg/watermark/pool and would re-ingest its articles as duplicates
// into immutable packs; discarding the whole record is the safe side, and the
// next cycle re-fetches against the winner's state. Discards are warn-only —
// onFeed/progress already reported the fan-out's counts, which may therefore
// overcount by the discarded feeds (same advisory contract as a spool).
//
// Applied records adopt the fan-out's state wholesale like applyInbox, plus
// one piece the envelope does not carry: a discovery repoint of the URL
// (guarded against the LIVE feed above, so only our own fan-out's repoint can
// land). Items are repointed at the live feed — PutArticles bumps
// TotalArt/ContentBytes on it — and returned for the batch. The AssetBytes
// delta is charged ABOVE the discard guards; see there for why.
func (db *DB) applyFetched(fetched []fetchedFeed, today uint16) []*Item {
	var articles []*Item
	for _, f := range fetched {
		snap := f.feed
		live, ok := db.core.Feeds[snap.id]
		if !ok {
			// The one discard with no live feed to charge: the bytes this
			// fan-out uploaded for a feed that has since been REMOVED stay
			// uncharged by construction. Accepted — there is no counter left
			// to hold them, and `ab` is per-feed by definition.
			slog.Warn("feed removed during the fan-out; discarding its fetch",
				"feed_id", snap.id, "url", snap.URL)
			continue
		}

		// Charge the fan-out's asset uploads BEFORE the two discard guards
		// below, because the uploads are not discardable: assets/ objects are
		// content-hash-addressed and were AtomicPut during the fan-out, so they
		// are durably in the store whether or not this record's articles land.
		// Charging only on the apply path lost them permanently — a later cycle
		// referencing the same hash gets a store-existence hit, for which
		// UploadCacheRef reports 0 bytes, so nobody ever charges them — while
		// expiration still DECREMENTS the object's size from the owner the
		// reference sidecar recorded when it eventually leaves. `ab` then drifts
		// down without bound (clamped at 0) against a store that really holds
		// the bytes.
		//
		// This is NOT exact, and the trade is deliberate. When the cycle that
		// WON the race also missed the store-existence probe and led its own Put
		// of the same bytes, both cycles charge for one object — a bounded
		// over-count of one object's size per racing pair. Against that: the old
		// behavior was an unbounded, permanent UNDER-count, and the counter is
		// never recomputed, only adjusted, so an under-count clamps to 0 and
		// hides real footprint while an over-count merely overstates it.
		//
		// RELATIVE, never absolute: the snapshot's total predates any expiration
		// a peer ran between the phases, so assigning it would resurrect the
		// released bytes (TestApplyFetchedFoldsAssetBytesRelatively).
		live.AssetBytes += snap.AssetBytes - f.priorAssetBytes

		if live.URL != f.priorURL {
			slog.Warn("feed URL repointed during the fan-out; discarding its fetch",
				"feed", live, "fetched_url", f.priorURL, "feed_url", live.URL)
			continue
		}
		if !fetchState(live).equal(f.priorState) {
			slog.Warn("another fetch advanced this feed during the fan-out; discarding this cycle's result",
				"feed", live)
			continue
		}

		live.URL = snap.URL
		live.Watermark = snap.Watermark
		live.BoundaryGUIDs = snap.BoundaryGUIDs
		live.ETag = snap.ETag
		live.LastModified = snap.LastModified
		live.FetchError = snap.FetchError
		live.LastOK = snap.LastOK
		live.FailStreak = snap.FailStreak
		live.LastNew = snap.LastNew

		for _, h := range snap.seenStamps {
			db.seen.stamp(live.id, h, today)
		}
		for _, it := range snap.newItems {
			it.Feed = live
			articles = append(articles, it)
		}
	}
	return articles
}

// feedProgress reports one feed's outcome to a runFetch caller (the SSE handler).
type feedProgress struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Error string `json:"error,omitempty"`
	New   int    `json:"new"`
}

func (o *FetchCmd) Run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Build once per Run so the transport's idle-conn pool is shared across
	// all --interval cycles.  A fresh transport per cycle would orphan
	// readLoop goroutines that keep their sockets/FDs alive until the remote
	// server closes the connection.
	client := newFetchClient(globals.Workers)
	return o.fetchLoop(ctx, client)
}

// fetchLoop runs the all-feeds fetch cycle, honoring o.Interval. With a
// positive interval it loops — one cycle, then sleep, repeat — until ctx is
// cancelled, returning nil on clean shutdown and logging (not propagating) a
// failed cycle so a transient error never tears the loop down. With a
// non-positive interval it runs a single cycle and returns its result. Shared
// by `srr art fetch --interval` and `srr serve --interval`; the supplied client
// is reused across every cycle so its idle-conn pool isn't orphaned per cycle.
func (o *FetchCmd) fetchLoop(ctx context.Context, client *http.Client) error {
	if o.Interval <= 0 {
		return runCycleSafe(func() error { return o.runFetch(ctx, client, nil) })
	}
	for {
		// The cycle runs under a DETACHED context: on SIGTERM the loop must stop
		// starting new cycles immediately (the ctx.Done() check below) but must
		// not cancel the cycle already in flight — that discards a batch already
		// fetched but not yet committed, on every graceful restart. In normal
		// operation the cycle is UNCAPPED: a legitimately long cycle (a big
		// consolidation, slow asset transcodes) must run to its commit, not be
		// guillotined at a fixed deadline and rolled back. The shutdownGrace bound
		// arms ONLY once ctx is cancelled (shutdown), so a wedged cycle can't block
		// shutdown forever; a second signal still hard-kills (NotifyContext restores
		// default handling after the first).
		cycleCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		// Read the grace HERE, not inside the callback: context.AfterFunc runs its
		// func on its own goroutine at cancellation, and stopGrace() cannot unrun
		// one already started — so reading the package var in there races anything
		// that writes it (the tests, which shrink it and restore it in Cleanup).
		// Sampling it per cycle is also the honest semantics: the bound in force is
		// the one that was configured when the cycle began.
		grace := shutdownGrace
		stopGrace := context.AfterFunc(ctx, func() { time.AfterFunc(grace, cancel) })
		err := runCycleSafe(func() error { return o.runFetch(cycleCtx, client, nil) })
		stopGrace()
		cancel()
		if err != nil {
			slog.Error("fetch iteration failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(o.Interval):
		}
	}
}

// sweepAssetCache deletes ingest-cache files unused for longer than maxAge,
// returning how many were removed. A download is consumed — uploaded to the
// store under its content-hash key — within the cycle that fetched it, and
// both cache consumers (an external ingest's own reuse check, #selfhost's URL
// cache) refresh a file's mtime when they reuse it, so anything older than the
// window is garbage: a dropped item's media, debris from an interrupted run,
// or a consumed download nothing re-references. A feed warming a big backlog
// across failing cycles keeps its files fresh through those reuse touches.
// maxAge <= 0 disables. Best-effort: unreadable entries and remove failures
// are skipped (warn), a missing dir is a quiet no-op.
func sweepAssetCache(dir string, maxAge time.Duration) int {
	if maxAge <= 0 {
		return 0
	}
	cutoff := time.Now().Add(-maxAge)
	removed := 0
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return nil
		}
		fi, err := d.Info()
		if err != nil || fi.ModTime().After(cutoff) {
			return nil
		}
		// G122 warns about symlink TOCTOU between WalkDir's stat and this Remove.
		// The tree is SRR's own ingest cache, written only by this process; WalkDir
		// does not follow symlinks and the IsRegular guard above already skips any
		// it finds, so a swap would have to be won by something that can already
		// write inside the cache dir. Rewriting the sweep on os.Root would buy
		// nothing against an attacker who is by then inside the trust boundary.
		//nolint:gosec // G122: own cache tree, symlinks already filtered
		if err := os.Remove(p); err != nil {
			slog.Warn("sweep asset cache: remove", "file", p, "err", err)
			return nil
		}
		removed++
		return nil
	})
	return removed
}

// newFetchClient builds the shared HTTP client for a fetch run.  It is called
// once per Run() invocation so the same client (and its transport's idle-conn
// pool) is reused across --interval cycles, preventing the per-cycle Transport
// leak where readLoop goroutines keep idle sockets/FDs alive until the remote
// server closes them.
//
// It is built on mod.SafeTransport so the dial-time SSRF guard screens the
// feed-fetch path: the #feed fetcher drives this client for BOTH the configured
// feed URL and the auto-discovered <link rel=alternate> target — a URL pulled
// out of fetched HTML, i.e. attacker-influenced — and the guard re-checks every
// redirect hop. It honors SRR_ALLOW_PRIVATE_FETCH (via mod.AllowPrivateFetch),
// so the flag's documented scope actually covers feed fetches. Pooling limits
// are sized to the worker count; SafeTransport's IdleConnTimeout is 90 s.
func newFetchClient(workers int) *http.Client {
	t := mod.SafeTransport()
	t.MaxIdleConnsPerHost = workers
	t.MaxConnsPerHost = workers
	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: t,
	}
}

// fetchResults carries the read-only fetch phase's outcome across the store
// scopes of runFetch: the snapshot feeds the fan-out mutated (plus their
// pre-fan-out guard records for applyFetched), and the run-scoped objects the
// locked write phase still reports on (notify, asset counters, the progress
// line, the cache dir for the post-commit sweep).
type fetchResults struct {
	feeds    []*Feed
	fetched  []fetchedFeed
	notify   *notifyState
	assets   *assetFetcher
	progress *fetchProgress
	cacheDir string
}

// checkStoreBusy is the fetch phase's advisory fail-fast probe. With the lock
// held only by the short write phase, a cycle against a store whose writer is
// alive elsewhere would otherwise burn a whole network fan-out before
// discovering the contention at commit time — so a LIVE foreign lease is
// refused up front with the same os.ErrExist contract acquireMarker answers
// (serve's 409, MCP's "store busy"). Everything else — absent, this process's
// own (the in-process storeWriter gate queues us properly), expired, legacy,
// unreadable — falls through: the write phase's real acquire stays the single
// authority, and this probe is advisory by construction (a lease may still
// appear in the gap; the write phase then answers exactly as before).
func checkStoreBusy(ctx context.Context, db *DB) error {
	if globals.Force {
		return nil
	}
	held, present, err := readLease(ctx, db.Backend, dbLockKey)
	if err != nil || !present {
		return nil
	}
	if held.Owner != "" && held.Owner != leaseOwner && !held.expired(leaseNow()) {
		return fmt.Errorf("%s is held by %s until %s: %w", dbLockKey, held.Owner, held.until(), os.ErrExist)
	}
	return nil
}

// runFetch runs one fetch cycle over every feed, invoking onFeed (if non-nil)
// once per feed as it finishes; onFeed may run from worker goroutines, so
// callers must guard it.
//
// The cycle is TWO store scopes (FET5): a read-only phase — snapshot the feed
// set, recipes and dedup view, then run the whole network fan-out (feed GETs,
// pipelines, #readability fetches, asset transcodes/uploads) with NO store
// lock held — and a short LOCKED write phase that re-loads the store, folds
// the results back per feed (applyFetched, discarding any feed the store
// advanced underneath), and runs the existing PutArticles→Commit chain. The
// lock hold drops from the whole fan-out (minutes on a slow cycle) to the
// write phase (seconds), so an operator mutation no longer 409s against a
// running cycle — and the .locked lease is stamped far inside its TTL. A
// producer (--spool) runs only the first phase: it publishes its results as
// an inbox envelope instead of folding them, and never locks at all.
func (o *FetchCmd) runFetch(ctx context.Context, client *http.Client, onFeed func(feedProgress)) error {
	res := &fetchResults{}
	// The progress line spans both phases. finish() is idempotent, so this one
	// defer covers every error return alongside commitPhase's own pre-summary
	// call; nil when the fetch phase failed before starting the line.
	defer func() {
		if res.progress != nil {
			res.progress.finish()
		}
	}()
	if err := withDBCtx(ctx, false, func(ctx context.Context, db *DB) error {
		return o.fetchPhase(ctx, db, client, onFeed, res)
	}); err != nil || o.Spool {
		return err
	}
	return withDBCtx(ctx, true, func(ctx context.Context, db *DB) error {
		return o.commitPhase(ctx, db, res)
	})
}

// fetchPhase is the read-only half of a cycle: it snapshots the feed set and
// everything the fan-out reads (recipes, the dedup pool, the store-default
// horizon), runs the network fan-out over the snapshot Feed objects, and — in
// producer mode — publishes the spool envelope and ends the cycle. It holds
// no lock: the snapshot is consistent by construction (an atomic root naming
// immutable manifests), the fan-out writes only content-hash assets (safe
// from any box, like a producer), and every per-feed mutation lands on
// snapshot objects the write phase folds back explicitly.
func (o *FetchCmd) fetchPhase(ctx context.Context, db *DB, client *http.Client, onFeed func(feedProgress), res *fetchResults) error {
	db.core.FetchedAt = time.Now().UTC().Unix()

	var spoolName string
	if o.Spool {
		var err error
		if spoolName, err = o.spoolSlot(); err != nil {
			return err
		}
		// Single-slot backpressure: an undrained previous spool means this
		// producer's read-only view of the dedup state is already one cycle
		// ahead of the store, so fetching again would re-ingest against stale
		// state. Skip the cycle entirely instead. PRESENCE is the signal, not
		// size: a spool that is present but reports 0 bytes (a store whose HEAD
		// omits Content-Length) is still undrained, and treating it as drained
		// would overwrite a cycle the consolidator has not folded in yet.
		switch _, err := db.Stat(ctx, inboxKey(spoolName)); {
		case err == nil:
			slog.Info("previous spool not yet drained; skipping cycle", "producer", spoolName)
			return nil
		case !errors.Is(err, fs.ErrNotExist):
			return fmt.Errorf("probe spool slot: %w", err)
		}
	} else if err := checkStoreBusy(ctx, db); err != nil {
		return err
	}
	// Asset uploader for the end-of-pipeline self-hosting step, shared across
	// workers (the store backend is concurrent-safe). It reads files an ingest
	// strategy left in the run's cache dir and uploads them under a
	// content-hash key — no outbound HTTP of its own.
	assets := newAssetFetcher(db.Backend, globals.MaxAssetSize, globals.AssetProcess)
	assets.peek = strings.Fields(globals.AssetPeek)
	assets.procTimeout = globals.AssetProcessTimeout
	// Run-global asset worker pool + run/shutdown ctx for the singleflight body:
	// the slot is held by the leader job only (see assetFetcher), and the body
	// is decoupled from any single feed's errgroup so one feed's cancellation
	// can't poison a follower feed sharing an asset. ctx here is the fetch ctx
	// (the errgroup parent below), so run shutdown still aborts a long transcode.
	assets.baseCtx = ctx
	assets.sem = make(chan struct{}, max(1, globals.AssetWorkers))
	// Per-worker buffers/processors and the shared ingest engine, built once
	// per command and reused by every cycle it runs (see fetchPools).
	pools := o.workerPools()

	// One asset cache dir shared by every external-ingest feed this run,
	// created once. Each external command runs with this as its working
	// directory and chooses its own file layout inside it. Creation is
	// mandatory: handing a command an empty working dir would run it in SRR's
	// own cwd (littering it, and its self-hosted files would never upload), so
	// a dir we can't create is a hard error, not a silent disable. Override
	// the location with --cache-dir/SRR_CACHE_DIR if the default is unwritable.
	// globals.CacheDir is always set (kong ${cacheDir} default + the
	// post-parse floor in main; tests set it in setupTestDB), so the shared
	// cache dir needs no fallback resolution here.
	cacheDir := globals.CacheDir
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return fmt.Errorf("create asset cache dir %q: %w", cacheDir, err)
	}
	// Stage asset-process {output} files inside the cache tree (not the OS
	// temp dir): big transcodes can't fill a tmpfs /tmp, and a crash-leaked
	// output is reclaimed by the post-cycle age sweep below.
	assets.procDir = filepath.Join(cacheDir, "_processed")

	// Run-scoped deps shared across all workers (all concurrent-safe). The
	// per-worker buf/processor are pulled from their pools inside each worker.
	run := &fetchRun{
		client:       client,
		engine:       pools.engine,
		assets:       assets,
		cacheDir:     cacheDir,
		fetchedAt:    db.core.FetchedAt,
		recipes:      db.core.Recipes,
		maxAssetSize: int(assets.maxBytes),
		// Persistent dedup pool + its store-default horizon, read-only during
		// the fan-out; the collected stamps are merged into it after g.Wait().
		seen:      db.seen,
		dedupDays: db.core.DedupDays,
	}

	// The cycle's feed set: the GUI single-feed fetch (o.only), the
	// include/exclude filter, or every feed. The filter scopes the fan-out
	// and the progress / summary counts below — a stale FetchError on an
	// unselected feed must not count as this cycle's failure.
	feeds, err := o.selectFeeds(db)
	if err != nil {
		return err
	}

	// The write phase's guard records, captured BEFORE the fan-out mutates the
	// snapshot feeds: the URL and fetch state the live store should still hold
	// when the results fold back, and the AssetBytes baseline the upload delta
	// is measured from.
	fetched := make([]fetchedFeed, len(feeds))
	for i, ch := range feeds {
		fetched[i] = fetchedFeed{
			feed:            ch,
			priorURL:        ch.URL,
			priorState:      fetchState(ch),
			priorAssetBytes: ch.AssetBytes,
		}
	}

	// Pre-fetch failure streaks, so the summary phase can spot the
	// threshold crossings and recoveries this cycle produced. nil (and inert)
	// unless a notify command is configured.
	notify := snapshotNotify(feeds)

	// Live stats on the terminal status line while the cycle runs (feeds
	// done/total, new articles, failures, asset jobs). No-op when stderr
	// isn't a tty (service/cron runs), so logs stay clean. Assigned to res
	// up front so runFetch's deferred finish covers the spool path and the
	// error returns below.
	res.progress = startFetchProgress(len(feeds), assets)

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(globals.Workers)

	// Politeness: at most perHostConns feeds of one hostname in flight,
	// whatever --workers allows overall.
	gate := &hostGate{}

	for _, ch := range feeds {
		if ctx.Err() != nil {
			break
		}
		g.Go(func() error {
			release := gate.acquire(ch.URL)
			defer release()

			buf := pools.buf.Get().(*[]byte)
			defer pools.buf.Put(buf)
			processor := pools.proc.Get().(*mod.Module)
			defer pools.proc.Put(processor)
			runFeedFetch(ch, func() { ch.Fetch(gctx, run, *buf, processor) })
			res.progress.feedDone(ch.FetchError != "", len(ch.newItems))
			if onFeed != nil {
				onFeed(feedProgress{ID: ch.id, Title: ch.Title, Error: ch.FetchError, New: len(ch.newItems)})
			}
			return nil
		})
	}
	_ = g.Wait() // workers never return an error — per-feed failures ride ch.FetchError
	// Feed fan-out done; the rest of the cycle writes packs/summaries
	// (zopfli-grade finalization can take a while on a big batch).
	res.progress.setSaving()

	// Producer mode ends here: publish the cycle as one write-once envelope
	// and touch nothing else. No packs, no summaries, no expiration, no GC —
	// all of that belongs to the lock-holding consolidator.
	if o.Spool {
		env := spoolEnvelope(spoolName, db.core.FetchedAt, feeds)
		if err := writeInbox(ctx, db.Backend, spoolName, env); err != nil {
			return err
		}
		spooled := 0
		for _, rec := range env.Feeds {
			spooled += len(rec.Items)
		}
		slog.Info("spooled fetch cycle", "producer", spoolName,
			"cycle_id", env.CycleID, "feeds", len(env.Feeds), "articles", spooled)
		return nil
	}

	res.feeds = feeds
	res.fetched = fetched
	res.notify = notify
	res.assets = assets
	res.cacheDir = cacheDir
	return nil
}

// commitPhase is the locked half of a cycle: it re-loads the store (this db
// handle is fresh — the fetch phase's snapshot may be a generation behind),
// folds the fan-out's results back per feed, and runs the batch through the
// existing PutArticles→Commit chain. Everything here is store round-trips and
// CPU; the network is behind us, so the lock hold is seconds.
func (o *FetchCmd) commitPhase(ctx context.Context, db *DB, res *fetchResults) error {
	// The write phase's OWN stamp: PutArticles stamps each article with
	// core.FetchedAt, and a peer may have committed a later batch between the
	// phases — re-stamping keeps fetched_at chron-monotone (the property
	// ExpireArticles' contiguous-prefix model and `art ls --since`'s binary
	// search need), the same reason the inbox consolidator stamps drained
	// items itself.
	db.core.FetchedAt = time.Now().UTC().Unix()

	// The seen-pool day stamp, shared by the inbox drain below and the fold's
	// own stamp merge.
	today := uint16(db.core.FetchedAt / 86400)

	// Fold in any producer spools BEFORE the batch is assembled, so drained
	// articles ride this cycle's published-sort and — crucially — its
	// fetched_at stamp, keeping fetched_at chron-monotone (see
	// docs/INBOX-SPEC.md).
	articles, drainedSlots := db.drainInbox(ctx, o.InboxProducers, today)

	// Fold the local fan-out's results onto the freshly-loaded feeds — the
	// same shape as the inbox drain above, including the per-feed dedup-stamp
	// merge (single-threaded here, like the articles aggregation).
	articles = append(articles, db.applyFetched(res.fetched, today)...)
	sort.SliceStable(articles, func(i, j int) bool {
		return articles[i].Published < articles[j].Published
	})

	// Age/cap/dead-feed eviction over the pool the folds above stamped. Runs
	// every cycle including the GUI single-feed fetch (o.only) — evict is
	// global maintenance, like ExpireArticles: it uses the full live feeds map
	// so an unfetched feed's entries are retained (they age out over the
	// horizon), while stamps come only from feeds fetched this cycle. SyncSeen
	// (before Commit, below) persists it; the pool's dirty flag skips the
	// write on an idle cycle that changed nothing.
	db.seen.evict(today, func(fid int) int {
		return db.core.Feeds[fid].dedupDays(db.core.DedupDays)
	}, seenFeedCap, db.core.Feeds)

	written, err := db.PutArticles(ctx, articles)
	if err != nil {
		return err
	}
	// Warn-only: the batch is already durable in L<Seq+1>, so a failed
	// ~1KB summary write must not discard it. HdrPacks stays behind,
	// readers fall back to eager idx loading, and the next run retries
	// the rebuild. Runs unconditionally (zero-article runs included) so a
	// pre-summary store migrates on its first fetch cycle.
	if err := db.SyncIdxSummary(ctx); err != nil {
		slog.Warn("sync idx summary", "error", err)
	}
	// Same warn-only contract: the meta series is a derived index, so a
	// failed sync must not discard the durable batch. Coverage fields stay
	// behind, readers keep search disabled (or miss only the newest tail),
	// and the next run reconciles. PutArticles' return lets the common
	// cycle build its entries from memory instead of re-reading the packs
	// just written.
	if err := db.SyncMeta(ctx, written); err != nil {
		slog.Warn("sync meta", "error", err)
	}
	// The keyword-watchlist bitmaps (watch.go) are a derived projection over the
	// same chrons and take the same warn-only contract for the same reason. Its
	// self-heal is exact rather than approximate: WatchCovered advances only on
	// success, so a failed run leaves a gap the next run re-evaluates precisely
	// — from this batch when it still covers it, from the packs when it does
	// not. A store with no watch rules returns immediately and writes nothing.
	if err := db.SyncWatch(ctx, written); err != nil {
		slog.Warn("sync watch bitmaps", "error", err)
	}
	// Warn-only: retention is maintenance — a failed walk or asset delete
	// must not block committing the durable article batch. ExpireArticles
	// applies nothing on failure, so the next cycle recomputes the same
	// window and retries idempotently (Rm is silent on missing). The
	// AddIdx/Expired bumps it does apply ride this cycle's Commit; runs
	// before the out-feed sync so the same cycle's syndication already
	// excludes what just expired. Expiration deliberately runs on every
	// cycle including the GUI's single-feed fetch (o.only) — it's global
	// maintenance, like SyncIdxSummary/SyncMeta.
	if err := db.ExpireArticles(ctx, db.core.FetchedAt); err != nil {
		slog.Warn("expire articles", "error", err)
	}
	// Warn-only: a syndication write failure must not discard the durable
	// article batch. SyncOutFeeds is a no-op when core.Out is empty (the
	// default) or SRR_CDN_URL is unset (degrades with a warning). Skip the
	// store walk on a truly-idle cycle — no new articles AND unchanged
	// syndication inputs (out config + feed tags/AddIdx) since the last
	// sync — so the --interval loop doesn't rewrite byte-identical out/*
	// every cycle, while still materializing config/tag edits made during
	// the lock-free idle sleep and this cycle's expiration bumps (gating on
	// len(written) alone would skip those — a stale-output bug).
	sig := db.outFeedsSig()
	if len(written) > 0 || sig != o.lastOutSig {
		if err := db.SyncOutFeeds(ctx); err != nil {
			// Leave lastOutSig unadvanced so the next cycle retries the failed
			// output(s), rather than skipping until the signature next changes.
			slog.Warn("sync out feeds", "error", err)
		} else {
			o.lastOutSig = sig
		}
	}
	// Persist the dedup pool (pool + bg) to the inactive seen slot and flip
	// SeenFlag BEFORE the commit, so db.gz publishes the article batch and the
	// pointer to its matching dedup state atomically. Fatal to the cycle on
	// failure: bg is load-bearing, so a committed batch must never outrun the
	// slot that dedups its GUIDs. Idle cycles write nothing (write-if-dirty).
	if err := db.SyncSeen(ctx); err != nil {
		return fmt.Errorf("sync seen pool: %w", err)
	}
	// Same contract for the asset refcount sidecar, and the same reason it is
	// fatal rather than warn-only: the batch and the reference counts that
	// describe it must become durable by ONE root flip, or a committed article
	// leaves its assets undercounted and a later expiry deletes an object a live
	// article still shows. Written after ExpireArticles so this cycle's releases
	// ride the same object as its additions; write-if-dirty, so an idle cycle
	// writes nothing and mints no generation.
	if err := db.SyncRefs(ctx); err != nil {
		return fmt.Errorf("sync asset refcounts: %w", err)
	}
	// ONE GC rule (docs/MANIFEST-SPEC.md §7): delete what the last K
	// manifests do not name. It replaces the four per-feature sweeps and
	// their window formulas the cutover retired. Runs BEFORE the Commit, so
	// the low-water advance rides this cycle's own root flip instead of
	// forcing a second commit; everything it deletes is already superseded
	// and referenced by nothing. Warn-only, idempotent (Rm is silent on
	// missing), and a missed run resumes from the low-water rather than
	// stranding anything.
	if err := db.GC(ctx, globals.KeepManifests); err != nil {
		slog.Warn("gc", "error", err)
	}
	if err := db.Commit(ctx); err != nil {
		return err
	}
	gcCtx := context.WithoutCancel(ctx)
	// The drained watermark is durable now, so the slots can go. Warn-only
	// and idempotent: a slot that survives is SKIPPED (never re-applied) next
	// cycle by the watermark check, and reaped then.
	reapInbox(gcCtx, db.Backend, drainedSlots)

	// The ingest cache is self-maintaining: a download is consumed (uploaded
	// to the store under its content-hash key) within the cycle that fetched
	// it, so files unused past the age window are garbage — dropped items'
	// media, interrupted-run debris, consumed downloads nothing re-references.
	// Swept only after a successful Commit; both cache consumers refresh a
	// file's mtime on reuse, so a warming retry never loses its cache.
	if n := sweepAssetCache(res.cacheDir, globals.CacheMaxAge); n > 0 {
		slog.Info("asset cache swept", "removed", n)
	}

	// Aggregate asset-pipeline health: each peek/process failure and each
	// declined corrupt asset already warned per asset, but a systemic cause
	// (webify missing from the service PATH, a broken transcoder) drowns in
	// per-asset noise while every asset silently degrades to an unprocessed
	// original — surface it once per cycle, loudly.
	if pf := res.assets.procFailed.Load(); pf > 0 {
		slog.Warn("asset processing degraded this cycle — check the asset-peek/asset-process commands (PATH?)",
			"failed_commands", pf, "asset_jobs", res.assets.done.Load())
	}
	if c := res.assets.corrupt.Load(); c > 0 {
		slog.Warn("corrupt media assets declined this cycle (published without media)", "count", c)
	}

	// Failure counting stays on the SNAPSHOT feeds — the fan-out's outcome is
	// what this cycle did, whether or not every record survived the fold.
	failed := 0
	for _, ch := range res.feeds {
		if ch.FetchError != "" {
			failed++
		}
	}
	res.progress.finish()
	slog.Info("fetch complete",
		"new_articles", len(articles),
		"fetched", len(res.feeds)-failed,
		"failed", failed,
	)
	// Alert on the outages/recoveries this cycle produced. Last, after the
	// batch is durable: an operator's notify command must never be able to
	// affect what got stored. WithoutCancel so a shutdown mid-summary still
	// delivers the alert the cycle already decided to send.
	res.notify.fire(context.WithoutCancel(ctx), res.feeds)
	return nil
}
