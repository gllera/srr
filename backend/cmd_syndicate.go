package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// outNameRe is the allowlist for syndication output feed names: one or more
// alphanumeric, dot, underscore, or hyphen characters. "." and ".." are
// explicitly rejected after the regex check so names like "." never escape
// the out/ prefix via path.Join / filepath.Join.
var outNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// validOutName reports whether name is a safe syndication output feed name:
// it must match outNameRe and must not be "." or "..".
func validOutName(name string) bool {
	return outNameRe.MatchString(name) && name != "." && name != ".."
}

// outDefaultLimit is the default item count for a syndication output feed when
// the caller does not specify --limit (or specifies 0).
const outDefaultLimit = 50

// SyndicateGroup holds the `srr syndicate` sub-commands.
type SyndicateGroup struct {
	Ls  SyndicateLsCmd  `cmd:"" help:"List syndication output feeds."`
	Set SyndicateSetCmd `cmd:"" help:"Add or update a syndication output feed."`
	Rm  SyndicateRmCmd  `cmd:"" help:"Remove a syndication output feed and delete its out/* files."`
}

// SyndicateLsCmd prints the current Out list as JSON.
type SyndicateLsCmd struct{}

func (o *SyndicateLsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		return printJSON(db.core.Out)
	})
}

// SyndicateSetCmd adds or updates a named syndication output feed.
type SyndicateSetCmd struct {
	Name    string   `arg:"" help:"Output feed name (used as the file stem: out/<name>.rss or out/<name>.json)."`
	Format  string   `short:"f" required:"" help:"Output format: rss (RSS 2.0) or json (JSON Feed 1.1)."`
	Title   string   `short:"t" help:"Channel/feed title (defaults to name when empty)."`
	Tags    []string `short:"g" sep:"," help:"Tag filter: include articles from feeds whose tag is in this list (comma-separated)."`
	FeedIDs []int    `short:"i" sep:"," help:"Feed id filter: include articles from these specific feed ids (comma-separated)."`
	Limit   int      `short:"l" default:"0" help:"Maximum number of items to include (newest first; default 50)."`
}

func (o *SyndicateSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		// Validate name: must be a safe file stem with no path components.
		if !validOutName(o.Name) {
			return fmt.Errorf("syndication name %q must match [A-Za-z0-9._-] and not be '.' or '..'", o.Name)
		}
		// Validate format.
		if o.Format != "rss" && o.Format != "json" {
			return fmt.Errorf("format %q is invalid; must be rss or json", o.Format)
		}
		// Require at least one selector.
		if len(o.Tags) == 0 && len(o.FeedIDs) == 0 {
			return fmt.Errorf("at least one of --tags or --feeds must be non-empty")
		}
		// Validate every explicit feed id.
		for _, id := range o.FeedIDs {
			if _, err := db.FeedByID(id); err != nil {
				return fmt.Errorf("feed id %d: %w", id, err)
			}
		}
		// Default limit.
		limit := o.Limit
		if limit <= 0 {
			limit = outDefaultLimit
		}

		entry := OutFeed{
			Name:   o.Name,
			Title:  o.Title,
			Format: o.Format,
			Tags:   o.Tags,
			Feeds:  o.FeedIDs,
			Limit:  limit,
		}

		// Upsert by name. Capture the prior format so a format change can reap the
		// now-orphaned old-extension out/* file (SyncOutFeeds only ever writes the
		// current extension, so the old file would be served stale forever).
		found := false
		oldFormat := ""
		for i, e := range db.core.Out {
			if e.Name == o.Name {
				oldFormat = e.Format
				db.core.Out[i] = entry
				found = true
				break
			}
		}
		if !found {
			db.core.Out = append(db.core.Out, entry)
		}
		if err := db.Commit(ctx); err != nil {
			return err
		}
		if found && oldFormat != "" && oldFormat != o.Format {
			// Best-effort delete the orphaned old-extension file (Rm is silent-on-missing).
			_ = db.Rm(ctx, outFileKey(OutFeed{Name: o.Name, Format: oldFormat}))
		}
		return nil
	})
}

// SyndicateRmCmd removes a named syndication output feed and best-effort
// deletes its out/* files (silent-on-missing).
type SyndicateRmCmd struct {
	Name string `arg:"" help:"Output feed name to remove."`
}

func (o *SyndicateRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		// Find the entry so we know the format for key cleanup.
		var format string
		out := db.core.Out[:0]
		for _, e := range db.core.Out {
			if e.Name == o.Name {
				format = e.Format
				continue
			}
			out = append(out, e)
		}
		db.core.Out = out

		if err := db.Commit(ctx); err != nil {
			return err
		}

		// Best-effort delete the out/ file (silent-on-missing via Rm contract).
		// If format was empty (name not found), still attempt both extensions so
		// a leftover file from a previous run is also cleaned.
		exts := map[string]string{"rss": ".rss", "json": ".json"}
		if ext := exts[format]; format != "" && ext != "" {
			_ = db.Rm(ctx, "out/"+o.Name+ext)
		} else {
			// Unknown/empty format (e.g. a hand-edited db.gz value): delete both
			// possible extensions so the real out/* file isn't left orphaned.
			for _, ext := range exts {
				_ = db.Rm(ctx, "out/"+o.Name+ext)
			}
		}
		return nil
	})
}

// outFileKey returns the store key for an OutFeed's output file.
func outFileKey(o OutFeed) string {
	switch o.Format {
	case "json":
		return "out/" + o.Name + ".json"
	default:
		return "out/" + o.Name + ".rss"
	}
}

// outTitle returns the effective channel title (falls back to Name).
func outTitle(o OutFeed) string {
	if o.Title != "" {
		return o.Title
	}
	return o.Name
}

// joinURL joins a CDN base with a key, handling trailing/missing slashes.
func joinURL(base, key string) string {
	return strings.TrimRight(base, "/") + "/" + key
}
