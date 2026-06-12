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
		db.core.Gen++
		// An in-place rebuild reuses finalized idx pack names with new bytes,
		// so the published summary's copied headers may be stale too. Reset
		// so the next fetch rebuilds idx/h<N>.gz; readers fall back to eager
		// idx loading in the gap.
		db.core.HdrPacks = 0
		return db.Commit(ctx)
	})
}
