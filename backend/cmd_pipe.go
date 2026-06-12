package main

import "context"

// PipeCmd sets (or prints) the db.gz root pipe — the default pipeline
// inherited by channels whose Pipe field is nil.
// No args → print current. "" alone → clear. Otherwise → set.
// One positional arg per pipeline step (sep:none → never comma-split, so a
// step may contain commas, e.g. inside a module parameter value).
type PipeCmd struct {
	Pipe []string `arg:"" optional:"" sep:"none" help:"Root pipe; one arg per step (omit to print current; use \"\" alone to clear)."`
}

func (o *PipeCmd) Run() error {
	return withDB(len(o.Pipe) > 0, func(ctx context.Context, db *DB) error {
		if len(o.Pipe) == 0 {
			return printJSON(db.core.Pipe)
		}
		db.core.Pipe = filterPipe(o.Pipe)
		return db.Commit(ctx)
	})
}

// filterPipe drops empty entries. Returns nil when the result is empty so
// callers can use that as the CLI sentinel for "clear / revert to inherit".
func filterPipe(in []string) []string {
	out := make([]string, 0, len(in))
	for _, m := range in {
		if m != "" {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
