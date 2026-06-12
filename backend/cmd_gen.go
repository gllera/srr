package main

import "context"

// GenCmd prints (or bumps) the db.gz store generation — the value the
// frontend service worker compares to decide whether its cache-first
// finalized-pack cache is stale. Bump after an in-place store rebuild
// (a normal fetch only appends, so it never needs one).
type GenCmd struct {
	Bump bool `short:"b" help:"Increment the store generation and commit (otherwise print)."`
}

func (o *GenCmd) Run() error {
	return withDB(o.Bump, func(ctx context.Context, db *DB) error {
		if !o.Bump {
			return printJSON(db.core.Gen)
		}
		db.BumpGen()
		return db.Commit(ctx)
	})
}
