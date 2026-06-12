package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"srrb/ingest"
	"srrb/mod"
)

// pipeBase is the token expanded inline to the root pipe at the
// position where it appears in a channel's Pipe slice.
const pipeBase = "#base"

// resolvePipe composes the effective pipeline by expanding "#base"
// tokens in chPipe to root. An empty chPipe (nil or []) inherits root;
// a non-empty chPipe overrides.
func resolvePipe(root, chPipe []string) []string {
	if len(chPipe) == 0 {
		return root
	}
	out := make([]string, 0, len(chPipe)+len(root))
	for _, m := range chPipe {
		if m == pipeBase {
			out = append(out, root...)
		} else {
			out = append(out, m)
		}
	}
	return out
}

type Channel struct {
	id    int
	Title string   `json:"title"`
	Feeds []*Feed  `json:"feeds"`
	Tag   string   `json:"tag,omitempty"`
	Pipe  []string `json:"pipe,omitempty"`
	// Ingest is the channel-level extraction strategy. Empty falls through
	// to the db.gz root Ingest → built-in "#rss".
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

// LogValue keeps per-feed log lines compact: callers already emit the
// specific feed URL alongside the channel, so the channel-level URL list
// would duplicate it once per feed in the same fetch loop.
func (c *Channel) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int("id", c.id),
		slog.String("title", c.Title),
	)
}

// fetchRun bundles the run-scoped dependencies shared by every channel and feed
// in a single fetch: built once in FetchCmd.fetch and concurrent-safe, so one
// *fetchRun is shared across all workers. The genuinely per-worker values (the
// pooled read buffer and module processor) stay separate call parameters.
type fetchRun struct {
	client *http.Client
	engine *ingest.Fetcher
	// assets is the content-addressed uploader for files a fetcher self-hosts
	// into cacheDir; feed.fetch's end-of-pipeline step calls UploadCacheRef on it.
	assets *assetFetcher
	// cacheDir is the single download/working dir shared by every feed this run,
	// built once in FetchCmd.fetch (always non-empty). Any fetcher (built-in or
	// external) may stash files here and self-host them, owning the layout inside.
	cacheDir   string
	fetchedAt  int64
	rootPipe   []string
	rootIngest string
}

func (c *Channel) Fetch(ctx context.Context, run *fetchRun, buf []byte, processor *mod.Module) {
	c.newItems = c.newItems[:0]
	pipe := resolvePipe(run.rootPipe, c.Pipe)
	// Validate the resolved pipeline once, before the item loop. A bad token
	// (unknown built-in, stray #base, malformed params) is a config error that
	// would fail identically for every item; surface it loudly here instead of
	// letting feed.go skip every item one by one.
	if err := processor.Validate(ctx, pipe); err != nil {
		err = fmt.Errorf("invalid pipeline %v: %w", pipe, err)
		slog.Error("channel pipeline invalid; skipping fetch", "channel", c, "err", err)
		for _, feed := range c.Feeds {
			feed.FetchError = err.Error()
		}
		return
	}
	ingestName := ingest.Select(c.Ingest, run.rootIngest)
	for _, feed := range c.Feeds {
		items, err := feed.fetch(ctx, run, buf, processor, c, pipe, ingestName)
		if err != nil {
			feed.FetchError = err.Error()
			slog.Error("feed fetch failed", "channel", c, "url", feed.URL, "err", err)
			continue
		}
		feed.FetchError = ""
		c.newItems = append(c.newItems, items...)
	}
}
