package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
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
	Upd     *int      `          optional:"" help:"Update existing subscription id instead."`
	Title   *string   `short:"t" optional:"" help:"Subscription title."`
	URL     *url.URL  `short:"u" optional:"" help:"Subscription RSS url."`
	Tag     *string   `short:"g" optional:"" help:"Subscription tag. Empty (\"\") to clear."`
	Parsers *[]string `short:"p" optional:"" help:"Subscription parsers commands. Empty (\"\") for default."`
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
		if *o.Upd < 0 || *o.Upd > 255 {
			return fmt.Errorf("subscription id must be in [0, 255]")
		}
		sub = db.Subscriptions()[*o.Upd]
		if sub == nil {
			return fmt.Errorf("subscription id %d not found", *o.Upd)
		}
	} else {
		if o.Title == nil {
			return fmt.Errorf("title is required for new subscription")
		}
		if o.URL == nil {
			return fmt.Errorf("url is required for new subscription")
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
	if o.URL != nil {
		if o.URL.String() == "" {
			return fmt.Errorf("url cannot be empty")
		}
		sub.URL = o.URL.String()
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

	type SubscriptionLS struct {
		ID    int    `json:"id"`
		Title string `json:"title"`
		URL   string `json:"url"`
		Tag   string `json:"tag,omitempty" yaml:"tag,omitempty"`
		Error string `json:"error,omitempty" yaml:"error,omitempty"`
	}

	subsList := make([]*SubscriptionLS, 0, len(db.Subscriptions()))
	for _, s := range db.Subscriptions() {
		if o.Tag != nil && s.Tag != *o.Tag {
			continue
		}
		subsList = append(subsList, &SubscriptionLS{
			Title: s.Title,
			URL:   s.URL,
			ID:    s.id,
			Tag:   s.Tag,
			Error: s.FetchError,
		})
	}

	sort.Slice(subsList, func(i, j int) bool {
		return strings.ToLower(subsList[i].Title) < strings.ToLower(subsList[j].Title)
	})

	return printFormatted(o.Format, &subsList)
}
