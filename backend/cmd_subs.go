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
	Upd     *int      `          optional:""              help:"Update existing subscription id instead."`
	Title   *string   `short:"t" optional:""              help:"Subscription title."`
	URLs    *[]string `short:"u" optional:"" name:"url"   help:"Subscription RSS url(s); repeat to merge multiple sources under one id."`
	Tag     *string   `short:"g" optional:""              help:"Subscription tag. Empty (\"\") to clear."`
	Parsers *[]string `short:"p" optional:""              help:"Subscription parsers commands. Empty (\"\") for default."`
}

// parseSources validates URL flag values and reuses any prior Source whose URL
// survives the update so per-source state (ETag, StopGUID, etc.) is preserved.
func parseSources(urls []string, prev []*Source) ([]*Source, error) {
	if len(urls) == 0 {
		return nil, fmt.Errorf("at least one --url is required")
	}
	out := make([]*Source, 0, len(urls))
	for _, raw := range urls {
		if !validFeedURL(raw) {
			return nil, fmt.Errorf("invalid url %q", raw)
		}
		if slices.ContainsFunc(out, func(s *Source) bool { return s.URL == raw }) {
			return nil, fmt.Errorf("duplicate url %q", raw)
		}
		i := slices.IndexFunc(prev, func(s *Source) bool { return s.URL == raw })
		if i >= 0 {
			out = append(out, prev[i])
		} else {
			out = append(out, &Source{URL: raw})
		}
	}
	return out, nil
}

func (o *AddCmd) Run() error {
	ctx := context.Background()
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	var sub *Subscription
	if o.Upd != nil {
		sub, err = db.SubByID(*o.Upd)
		if err != nil {
			return err
		}
	} else {
		if o.Title == nil {
			return fmt.Errorf("title is required for new subscription")
		}
		if o.URLs == nil {
			return fmt.Errorf("at least one --url is required for new subscription")
		}
		sub = &Subscription{}
		if err := db.AddSubscription(sub); err != nil {
			return err
		}
	}

	if o.Title != nil {
		if *o.Title == "" {
			return fmt.Errorf("title cannot be empty")
		}
		sub.Title = *o.Title
	}
	if o.URLs != nil {
		sources, err := parseSources(*o.URLs, sub.Sources)
		if err != nil {
			return err
		}
		sub.Sources = sources
	}
	if o.Tag != nil {
		sub.Tag = *o.Tag
	}
	if o.Parsers != nil {
		sub.Pipeline = []string{}
		for _, p := range *o.Parsers {
			if p != "" {
				sub.Pipeline = append(sub.Pipeline, p)
			}
		}
	}

	return db.Commit(ctx)
}

type AddSrcCmd struct {
	ID   int      `arg:""              help:"Subscription id."`
	URLs []string `arg:"" name:"url"   help:"URL(s) to add."`
}

// add-src is idempotent: URLs already on the sub or duplicated within args
// are silently skipped (mkdir -p semantics). Only invalid URL formats fail.
func (o *AddSrcCmd) Run() error {
	ctx := context.Background()
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	sub, err := db.SubByID(o.ID)
	if err != nil {
		return err
	}

	seen := make(map[string]bool, len(sub.Sources)+len(o.URLs))
	for _, s := range sub.Sources {
		seen[s.URL] = true
	}
	for _, u := range o.URLs {
		if !validFeedURL(u) {
			return fmt.Errorf("invalid url %q", u)
		}
		if seen[u] {
			continue
		}
		seen[u] = true
		sub.Sources = append(sub.Sources, &Source{URL: u})
	}
	return db.Commit(ctx)
}

type RmSrcCmd struct {
	ID   int      `arg:""              help:"Subscription id."`
	URLs []string `arg:"" name:"url"   help:"URL(s) to remove."`
}

func (o *RmSrcCmd) Run() error {
	ctx := context.Background()
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	sub, err := db.SubByID(o.ID)
	if err != nil {
		return err
	}

	rmSet := make(map[string]bool, len(o.URLs))
	for _, u := range o.URLs {
		if rmSet[u] {
			return fmt.Errorf("duplicate url %q", u)
		}
		rmSet[u] = true
		if !slices.ContainsFunc(sub.Sources, func(s *Source) bool { return s.URL == u }) {
			return fmt.Errorf("url %q is not a source of subscription %d", u, o.ID)
		}
	}

	if len(rmSet) == len(sub.Sources) {
		return fmt.Errorf("subscription %d would have no sources after removal", o.ID)
	}

	sub.Sources = slices.DeleteFunc(sub.Sources, func(s *Source) bool { return rmSet[s.URL] })
	return db.Commit(ctx)
}

type RmCmd struct {
	ID []int `arg:"" help:"Subscription ids to remove."`
}

func (o *RmCmd) Run() error {
	ctx := context.Background()
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	for _, id := range o.ID {
		db.RemoveSubscription(id)
	}

	return db.Commit(ctx)
}

type LsCmd struct {
	Tag    *string `short:"g" optional:"" help:"Filter by tag."`
	Format string  `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *LsCmd) Run() error {
	ctx := context.Background()
	db, err := NewDB(ctx, false)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	type lsSource struct {
		URL   string `json:"url" yaml:"url"`
		Error string `json:"error,omitempty" yaml:"error,omitempty"`
	}
	type lsSub struct {
		ID      int        `json:"id" yaml:"id"`
		Title   string     `json:"title" yaml:"title"`
		Sources []lsSource `json:"sources" yaml:"sources"`
		Tag     string     `json:"tag,omitempty" yaml:"tag,omitempty"`
	}

	subsList := make([]*lsSub, 0, len(db.Subscriptions()))
	for _, s := range db.Subscriptions() {
		if o.Tag != nil && s.Tag != *o.Tag {
			continue
		}
		sources := make([]lsSource, len(s.Sources))
		for i, src := range s.Sources {
			sources[i] = lsSource{URL: src.URL, Error: src.FetchError}
		}
		subsList = append(subsList, &lsSub{
			ID:      s.id,
			Title:   s.Title,
			Sources: sources,
			Tag:     s.Tag,
		})
	}

	sort.Slice(subsList, func(i, j int) bool {
		return strings.ToLower(subsList[i].Title) < strings.ToLower(subsList[j].Title)
	})

	return printFormatted(o.Format, &subsList)
}
