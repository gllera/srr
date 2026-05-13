package main

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"srrb/ingest"
	"srrb/mod"
)

// pipeParent is the token expanded inline to the root pipe at the
// position where it appears in a channel's Pipeline slice.
const pipeParent = "#parent"

// resolvePipe composes the effective pipeline by expanding "#parent"
// tokens in chPipe to root. nil chPipe inherits root; non-nil overrides
// (an empty slice means "no pipe").
func resolvePipe(root, chPipe []string) []string {
	if chPipe == nil {
		return root
	}
	out := make([]string, 0, len(chPipe)+len(root))
	for _, m := range chPipe {
		if m == pipeParent {
			out = append(out, root...)
		} else {
			out = append(out, m)
		}
	}
	return out
}

type Channel struct {
	id       int
	Title    string   `json:"title"`
	Feeds    []*Feed  `json:"feeds"`
	Tag      string   `json:"tag,omitempty"`
	Pipeline []string `json:"pipe,omitempty"`
	// Ingest is the channel-level extraction strategy. Empty falls through
	// to Globals.DefaultIngest → built-in "#rss".
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

func (c *Channel) Fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module, engine *ingest.Fetcher, fetchedAt int64, rootPipe []string) {
	c.newItems = c.newItems[:0]
	pipeline := resolvePipe(rootPipe, c.Pipeline)
	for _, feed := range c.Feeds {
		items, err := feed.fetch(ctx, client, buf, processor, engine, c, fetchedAt, pipeline)
		if err != nil {
			feed.FetchError = err.Error()
			slog.Error("feed fetch failed", "channel", c, "url", feed.URL, "err", err)
			continue
		}
		feed.FetchError = ""
		c.newItems = append(c.newItems, items...)
	}
}
