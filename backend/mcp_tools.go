package main

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This file holds the srr MCP tool set: one named top-level handler per tool
// (so they are unit-testable without a transport) plus the I/O structs whose
// `jsonschema:` tags are the documentation an LLM actually reads.
//
// Every handler WRAPS an existing function — listArticles, buildOverview,
// renderPreview, previewFetch, resolveFeedViewURL+saveFeed, runFetch — rather
// than reimplementing it, so the tool surface and the CLI/GUI surfaces can
// never drift. See mcp.go for the stdout-discipline rule these handlers obey.
//
// Absent-means-optional: the schema inferencer marks every field WITHOUT
// `omitempty` as required, so optional inputs must carry it.

// --- shared limits ----------------------------------------------------------

const (
	// mcpDefaultArticleLimit mirrors `srr art ls -l`'s default.
	mcpDefaultArticleLimit = 50
	// mcpMaxArticleLimit caps one tool response. Article content is large and a
	// tool result is a context-window payload, not a file download.
	mcpMaxArticleLimit = 200
	// mcpDefaultPreviewLimit keeps a preview to a glance-sized sample.
	mcpDefaultPreviewLimit = 5
	// mcpDefaultPreviewChars bounds each previewed article's content.
	mcpDefaultPreviewChars = 5000
)

// truncateRunes cuts s to at most maxRunes runes, never mid-rune, and reports
// whether it cut. maxRunes <= 0 means "no limit".
func truncateRunes(s string, maxRunes int) (string, bool) {
	if maxRunes <= 0 || utf8.RuneCountInString(s) <= maxRunes {
		return s, false
	}
	n := 0
	for i := range s {
		if n == maxRunes {
			return s[:i], true
		}
		n++
	}
	return s, false
}

// parseMCPWindow resolves the tool-level since/until strings into the same
// half-open [since, until) unix-second window `srr art ls` uses, over the
// shared parseTimeBound grammar. Its own wording (field names, not flag names)
// keeps ArtCmd.window's test-pinned messages untouched.
func parseMCPWindow(sinceStr, untilStr string, now time.Time) (since, until *int64, err error) {
	if sinceStr != "" {
		t, err := parseTimeBound(sinceStr, now)
		if err != nil {
			return nil, nil, fmt.Errorf("since: %w", err)
		}
		since = &t
	}
	if untilStr != "" {
		t, err := parseTimeBound(untilStr, now)
		if err != nil {
			return nil, nil, fmt.Errorf("until: %w", err)
		}
		until = &t
	}
	if since != nil && until != nil && *since >= *until {
		return nil, nil, fmt.Errorf("since %q is not before until %q: the window is empty", sinceStr, untilStr)
	}
	return since, until, nil
}

// --- srr_list_articles ------------------------------------------------------

type listArticlesIn struct {
	FeedIDs        []int    `json:"feed_ids,omitempty" jsonschema:"Only articles from these feed ids. Combined with tags as a union (an article matches if it is in ANY selected feed). Omit for every feed. Feed ids come from srr_overview."`
	Tags           []string `json:"tags,omitempty" jsonschema:"Only articles from feeds carrying one of these tags. Exact tag match, not hierarchical; combined with feed_ids as a union. Omit for every feed."`
	Query          string   `json:"query,omitempty" jsonschema:"Only articles whose TITLE contains this text, matched accent- and case-insensitively. Title-only: article bodies are not searched. Costly on a large store — an exact match count reads every data pack inside the window, so pair query with since (e.g. since=\"7d\") to bound the work."`
	Limit          int      `json:"limit,omitempty" jsonschema:"Maximum articles to return. Default 50, hard-capped at 200 — article content is large and this result lands in a context window."`
	Before         *int     `json:"before,omitempty" jsonschema:"Pagination cursor: return only articles strictly before this chron index (exclusive). Pass back the next_cursor of the previous call; omit for the newest page. Articles are always returned newest-first."`
	Since          string   `json:"since,omitempty" jsonschema:"Window start, INCLUSIVE. Forms: a duration before now (\"24h\", \"7d\", \"2w\", \"1d12h\"), a local date (\"2026-07-15\"), or an RFC3339 instant (\"2026-07-15T09:00:00Z\"). The clock is fetched_at (when SRR ingested the article), not the publisher's date — a backfill of old posts rides its recent ingest time."`
	Until          string   `json:"until,omitempty" jsonschema:"Window end, EXCLUSIVE — same forms as since. Consecutive windows compose without overlapping. The clock is fetched_at, not published."`
	IncludeContent bool     `json:"include_content,omitempty" jsonschema:"Include each article's full HTML content. Off by default: content dominates the payload, so leave it off to browse or count and turn it on only when the text is actually going to be read."`
}

type mcpArticle struct {
	ChronIdx  int    `json:"chron_idx" jsonschema:"Global 0-based article index across the whole store (the article's stable address). Feed it back as the before cursor to page."`
	FeedID    int    `json:"feed_id" jsonschema:"Id of the feed this article came from."`
	FeedTitle string `json:"feed_title,omitempty" jsonschema:"Title of that feed, resolved from the same store read. Absent if the feed has since been removed."`
	Title     string `json:"title,omitempty" jsonschema:"Article title. Absent on titleless microblog-style feeds (the feed's no_title flag)."`
	Link      string `json:"link,omitempty" jsonschema:"Canonical URL of the article at its origin."`
	Published int64  `json:"published,omitempty" jsonschema:"Publisher's date, unix seconds. Absent when the source item carried no date."`
	FetchedAt int64  `json:"fetched_at" jsonschema:"When SRR ingested the article, unix seconds. This is the clock the since/until window filters on."`
	Lang      string `json:"lang,omitempty" jsonschema:"ISO 639-1 language code detected at ingest. Absent means unknown — detection is fail-open and short texts are left unstamped."`
	Content   string `json:"content,omitempty" jsonschema:"Article HTML, already sanitized and processed by the feed's pipeline. Present only when include_content was set."`
}

type listArticlesOut struct {
	Articles   []mcpArticle `json:"articles" jsonschema:"The matching articles, newest first."`
	Total      int          `json:"total" jsonschema:"How many articles match the filters INSIDE the time window — not the store total, and not capped by limit."`
	NextCursor *int         `json:"next_cursor,omitempty" jsonschema:"Pass as before on the next call to get the following page. Absent when this page is the last one."`
}

// mcpListArticles wraps listArticles (cmd_art.go) in a read-only, unlocked DB
// scope. Feed titles are resolved inside that same scope, so the ids and the
// names they are labelled with come from one consistent db.gz read.
func mcpListArticles(ctx context.Context, _ *mcp.CallToolRequest, in listArticlesIn) (*mcp.CallToolResult, listArticlesOut, error) {
	// Both bounds resolve against one `now`, so a relative window can't straddle
	// a clock tick mid-call.
	since, until, err := parseMCPWindow(in.Since, in.Until, time.Now())
	if err != nil {
		return nil, listArticlesOut{}, mcpToolErr(err)
	}
	limit := in.Limit
	if limit <= 0 {
		limit = mcpDefaultArticleLimit
	}
	limit = min(limit, mcpMaxArticleLimit)

	out := listArticlesOut{Articles: []mcpArticle{}}
	err = withDBCtx(ctx, false, func(ctx context.Context, db *DB) error {
		res, e := listArticles(ctx, db, artQuery{
			ids:    in.FeedIDs,
			tags:   in.Tags,
			limit:  limit,
			before: in.Before,
			since:  since,
			until:  until,
			query:  in.Query,
		})
		if e != nil {
			return e
		}
		feeds := db.Feeds()
		for _, a := range res.Articles {
			m := mcpArticle{
				ChronIdx:  a.Idx,
				FeedID:    a.FeedID,
				Title:     a.Title,
				Link:      a.Link,
				Published: a.Published,
				FetchedAt: a.FetchedAt,
				Lang:      a.Lang,
			}
			if ch := feeds[a.FeedID]; ch != nil {
				m.FeedTitle = ch.Title
			}
			if in.IncludeContent {
				m.Content = a.Content
			}
			out.Articles = append(out.Articles, m)
		}
		out.Total = res.Total
		out.NextCursor = res.NextCursor
		return nil
	})
	if err != nil {
		return nil, listArticlesOut{}, mcpToolErr(err)
	}
	return nil, out, nil
}

// --- srr_overview -----------------------------------------------------------

// overviewOut carries the admin console's own whole-store projection verbatim.
// It is a one-field wrapper rather than a re-listing of overviewView's fields
// on purpose: buildOverview stays the single definition of the projection, so
// the tool can never drift from what the GUI shows.
type overviewOut struct {
	Store overviewView `json:"store" jsonschema:"Whole-store snapshot from one db.gz read. Holds: feeds (every subscription with its id, title, url, tag, recipe, per-feed processing overrides, retention/dedup settings, fetch-health vitals last_ok/last_new/fail_streak/error, all-time total_art, expired count and the stored content_bytes/asset_bytes); tags (per-tag feed and live-article counts); recipes (the named ingest+pipe processing bundles, including the reserved default); out (the syndication output slots); gen, fetched_at and total_art for the store as a whole; dedup_days (the effective store-wide dedup horizon); cdn_url; and version (the running srr binary)."`
}

// mcpOverview wraps buildOverview (serve_overview.go) — the exact projection
// GET /api/overview serves — in a read-only, unlocked DB scope.
func mcpOverview(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, overviewOut, error) {
	var out overviewOut
	err := withDBCtx(ctx, false, func(_ context.Context, db *DB) error {
		out.Store = buildOverview(db)
		return nil
	})
	if err != nil {
		return nil, overviewOut{}, mcpToolErr(err)
	}
	return nil, out, nil
}

// --- srr_preview_feed -------------------------------------------------------

type previewFeedIn struct {
	URL             string   `json:"url" jsonschema:"Feed or page URL to fetch and process. PERFORMS AN OUTBOUND REQUEST to this URL (and, depending on the pipeline, to the article pages it links)."`
	Recipe          string   `json:"recipe,omitempty" jsonschema:"Preview as if the feed used this named recipe. Omit for the reserved default recipe. Names come from srr_overview's recipes."`
	Ingest          string   `json:"ingest,omitempty" jsonschema:"Ad-hoc ingest override with feed-level semantics (wins over the recipe's): the built-in \"#feed\" or an external shell command."`
	Pipe            []string `json:"pipe,omitempty" jsonschema:"Ad-hoc processing pipeline override with feed-level semantics (replaces the recipe's pipe), one step per entry. Built-ins start with # (#sanitize, #minify, #readability, #filter, #dedupmedia, #unlazy, #embed, #enclosure, #untrack, #selfhost); #default expands inline to the recipe's effective pipe; anything else is a shell command."`
	Limit           int      `json:"limit,omitempty" jsonschema:"Maximum articles to return from the preview. Default 5. The whole feed is still fetched and processed; this bounds the reply only."`
	MaxContentChars int      `json:"max_content_chars,omitempty" jsonschema:"Truncate each article's content to this many characters (never mid-character). Default 5000; a negative value disables truncation."`
}

type previewArticleOut struct {
	Title     string `json:"title,omitempty" jsonschema:"Processed article title."`
	Link      string `json:"link,omitempty" jsonschema:"Article URL at its origin."`
	Published int64  `json:"published,omitempty" jsonschema:"Publisher's date, unix seconds; 0 when the source item carried no date."`
	Content   string `json:"content,omitempty" jsonschema:"Article HTML exactly as the pipeline would store it, possibly truncated (see truncated)."`
	Truncated bool   `json:"truncated,omitempty" jsonschema:"True when content was cut at max_content_chars."`
}

type previewFeedOut struct {
	Articles []previewArticleOut `json:"articles" jsonschema:"The previewed articles, in the order the source produced them, at most limit of them."`
	Total    int                 `json:"total" jsonschema:"How many articles the fetch+pipeline produced in total, before limit was applied."`
}

// mcpPreviewFeed wraps renderPreview (cmd_preview.go) — the same code path as
// `srr preview` and GET /api/preview — in a read-only, unlocked DB scope (it
// reads only the recipes map). Nothing is stored: this is a dry run.
func mcpPreviewFeed(ctx context.Context, _ *mcp.CallToolRequest, in previewFeedIn) (*mcp.CallToolResult, previewFeedOut, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = mcpDefaultPreviewLimit
	}
	maxChars := in.MaxContentChars
	if maxChars == 0 {
		maxChars = mcpDefaultPreviewChars
	}

	var items []*Item
	err := withDBCtx(ctx, false, func(ctx context.Context, db *DB) error {
		var e error
		items, e = renderPreview(ctx, db.core.Recipes, in.Recipe, in.Pipe, in.Ingest, in.URL)
		return e
	})
	if err != nil {
		return nil, previewFeedOut{}, mcpToolErr(err)
	}

	out := previewFeedOut{Articles: []previewArticleOut{}, Total: len(items)}
	for _, i := range items {
		if len(out.Articles) >= limit {
			break
		}
		content, cut := truncateRunes(i.Content, maxChars)
		out.Articles = append(out.Articles, previewArticleOut{
			Title:     i.Title,
			Link:      i.Link,
			Published: i.Published,
			Content:   content,
			Truncated: cut,
		})
	}
	return nil, out, nil
}

// --- srr_resolve_feed -------------------------------------------------------

type resolveFeedIn struct {
	URL    string `json:"url" jsonschema:"Feed or homepage URL to probe. PERFORMS AN OUTBOUND REQUEST to this URL. A homepage advertising a feed via <link rel=alternate> folds to that feed's URL."`
	Recipe string `json:"recipe,omitempty" jsonschema:"Probe through this named recipe's ingest strategy. Omit for the reserved default recipe."`
	Ingest string `json:"ingest,omitempty" jsonschema:"Ad-hoc ingest override with feed-level semantics (wins over the recipe's): the built-in \"#feed\" or an external shell command."`
}

type resolveFeedOut struct {
	URL   string `json:"url" jsonschema:"The canonical feed URL: the input when it already serves a feed, or the discovered feed the input page advertises. Pass this to srr_add_feed."`
	Title string `json:"title,omitempty" jsonschema:"The feed's own channel-level title, a good default for the subscription title."`
	Items int    `json:"items" jsonschema:"How many items the feed currently carries — a quick liveness signal."`
}

// mcpResolveFeed wraps previewFetch (cmd_preview.go) behind the same
// validFeedURL gate the GUI's /api/resolve uses, in a read-only, unlocked DB
// scope. It is advisory: srr_add_feed re-resolves server-side, so a failed
// probe here never blocks an add.
func mcpResolveFeed(ctx context.Context, _ *mcp.CallToolRequest, in resolveFeedIn) (*mcp.CallToolResult, resolveFeedOut, error) {
	if !validFeedURL(in.URL) {
		return nil, resolveFeedOut{}, fmt.Errorf("invalid url %q", in.URL)
	}
	var out resolveFeedOut
	err := withDBCtx(ctx, false, func(ctx context.Context, db *DB) error {
		res, e := previewFetch(ctx, db.core.Recipes, in.Recipe, in.Ingest, in.URL)
		if e != nil {
			return e
		}
		out.URL = res.ResolvedURL
		if out.URL == "" {
			out.URL = in.URL
		}
		out.Title = res.Title
		out.Items = len(res.Items)
		return nil
	})
	if err != nil {
		return nil, resolveFeedOut{}, mcpToolErr(err)
	}
	return nil, out, nil
}

// --- srr_add_feed / srr_update_feed ----------------------------------------

// feedOut carries the stored feed exactly as the admin console lists it. Like
// overviewOut it is a one-field wrapper, so listViewOf stays the single
// definition of the feed's read shape.
type feedOut struct {
	Feed feedListView `json:"feed" jsonschema:"The stored feed after the write: its assigned id, title, url (already folded to the discovered feed URL if the input was a homepage), tag, recipe, per-feed ingest/pipe overrides, no_title, expire_days, dedup_days/dedup_title, plus the server-owned fetch-health vitals and counters."`
}

type addFeedIn struct {
	Title      string   `json:"title" jsonschema:"Subscription title. Required and cannot be empty — srr_resolve_feed's title is a good default."`
	URL        string   `json:"url" jsonschema:"Feed URL. PERFORMS AN OUTBOUND REQUEST: subscribe-time discovery probes it, so a homepage URL is folded to the feed it advertises and an unreachable/unparseable URL rejects the add."`
	Tag        string   `json:"tag,omitempty" jsonschema:"Tag for grouping. Hierarchical with \"/\" (e.g. \"news/tech\"). Omit for untagged."`
	Recipe     string   `json:"recipe,omitempty" jsonschema:"Name of an existing recipe to process this feed with. Omit for the reserved default recipe; an unknown name is rejected."`
	Ingest     string   `json:"ingest,omitempty" jsonschema:"Feed-level ingest override on top of the recipe: the built-in \"#feed\" or an external shell command."`
	Pipe       []string `json:"pipe,omitempty" jsonschema:"Feed-level processing pipeline override on top of the recipe, one step per entry. #default expands inline to the recipe's effective pipe."`
	NoTitle    bool     `json:"no_title,omitempty" jsonschema:"Mark as a titleless microblog-style feed; the reader then hides the per-article heading."`
	ExpireDays int      `json:"expire_days,omitempty" jsonschema:"Retention window in days: articles ingested longer ago than this are expired each cycle. 0 (default) keeps forever; maximum 36500."`
	DedupDays  int      `json:"dedup_days,omitempty" jsonschema:"Per-feed dedup horizon in days. 0 (default) inherits the store-wide default; -1 disables the persistent dedup pool for this feed."`
	DedupTitle bool     `json:"dedup_title,omitempty" jsonschema:"Also dedup by folded title, catching a re-publish that carries a fresh guid but the same headline."`
}

// mcpAddFeed creates one feed through the shared two-phase upsert below, which
// mirrors handleFeedSave (serve_feeds.go) exactly.
func mcpAddFeed(ctx context.Context, _ *mcp.CallToolRequest, in addFeedIn) (*mcp.CallToolResult, feedOut, error) {
	return mcpSaveFeedView(ctx, func(*DB) (*feedView, error) {
		// Nil ID ⇒ create.
		return &feedView{
			Title:      in.Title,
			URL:        in.URL,
			Tag:        in.Tag,
			Recipe:     in.Recipe,
			Ingest:     in.Ingest,
			Pipe:       in.Pipe,
			NoTitle:    in.NoTitle,
			ExpireDays: in.ExpireDays,
			DedupDays:  in.DedupDays,
			DedupTitle: in.DedupTitle,
		}, nil
	})
}

type updateFeedIn struct {
	ID int `json:"id" jsonschema:"Id of the feed to update. Required. Ids come from srr_overview."`
	// MERGE-ON-ABSENT: every other field is a pointer, and only the ones
	// actually present in the call are applied — see overlayUpdateFeed.
	Title      *string   `json:"title,omitempty" jsonschema:"New title. Omit to keep the current one; it cannot be set to empty."`
	URL        *string   `json:"url,omitempty" jsonschema:"New feed URL. Omit to keep the current one. CHANGING IT PERFORMS AN OUTBOUND REQUEST (subscribe-time discovery) and RESETS the feed's fetch state — etag, watermark and dedup memory — because a new source shares no history."`
	Tag        *string   `json:"tag,omitempty" jsonschema:"New tag; pass \"\" to clear it. Omit to keep the current one."`
	Recipe     *string   `json:"recipe,omitempty" jsonschema:"Name of an existing recipe; pass \"\" to fall back to the reserved default. Omit to keep the current one."`
	Ingest     *string   `json:"ingest,omitempty" jsonschema:"Feed-level ingest override; pass \"\" to clear it (inheriting the recipe's). Omit to keep the current one."`
	Pipe       *[]string `json:"pipe,omitempty" jsonschema:"Feed-level pipeline override, one step per entry; pass an empty array to clear it (inheriting the recipe's). Omit to keep the current one."`
	NoTitle    *bool     `json:"no_title,omitempty" jsonschema:"Titleless microblog-style flag. Omit to keep the current value."`
	ExpireDays *int      `json:"expire_days,omitempty" jsonschema:"Retention window in days; 0 keeps forever, maximum 36500. Omit to keep the current value."`
	DedupDays  *int      `json:"dedup_days,omitempty" jsonschema:"Per-feed dedup horizon in days; 0 inherits the store default, -1 disables the pool. Omit to keep the current value."`
	DedupTitle *bool     `json:"dedup_title,omitempty" jsonschema:"Also dedup by folded title. Omit to keep the current value."`
}

// mcpUpdateFeed loads the feed's current view, overlays only the fields the
// call actually supplied (see overlayUpdateFeed), and runs the very same
// two-phase save as mcpAddFeed.
func mcpUpdateFeed(ctx context.Context, _ *mcp.CallToolRequest, in updateFeedIn) (*mcp.CallToolResult, feedOut, error) {
	return mcpSaveFeedView(ctx, func(db *DB) (*feedView, error) {
		ch, err := db.FeedByID(in.ID)
		if err != nil {
			return nil, err
		}
		v := viewOf(ch) // non-nil ID ⇒ update
		overlayUpdateFeed(v, in)
		return v, nil
	})
}

// overlayUpdateFeed applies srr_update_feed's MERGE-ON-ABSENT semantics onto
// the feed's current view: only the fields the call actually supplied are
// written, everything else keeps its stored value.
//
// This is a DELIBERATE deviation from the GUI's full-replace contract (the edit
// modal always posts every field). A tool caller composes a partial JSON object
// naturally, so "field absent" has to mean "keep" — under full-replace, asking
// to change a tag would silently wipe the feed's pipe, retention and dedup
// settings. Where the CLI convention allows a value to be cleared, an EXPLICIT
// empty value still clears it; that is exactly what the pointers buy — the
// difference between "not mentioned" and "set to empty".
func overlayUpdateFeed(v *feedView, in updateFeedIn) {
	if in.Title != nil {
		v.Title = *in.Title
	}
	if in.URL != nil {
		v.URL = *in.URL
	}
	if in.Tag != nil {
		v.Tag = *in.Tag
	}
	if in.Recipe != nil {
		v.Recipe = *in.Recipe
	}
	if in.Ingest != nil {
		v.Ingest = *in.Ingest
	}
	if in.Pipe != nil {
		v.Pipe = *in.Pipe
	}
	if in.NoTitle != nil {
		v.NoTitle = *in.NoTitle
	}
	if in.ExpireDays != nil {
		v.ExpireDays = *in.ExpireDays
	}
	if in.DedupDays != nil {
		v.DedupDays = *in.DedupDays
	}
	if in.DedupTitle != nil {
		v.DedupTitle = *in.DedupTitle
	}
}

// mcpSaveFeedView is the two-phase upsert both feed-writing tools share, the
// same split handleFeedSave (serve_feeds.go) performs: resolve (networked,
// unlocked) then save (locked), so a slow feed URL never holds .locked — which
// would 409 the fetch loop and every other writer for the probe's duration.
// build produces the target view inside phase 1's read-only scope, so an
// update's merge base and its discovery probe come from ONE consistent db.gz
// read. A nil view ID ⇒ create, non-nil ⇒ update.
func mcpSaveFeedView(ctx context.Context, build func(db *DB) (*feedView, error)) (*mcp.CallToolResult, feedOut, error) {
	// Phase 1 (no lock): build the view, validate it, run subscribe-time discovery.
	var v *feedView
	if err := withDBCtx(ctx, false, func(ctx context.Context, db *DB) error {
		built, e := build(db)
		if e != nil {
			return e
		}
		v = built
		return resolveFeedViewURL(ctx, db, v)
	}); err != nil {
		return nil, feedOut{}, mcpToolErr(err)
	}
	// Phase 2 (locked): apply the write with the already-resolved URL.
	var saved *Feed
	if err := withDBCtx(ctx, true, func(ctx context.Context, db *DB) error {
		s, e := saveFeed(ctx, db, v)
		saved = s
		return e
	}); err != nil {
		return nil, feedOut{}, mcpToolErr(err)
	}
	return nil, feedOut{Feed: listViewOf(saved)}, nil
}

// --- srr_fetch --------------------------------------------------------------

type fetchIn struct {
	FeedIDs []int `json:"feed_ids,omitempty" jsonschema:"Restrict the cycle to these feed ids. Omit to fetch every feed. An unknown id fails the whole cycle."`
}

type fetchOut struct {
	NewArticles int            `json:"new_articles" jsonschema:"How many new articles this cycle ingested across all fetched feeds."`
	Fetched     int            `json:"fetched" jsonschema:"How many feeds completed without an error."`
	Failed      int            `json:"failed" jsonschema:"How many feeds reported a fetch error. A failed feed does not fail the cycle — its error is recorded on the feed."`
	Feeds       []feedProgress `json:"feeds" jsonschema:"Per-feed outcome, sorted by feed id: id, title, new (articles ingested) and error (empty when the feed succeeded)."`
}

// mcpFetch wraps the very cycle `srr art fetch` and the GUI's fetch button
// run: runFetch under runCycleSafe (so a bad cycle returns an error instead of
// taking the process down), on a per-call SSRF-guarded client.
//
// It holds the store lock for the cycle's whole duration and can run for
// minutes with no intermediate output — the stateless+JSON transport forgoes
// progress notifications, which stay an additive future change. Cancellation
// is honest: ctx threads into runFetch and the lock is released by db.Close.
func mcpFetch(ctx context.Context, _ *mcp.CallToolRequest, in fetchIn) (*mcp.CallToolResult, fetchOut, error) {
	client := newFetchClient(globals.Workers)
	// Per-call transport: drop its idle keep-alive sockets now rather than
	// letting them linger ~90s, so repeated tool calls don't pile up sockets.
	defer client.CloseIdleConnections()

	// onFeed fires from the fan-out's worker goroutines, so the collector is
	// mutex-guarded; the slice is sorted by id afterwards for a stable reply.
	var mu sync.Mutex
	progress := []feedProgress{}
	fc := &FetchCmd{only: in.FeedIDs}
	err := runCycleSafe(func() error {
		return fc.runFetch(ctx, client, func(p feedProgress) {
			mu.Lock()
			progress = append(progress, p)
			mu.Unlock()
		})
	})
	if err != nil {
		return nil, fetchOut{}, mcpToolErr(err)
	}
	sort.Slice(progress, func(i, j int) bool { return progress[i].ID < progress[j].ID })

	out := fetchOut{Feeds: progress}
	for _, p := range progress {
		if p.Error != "" {
			out.Failed++
		} else {
			out.Fetched++
		}
		out.NewArticles += p.New
	}
	return nil, out, nil
}

// --- registry ---------------------------------------------------------------

// readOnlyTool is the annotation set for a tool that only reads: explicitly
// non-destructive, and explicitly closed- or open-world depending on whether it
// makes outbound requests. Both of those hints are pointers defaulting to TRUE,
// so they must be stated.
func readOnlyTool(openWorld bool) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		ReadOnlyHint:    true,
		IdempotentHint:  true,
		DestructiveHint: hintPtr(false),
		OpenWorldHint:   hintPtr(openWorld),
	}
}

// previewTool annotates srr_preview_feed / srr_resolve_feed. They read NOTHING
// from the store, but they are NOT read-only and NOT idempotent: they make
// outbound requests and run the feed's ingest/pipe, which — exactly as `srr
// preview` allows — may be arbitrary SHELL commands supplied in the tool's
// `ingest`/`pipe` params (no #-builtin gate on this path). A client must not
// treat them as side-effect-free and auto-approve them; ReadOnlyHint:true
// (which readOnlyTool sets) is what invites that. DestructiveHint is left at the
// SDK's pointer default (true) because a pipe step can have host side effects,
// and OpenWorldHint is true (outbound).
func previewTool() *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		ReadOnlyHint:   false,
		IdempotentHint: false,
		OpenWorldHint:  hintPtr(true),
	}
}

// addMCPTools registers every srr tool on s. Names carry the `srr_` prefix so
// they stay unambiguous in a client session that has other servers loaded.
func addMCPTools(s *mcp.Server) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_list_articles",
		Title:       "List stored articles",
		Description: "List articles already stored in the SRR feed store, newest first, with optional feed/tag, title-query and time-window filters and cursor pagination. Reads the store only — no outbound requests, nothing is fetched or modified. Content is omitted unless include_content is set. Note: an exact match count with `query` reads every data pack in the window, so pair `query` with `since` on a large store.",
		Annotations: readOnlyTool(false),
	}, mcpListArticles)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_overview",
		Title:       "Store overview",
		Description: "Whole-store snapshot in a single read: every feed with its configuration and fetch-health vitals, the tag buckets, the named processing recipes, the syndication slots, and the store-wide counters. Start here to learn feed ids, tags and recipe names for the other tools. Reads the store only — no outbound requests, nothing is modified.",
		Annotations: readOnlyTool(false),
	}, mcpOverview)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_preview_feed",
		Title:       "Preview a feed through a recipe",
		Description: "Dry-run a URL through SRR's ingest and processing pipeline and return the articles it WOULD store, without storing anything. Use it to check how a candidate subscription renders, or to test a recipe/pipe change before applying it. PERFORMS OUTBOUND REQUESTS: it fetches the given URL, and pipeline steps such as #readability or #selfhost fetch the linked article pages and their media.",
		Annotations: previewTool(),
	}, mcpPreviewFeed)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_resolve_feed",
		Title:       "Resolve a feed URL",
		Description: "Probe a URL and report the canonical feed URL, the feed's own title and its current item count — the cheap look-before-you-subscribe check. A homepage that advertises a feed folds to that feed's URL. PERFORMS AN OUTBOUND REQUEST to the given URL. Reads nothing from and writes nothing to the store; advisory only, since srr_add_feed re-resolves server-side.",
		Annotations: previewTool(),
	}, mcpResolveFeed)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_add_feed",
		Title:       "Add a feed",
		Description: "Subscribe to a new feed. Additive: it creates a feed and never alters or removes an existing one. PERFORMS AN OUTBOUND REQUEST — subscribe-time discovery probes the URL, folding a homepage to the feed it advertises and rejecting an unresolvable one. Briefly takes the store lock, so it can report that the store is busy mid-fetch-cycle; retry then.",
		Annotations: &mcp.ToolAnnotations{
			// Writes, but only ever adds a feed — nothing existing is touched.
			// Not idempotent: calling twice creates two subscriptions.
			DestructiveHint: hintPtr(false),
			OpenWorldHint:   hintPtr(true),
		},
	}, mcpAddFeed)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_update_feed",
		Title:       "Update a feed",
		Description: "Change an existing feed's settings. MERGE SEMANTICS: only the fields you supply are changed, everything omitted is kept as-is. Destructive in that supplied fields overwrite stored values — and changing `url` additionally resets the feed's etag/watermark/dedup state. Changing `url` PERFORMS AN OUTBOUND REQUEST (subscribe-time discovery). Briefly takes the store lock, so it can report that the store is busy mid-fetch-cycle; retry then.",
		Annotations: &mcp.ToolAnnotations{
			// Overwrites stored settings, so destructive; but re-applying the
			// same arguments lands on the same state, so idempotent. Open-world
			// because a url change probes the network.
			DestructiveHint: hintPtr(true),
			IdempotentHint:  true,
			OpenWorldHint:   hintPtr(true),
		},
	}, mcpUpdateFeed)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "srr_fetch",
		Title:       "Run a fetch cycle",
		Description: "Run one full fetch cycle now — poll the feeds, process and store new articles, then run the store's maintenance (retention/expiry, derived summaries, syndication outputs). Optionally restricted to specific feed ids. PERFORMS OUTBOUND REQUESTS to every selected feed and, depending on the pipelines, to article pages and media. Holds the store lock for the whole cycle and may run for minutes with no intermediate progress; if another srr process holds the lock it reports that the store is busy. NOT idempotent — each call ingests whatever is new and advances retention.",
		Annotations: &mcp.ToolAnnotations{
			// Expiry deletes assets and advances each feed's retention frontier,
			// so the cycle is genuinely destructive; and every call does more
			// work, so it is not idempotent.
			DestructiveHint: hintPtr(true),
			OpenWorldHint:   hintPtr(true),
		},
	}, mcpFetch)
}
