package main

import (
	"context"
	"fmt"
)

// DedupCmd prints or sets the store-wide default seen.gz dedup horizon
// (db.gz DBCore.DedupDays) — the fallback for feeds whose own DedupDays is 0.
// A per-feed -1 (feed add/upd --dedup-days -1) disables the pool for that feed;
// the store default has NO off switch, so it must stay >= 0 (0 resets to the
// built-in defaultDedupDays).
type DedupCmd struct {
	Days *int `name:"days" help:"Set the store-wide default dedup horizon in days (0 resets to the built-in default). Omit to print the current default."`
}

func (o *DedupCmd) Run() error {
	if o.Days == nil {
		return withDB(false, func(_ context.Context, db *DB) error {
			eff := db.core.DedupDays
			if eff <= 0 {
				eff = defaultDedupDays
			}
			return printJSON(eff)
		})
	}
	d := *o.Days
	if d < 0 || d > 36500 {
		return fmt.Errorf("store default dedup days must be in [0, 36500] (got %d); a per-feed -1 disables the pool, the store default cannot", d)
	}
	return withDB(true, func(ctx context.Context, db *DB) error {
		db.core.DedupDays = d
		return db.Commit(ctx)
	})
}
