package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
)

type ClearCacheCmd struct {
	All bool `help:"Also bump version in db.gz so deployed readers invalidate their caches."`
}

func (o *ClearCacheCmd) Run() error {
	if globals.Cache != "" {
		if err := os.RemoveAll(globals.Cache); err != nil {
			return fmt.Errorf("removing %s: %w", globals.Cache, err)
		}
		slog.Info("local cache cleared", "path", globals.Cache)
	} else {
		slog.Info("no local cache configured")
	}

	if !o.All {
		return nil
	}

	ctx := context.Background()
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	db.core.Version++
	if err := db.Commit(ctx); err != nil {
		return fmt.Errorf("commit db.gz: %w", err)
	}
	slog.Info("cache version bumped", "version", db.core.Version)
	return nil
}
