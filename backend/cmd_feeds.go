package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"srrb/ingest"
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
// feed's effective ingest strategy is the built-in #feed. External ingest
// strategies own their own (non-HTTP-feed) source and must be stored as-is.
func resolvesFeed(feedIngest, rootIngest string) bool {
	return ingest.Select(feedIngest, rootIngest) == ingest.Builtin
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

// normalizeFeed trims/validates a feed's pipe and tag just before it is
// persisted (the single chokepoint for add / upd / apply / edit / import), so a
// bad value fails loudly at config time instead of silently breaking the fetch
// later. Feed pipes may use #base (allowBase=true).
func normalizeFeed(ch *Feed) error {
	ch.Pipe = filterPipe(ch.Pipe)
	if err := validatePipe(ch.Pipe, true); err != nil {
		return err
	}
	return validateTag(ch.Tag)
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
	Title   *string  `short:"t" required:""              help:"Feed title."`
	URL     *string  `short:"u" required:""              help:"Feed RSS url."`
	Tag     *string  `short:"g" optional:""              help:"Feed tag."`
	Parsers []string `short:"p" sep:"none" optional:"" help:"Feed pipe step; repeat -p per step (not comma-separated). Empty (\"\") for default."`
	Ingest  *string  `short:"i" optional:""              help:"Ingest strategy: built-in ('#feed') or shell command."`
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
		Pipe:  o.Parsers,
	}
	if o.Tag != nil {
		v.Tag = *o.Tag
	}
	if o.Ingest != nil {
		v.Ingest = *o.Ingest
	}
	return withDB(true, func(ctx context.Context, db *DB) error {
		if resolvesFeed(v.Ingest, db.core.Ingest) {
			resolved, err := resolveFeedURL(ctx, v.URL)
			if err != nil {
				return fmt.Errorf("resolve feed %q: %w", v.URL, err)
			}
			v.URL = resolved
		}
		return applyViews(ctx, db, []*feedView{v})
	})
}

// feedView is the canonical JSON/YAML shape for feed records. Used
// by `feed ls`, `feed show`, `feed apply`, and `feed edit`. ID is a pointer
// so `apply` can distinguish "absent => create" from "id 0 => update". One
// feed = one URL: the URL is a flat field; the last fetch error (if any)
// rides alongside it as a read-only `error` for visibility.
type feedView struct {
	ID     *int     `json:"id,omitempty" yaml:"id,omitempty"`
	Title  string   `json:"title"        yaml:"title"`
	URL    string   `json:"url"          yaml:"url"`
	Error  string   `json:"error,omitempty" yaml:"error,omitempty"`
	Tag    string   `json:"tag,omitempty" yaml:"tag,omitempty"`
	Pipe   []string `json:"pipe,omitempty" yaml:"pipe,omitempty"`
	Ingest string   `json:"ingest,omitempty" yaml:"ingest,omitempty"`
}

// viewOf builds an output feedView for a stored Feed.
func viewOf(ch *Feed) *feedView {
	id := ch.id
	return &feedView{
		ID:     &id,
		Title:  ch.Title,
		URL:    ch.URL,
		Error:  ch.FetchError,
		Tag:    ch.Tag,
		Pipe:   append([]string(nil), ch.Pipe...),
		Ingest: ch.Ingest,
	}
}

type UpdCmd struct {
	ID      int      `arg:""                                 help:"Feed id to update."`
	Title   *string  `short:"t" optional:""                  help:"Feed title (empty rejected)."`
	URL     *string  `short:"u" optional:""                  help:"Feed RSS url. Changing it resets the feed's fetch state (etag/watermark/dedup)."`
	Tag     *string  `short:"g" optional:""                  help:"Feed tag. Empty (\"\") to clear."`
	Parsers []string `short:"p" sep:"none" optional:"" help:"Feed pipe step; repeat -p per step (not comma-separated). Empty (\"\") to clear."`
	Ingest  *string  `short:"i" optional:""                  help:"Feed ingest strategy. Empty (\"\") to clear."`
}

func (o *UpdCmd) Run() error {
	if o.Title == nil && o.Tag == nil && o.Parsers == nil && o.Ingest == nil && o.URL == nil {
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
		if o.Parsers != nil {
			ch.Pipe = o.Parsers // normalizeFeed trims/validates below
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}
		if o.URL != nil {
			if !validFeedURL(*o.URL) {
				return fmt.Errorf("invalid url %q", *o.URL)
			}
			newURL := *o.URL
			// Resolve only when the URL actually changes (a repoint) and the
			// effective ingest is the built-in #feed. ch.Ingest already reflects
			// any -i update applied above.
			if newURL != ch.URL && resolvesFeed(ch.Ingest, db.core.Ingest) {
				resolved, err := resolveFeedURL(ctx, newURL)
				if err != nil {
					return fmt.Errorf("resolve feed %q: %w", newURL, err)
				}
				newURL = resolved
			}
			setFeedURL(ch, newURL)
		}

		if err := normalizeFeed(ch); err != nil {
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
		if err := normalizeFeed(target); err != nil {
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
	ch.Pipe = append([]string(nil), v.Pipe...)
	ch.Ingest = v.Ingest
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
