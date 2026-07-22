package main

import (
	"context"
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
		stopGrace := context.AfterFunc(ctx, func() { time.AfterFunc(shutdownGrace, cancel) })
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

// runFetch runs one fetch cycle over every feed, invoking onFeed (if non-nil)
// once per feed as it finishes; onFeed may run from worker goroutines, so
// callers must guard it.
func (o *FetchCmd) runFetch(ctx context.Context, client *http.Client, onFeed func(feedProgress)) error {
	// A producer opens the store read-only and takes NO lock: it writes exactly
	// one object (its own spool slot) plus content-hash assets, both safe from
	// any box. Only the consolidator writes packs.
	return withDBCtx(ctx, !o.Spool, func(ctx context.Context, db *DB) error {
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
			// state. Skip the cycle entirely instead.
			size, err := db.Stat(ctx, inboxKey(spoolName))
			if err != nil {
				return fmt.Errorf("probe spool slot: %w", err)
			}
			if size > 0 {
				slog.Info("previous spool not yet drained; skipping cycle", "producer", spoolName)
				return nil
			}
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
		bufPool := sync.Pool{
			// Pointer-like pool payload (SA6002): a bare slice header would be
			// boxed into a fresh interface allocation on every Put.
			New: func() any {
				buf := make([]byte, globals.MaxFeedSize*(1<<10)+1)
				return &buf
			},
		}
		// Per-worker module processors: built-in processors hold mutable state
		// (minify reuses internal buffers and is not goroutine-safe), so a single
		// shared *mod.Module across workers is unsafe. Workers also amortize their
		// own bluemonday/minify allocations across the items they process.
		procPool := sync.Pool{
			New: func() any { return mod.New() },
		}
		// Built-in FetchFuncs are concurrent-safe (HTTP built-ins are stateless;
		// external shell fetchers spawn per-call subprocesses), so one
		// *ingest.Fetcher is shared across workers.
		engine := ingest.New()

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
			engine:       engine,
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

		// Pre-fetch failure streaks, so the summary phase can spot the
		// threshold crossings and recoveries this cycle produced. nil (and inert)
		// unless a notify command is configured.
		notify := snapshotNotify(feeds)

		// Live stats on the terminal status line while the cycle runs (feeds
		// done/total, new articles, failures, asset jobs). No-op when stderr
		// isn't a tty (service/cron runs), so logs stay clean.
		progress := startFetchProgress(len(feeds), assets)
		defer progress.finish()

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

				buf := bufPool.Get().(*[]byte)
				defer bufPool.Put(buf)
				processor := procPool.Get().(*mod.Module)
				defer procPool.Put(processor)
				runFeedFetch(ch, func() { ch.Fetch(gctx, run, *buf, processor) })
				progress.feedDone(ch.FetchError != "", len(ch.newItems))
				if onFeed != nil {
					onFeed(feedProgress{ID: ch.id, Title: ch.Title, Error: ch.FetchError, New: len(ch.newItems)})
				}
				return nil
			})
		}
		_ = g.Wait() // workers never return an error — per-feed failures ride ch.FetchError
		// Feed fan-out done; the rest of the cycle writes packs/summaries
		// (zopfli-grade finalization can take a while on a big batch).
		progress.setSaving()

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

		// The seen-pool day stamp, shared by the inbox drain below and this
		// cycle's own stamp merge further down.
		today := uint16(db.core.FetchedAt / 86400)

		// Fold in any producer spools BEFORE the batch is assembled, so drained
		// articles ride this cycle's published-sort and — crucially — its
		// fetched_at stamp, keeping fetched_at chron-monotone (see
		// docs/INBOX-SPEC.md).
		articles, drainedSlots := db.drainInbox(ctx, o.InboxProducers, today)

		for _, ch := range feeds {
			articles = append(articles, ch.newItems...)
		}
		sort.SliceStable(articles, func(i, j int) bool {
			return articles[i].Published < articles[j].Published
		})

		// Merge the persistent-dedup stamps each fetched feed buffered during the
		// (lock-free) fan-out into the pool, single-threaded like the articles
		// aggregation above, then apply the age/cap/dead-feed eviction. Runs every
		// cycle including the GUI single-feed fetch (o.only) — evict is global
		// maintenance, like ExpireArticles: it uses the full live feeds map so an
		// unfetched feed's entries are retained (they age out over the horizon),
		// while stamps come only from feeds fetched this cycle. SyncSeen (before
		// Commit, below) persists it; the pool's dirty flag skips the write on an
		// idle cycle that changed nothing.
		for _, ch := range feeds {
			for _, h := range ch.seenStamps {
				db.seen.stamp(ch.id, h, today)
			}
		}
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
		if n := sweepAssetCache(cacheDir, globals.CacheMaxAge); n > 0 {
			slog.Info("asset cache swept", "removed", n)
		}

		// Aggregate asset-pipeline health: each peek/process failure and each
		// declined corrupt asset already warned per asset, but a systemic cause
		// (webify missing from the service PATH, a broken transcoder) drowns in
		// per-asset noise while every asset silently degrades to an unprocessed
		// original — surface it once per cycle, loudly.
		if pf := assets.procFailed.Load(); pf > 0 {
			slog.Warn("asset processing degraded this cycle — check the asset-peek/asset-process commands (PATH?)",
				"failed_commands", pf, "asset_jobs", assets.done.Load())
		}
		if c := assets.corrupt.Load(); c > 0 {
			slog.Warn("corrupt media assets declined this cycle (published without media)", "count", c)
		}

		failed := 0
		for _, ch := range feeds {
			if ch.FetchError != "" {
				failed++
			}
		}
		totalFeeds := len(feeds)
		progress.finish()
		slog.Info("fetch complete",
			"new_articles", len(articles),
			"fetched", totalFeeds-failed,
			"failed", failed,
		)
		// Alert on the outages/recoveries this cycle produced. Last, after the
		// batch is durable: an operator's notify command must never be able to
		// affect what got stored. WithoutCancel so a shutdown mid-summary still
		// delivers the alert the cycle already decided to send.
		notify.fire(context.WithoutCancel(ctx), feeds)
		return nil
	})
}
