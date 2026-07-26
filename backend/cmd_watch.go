package main

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"

	"srr/mod"
)

// `srr watch` — the keyword-watchlist verbs (finding FMT5, watch.go).
//
// Shaped exactly like `srr recipe` and `srr syndicate`: ls / show / set (upsert,
// full replace) / rm, every mutation a single locked withDB + Commit. That is
// not cosmetic — it is what makes the rule and its coverage floor become
// durable by ONE root flip, so a rule can never exist without the manifest
// saying where its lane starts.
type WatchGroup struct {
	Ls   WatchLsCmd   `cmd:"" help:"List the keyword watch rules and where each lane starts."`
	Show WatchShowCmd `cmd:"" help:"Print one watch rule."`
	Set  WatchSetCmd  `cmd:"" help:"Add or replace a watch rule (its lane starts at the store's current article count)."`
	Rm   WatchRmCmd   `cmd:"" help:"Remove a watch rule."`
}

// watchView is the flat record ls/show print: the operator's spec plus the
// server-owned coverage floor (read-only — `from` is stamped by set and never
// applied back).
type watchView struct {
	Name  string `json:"name" yaml:"name"`
	Match string `json:"match" yaml:"match"`
	From  int    `json:"from" yaml:"from"`
}

func watchViews(c *DBCore) []watchView {
	out := make([]watchView, 0, len(c.Watch))
	for _, name := range slices.Sorted(maps.Keys(c.Watch)) {
		out = append(out, watchView{Name: name, Match: c.Watch[name], From: c.WatchFrom[name]})
	}
	return out
}

// WatchLsCmd prints every rule. Same -f contract as `feed ls` / `recipe ls`.
type WatchLsCmd struct {
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *WatchLsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		return printFormatted(o.Format, watchViews(&db.core))
	})
}

// WatchShowCmd prints one rule; errors if it does not exist.
type WatchShowCmd struct {
	Name   string `arg:"" help:"Watch rule name."`
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *WatchShowCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		spec, ok := db.core.Watch[o.Name]
		if !ok {
			return fmt.Errorf("watch rule %q not found", o.Name)
		}
		return printFormatted(o.Format, watchView{Name: o.Name, Match: spec, From: db.core.WatchFrom[o.Name]})
	})
}

// WatchSetCmd upserts a rule. The match specification is the remaining
// positional arguments joined with spaces, so both of these work and mean the
// same thing:
//
//	srr watch set cve 'title=/CVE-\d{4}/i' lang=en
//	srr watch set cve "title=/CVE-\d{4}/i lang=en"
type WatchSetCmd struct {
	Name  string   `arg:"" help:"Watch rule name (also the reader's lane label)."`
	Match []string `arg:"" optional:"" help:"Match conditions, #filter syntax: title=/re/[i] content=/re/[i] any=/re/[i] lang=en,es min_words=N. All must hold."`
}

func (o *WatchSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return setWatchRule(ctx, db, o.Name, strings.Join(o.Match, " "))
	})
}

// setWatchRule validates and upserts, then commits. The whole point of doing it
// under the store lock — rather than as a config-only edit like `srr store dedup` —
// is the coverage stamp: WatchFrom rides the MANIFEST, so the rule and the
// statement of where its lane begins become durable together.
//
// An unchanged spec is a NO-OP, deliberately: re-running the same command must
// not restart the lane. A CHANGED spec DOES restart it — the old bits describe
// a predicate that no longer exists, and re-stamping the floor is how the store
// says so out loud instead of quietly serving them as if they meant the new
// rule. Older objects keep their now-meaningless planes; nothing reads below
// the floor, and §7's sweep reclaims them as the regions get rewritten.
func setWatchRule(ctx context.Context, db *DB, name, spec string) error {
	if err := validateWatchName(name); err != nil {
		return err
	}
	if _, err := mod.ParseMatch(spec); err != nil {
		return fmt.Errorf("watch rule %q: %w", name, err)
	}
	c := &db.core
	if cur, ok := c.Watch[name]; ok && cur == spec {
		return nil
	}
	if c.Watch == nil {
		c.Watch = map[string]string{}
	}
	if c.WatchFrom == nil {
		c.WatchFrom = map[string]int{}
	}
	c.Watch[name] = spec
	c.WatchFrom[name] = c.TotalArticles
	return db.Commit(ctx)
}

// WatchRmCmd removes a rule. Its lane disappears from the roster immediately;
// the bits already published stay in their immutable objects until the regions
// holding them are rewritten or the GC window slides past, and nothing names
// the rule so nothing reads them.
type WatchRmCmd struct {
	Name string `arg:"" help:"Watch rule name to remove."`
}

func (o *WatchRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return removeWatchRule(ctx, db, o.Name)
	})
}

func removeWatchRule(ctx context.Context, db *DB, name string) error {
	c := &db.core
	if _, ok := c.Watch[name]; !ok {
		return fmt.Errorf("watch rule %q not found", name)
	}
	delete(c.Watch, name)
	delete(c.WatchFrom, name)
	// Removing the LAST rule returns the store to having none at all, in the
	// same commit rather than at the next fetch cycle: the roster, the coverage
	// and the series row go together (resetWatch), and §7 reclaims the bitmap
	// objects because nothing names them any more.
	if len(c.Watch) == 0 {
		c.Watch = nil
		db.resetWatch()
	}
	return db.Commit(ctx)
}
