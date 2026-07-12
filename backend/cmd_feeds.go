package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"srr/ingest"
)

// stdout is the destination for printFormatted. Tests substitute this to
// capture command output without spawning a subprocess.
var stdout io.Writer = os.Stdout

// resolveFeedURL resolves a subscription URL to its canonical feed URL via the
// built-in #feed fetcher's auto-discovery (a homepage URL is repointed to its
// <link rel=alternate> feed; an unresolvable URL returns an error so callers
// hard-fail). A package var so tests stub it offline. Only invoked when the
// feed's effective ingest strategy is the built-in #feed (see resolvesFeed).
var resolveFeedURL = func(ctx context.Context, rawURL string) (string, error) {
	return ingest.Resolve(ctx, newFetchClient(1), rawURL, globals.MaxFeedSize*(1<<10))
}

// resolvesFeed reports whether subscribe-time discovery applies: only when the
// feed's effective ingest strategy (its own override, falling back to its
// recipe's, then default's) is the built-in #feed. External ingest strategies
// own their own source and are stored as-is.
func resolvesFeed(recipes map[string]Recipe, recipeName, feedIngest string) bool {
	r := recipeFor(recipes, recipeName)
	def := recipeFor(recipes, defaultRecipeName)
	return ingest.Select(feedIngest, r.Ingest, def.Ingest) == ingest.Builtin
}

// resolveFeedProbe validates the recipe reference and — when the URL is new
// or changed (newURL != oldURL) and the effective ingest is #feed — resolves
// the URL via subscribe-time discovery. feedIngest is the feed-level ingest
// override (may be empty). Returns the resolved URL (unchanged if no probe
// ran). Called before any network probe so an unknown recipe surfaces as a
// clear "recipe does not exist" error rather than a resolve failure.
func resolveFeedProbe(ctx context.Context, recipes map[string]Recipe, recipe, feedIngest, oldURL, newURL string) (string, error) {
	if err := validateRecipeRef(recipes, recipe); err != nil {
		return "", err
	}
	if newURL != oldURL && resolvesFeed(recipes, recipe, feedIngest) {
		resolved, err := resolveFeedURL(ctx, newURL)
		if err != nil {
			return "", fmt.Errorf("resolve feed %q: %w", newURL, err)
		}
		return resolved, nil
	}
	return newURL, nil
}

func printFormatted(format string, v any) error {
	var output []byte
	var err error
	switch format {
	case "yaml":
		output, err = yaml.Marshal(v)
	case "json":
		output, err = jsonEncode(v)
	}
	if err != nil {
		return fmt.Errorf("encoding %s: %w", format, err)
	}
	_, err = fmt.Fprint(stdout, string(output))
	return err
}

func printJSON(v any) error {
	return printFormatted("json", v)
}

// normalizeFeed validates a feed just before it is persisted (the single
// chokepoint for add/upd/apply/edit/import): its recipe reference must exist
// (no dangling refs created via the CLI), its feed-level pipe override must
// pass the same token check as a recipe pipe (#default allowed — it expands
// to the recipe's effective pipe), and its tag must be OPML-safe.
// validateIngest trims a feed/recipe ingest override and rejects a "#"-prefixed
// name that isn't a registered built-in — mirroring validatePipe on the pipe
// axis. Without it a typo like "#feeds" (or an untrimmed " #feed ") is stored
// verbatim and only fails at fetch time, dispatched as `/bin/sh -c '#feeds'`
// (a shell comment → empty stdout → the ingest engine's hard error), breaking
// every feed on that recipe with no signal at the `recipe set`/`feed add` that
// introduced it. A non-"#" value is an external shell command and passes through.
func validateIngest(name string) (string, error) {
	name = strings.TrimSpace(name)
	if strings.HasPrefix(name, "#") && !ingest.IsBuiltin(name) {
		return "", fmt.Errorf("unknown built-in ingest %q (the only built-in is %q; a non-# value is a shell command)", name, ingest.Builtin)
	}
	return name, nil
}

// validateFeedFields runs the DB-independent field validations (expire bounds,
// ingest/pipe tokens, tag) shared by normalizeFeed and the AddCmd/UpdCmd/serve
// pre-flight, so bad input is rejected BEFORE the subscribe-time network probe
// rather than after a wasted round-trip. Pure check, no mutation. The recipe-ref
// check is separate — it needs the recipes map and already runs inside
// resolveFeedProbe before any network I/O.
func validateFeedFields(expireDays int, ingest string, pipe []string, tag string) error {
	if expireDays < 0 {
		return fmt.Errorf("expire days must be >= 0 (got %d)", expireDays)
	}
	// Sanity ceiling: keeps the cutoff arithmetic (now − days·86400) far from
	// int64 overflow and rejects obviously-typo'd values.
	if expireDays > 36500 {
		return fmt.Errorf("expire days must be <= 36500 (100 years) (got %d)", expireDays)
	}
	if _, err := validateIngest(ingest); err != nil {
		return err
	}
	if err := validatePipe(filterPipe(pipe), true); err != nil {
		return err
	}
	return validateTag(tag)
}

func normalizeFeed(ch *Feed, recipes map[string]Recipe) error {
	if err := validateFeedFields(ch.ExpireDays, ch.Ingest, ch.Pipe, ch.Tag); err != nil {
		return err
	}
	if err := validateRecipeRef(recipes, ch.Recipe); err != nil {
		return err
	}
	// Apply the normalizations the checks above validated.
	ch.Ingest = strings.TrimSpace(ch.Ingest)
	ch.Pipe = filterPipe(ch.Pipe)
	return nil
}

// validateRecipeRef accepts an empty name (⇒ default) or any existing recipe;
// a non-empty unknown name is an eager error listing the available recipes.
func validateRecipeRef(recipes map[string]Recipe, name string) error {
	if name == "" {
		return nil
	}
	if _, ok := recipes[name]; ok {
		return nil
	}
	avail := slices.Sorted(maps.Keys(recipes))
	return fmt.Errorf("recipe %q does not exist (available: %s)", name, strings.Join(avail, ", "))
}

// validateTag rejects tags that OPML import would mutate or refuse, so that
// export → import -a is always identity. It splits on "/" and validates each
// segment through normalizeGroupName (same rules import applies): the segment
// must survive normalization unchanged — no uppercasing, spaces, dashes,
// non-ASCII letters, or empty/numeric-only segments allowed.
func validateTag(tag string) error {
	if tag == "" {
		return nil
	}
	for _, seg := range strings.Split(tag, "/") {
		norm, err := normalizeGroupName(seg)
		if err != nil {
			return fmt.Errorf("tag %q: segment %q: %w", tag, seg, err)
		}
		if norm != seg {
			return fmt.Errorf("tag %q: segment %q is not normalized (OPML import would change it to %q)", tag, seg, norm)
		}
	}
	return nil
}

type AddCmd struct {
	Title  *string  `short:"t" required:"" help:"Feed title."`
	URL    *string  `short:"u" required:"" help:"Feed RSS url."`
	Tag    *string  `short:"g" optional:"" help:"Feed tag."`
	Recipe *string  `short:"r" optional:"" help:"Recipe name (must exist). Empty inherits 'default'."`
	Ingest *string  `short:"i" optional:"" help:"Feed-level ingest override: built-in ('#feed') or shell command. Empty inherits the recipe's."`
	Pipe   []string `short:"p" sep:"none" optional:"" help:"Feed-level pipeline step; repeat -p per step. Overrides the recipe's pipe; #default expands to the recipe's effective pipe."`
	Expire *int     `short:"e" name:"expire-days" optional:"" help:"Expire articles after N days (0 = keep forever)."`
}

func (o *AddCmd) Run() error {
	if o.Title == nil || *o.Title == "" {
		return fmt.Errorf("title is required")
	}
	if o.URL == nil {
		return fmt.Errorf("--url is required")
	}
	v := &feedView{
		Title: *o.Title,
		URL:   *o.URL,
	}
	if o.Tag != nil {
		v.Tag = *o.Tag
	}
	if o.Recipe != nil {
		v.Recipe = *o.Recipe
	}
	if o.Ingest != nil {
		v.Ingest = *o.Ingest
	}
	v.Pipe = o.Pipe
	if o.Expire != nil {
		v.ExpireDays = *o.Expire
	}
	// Offline field checks before the store lock and the subscribe-time probe, so
	// bad input never triggers a wasted fetch (the recipe ref is checked inside
	// resolveFeedProbe, also before any network I/O).
	if err := validateFeedFields(v.ExpireDays, v.Ingest, v.Pipe, v.Tag); err != nil {
		return err
	}
	return withDB(true, func(ctx context.Context, db *DB) error {
		resolved, err := resolveFeedProbe(ctx, db.core.Recipes, v.Recipe, v.Ingest, "", v.URL)
		if err != nil {
			return err
		}
		v.URL = resolved
		return applyViews(ctx, db, []*feedView{v})
	})
}

// feedView is the canonical JSON/YAML shape for feed records. Used
// by `feed ls`, `feed show`, `feed apply`, and `feed edit`. ID is a pointer
// so `apply` can distinguish "absent => create" from "id 0 => update". One
// feed = one URL: the URL is a flat field; the last fetch error (if any)
// rides alongside it as a read-only `error` for visibility.
type feedView struct {
	ID         *int     `json:"id,omitempty" yaml:"id,omitempty"`
	Title      string   `json:"title"        yaml:"title"`
	URL        string   `json:"url"          yaml:"url"`
	Error      string   `json:"error,omitempty" yaml:"error,omitempty"`
	Tag        string   `json:"tag,omitempty" yaml:"tag,omitempty"`
	Recipe     string   `json:"recipe,omitempty" yaml:"recipe,omitempty"`
	Ingest     string   `json:"ingest,omitempty" yaml:"ingest,omitempty"`
	Pipe       []string `json:"pipe,omitempty" yaml:"pipe,omitempty"`
	NoTitle    bool     `json:"no_title,omitempty" yaml:"no_title,omitempty"`
	ExpireDays int      `json:"expire_days,omitempty" yaml:"expire_days,omitempty"`
	// Expired is read-only (server-owned, like Error): reported by ls/show/
	// edit, never applied back by writeFeedView.
	Expired int `json:"expired,omitempty" yaml:"expired,omitempty"`
	// ContentBytes/AssetBytes are read-only like Expired: the cumulative
	// uncompressed JSONL bytes the feed's articles added to data/ packs, and
	// the live store footprint of its self-hosted assets/ objects.
	ContentBytes int64 `json:"content_bytes,omitempty" yaml:"content_bytes,omitempty"`
	AssetBytes   int64 `json:"asset_bytes,omitempty" yaml:"asset_bytes,omitempty"`
}

// viewOf builds an output feedView for a stored Feed.
func viewOf(ch *Feed) *feedView {
	id := ch.id
	return &feedView{
		ID:           &id,
		Title:        ch.Title,
		URL:          ch.URL,
		Error:        ch.FetchError,
		Tag:          ch.Tag,
		Recipe:       ch.Recipe,
		Ingest:       ch.Ingest,
		Pipe:         ch.Pipe,
		NoTitle:      ch.NoTitle,
		ExpireDays:   ch.ExpireDays,
		Expired:      ch.Expired,
		ContentBytes: ch.ContentBytes,
		AssetBytes:   ch.AssetBytes,
	}
}

type UpdCmd struct {
	ID     int      `arg:""                help:"Feed id to update."`
	Title  *string  `short:"t" optional:"" help:"Feed title (empty rejected)."`
	URL    *string  `short:"u" optional:"" help:"Feed RSS url. Changing it resets the feed's fetch state (etag/watermark/dedup)."`
	Tag    *string  `short:"g" optional:"" help:"Feed tag. Empty (\"\") to clear."`
	Recipe *string  `short:"r" optional:"" help:"Recipe name (must exist). Empty (\"\") to clear (⇒ default)."`
	Ingest *string  `short:"i" optional:"" help:"Feed-level ingest override. Empty (\"\") to clear (⇒ recipe's)."`
	Pipe   []string `short:"p" sep:"none" optional:"" help:"Feed-level pipeline step; repeat -p per step (#default expands to the recipe's effective pipe). A single -p \"\" clears (⇒ recipe's)."`
	Expire *int     `short:"e" name:"expire-days" optional:"" help:"Expire articles after N days (0 = keep forever)."`
}

func (o *UpdCmd) Run() error {
	if o.Title == nil && o.Tag == nil && o.Recipe == nil && o.Ingest == nil && o.Pipe == nil && o.URL == nil && o.Expire == nil {
		return fmt.Errorf("nothing to update")
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.FeedByID(o.ID)
		if err != nil {
			return err
		}
		if o.Title != nil {
			if *o.Title == "" {
				return fmt.Errorf("title cannot be empty")
			}
			ch.Title = *o.Title
		}
		if o.Tag != nil {
			ch.Tag = *o.Tag
		}
		if o.Recipe != nil {
			ch.Recipe = *o.Recipe
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}
		if o.Pipe != nil {
			// normalizeFeed's filterPipe turns a lone -p "" into nil = cleared.
			ch.Pipe = o.Pipe
		}
		if o.Expire != nil {
			ch.ExpireDays = *o.Expire
		}
		// Determine the candidate URL (unchanged when -u is absent). resolveFeedProbe
		// validates the recipe reference and probes for discovery only when the URL
		// is actually changing and the effective ingest is #feed.
		oldURL := ch.URL
		newURL := ch.URL
		if o.URL != nil {
			if !validFeedURL(*o.URL) {
				return fmt.Errorf("invalid url %q", *o.URL)
			}
			newURL = *o.URL
		}
		// Offline field checks before the subscribe-time probe, so bad input
		// never triggers a wasted fetch.
		if err := validateFeedFields(ch.ExpireDays, ch.Ingest, ch.Pipe, ch.Tag); err != nil {
			return err
		}
		resolved, err := resolveFeedProbe(ctx, db.core.Recipes, ch.Recipe, ch.Ingest, oldURL, newURL)
		if err != nil {
			return err
		}
		if o.URL != nil {
			setFeedURL(ch, resolved)
		}

		if err := normalizeFeed(ch, db.core.Recipes); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
}

// setFeedURL points the feed at url, preserving the per-feed fetch
// state (ETag/Watermark/BoundaryGUIDs/LastModified/FetchError) when the URL is
// unchanged and resetting it when the URL changes — a new source shares no
// dedup/cache history with the old one.
func setFeedURL(ch *Feed, url string) {
	if ch.URL == url {
		return
	}
	ch.URL = url
	ch.ETag = ""
	ch.LastModified = ""
	ch.Watermark = 0
	ch.BoundaryGUIDs = nil
	ch.FetchError = ""
	ch.LastOK = 0
	ch.FailStreak = 0
	ch.LastNew = 0
}

type RmCmd struct {
	ID []int `arg:"" help:"Feed ids to remove."`
}

func (o *RmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		for _, id := range o.ID {
			db.RemoveFeed(id)
		}
		return db.Commit(ctx)
	})
}

type LsCmd struct {
	Tag    *string `short:"g" optional:"" help:"Filter by tag."`
	Format string  `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *LsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		out := make([]*feedView, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			if o.Tag != nil && ch.Tag != *o.Tag {
				continue
			}
			out = append(out, viewOf(ch))
		}
		sort.Slice(out, func(i, j int) bool {
			return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
		})
		return printFormatted(o.Format, out)
	})
}

type ShowCmd struct {
	ID     int    `arg:"" help:"Feed id."`
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *ShowCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		ch, err := db.FeedByID(o.ID)
		if err != nil {
			return err
		}
		return printFormatted(o.Format, viewOf(ch))
	})
}

type ApplyCmd struct {
	File string `short:"f" type:"path" help:"Read JSON from PATH instead of stdin."`

	in io.Reader // test seam; defaults to os.Stdin
}

func (o *ApplyCmd) Run() error {
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

	views, err := parseApplyInput(data)
	if err != nil {
		return err
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		return applyViews(ctx, db, views)
	})
}

// applyViews validates the whole batch, then applies it. Commit only runs
// if every entry validates and applies cleanly — a late failure abandons
// the closure with the in-memory mutations unpersisted, so the on-disk
// db.gz stays at the pre-apply state.
func applyViews(ctx context.Context, db *DB, views []*feedView) error {
	type pending struct {
		view *feedView
		ch   *Feed // existing feed for update; nil for create
	}
	ops := make([]pending, 0, len(views))
	for i, v := range views {
		if v == nil {
			return fmt.Errorf("feed #%d: null entry", i)
		}
		if v.Title == "" {
			return fmt.Errorf("feed #%d: title required", i)
		}
		if v.URL == "" {
			return fmt.Errorf("feed #%d: url required", i)
		}
		if !validFeedURL(v.URL) {
			return fmt.Errorf("feed #%d: invalid url %q", i, v.URL)
		}
		if v.ID == nil {
			ops = append(ops, pending{view: v})
			continue
		}
		ch, err := db.FeedByID(*v.ID)
		if err != nil {
			return err
		}
		ops = append(ops, pending{view: v, ch: ch})
	}

	for _, op := range ops {
		target := op.ch
		if target == nil {
			target = &Feed{}
		}
		writeFeedView(target, op.view)
		if err := normalizeFeed(target, db.core.Recipes); err != nil {
			return fmt.Errorf("feed %q: %w", op.view.Title, err)
		}
		if op.ch == nil {
			if err := db.AddFeed(target); err != nil {
				return err
			}
		}
	}
	return db.Commit(ctx)
}

// writeFeedView applies a feedView onto ch. The URL goes through
// setFeedURL so per-feed fetch state is preserved when the URL is
// unchanged (an update keeping the same source) and reset when it changes.
func writeFeedView(ch *Feed, v *feedView) {
	ch.Title = v.Title
	setFeedURL(ch, v.URL)
	ch.Tag = v.Tag
	ch.Recipe = v.Recipe
	ch.Ingest = v.Ingest
	ch.Pipe = v.Pipe
	ch.NoTitle = v.NoTitle
	ch.ExpireDays = v.ExpireDays
}

// parseApplyInput accepts either a single feedView or an array.
// Auto-detect on the first non-whitespace byte.
func parseApplyInput(data []byte) ([]*feedView, error) {
	trim := bytes.TrimLeft(data, " \t\r\n")
	if len(trim) == 0 {
		return nil, fmt.Errorf("input must be a feed object or array of feed objects")
	}
	if trim[0] == '[' {
		var views []*feedView
		if err := json.Unmarshal(data, &views); err != nil {
			return nil, fmt.Errorf("decode array: %w", err)
		}
		return views, nil
	}
	if trim[0] == '{' {
		var view feedView
		if err := json.Unmarshal(data, &view); err != nil {
			return nil, fmt.Errorf("decode object: %w", err)
		}
		return []*feedView{&view}, nil
	}
	return nil, fmt.Errorf("input must be a feed object or array of feed objects")
}

type EditCmd struct {
	ID int `arg:"" help:"Feed id to edit."`
}

func (o *EditCmd) Run() error {
	editor := resolveEditor()
	if editor == "" {
		return fmt.Errorf("no editor found ($VISUAL, $EDITOR, vi)")
	}

	// 1. Load + serialize to a tempfile.
	view, err := loadFeedView(o.ID)
	if err != nil {
		return err
	}
	original, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal feed: %w", err)
	}

	tmp, err := os.CreateTemp("", fmt.Sprintf("srr-feed-%d-*.json", o.ID))
	if err != nil {
		return fmt.Errorf("create tempfile: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(original); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write tempfile: %w", err)
	}
	tmp.Close()

	// 2. Spawn editor.
	cmd := exec.Command(editor, tmpPath)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("editor exited with status %v (tempfile: %s): %w", cmd.ProcessState, tmpPath, err)
	}

	// 3. Re-read and check for changes.
	edited, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("read edited file %s: %w", tmpPath, err)
	}
	if bytes.Equal(edited, original) {
		os.Remove(tmpPath)
		return nil
	}

	// 4. Parse + validate id.
	var newView feedView
	if err := json.Unmarshal(edited, &newView); err != nil {
		return fmt.Errorf("invalid JSON in %s: %w", tmpPath, err)
	}
	if newView.ID == nil || *newView.ID != o.ID {
		got := -1
		if newView.ID != nil {
			got = *newView.ID
		}
		return fmt.Errorf("edited document changed id from %d to %d; refusing to apply (tempfile: %s)", o.ID, got, tmpPath)
	}

	// 5. Apply.
	if err := withDB(true, func(ctx context.Context, db *DB) error {
		return applyViews(ctx, db, []*feedView{&newView})
	}); err != nil {
		return fmt.Errorf("%w (tempfile: %s)", err, tmpPath)
	}
	os.Remove(tmpPath)
	return nil
}

// loadFeedView reads the DB unlocked (read-only) and returns the
// feedView for ID. The DB lock for the apply step is acquired separately
// in EditCmd.Run.
func loadFeedView(id int) (*feedView, error) {
	var view *feedView
	err := withDB(false, func(_ context.Context, db *DB) error {
		ch, err := db.FeedByID(id)
		if err != nil {
			return err
		}
		view = viewOf(ch)
		return nil
	})
	return view, err
}

// resolveEditor returns the first non-empty of $VISUAL, $EDITOR, then "vi"
// if available on PATH.
func resolveEditor() string {
	for _, env := range []string{"VISUAL", "EDITOR"} {
		if v := os.Getenv(env); v != "" {
			return v
		}
	}
	if _, err := exec.LookPath("vi"); err == nil {
		return "vi"
	}
	return ""
}
