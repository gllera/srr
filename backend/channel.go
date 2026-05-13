package main

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"srrb/ingest"
	"srrb/mod"
)

type Channel struct {
	id       int
	Title    string   `json:"title"`
	Feeds    []*Feed  `json:"feeds"`
	Tag      string   `json:"tag,omitempty"`
	Pipeline []string `json:"pipe,omitempty"`
	// Ingest is the channel-level default for feeds whose own
	// Ingest field is empty. See Feed.Ingest.
	Ingest   string `json:"ingest,omitempty"`
	TotalArt int    `json:"total_art"`
	AddIdx   int    `json:"add_idx"`
	newItems []*Item
}

func (c *Channel) URLs() string {
	urls := make([]string, len(c.Feeds))
	for i, feed := range c.Feeds {
		urls[i] = feed.URL
	}
	return strings.Join(urls, ", ")
}

func (c *Channel) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int("id", c.id),
		slog.String("urls", c.URLs()),
	)
}

func (c *Channel) Fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module, engine *ingest.Fetcher, fetchedAt int64) {
	c.newItems = c.newItems[:0]
	for _, feed := range c.Feeds {
		items, err := feed.fetch(ctx, client, buf, processor, engine, c, fetchedAt)
		if err != nil {
			feed.FetchError = err.Error()
			slog.Error("feed fetch failed", "channel", c, "url", feed.URL, "err", err)
			continue
		}
		feed.FetchError = ""
		c.newItems = append(c.newItems, items...)
	}
}
