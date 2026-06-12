package main

import (
	"context"
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
		// Dedicated client for asset downloads: a longer timeout than the 10s
		// feed client, suited to large media (video). The asset fetcher is
		// shared across workers (its client + the store backend are
		// concurrent-safe). SSRF-guarded transport: media URLs come from
		// attacker-controlled feed content, so dials to private/loopback/
		// link-local addresses are refused (override with SRR_ALLOW_PRIVATE_FETCH).
		mediaTransport := mod.SafeTransport()
		mediaTransport.MaxIdleConnsPerHost = globals.Workers
		mediaTransport.MaxConnsPerHost = globals.Workers
		mediaClient := &http.Client{
			Timeout:   5 * time.Minute,
			Transport: mediaTransport,
		}
		assets := newAssetFetcher(db.Backend, mediaClient, globals.MaxMediaSize)
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
			New: func() any { return mod.New(assets) },
		}
		// Built-in FetchFuncs are concurrent-safe (HTTP built-ins are stateless;
		// external shell fetchers spawn per-call subprocesses), so one
		// *ingest.Fetcher is shared across workers. Close releases any resources
		// held by stateful built-ins (a no-op for the shipped ones).
		engine := ingest.New(ingest.Deps{})
		defer engine.Close()

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
				ch.Fetch(gctx, client, buf, processor, engine, db.core.FetchedAt, db.core.Pipe, db.core.Ingest)
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
		if err := db.Commit(ctx); err != nil {
			return err
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
