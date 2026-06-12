package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// stdout is the destination for printFormatted. Tests substitute this to
// capture command output without spawning a subprocess.
var stdout io.Writer = os.Stdout

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

// normalizeChannel trims/validates a channel's pipe and tag just before it is
// persisted (the single chokepoint for add / upd / apply / edit / import), so a
// bad value fails loudly at config time instead of silently breaking the fetch
// later. Channel pipes may use #base (allowBase=true).
func normalizeChannel(ch *Channel) error {
	ch.Pipe = filterPipe(ch.Pipe)
	if err := validatePipe(ch.Pipe, true); err != nil {
		return err
	}
	return validateTag(ch.Tag)
}

// validateTag rejects a numeric-only tag. The frontend filter resolves an
// all-digits token as a channel id, so such a tag would silently show every
// article instead of the tagged set (and could collide with a real id).
func validateTag(tag string) error {
	if tag == "" {
		return nil
	}
	for _, r := range tag {
		if r < '0' || r > '9' {
			return nil
		}
	}
	return fmt.Errorf("tag %q cannot be numeric-only (it would be read as a channel id)", tag)
}

type AddCmd struct {
	Title   *string   `short:"t" required:""              help:"Channel title."`
	URLs    *[]string `short:"u" required:"" name:"url"   help:"Channel RSS url(s); repeat to merge multiple feeds under one id."`
	Tag     *string   `short:"g" optional:""              help:"Channel tag."`
	Parsers []string  `short:"p" sep:"none" optional:"" help:"Channel pipe step; repeat -p per step (not comma-separated). Empty (\"\") for default."`
	Ingest  *string   `short:"i" optional:""              help:"Ingest strategy: built-in ('#rss') or shell command."`
}

// parseFeeds validates URL flag values and reuses any prior Feed whose URL
// survives the update so per-feed state (ETag, Watermark, etc.) is preserved.
func parseFeeds(urls []string, prev []*Feed) ([]*Feed, error) {
	if len(urls) == 0 {
		return nil, fmt.Errorf("at least one --url is required")
	}
	out := make([]*Feed, 0, len(urls))
	for _, raw := range urls {
		if !validFeedURL(raw) {
			return nil, fmt.Errorf("invalid url %q", raw)
		}
		if slices.ContainsFunc(out, func(f *Feed) bool { return f.URL == raw }) {
			return nil, fmt.Errorf("duplicate url %q", raw)
		}
		i := slices.IndexFunc(prev, func(f *Feed) bool { return f.URL == raw })
		if i >= 0 {
			out = append(out, prev[i])
		} else {
			out = append(out, &Feed{URL: raw})
		}
	}
	return out, nil
}

func (o *AddCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Title == nil || *o.Title == "" {
			return fmt.Errorf("title is required")
		}
		if o.URLs == nil {
			return fmt.Errorf("--url is required")
		}
		feeds, err := parseFeeds(*o.URLs, nil)
		if err != nil {
			return err
		}
		ch := &Channel{Title: *o.Title, Feeds: feeds}
		if o.Tag != nil {
			ch.Tag = *o.Tag
		}
		if o.Parsers != nil {
			ch.Pipe = o.Parsers // normalizeChannel trims/validates below
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}
		if err := normalizeChannel(ch); err != nil {
			return err
		}
		if err := db.AddChannel(ch); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
}

// channelView is the canonical JSON/YAML shape for channel records. Used
// by `chan ls`, `chan show`, `chan apply`, and `chan edit`. ID is a pointer
// so `apply` can distinguish "absent => create" from "id 0 => update".
type channelView struct {
	ID     *int       `json:"id,omitempty" yaml:"id,omitempty"`
	Title  string     `json:"title"        yaml:"title"`
	Feeds  []feedView `json:"feeds"        yaml:"feeds"`
	Tag    string     `json:"tag,omitempty" yaml:"tag,omitempty"`
	Pipe   []string   `json:"pipe,omitempty" yaml:"pipe,omitempty"`
	Ingest string     `json:"ingest,omitempty" yaml:"ingest,omitempty"`
}

type feedView struct {
	URL   string `json:"url" yaml:"url"`
	Error string `json:"error,omitempty" yaml:"error,omitempty"`
}

// viewOf builds an output channelView for a stored Channel.
func viewOf(ch *Channel) *channelView {
	feeds := make([]feedView, len(ch.Feeds))
	for i, f := range ch.Feeds {
		feeds[i] = feedView{URL: f.URL, Error: f.FetchError}
	}
	id := ch.id
	return &channelView{
		ID:     &id,
		Title:  ch.Title,
		Feeds:  feeds,
		Tag:    ch.Tag,
		Pipe:   append([]string(nil), ch.Pipe...),
		Ingest: ch.Ingest,
	}
}

type UpdCmd struct {
	ID      int       `arg:""                                 help:"Channel id to update."`
	Title   *string   `short:"t" optional:""                  help:"Channel title (empty rejected)."`
	URLs    *[]string `short:"u" optional:"" name:"url"       help:"Replace the feed list. Per-URL state preserved for surviving URLs. Mutually exclusive with --add-url and --rm-url."`
	AddURLs *[]string `           optional:"" name:"add-url"   help:"Append URL(s) (idempotent). Mutually exclusive with -u and --rm-url."`
	RmURLs  *[]string `           optional:"" name:"rm-url"    help:"Remove URL(s) (strict). Mutually exclusive with -u and --add-url."`
	Tag     *string   `short:"g" optional:""                  help:"Channel tag. Empty (\"\") to clear."`
	Parsers []string  `short:"p" sep:"none" optional:"" help:"Channel pipe step; repeat -p per step (not comma-separated). Empty (\"\") to clear."`
	Ingest  *string   `short:"i" optional:""                  help:"Channel ingest strategy. Empty (\"\") to clear."`
}

func (o *UpdCmd) Run() error {
	// Mutex on the three feed-list flags.
	urlFlagCount := 0
	if o.URLs != nil {
		urlFlagCount++
	}
	if o.AddURLs != nil {
		urlFlagCount++
	}
	if o.RmURLs != nil {
		urlFlagCount++
	}
	if urlFlagCount > 1 {
		return fmt.Errorf("--url cannot be combined with --add-url/--rm-url")
	}

	if o.Title == nil && o.Tag == nil && o.Parsers == nil && o.Ingest == nil && urlFlagCount == 0 {
		return fmt.Errorf("nothing to update")
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
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
			ch.Pipe = o.Parsers // normalizeChannel trims/validates below
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}

		switch {
		case o.URLs != nil:
			feeds, err := parseFeeds(*o.URLs, ch.Feeds)
			if err != nil {
				return err
			}
			ch.Feeds = feeds
		case o.AddURLs != nil:
			if err := appendURLs(ch, *o.AddURLs); err != nil {
				return err
			}
		case o.RmURLs != nil:
			if err := removeURLs(ch, *o.RmURLs); err != nil {
				return err
			}
		}

		if err := normalizeChannel(ch); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
}

// appendURLs adds urls to ch.Feeds idempotently (silent skip on duplicates
// or URLs already on the channel). Invalid URL formats fail.
func appendURLs(ch *Channel, urls []string) error {
	seen := make(map[string]bool, len(ch.Feeds)+len(urls))
	for _, f := range ch.Feeds {
		seen[f.URL] = true
	}
	for _, u := range urls {
		if !validFeedURL(u) {
			return fmt.Errorf("invalid url %q", u)
		}
		if seen[u] {
			continue
		}
		seen[u] = true
		ch.Feeds = append(ch.Feeds, &Feed{URL: u})
	}
	return nil
}

// removeURLs strict-removes urls from ch.Feeds. Errors if any url is not a
// current feed, on duplicate args, or if all feeds would be removed.
func removeURLs(ch *Channel, urls []string) error {
	rmSet := make(map[string]bool, len(urls))
	for _, u := range urls {
		if rmSet[u] {
			return fmt.Errorf("duplicate url %q", u)
		}
		rmSet[u] = true
		if !slices.ContainsFunc(ch.Feeds, func(f *Feed) bool { return f.URL == u }) {
			return fmt.Errorf("url %q is not a feed of channel %d", u, ch.id)
		}
	}
	if len(rmSet) == len(ch.Feeds) {
		return fmt.Errorf("channel %d would have no feeds after removal", ch.id)
	}
	ch.Feeds = slices.DeleteFunc(ch.Feeds, func(f *Feed) bool { return rmSet[f.URL] })
	return nil
}

type RmCmd struct {
	ID []int `arg:"" help:"Channel ids to remove."`
}

func (o *RmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		for _, id := range o.ID {
			db.RemoveChannel(id)
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
		out := make([]*channelView, 0, len(db.Channels()))
		for _, ch := range db.Channels() {
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
	ID     int    `arg:"" help:"Channel id."`
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *ShowCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
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
func applyViews(ctx context.Context, db *DB, views []*channelView) error {
	type pending struct {
		view *channelView
		ch   *Channel // existing channel for update; nil for create
	}
	ops := make([]pending, 0, len(views))
	for i, v := range views {
		if v == nil {
			return fmt.Errorf("channel #%d: null entry", i)
		}
		if v.Title == "" {
			return fmt.Errorf("channel #%d: title required", i)
		}
		if len(v.Feeds) == 0 {
			return fmt.Errorf("channel #%d: feeds required", i)
		}
		if v.ID == nil {
			ops = append(ops, pending{view: v})
			continue
		}
		ch, err := db.ChannelByID(*v.ID)
		if err != nil {
			return err
		}
		ops = append(ops, pending{view: v, ch: ch})
	}

	for _, op := range ops {
		urls := make([]string, len(op.view.Feeds))
		for i, f := range op.view.Feeds {
			urls[i] = f.URL
		}
		var prevFeeds []*Feed
		if op.ch != nil {
			prevFeeds = op.ch.Feeds
		}
		feeds, err := parseFeeds(urls, prevFeeds)
		if err != nil {
			return err
		}

		target := op.ch
		if target == nil {
			target = &Channel{}
		}
		writeChannelView(target, op.view, feeds)
		if err := normalizeChannel(target); err != nil {
			return fmt.Errorf("channel %q: %w", op.view.Title, err)
		}
		if op.ch == nil {
			if err := db.AddChannel(target); err != nil {
				return err
			}
		}
	}
	return db.Commit(ctx)
}

func writeChannelView(ch *Channel, v *channelView, feeds []*Feed) {
	ch.Title = v.Title
	ch.Feeds = feeds
	ch.Tag = v.Tag
	ch.Pipe = append([]string(nil), v.Pipe...)
	ch.Ingest = v.Ingest
}

// parseApplyInput accepts either a single channelView or an array.
// Auto-detect on the first non-whitespace byte.
func parseApplyInput(data []byte) ([]*channelView, error) {
	trim := bytes.TrimLeft(data, " \t\r\n")
	if len(trim) == 0 {
		return nil, fmt.Errorf("input must be a channel object or array of channel objects")
	}
	if trim[0] == '[' {
		var views []*channelView
		if err := json.Unmarshal(data, &views); err != nil {
			return nil, fmt.Errorf("decode array: %w", err)
		}
		return views, nil
	}
	if trim[0] == '{' {
		var view channelView
		if err := json.Unmarshal(data, &view); err != nil {
			return nil, fmt.Errorf("decode object: %w", err)
		}
		return []*channelView{&view}, nil
	}
	return nil, fmt.Errorf("input must be a channel object or array of channel objects")
}

type EditCmd struct {
	ID int `arg:"" help:"Channel id to edit."`
}

func (o *EditCmd) Run() error {
	editor := resolveEditor()
	if editor == "" {
		return fmt.Errorf("no editor found ($VISUAL, $EDITOR, vi)")
	}

	// 1. Load + serialize to a tempfile.
	view, err := loadChannelView(o.ID)
	if err != nil {
		return err
	}
	original, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal channel: %w", err)
	}

	tmp, err := os.CreateTemp("", fmt.Sprintf("srr-chan-%d-*.json", o.ID))
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
	var newView channelView
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
		return applyViews(ctx, db, []*channelView{&newView})
	}); err != nil {
		return fmt.Errorf("%w (tempfile: %s)", err, tmpPath)
	}
	os.Remove(tmpPath)
	return nil
}

// loadChannelView reads the DB unlocked (read-only) and returns the
// channelView for ID. The DB lock for the apply step is acquired separately
// in EditCmd.Run.
func loadChannelView(id int) (*channelView, error) {
	var view *channelView
	err := withDB(false, func(_ context.Context, db *DB) error {
		ch, err := db.ChannelByID(id)
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
