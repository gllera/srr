package main

import "context"

// IngestCmd sets (or prints) the db.gz root Ingest — the default ingest
// strategy inherited by channels whose Ingest field is empty.
// No args → print current. "" alone → clear. Otherwise → set.
type IngestCmd struct {
	Ingest *string `arg:"" optional:"" help:"Root ingest strategy to set (omit to print current; use \"\" alone to clear)."`
}

func (o *IngestCmd) Run() error {
	return withDB(o.Ingest != nil, func(ctx context.Context, db *DB) error {
		if o.Ingest == nil {
			return printJSON(db.core.Ingest)
		}
		db.core.Ingest = *o.Ingest
		return db.Commit(ctx)
	})
}
