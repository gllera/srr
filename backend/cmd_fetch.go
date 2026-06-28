package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"srrb/ingest"
	"srrb/mod"

	"golang.org/x/sync/errgroup"
)

type FetchCmd struct {
	Interval time.Duration `help:"Run fetch in a loop with this interval." default:"0" env:"SRR_FETCH_INTERVAL"`

	// lastOutSig is the syndication-input signature (db.outFeedsSig) at the last
	// SyncOutFeeds call, carried across --interval cycles so an idle cycle whose
	// out config + feed tags are unchanged can skip the redundant store walk.
	lastOutSig string
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
		return o.runFetch(ctx, client, nil)
	}
	for {
		if err := o.runFetch(ctx, client, nil); err != nil {
			slog.Error("fetch iteration failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(o.Interval):
		}
	}
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
	return withDBCtx(ctx, true, func(ctx context.Context, db *DB) error {
		db.core.FetchedAt = time.Now().UTC().Unix()
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
			New: func() any {
				return make([]byte, globals.MaxFeedSize*(1<<10)+1)
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
		cacheDir := assetCacheRoot()
		if err := os.MkdirAll(cacheDir, 0o700); err != nil {
			return fmt.Errorf("create asset cache dir %q: %w", cacheDir, err)
		}

		// Run-scoped deps shared across all workers (all concurrent-safe). The
		// per-worker buf/processor are pulled from their pools inside each worker.
		run := newFetchRun(client, engine, assets, cacheDir, db.core.FetchedAt, db.core.Recipes)

		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(globals.Workers)

		for _, ch := range db.Feeds() {
			if ctx.Err() != nil {
				break
			}
			g.Go(func() error {
				buf := bufPool.Get().([]byte)
				defer bufPool.Put(buf)
				processor := procPool.Get().(*mod.Module)
				defer procPool.Put(processor)
				ch.Fetch(gctx, run, buf, processor)
				if onFeed != nil {
					onFeed(feedProgress{ID: ch.id, Title: ch.Title, Error: ch.FetchError, New: len(ch.newItems)})
				}
				return nil
			})
		}
		g.Wait()

		var articles []*Item
		for _, ch := range db.Feeds() {
			articles = append(articles, ch.newItems...)
		}
		sort.SliceStable(articles, func(i, j int) bool {
			return articles[i].Published < articles[j].Published
		})

		// Snapshot the GC-relevant counters: each sweep below runs only when
		// its counter advanced this run. Most cycles fetch nothing new, and an
		// unconditional sweep would re-delete the same already-gone window
		// every interval (≈20 no-op store round trips + warn lines per cycle).
		prevSeq, prevHdrs, prevMeta := db.core.Seq, db.core.HdrPacks, db.core.MetaPacks

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
		// Warn-only: a syndication write failure must not discard the durable
		// article batch. SyncOutFeeds is a no-op when core.Out is empty (the
		// default) or SRR_CDN_URL is unset (degrades with a warning). Skip the
		// store walk on a truly-idle cycle — no new articles AND unchanged
		// syndication inputs (out config + feed tags) since the last sync — so the
		// --interval loop doesn't rewrite byte-identical out/* every cycle, while
		// still materializing config/tag edits made during the lock-free idle
		// sleep (gating on len(written) alone would skip those — a stale-output bug).
		sig := db.outFeedsSig()
		if len(written) > 0 || sig != o.lastOutSig {
			if err := db.SyncOutFeeds(ctx); err != nil {
				slog.Warn("sync out feeds", "error", err)
			}
			o.lastOutSig = sig
		}
		if err := db.Commit(ctx); err != nil {
			return err
		}
		// Drop latest-pack generations older than the grace window, but only
		// when the counter advanced this run — a crash-leaked name is still
		// swept by the next advancing run (the sweep window is wider than a
		// single advance), which is the same "anything missed is swept by a
		// later run" guarantee. Articles are already durable, so failure here
		// is log-only; WithoutCancel keeps a shutdown signal from widening
		// the leak window.
		for _, gc := range []struct {
			advanced bool
			msg      string
			fn       func(context.Context, int) error
		}{
			{db.core.Seq != prevSeq, "gc latest packs", db.GCLatest},
			{db.core.HdrPacks != prevHdrs, "gc idx summaries", db.GCSummaries},
			{db.core.MetaPacks != prevMeta, "gc meta summaries", db.GCMetaSummaries},
		} {
			if !gc.advanced {
				continue
			}
			if err := gc.fn(context.WithoutCancel(ctx), latestKeep); err != nil {
				slog.Warn(gc.msg, "error", err)
			}
		}

		var failed, totalFeeds int
		for _, ch := range db.Feeds() {
			totalFeeds++
			if ch.FetchError != "" {
				failed++
			}
		}
		slog.Info("fetch complete",
			"new_articles", len(articles),
			"fetched", totalFeeds-failed,
			"failed", failed,
		)
		return nil
	})
}
