package main

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"srrb/mod"
)

// PipeCmd sets (or prints) the db.gz root pipe — the default pipeline
// inherited by feeds whose Pipe field is nil.
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
		pipe := filterPipe(o.Pipe)
		// allowBase=false: #base only means something inside a feed override.
		if err := validatePipe(pipe, false); err != nil {
			return err
		}
		db.core.Pipe = pipe
		return db.Commit(ctx)
	})
}

// filterPipe trims each step and drops empty/whitespace-only entries. Returns
// nil when the result is empty so callers can use that as the CLI sentinel for
// "clear / revert to inherit". Trimming matters: a whitespace-only step (e.g.
// `-p " "`) would otherwise be stored and later run as an empty `/bin/sh -c`,
// silently breaking the feed's fetch.
func filterPipe(in []string) []string {
	out := make([]string, 0, len(in))
	for _, m := range in {
		if m = strings.TrimSpace(m); m != "" {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// validatePipe rejects pipeline steps that would silently break a fetch: an
// unknown "#"-prefixed token (a typo'd built-in like "#sanitise"). "#base" is
// valid only inside a feed override (allowBase), never the root pipe.
// Known built-ins and shell commands pass. Run after filterPipe.
func validatePipe(steps []string, allowBase bool) error {
	names := mod.Builtins()
	for _, s := range steps {
		fields := strings.Fields(s)
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if name == pipeBase {
			if !allowBase {
				return fmt.Errorf("%q is only valid inside a feed pipe override, not the root pipe", pipeBase)
			}
			continue
		}
		if strings.HasPrefix(name, "#") && !slices.Contains(names, name) {
			return fmt.Errorf("unknown built-in module %q (known: %s)", name, strings.Join(names, ", "))
		}
	}
	return nil
}
