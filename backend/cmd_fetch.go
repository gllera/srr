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
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)
	db.core.FetchedAt = time.Now().UTC().Unix()

	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			MaxIdleConnsPerHost: globals.Workers,
			MaxConnsPerHost:     globals.Workers,
		},
	}
	processor := mod.New()

	bufPool := sync.Pool{
		New: func() any {
			return make([]byte, globals.MaxFeedSize*(1<<10)+1)
		},
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
			s.FetchError = ""
			if err := s.Fetch(gctx, client, buf, processor); err != nil {
				s.FetchError = err.Error()
				s.newItems = nil
				slog.Error("fetch failed", "sub", s, "err", err)
			}
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

	if err = db.PutArticles(ctx, articles); err != nil {
		return err
	}

	if err = db.UpdateTS(ctx); err != nil {
		return err
	}

	if err = db.Commit(ctx); err != nil {
		return err
	}

	var failed int
	for _, s := range db.Subscriptions() {
		if s.FetchError != "" {
			failed++
		}
	}
	slog.Info("fetch complete",
		"new_articles", db.core.TotalArticles-db.snapshot.totalArticles,
		"fetched", len(db.Subscriptions())-failed,
		"failed", failed,
	)
	return nil
}
