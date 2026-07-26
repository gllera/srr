package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"slices"

	"srr/mod"
)

// Whole-configuration export/import. OPML (`srr feed export`) stays the
// interop format, but its leaf carries only Title+XMLURL — restoring from it
// yields a store that silently fetches the WRONG content: every feed's
// recipe/ingest/pipe override, retention window, dedup tuning and no_title
// flag is gone, as are the recipes map, the syndication list and the
// store-wide dedup default. These verbs are the lossless backup path.
//
// Deliberately NOT exported: fetch STATE (watermark, validators, dedup pool,
// vitals, byte counters, add_idx/expired). That is derived bookkeeping the
// next fetch cycle rebuilds — this is a config backup, not a store clone.

// configExportVersion is the envelope version of the export document. Bumped
// only if the shape changes incompatibly; import refuses anything higher.
const configExportVersion = 1

// configDoc is the exported document — one JSON object, stable key order.
type configDoc struct {
	Version int `json:"version"`
	// DedupDays is the store-wide default dedup horizon (db.gz "dd").
	DedupDays int `json:"dedup_days,omitempty"`
	// Recipes is the named {ingest, pipe} map, "default" included.
	Recipes map[string]Recipe `json:"recipes,omitempty"`
	// Out is the syndication configuration (managed and external slots alike;
	// an external slot's published bytes are not config and are not carried).
	Out []OutFeed `json:"out,omitempty"`
	// Watch is the keyword-watchlist rule set: name → match specification. The
	// PATTERNS are config and travel; the per-rule coverage floor is derived
	// state that belongs to the store the rules land in, so an import stamps it
	// apply-forward there, exactly as `srr watch set` does.
	Watch map[string]string `json:"watch,omitempty"`
	// Feeds carries every writable per-feed field, keyed by URL on import.
	Feeds []configFeed `json:"feeds"`
}

// configFeed is the per-feed half: exactly the writable fields, no ids and no
// server-owned counters (an id is store-local — a restore into a fresh store
// assigns its own, and matching on URL is what makes import idempotent).
type configFeed struct {
	Title      string   `json:"title"`
	URL        string   `json:"url"`
	Tag        string   `json:"tag,omitempty"`
	Recipe     string   `json:"recipe,omitempty"`
	Ingest     string   `json:"ingest,omitempty"`
	Pipe       []string `json:"pipe,omitempty"`
	Secrets    []string `json:"secrets,omitempty"`
	NoTitle    bool     `json:"no_title,omitempty"`
	ExpireDays int      `json:"expire_days,omitempty"`
	DedupDays  int      `json:"dedup_days,omitempty"`
	DedupTitle bool     `json:"dedup_title,omitempty"`
}

// ExportAllCmd writes the whole store configuration as one JSON document.
type ExportAllCmd struct{}

func (o *ExportAllCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		out, err := json.MarshalIndent(buildConfigDoc(db), "", "  ")
		if err != nil {
			return fmt.Errorf("encoding config: %w", err)
		}
		if _, err := stdout.Write(out); err != nil {
			return err
		}
		_, err = stdout.Write([]byte("\n"))
		return err
	})
}

// buildConfigDoc projects the live store into the export document. Feeds are
// sorted by URL so successive exports of an unchanged store are byte-stable
// (map iteration order is not) — a diffable backup.
func buildConfigDoc(db *DB) configDoc {
	feeds := make([]configFeed, 0, len(db.Feeds()))
	for _, ch := range db.Feeds() {
		feeds = append(feeds, configFeed{
			Title:      ch.Title,
			URL:        ch.URL,
			Tag:        ch.Tag,
			Recipe:     ch.Recipe,
			Ingest:     ch.Ingest,
			Pipe:       ch.Pipe,
			Secrets:    ch.Secrets,
			NoTitle:    ch.NoTitle,
			ExpireDays: ch.ExpireDays,
			DedupDays:  ch.DedupDays,
			DedupTitle: ch.DedupTitle,
		})
	}
	slices.SortFunc(feeds, func(a, b configFeed) int {
		if a.URL != b.URL {
			return cmpString(a.URL, b.URL)
		}
		return cmpString(a.Title, b.Title)
	})
	return configDoc{
		Version:   configExportVersion,
		DedupDays: db.core.DedupDays,
		Recipes:   db.core.Recipes,
		Out:       db.core.Out,
		Watch:     db.core.Watch,
		Feeds:     feeds,
	}
}

func cmpString(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// ImportAllCmd restores a document written by `srr store export`.
type ImportAllCmd struct {
	File string `short:"f" type:"path" help:"Read JSON from PATH instead of stdin."`

	in io.Reader // test seam; defaults to os.Stdin
}

func (o *ImportAllCmd) Run() error {
	src := o.in
	if src == nil {
		if o.File == "" || o.File == "-" {
			src = os.Stdin
		} else {
			f, err := os.Open(o.File)
			if err != nil {
				return fmt.Errorf("open %s: %w", o.File, err)
			}
			defer f.Close()
			src = f
		}
	}
	data, err := io.ReadAll(src)
	if err != nil {
		return fmt.Errorf("read input: %w", err)
	}
	var doc configDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("decode config: %w", err)
	}
	if doc.Version > configExportVersion {
		return fmt.Errorf("config document version %d is newer than this srr supports (%d)", doc.Version, configExportVersion)
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		return applyConfigDoc(ctx, db, &doc)
	})
}

// applyConfigDoc validates the WHOLE document before mutating anything, then
// applies it: store default → recipes → out → feeds. Like applyViews, a late
// failure abandons the closure with the in-memory mutations unpersisted, so
// db.gz stays exactly at its pre-import state.
func applyConfigDoc(ctx context.Context, db *DB, doc *configDoc) error {
	if doc.DedupDays < 0 {
		return fmt.Errorf("dedup_days %d is invalid (a negative store default has no meaning; a per-feed -1 disables the pool)", doc.DedupDays)
	}
	// Recipes must validate before the feeds that reference them, and a feed
	// may name a recipe this document introduces — so stage the merged map and
	// validate feeds against THAT, not against the store's current recipes.
	recipes := map[string]Recipe{}
	maps.Copy(recipes, db.core.Recipes)
	for name, r := range doc.Recipes {
		pipe := filterPipe(r.Pipe)
		if err := validatePipe(pipe, name != defaultRecipeName); err != nil {
			return fmt.Errorf("recipe %q: %w", name, err)
		}
		secrets := filterPipe(r.Secrets)
		if err := validateSecretScopes(secrets); err != nil {
			return fmt.Errorf("recipe %q: %w", name, err)
		}
		recipes[name] = Recipe{Ingest: r.Ingest, Pipe: pipe, Secrets: secrets}
	}
	// Feeds: validate every entry (URL shape, recipe reference, pipe tokens,
	// bounded expire/dedup) before the first write.
	staged := make([]*Feed, 0, len(doc.Feeds))
	seen := map[string]bool{}
	for i := range doc.Feeds {
		f := &doc.Feeds[i]
		if f.Title == "" {
			return fmt.Errorf("feed %d: title is required", i)
		}
		if !validFeedURL(f.URL) {
			return fmt.Errorf("feed %q: invalid url %q", f.Title, f.URL)
		}
		if seen[f.URL] {
			return fmt.Errorf("feed %q: duplicate url %q in the document", f.Title, f.URL)
		}
		seen[f.URL] = true
		ch := &Feed{
			Title: f.Title, URL: f.URL, Tag: f.Tag, Recipe: f.Recipe,
			Ingest: f.Ingest, Pipe: f.Pipe, Secrets: f.Secrets, NoTitle: f.NoTitle,
			ExpireDays: f.ExpireDays, DedupDays: f.DedupDays, DedupTitle: f.DedupTitle,
		}
		if err := normalizeFeed(ch, recipes); err != nil {
			return fmt.Errorf("feed %q: %w", f.Title, err)
		}
		staged = append(staged, ch)
	}
	// Out entries reference feed ids, which a restore into a fresh store has not
	// assigned yet — validate the rest of the shape and drop unknown ids after
	// the feeds land (below), rather than refusing the whole import.
	for _, of := range doc.Out {
		if err := validateOutShape(of); err != nil {
			return err
		}
	}
	// Watch rules validate up front like everything else: a spec that will not
	// compile must fail the import, not land in config.gz and warn on every
	// fetch cycle from then on.
	for _, name := range slices.Sorted(maps.Keys(doc.Watch)) {
		if err := validateWatchName(name); err != nil {
			return err
		}
		if _, err := mod.ParseMatch(doc.Watch[name]); err != nil {
			return fmt.Errorf("watch rule %q: %w", name, err)
		}
	}

	// --- apply (validation passed) ---
	db.core.DedupDays = doc.DedupDays
	db.core.Recipes = recipes
	for _, name := range slices.Sorted(maps.Keys(doc.Watch)) {
		// setWatchRule without its Commit: same no-op-on-unchanged rule, same
		// apply-forward stamp at THIS store's head — an imported rule cannot
		// claim a lane over articles it was never evaluated against, and the
		// source store's floor means nothing here anyway.
		if db.core.Watch[name] == doc.Watch[name] {
			continue
		}
		// Guarded INDEPENDENTLY, like setWatchRule: the two maps live in two
		// different objects (patterns in config.gz, floors in the manifest) and
		// can legitimately arrive one without the other — a root pointed back at
		// an older generation keeps the sidecar's rules while losing its roster.
		// One guard covering both then wrote into a nil map and panicked.
		if db.core.Watch == nil {
			db.core.Watch = map[string]string{}
		}
		if db.core.WatchFrom == nil {
			db.core.WatchFrom = map[string]int{}
		}
		db.core.Watch[name] = doc.Watch[name]
		db.core.WatchFrom[name] = db.core.TotalArticles
	}

	byURL := map[string]*Feed{}
	for _, ch := range db.Feeds() {
		byURL[ch.URL] = ch
	}
	created, updated := 0, 0
	for _, want := range staged {
		if ch, ok := byURL[want.URL]; ok {
			// Same source ⇒ same feed: keep its id and all fetch state
			// (setFeedURL no-ops on an unchanged URL).
			writeFeedView(ch, &feedView{
				Title: want.Title, URL: want.URL, Tag: want.Tag, Recipe: want.Recipe,
				Ingest: want.Ingest, Pipe: want.Pipe, Secrets: want.Secrets, NoTitle: want.NoTitle,
				ExpireDays: want.ExpireDays, DedupDays: want.DedupDays, DedupTitle: want.DedupTitle,
			})
			updated++
			continue
		}
		if err := db.AddFeed(want); err != nil {
			return fmt.Errorf("add feed %q: %w", want.Title, err)
		}
		byURL[want.URL] = want
		created++
	}

	// Now that every feed exists, resolve the out[] slots: keep only feed ids
	// the store actually holds (a fresh store reassigns ids, so an id from the
	// source store may name a different feed or none at all — dropping the
	// unknown ones keeps tag-based slots, the common case, working).
	out := make([]OutFeed, 0, len(doc.Out))
	dropped := 0
	for _, of := range doc.Out {
		ids := make([]int, 0, len(of.Feeds))
		for _, id := range of.Feeds {
			if _, err := db.FeedByID(id); err == nil {
				ids = append(ids, id)
			} else {
				dropped++
			}
		}
		of.Feeds = ids
		if !of.External && len(of.Tags) == 0 && len(of.Feeds) == 0 {
			return fmt.Errorf("syndicate %q: no selector survived the import (its feed ids do not exist here)", of.Name)
		}
		out = append(out, of)
	}
	db.core.Out = out

	fmt.Fprintf(stdout, "imported: %d feeds created, %d updated, %d recipes, %d syndication slots",
		created, updated, len(doc.Recipes), len(out))
	if dropped > 0 {
		fmt.Fprintf(stdout, " (%d unknown feed id(s) dropped from syndication selectors)", dropped)
	}
	fmt.Fprintln(stdout)
	// commitState, not Commit: writeFeedView routes through setFeedURL, and a
	// changed URL resets the feed's fetch state — including the seen.gz-backed
	// validators and bg — so the sidecar must be persisted with the config
	// (same reason `feed apply` uses it).
	return db.commitState(ctx)
}
