package main

import (
	"context"
	"fmt"
)

// GenCmd prints (or bumps) the db.gz store generation — the value the
// frontend service worker compares to decide whether its cache-first
// finalized-pack cache is stale. Bump after an in-place store rebuild
// (a normal fetch only appends, so it never needs one).
type GenCmd struct {
	Bump   bool `short:"b" help:"Increment the store generation and commit (otherwise print)."`
	DryRun bool `short:"n" name:"dry-run" help:"With --bump: print the resulting generation and the CDN-purge consequence without committing."`
}

func (o *GenCmd) Run() error {
	// A bump is irreversible in the sense that matters: every reader purges its
	// pack cache, and the edge keeps serving the OLD bytes of every reused
	// finalized name for up to a year unless the operator purges the CDN. The
	// dry run states that BEFORE the commit rather than as a post-hoc warning,
	// and takes no write lock.
	locked := o.Bump && !o.DryRun
	return withDB(locked, func(ctx context.Context, db *DB) error {
		if !o.Bump {
			return printJSON(db.core.Gen)
		}
		if o.DryRun {
			fmt.Fprintf(stdout, "gen %d -> %d\n", db.core.Gen, db.core.Gen+1)
			fmt.Fprintf(stdout, "  resets: hdrs, mp, mt (the next fetch rebuilds the idx/meta summaries)\n")
			fmt.Fprintf(stdout, "  after committing you MUST purge the CDN cache for this store — finalized pack names are reused with new bytes and the edge caches them for a year\n")
			fmt.Fprintln(stdout, "(dry run — nothing was committed)")
			return nil
		}
		db.BumpGen()
		return db.Commit(ctx)
	})
}
