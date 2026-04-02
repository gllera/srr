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
)

type FetchCmd struct {
}

func (o *FetchCmd) Run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

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

	ch := make(chan *Subscription, globals.Workers)
	var wg sync.WaitGroup

	for range globals.Workers {
		wg.Go(func() {
			buffer := make([]byte, globals.MaxFeedSize*(1<<10)+1)

			for s := range ch {
				s.FetchError = ""
				if err := s.Fetch(ctx, client, buffer, processor); err != nil {
					s.FetchError = err.Error()
					s.newItems = nil
					slog.Error("fetch failed", "sub", s, "err", err)
				}
			}
		})
	}

loop:
	for _, s := range db.Subscriptions() {
		select {
		case ch <- s:
		case <-ctx.Done():
			break loop
		}
	}
	close(ch)
	wg.Wait()

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

	slog.Info("fetch complete", "new_articles", db.core.TotalArticles-db.core.oTotalArticles)
	return nil
}
