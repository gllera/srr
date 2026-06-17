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
	Title   *string  `short:"t" required:""              help:"Channel title."`
	URL     *string  `short:"u" required:""              help:"Channel RSS url."`
	Tag     *string  `short:"g" optional:""              help:"Channel tag."`
	Parsers []string `short:"p" sep:"none" optional:"" help:"Channel pipe step; repeat -p per step (not comma-separated). Empty (\"\") for default."`
	Ingest  *string  `short:"i" optional:""              help:"Ingest strategy: built-in ('#rss') or shell command."`
}

func (o *AddCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Title == nil || *o.Title == "" {
			return fmt.Errorf("title is required")
		}
		if o.URL == nil {
			return fmt.Errorf("--url is required")
		}
		if !validFeedURL(*o.URL) {
			return fmt.Errorf("invalid url %q", *o.URL)
		}
		ch := &Channel{Title: *o.Title, URL: *o.URL}
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
// so `apply` can distinguish "absent => create" from "id 0 => update". One
// channel = one URL: the URL is a flat field; the last fetch error (if any)
// rides alongside it as a read-only `error` for visibility.
type channelView struct {
	ID     *int     `json:"id,omitempty" yaml:"id,omitempty"`
	Title  string   `json:"title"        yaml:"title"`
	URL    string   `json:"url"          yaml:"url"`
	Error  string   `json:"error,omitempty" yaml:"error,omitempty"`
	Tag    string   `json:"tag,omitempty" yaml:"tag,omitempty"`
	Pipe   []string `json:"pipe,omitempty" yaml:"pipe,omitempty"`
	Ingest string   `json:"ingest,omitempty" yaml:"ingest,omitempty"`
}

// viewOf builds an output channelView for a stored Channel.
func viewOf(ch *Channel) *channelView {
	id := ch.id
	return &channelView{
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
	ID      int      `arg:""                                 help:"Channel id to update."`
	Title   *string  `short:"t" optional:""                  help:"Channel title (empty rejected)."`
	URL     *string  `short:"u" optional:""                  help:"Channel RSS url. Changing it resets the channel's fetch state (etag/watermark/dedup)."`
	Tag     *string  `short:"g" optional:""                  help:"Channel tag. Empty (\"\") to clear."`
	Parsers []string `short:"p" sep:"none" optional:"" help:"Channel pipe step; repeat -p per step (not comma-separated). Empty (\"\") to clear."`
	Ingest  *string  `short:"i" optional:""                  help:"Channel ingest strategy. Empty (\"\") to clear."`
}

func (o *UpdCmd) Run() error {
	if o.Title == nil && o.Tag == nil && o.Parsers == nil && o.Ingest == nil && o.URL == nil {
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
		if o.URL != nil {
			if !validFeedURL(*o.URL) {
				return fmt.Errorf("invalid url %q", *o.URL)
			}
			setChannelURL(ch, *o.URL)
		}

		if err := normalizeChannel(ch); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
}

// setChannelURL points the channel at url, preserving the per-channel fetch
// state (ETag/Watermark/BoundaryGUIDs/LastModified/FetchError) when the URL is
// unchanged and resetting it when the URL changes — a new source shares no
// dedup/cache history with the old one.
func setChannelURL(ch *Channel, url string) {
	if ch.URL == url {
		return
	}
	ch.URL = url
	ch.ETag = ""
	ch.LastModified = ""
	ch.Watermark = 0
	ch.BoundaryGUIDs = nil
	ch.FetchError = ""
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
		if v.URL == "" {
			return fmt.Errorf("channel #%d: url required", i)
		}
		if !validFeedURL(v.URL) {
			return fmt.Errorf("channel #%d: invalid url %q", i, v.URL)
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
		target := op.ch
		if target == nil {
			target = &Channel{}
		}
		writeChannelView(target, op.view)
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

// writeChannelView applies a channelView onto ch. The URL goes through
// setChannelURL so per-channel fetch state is preserved when the URL is
// unchanged (an update keeping the same source) and reset when it changes.
func writeChannelView(ch *Channel, v *channelView) {
	ch.Title = v.Title
	setChannelURL(ch, v.URL)
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
