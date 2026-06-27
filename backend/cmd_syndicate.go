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
		return setOutFeed(ctx, db, OutFeed{
			Name:   o.Name,
			Title:  o.Title,
			Format: o.Format,
			Tags:   o.Tags,
			Feeds:  o.FeedIDs,
			Limit:  o.Limit,
		})
	})
}

// SyndicateRmCmd removes a named syndication output feed and best-effort
// deletes its out/* files (silent-on-missing).
type SyndicateRmCmd struct {
	Name string `arg:"" help:"Output feed name to remove."`
}

func (o *SyndicateRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, o.Name)
	})
}

// setOutFeed validates and upserts one syndication output entry, reaping the
// orphaned old-extension file on a format change. Shared by `srr syndicate set`
// and the PUT handler. The caller supplies a fully-built OutFeed (Limit 0 ⇒
// default applied here).
func setOutFeed(ctx context.Context, db *DB, in OutFeed) error {
	if !validOutName(in.Name) {
		return fmt.Errorf("syndication name %q must match [A-Za-z0-9._-] and not be '.' or '..'", in.Name)
	}
	if in.Format != "rss" && in.Format != "json" {
		return fmt.Errorf("format %q is invalid; must be rss or json", in.Format)
	}
	if len(in.Tags) == 0 && len(in.Feeds) == 0 {
		return fmt.Errorf("at least one of tags or feeds must be non-empty")
	}
	for _, id := range in.Feeds {
		if _, err := db.FeedByID(id); err != nil {
			return fmt.Errorf("feed id %d: unknown", id)
		}
	}
	if in.Limit <= 0 {
		in.Limit = outDefaultLimit
	}

	found := false
	oldFormat := ""
	for i, e := range db.core.Out {
		if e.Name == in.Name {
			oldFormat = e.Format
			db.core.Out[i] = in
			found = true
			break
		}
	}
	if !found {
		db.core.Out = append(db.core.Out, in)
	}
	if err := db.Commit(ctx); err != nil {
		return err
	}
	if found && oldFormat != "" && oldFormat != in.Format {
		_ = db.Rm(ctx, outFileKey(OutFeed{Name: in.Name, Format: oldFormat}))
	}
	return nil
}

// removeOutFeed deletes a syndication entry by name and best-effort removes its
// out/* files. Shared by `srr syndicate rm` and the DELETE handler.
func removeOutFeed(ctx context.Context, db *DB, name string) error {
	var format string
	out := db.core.Out[:0]
	for _, e := range db.core.Out {
		if e.Name == name {
			format = e.Format
			continue
		}
		out = append(out, e)
	}
	db.core.Out = out
	if err := db.Commit(ctx); err != nil {
		return err
	}
	exts := map[string]string{"rss": ".rss", "json": ".json"}
	if ext := exts[format]; format != "" && ext != "" {
		_ = db.Rm(ctx, "out/"+name+ext)
	} else {
		for _, ext := range exts {
			_ = db.Rm(ctx, "out/"+name+ext)
		}
	}
	return nil
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
