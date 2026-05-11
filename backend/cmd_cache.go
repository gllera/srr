package main

import (
	"fmt"
	"log/slog"
	"os"
)

type ClearCacheCmd struct{}

func (o *ClearCacheCmd) Run() error {
	if globals.Cache == "" {
		return fmt.Errorf("no cache directory configured (set --cache or SRR_CACHE)")
	}
	if err := os.RemoveAll(globals.Cache); err != nil {
		return fmt.Errorf("removing %s: %w", globals.Cache, err)
	}
	slog.Info("local cache cleared", "path", globals.Cache)
	return nil
}
