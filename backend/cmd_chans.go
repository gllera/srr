package main

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

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
	fmt.Printf("%s\n", output)
	return nil
}

func printJSON(v any) error {
	output, err := jsonEncode(v)
	if err != nil {
		return fmt.Errorf("encoding json: %w", err)
	}
	fmt.Print(string(output))
	return nil
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

type UpdCmd struct {
	ID      int       `arg:""              help:"Channel id to update."`
	Title   *string   `short:"t" optional:""              help:"Channel title (empty rejected)."`
	Tag     *string   `short:"g" optional:""              help:"Channel tag. Empty (\"\") to clear."`
	Parsers *[]string `short:"p" optional:""              help:"Channel parsers commands. Empty (\"\") to clear."`
	Ingest  *string   `short:"i" optional:""              help:"Channel ingest strategy. Empty (\"\") to clear."`
}

func (o *UpdCmd) Run() error {
	if o.Title == nil && o.Tag == nil && o.Parsers == nil && o.Ingest == nil {
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
		return db.Commit(ctx)
	})
}

type AddFeedCmd struct {
	ID   int      `arg:""            help:"Channel id."`
	URLs []string `arg:"" name:"url" help:"URL(s) to add."`
}

// add-feed is idempotent: URLs already on the channel or duplicated within args
// are silently skipped (mkdir -p semantics). Only invalid URL formats fail.
func (o *AddFeedCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
		if err != nil {
			return err
		}

		seen := make(map[string]bool, len(ch.Feeds)+len(o.URLs))
		for _, f := range ch.Feeds {
			seen[f.URL] = true
		}
		for _, u := range o.URLs {
			if !validFeedURL(u) {
				return fmt.Errorf("invalid url %q", u)
			}
			if seen[u] {
				continue
			}
			seen[u] = true
			ch.Feeds = append(ch.Feeds, &Feed{URL: u})
		}
		return db.Commit(ctx)
	})
}

type RmFeedCmd struct {
	ID   int      `arg:""              help:"Channel id."`
	URLs []string `arg:"" name:"url"   help:"URL(s) to remove."`
}

func (o *RmFeedCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
		if err != nil {
			return err
		}

		rmSet := make(map[string]bool, len(o.URLs))
		for _, u := range o.URLs {
			if rmSet[u] {
				return fmt.Errorf("duplicate url %q", u)
			}
			rmSet[u] = true
			if !slices.ContainsFunc(ch.Feeds, func(f *Feed) bool { return f.URL == u }) {
				return fmt.Errorf("url %q is not a feed of channel %d", u, o.ID)
			}
		}

		if len(rmSet) == len(ch.Feeds) {
			return fmt.Errorf("channel %d would have no feeds after removal", o.ID)
		}

		ch.Feeds = slices.DeleteFunc(ch.Feeds, func(f *Feed) bool { return rmSet[f.URL] })
		return db.Commit(ctx)
	})
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
		type lsFeed struct {
			URL   string `json:"url" yaml:"url"`
			Error string `json:"error,omitempty" yaml:"error,omitempty"`
		}
		type lsChannel struct {
			ID     int      `json:"id" yaml:"id"`
			Title  string   `json:"title" yaml:"title"`
			Feeds  []lsFeed `json:"feeds" yaml:"feeds"`
			Tag    string   `json:"tag,omitempty" yaml:"tag,omitempty"`
			Ingest string   `json:"ingest,omitempty" yaml:"ingest,omitempty"`
		}

		channelsList := make([]*lsChannel, 0, len(db.Channels()))
		for _, ch := range db.Channels() {
			if o.Tag != nil && ch.Tag != *o.Tag {
				continue
			}
			feeds := make([]lsFeed, len(ch.Feeds))
			for i, f := range ch.Feeds {
				feeds[i] = lsFeed{URL: f.URL, Error: f.FetchError}
			}
			channelsList = append(channelsList, &lsChannel{
				ID:     ch.id,
				Title:  ch.Title,
				Feeds:  feeds,
				Tag:    ch.Tag,
				Ingest: ch.Ingest,
			})
		}

		sort.Slice(channelsList, func(i, j int) bool {
			return strings.ToLower(channelsList[i].Title) < strings.ToLower(channelsList[j].Title)
		})

		return printFormatted(o.Format, &channelsList)
	})
}
