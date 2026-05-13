package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
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
		output, err = json.Marshal(v)
	}
	if err != nil {
		return fmt.Errorf("encoding %s: %w", format, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", output); err != nil {
		return err
	}
	return nil
}

func printJSON(v any) error {
	output, err := jsonEncode(v)
	if err != nil {
		return fmt.Errorf("encoding json: %w", err)
	}
	_, err = fmt.Fprint(stdout, string(output))
	return err
}

type AddCmd struct {
	Title   *string   `short:"t" required:""              help:"Channel title."`
	URLs    *[]string `short:"u" required:"" name:"url"   help:"Channel RSS url(s); repeat to merge multiple feeds under one id."`
	Tag     *string   `short:"g" optional:""              help:"Channel tag."`
	Parsers *[]string `short:"p" optional:""              help:"Channel parsers commands. Empty (\"\") for default."`
	Ingest  *string   `short:"i" optional:""              help:"Ingest strategy: built-in ('#rss', '#telegram') or shell command."`
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
			for _, p := range *o.Parsers {
				if p != "" {
					ch.Pipeline = append(ch.Pipeline, p)
				}
			}
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
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
		Pipe:   append([]string(nil), ch.Pipeline...),
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
	Parsers *[]string `short:"p" optional:""                  help:"Channel parsers commands. Empty (\"\") to clear."`
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
			ch.Pipeline = ch.Pipeline[:0]
			for _, p := range *o.Parsers {
				if p != "" {
					ch.Pipeline = append(ch.Pipeline, p)
				}
			}
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
		// Disk writes are atomic: Commit is only called after all entries
		// apply successfully. The validation loop catches the cheap shape
		// errors (missing title/feeds, unknown id) before any mutation
		// happens; per-URL validation runs inside parseFeeds during apply.
		// A late URL-validation failure rolls back in-memory state by
		// abandoning the closure without committing.
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

		// Apply.
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

			if op.ch == nil {
				ch := &Channel{
					Title:    op.view.Title,
					Feeds:    feeds,
					Tag:      op.view.Tag,
					Pipeline: append([]string(nil), op.view.Pipe...),
					Ingest:   op.view.Ingest,
				}
				if err := db.AddChannel(ch); err != nil {
					return err
				}
			} else {
				op.ch.Title = op.view.Title
				op.ch.Feeds = feeds
				op.ch.Tag = op.view.Tag
				op.ch.Pipeline = append([]string(nil), op.view.Pipe...)
				op.ch.Ingest = op.view.Ingest
			}
		}
		return db.Commit(ctx)
	})
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
