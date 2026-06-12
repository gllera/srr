package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"sync"
	"syscall"
	"time"

	"srrb/ingest"
	"srrb/mod"

	"golang.org/x/sync/errgroup"
)

type FetchCmd struct {
	Interval time.Duration `help:"Run fetch in a loop with this interval." default:"0" env:"SRR_FETCH_INTERVAL"`
}

func (o *FetchCmd) Run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if o.Interval > 0 {
		for {
			if err := o.fetch(ctx); err != nil {
				slog.Error("fetch iteration failed", "err", err)
			}
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(o.Interval):
			}
		}
	}
	return o.fetch(ctx)
}

func (o *FetchCmd) fetch(ctx context.Context) error {
	return withDBCtx(ctx, true, func(ctx context.Context, db *DB) error {
		db.core.FetchedAt = time.Now().UTC().Unix()

		client := &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: globals.Workers,
				MaxConnsPerHost:     globals.Workers,
			},
		}
		// Asset uploader for the end-of-pipeline self-hosting step, shared across
		// workers (the store backend is concurrent-safe). It reads files an ingest
		// strategy left in the run's cache dir and uploads them under a
		// content-hash key — no outbound HTTP of its own.
		assets := newAssetFetcher(db.Backend, globals.MaxMediaSize)
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
		run := &fetchRun{
			client:     client,
			engine:     engine,
			assets:     assets,
			cacheDir:   cacheDir,
			fetchedAt:  db.core.FetchedAt,
			rootPipe:   db.core.Pipe,
			rootIngest: db.core.Ingest,
		}

		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(globals.Workers)

		for _, ch := range db.Channels() {
			if ctx.Err() != nil {
				break
			}
			g.Go(func() error {
				buf := bufPool.Get().([]byte)
				defer bufPool.Put(buf)
				processor := procPool.Get().(*mod.Module)
				defer procPool.Put(processor)
				ch.Fetch(gctx, run, buf, processor)
				return nil
			})
		}
		g.Wait()

		var articles []*Item
		for _, ch := range db.Channels() {
			articles = append(articles, ch.newItems...)
		}
		sort.SliceStable(articles, func(i, j int) bool {
			return articles[i].Published < articles[j].Published
		})

		if err := db.PutArticles(ctx, articles); err != nil {
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
		if err := db.Commit(ctx); err != nil {
			return err
		}
		// Drop latest-pack generations older than the grace window. Articles
		// are already durable, so failure here is log-only; WithoutCancel
		// keeps a shutdown signal from widening the leak window (anything
		// missed is swept by a later run regardless).
		if err := db.GCLatest(context.WithoutCancel(ctx), latestKeep); err != nil {
			slog.Warn("gc latest packs", "error", err)
		}
		if err := db.GCSummaries(context.WithoutCancel(ctx), latestKeep); err != nil {
			slog.Warn("gc idx summaries", "error", err)
		}

		var failed, totalFeeds int
		for _, ch := range db.Channels() {
			for _, feed := range ch.Feeds {
				totalFeeds++
				if feed.FetchError != "" {
					failed++
				}
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
