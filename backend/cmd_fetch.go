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

		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(globals.Workers)

		for _, s := range db.Subscriptions() {
			if ctx.Err() != nil {
				break
			}
			g.Go(func() error {
				buf := bufPool.Get().([]byte)
				defer bufPool.Put(buf)
				processor := procPool.Get().(*mod.Module)
				defer procPool.Put(processor)
				s.Fetch(gctx, client, buf, processor, db.core.FetchedAt)
				return nil
			})
		}
		g.Wait()

		total := 0
		for _, s := range db.Subscriptions() {
			total += len(s.newItems)
		}
		articles := make([]*Item, 0, total)
		for _, s := range db.Subscriptions() {
			articles = append(articles, s.newItems...)
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

		var failed, totalSrc int
		for _, s := range db.Subscriptions() {
			for _, src := range s.Sources {
				totalSrc++
				if src.FetchError != "" {
					failed++
				}
			}
		}
		slog.Info("fetch complete",
			"new_articles", len(articles),
			"fetched", totalSrc-failed,
			"failed", failed,
		)
		return nil
	})
}
