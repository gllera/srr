package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	"srr/ingest"
	"srr/mod"

	"golang.org/x/sync/errgroup"
)

// maxBoundaryGUIDs caps the persisted per-feed BoundaryGUIDs array. Real
// publishers expose at most a few hundred items per response; without a cap,
// one misbehaving feed (thousands of dateless or same-second items) bloats
// db.gz — the one no-cache object every reader polls — permanently. See the
// cap logic in fetchURL for the over-cap semantics.
const maxBoundaryGUIDs = 1024

// pipeDefault is the token expanded inline to the next pipe down the fallback
// chain at the position where it appears in a Pipe slice: in a recipe's pipe
// it means the default recipe's pipe, in a feed's pipe the feed's effective
// recipe pipe.
const pipeDefault = "#default"

// resolvePipe composes the effective pipeline by expanding "#default"
// tokens in override to base (the next pipe down the fallback chain). An
// empty override (nil or []) inherits base; a non-empty override replaces it.
// Chained once per level — resolvePipe(resolvePipe(def, recipe), feed) — so a
// feed pipe's #default expands to its recipe's effective pipe.
func resolvePipe(base, override []string) []string {
	if len(override) == 0 {
		return base
	}
	out := make([]string, 0, len(override)+len(base))
	for _, m := range override {
		if m == pipeDefault {
			out = append(out, base...)
		} else {
			out = append(out, m)
		}
	}
	return out
}

type Feed struct {
	id           int
	Title        string `json:"title"`
	URL          string `json:"url"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	// Watermark is the max published unix-second ever seen across fetches.
	Watermark int64 `json:"wm,omitempty"`
	// BoundaryGUIDs is the GUIDs from the most recent non-empty fetch whose
	// pub is >= Watermark (the dated boundary, incl. re-dated items bumped above
	// the unraised watermark) or == 0 (dateless).
	// Repopulated each non-empty fetch from the current response so its size
	// stays bounded by what the publisher currently exposes, and hard-capped
	// at maxBoundaryGUIDs (over-cap items are skipped, not ingested); a 200 OK
	// with zero items leaves the field untouched so a transient empty feed
	// doesn't drop dedup state.
	BoundaryGUIDs []uint32 `json:"bg,omitempty"`
	FetchError    string   `json:"ferr,omitempty"`
	// LastOK is the unix-second of the last successful fetch (including 304
	// Not-Modified). Zero when the feed has never been fetched successfully.
	LastOK int64 `json:"last_ok,omitempty"`
	// FailStreak is the number of consecutive fetch failures. Reset to 0 on any
	// success (including 304 Not-Modified). Incremented on each failure.
	FailStreak int `json:"fail_streak,omitempty"`
	// LastNew is the unix-second of the last fetch that ingested ≥1 new article.
	// Not updated on 304 or on a 200 with zero new items.
	LastNew int64  `json:"last_new,omitempty"`
	Tag     string `json:"tag,omitempty"`
	// Recipe is the name of the {ingest, pipe} recipe this feed uses. Empty
	// resolves to the "default" recipe (recipeFor). A dangling name is tolerated
	// at read time (⇒ default) but the CLI refuses to create one.
	Recipe string `json:"recipe,omitempty"`
	// Ingest is the feed-level ingest override: built-in ("#feed") or shell
	// command. Set it wins over the recipe's ingest (and the default's); empty
	// inherits the recipe (ingest.Select). Note: the pre-recipes format used the
	// same JSON key for its per-feed ingest, so loading an ancient db.gz revives
	// that value as an override — accepted, the meaning is the same.
	Ingest string `json:"ingest,omitempty"`
	// Pipe is the feed-level pipeline override. Empty inherits the feed's
	// effective recipe pipe; non-empty replaces it, with "#default" expanding
	// inline to that recipe pipe (resolvePipe, chained per level). Same
	// pre-recipes key-revival note as Ingest.
	Pipe []string `json:"pipe,omitempty"`
	// NoTitle marks a feed whose article titles duplicate the content lead
	// (microblog sources like Telegram, where the title is the first line of the
	// body). The reader hides the heading for these; the home list still uses the
	// title as its row label. Set out-of-band via `feed apply`/`edit` — the
	// external-ingest protocol emits articles, not feed config.
	NoTitle bool `json:"nt,omitempty"`
	// ExpireDays is the per-feed retention window in days: each fetch cycle
	// expires this feed's articles fetched more than ExpireDays·24h ago —
	// their assets/ objects are deleted and AddIdx is bumped past them (see
	// db_expire.go). 0 = keep forever (the default).
	ExpireDays int `json:"exp,omitempty"`
	// Expired is the cumulative count of this feed's expired idx entries (the
	// entries in [incarnation start, AddIdx)). Finalized idx headers are
	// immutable all-time cumulative counts (writeIdxHeader sources them from
	// TotalArt), so readers subtract Expired to count only visible articles.
	// Starts at 0 on AddFeed (id reuse included); never decreases otherwise.
	Expired  int `json:"xp,omitempty"`
	TotalArt int `json:"total_art"`
	AddIdx   int `json:"add_idx"`
	newItems []*Item
}

func (c *Feed) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int("id", c.id),
		slog.String("title", c.Title),
	)
}

// fetchRun bundles the run-scoped dependencies shared by every feed in a
// single fetch: built once in FetchCmd.fetch and concurrent-safe, so one
// *fetchRun is shared across all workers. The genuinely per-worker values (the
// pooled read buffer and module processor) stay separate call parameters.
type fetchRun struct {
	client *http.Client
	engine *ingest.Fetcher
	// assets is the content-addressed uploader for files a fetcher self-hosts
	// into cacheDir; fetchURL's end-of-pipeline step calls UploadCacheRef on it.
	assets *assetFetcher
	// cacheDir is the single download/working dir shared by every feed this
	// run, built once in FetchCmd.fetch (always non-empty). Any fetcher (built-in
	// or external) may stash files here and self-host them, owning the layout
	// inside.
	cacheDir  string
	fetchedAt int64
	// maxAssetSize is the self-hosted-object size cap in bytes (--max-asset-size),
	// passed to each ingest Request so an external fetcher enforces it at download.
	// Set from assets.maxBytes (already converted from KB) to avoid a redundant
	// KB→bytes step.
	maxAssetSize int
	// recipes is the full db.gz recipes map, read-only during a fetch run;
	// each feed resolves its recipe (and the default) from it.
	recipes map[string]Recipe
}

func (c *Feed) Fetch(ctx context.Context, run *fetchRun, buf []byte, processor *mod.Module) {
	c.newItems = c.newItems[:0]
	// Expose the run's shared asset cache dir to pipeline mods (e.g. #selfhost)
	// via context, so a built-in can download media into it and emit upload
	// markers. Set before Validate so every downstream step (and the throwaway
	// Validate run) sees it; srr preview never sets it, so #selfhost no-ops there.
	ctx = mod.WithCacheDir(ctx, run.cacheDir)
	r := recipeFor(run.recipes, c.Recipe)
	def := recipeFor(run.recipes, defaultRecipeName)
	pipe := resolvePipe(resolvePipe(def.Pipe, r.Pipe), c.Pipe)
	// Validate the resolved pipeline once, before the item loop. A bad token
	// (unknown built-in, stray #default, malformed params) is a config error that
	// would fail identically for every item; surface it loudly here instead of
	// letting fetchURL skip every item one by one.
	if err := processor.Validate(ctx, pipe); err != nil {
		err = fmt.Errorf("invalid pipeline %v: %w", pipe, err)
		slog.Error("feed pipeline invalid; skipping fetch", "feed", c, "err", err)
		c.FetchError = err.Error()
		c.FailStreak++
		return
	}
	ingestName := ingest.Select(c.Ingest, r.Ingest, def.Ingest)
	items, err := c.fetchURL(ctx, run, buf, processor, pipe, ingestName)
	if err != nil {
		c.FetchError = err.Error()
		c.FailStreak++
		slog.Error("feed fetch failed", "feed", c, "url", c.URL, "err", err)
		return
	}
	c.FetchError = ""
	c.LastOK = run.fetchedAt
	c.FailStreak = 0
	c.newItems = append(c.newItems, items...)
}

// fetchURL routes the feed's single URL through the selected FetchFunc so
// the dedup / watermark / pipeline path stays uniform across the built-in
// (#feed) and external ingest strategies. ingestName is resolved once by
// Feed.Fetch before this is called.
func (c *Feed) fetchURL(ctx context.Context, run *fetchRun, buf []byte, processor *mod.Module, pipeline []string, ingestName string) ([]*Item, error) {
	slog.Debug("downloading feed", "url", c.URL, "feed", c)

	// Every fetcher gets the run's shared cache dir as its working directory
	// (Request.AssetDir, always non-empty here — created in FetchCmd.fetch) and
	// may self-host files it leaves there: the post-pipeline upload step below
	// scans each item for "#"-markers naming a real file in the dir and uploads
	// them. Built-in or external, the fetcher owns the layout inside.
	result, err := run.engine.Fetch(ctx, ingestName, run.client, buf, ingest.Request{
		URL:          c.URL,
		ETag:         c.ETag,
		LastModified: c.LastModified,
		MaxSize:      cap(buf) - 1,
		MaxAssetSize: run.maxAssetSize,
		AssetDir:     run.cacheDir,
	})
	if err != nil {
		return nil, fmt.Errorf("ingest %q: %w", ingestName, err)
	}

	// Auto-discovery repoint: the #feed fetcher found a feed URL embedded in an
	// HTML page and fetched from that URL instead. Persist the repoint so the
	// next fetch goes directly to the feed without rediscovering. We do NOT call
	// setFeedURL here — that would reset dedup/etag/vitals. This is the same
	// logical feed, just with the canonical URL now known.
	if result.ResolvedURL != "" && result.ResolvedURL != c.URL {
		slog.Info("feed URL repointed via auto-discovery", "feed", c, "old_url", c.URL, "new_url", result.ResolvedURL)
		c.URL = result.ResolvedURL
	}

	if result.NotModified {
		return nil, nil
	}

	// A 200 OK with zero items (e.g. transient empty feed) advances
	// the HTTP cache headers but leaves Watermark/BoundaryGUIDs untouched,
	// so prior items still dedup when the feed recovers.
	if len(result.Items) == 0 {
		c.ETag = result.ETag
		c.LastModified = result.LastModified
		return nil, nil
	}

	// Back-dated items below Watermark are not recovered (single-cursor
	// limitation), and watermark-second or dateless items that disappear
	// from the feed and reappear are re-ingested as duplicates (snapshot
	// semantics over carry-over). The stale-response guard below removes the
	// common flap — a stale cache copy predating every watermark item — but a
	// response that keeps one watermark sibling while dropping another still
	// re-ingests the dropped one.
	priorWatermark := c.Watermark
	priorBoundary := uint32Set(c.BoundaryGUIDs)

	maxPub := priorWatermark
	boundary := make(map[uint32]int64)

	// Stale-response detection inputs, gathered over first occurrences of
	// every GUID (seen or not — a response containing the watermark item at
	// its original pub proves it is fresh enough).
	var maxSeen int64
	var hasDateless bool

	// First pass: cheap dedup/watermark classification over the whole
	// response, no pipeline work yet. The boundary cap below must see the
	// complete fetch before any item is committed to ingestion.
	type candidate struct {
		item *mod.RawItem
		pub  int64
	}
	var candidates []candidate
	for _, i := range result.Items {
		// An external ingest strategy returns items as a JSON array; a null
		// element decodes to a nil *mod.RawItem. Skip it before any field access
		// — otherwise i.GUID below panics, and (with no recover in the worker)
		// crashes the whole fetch process, taking every feed down with it.
		if i == nil {
			continue
		}
		// Skip subsequent occurrences of the same GUID first so a within-fetch
		// duplicate cannot pollute boundary or maxPub with a stale pub.
		if _, dup := boundary[i.GUID]; dup {
			continue
		}

		var pubUnix int64
		if i.Published != nil {
			if u := i.Published.Unix(); u > 0 {
				// Clamp future-dated items so a publisher CMS bug
				// (year-2099 default) can't push Watermark past now and
				// silently swallow every subsequent real item.
				pubUnix = min(u, run.fetchedAt)
			}
		}

		boundary[i.GUID] = pubUnix

		if pubUnix == 0 {
			hasDateless = true
		} else if pubUnix > maxSeen {
			maxSeen = pubUnix
		}

		if _, prev := priorBoundary[i.GUID]; prev {
			// A GUID we have already seen: keep deduping it, but do NOT let a
			// publisher re-dating an existing post raise Watermark. Otherwise a
			// genuinely-new article later dated between the old and the bumped
			// value is permanently and silently dropped by the watermark check.
			continue
		}
		// Only newly-seen items advance the watermark.
		if pubUnix > maxPub {
			maxPub = pubUnix
		}
		if pubUnix != 0 && pubUnix < priorWatermark {
			continue
		}
		candidates = append(candidates, candidate{i, pubUnix})
	}

	// Stale-response guard: a 200 whose newest dated item sits strictly below
	// the watermark is a stale copy of the feed (a flappy CDN cache serving an
	// older generation), not new content. Every dated item in it would be
	// skipped by the watermark check anyway, but rebuilding the boundary
	// snapshot from it evicts the watermark items' GUIDs — so the fresh copy
	// one cycle later re-ingests them as duplicates. Ignore it wholesale,
	// preserving Watermark/BoundaryGUIDs and the HTTP validators. Dateless
	// items bypass the watermark by design, so any dateless presence means
	// the response may carry new content and disables the guard.
	if maxSeen > 0 && maxSeen < priorWatermark && !hasDateless {
		slog.Warn("ignoring stale feed response", "url", c.URL, "newest", maxSeen, "watermark", priorWatermark)
		return nil, nil
	}

	bg := make([]uint32, 0, len(boundary))
	for g, p := range boundary {
		// Keep dateless GUIDs and everything at or above the watermark so they
		// dedup next fetch. ">= maxPub" (not "==") also retains a re-dated
		// existing item whose bumped pub exceeds the (deliberately unraised)
		// watermark, so it stays deduped instead of re-ingesting.
		if p == 0 || p >= maxPub {
			bg = append(bg, g)
		}
	}
	slices.Sort(bg)

	// Cap bg at maxBoundaryGUIDs. When over cap, prefer retaining GUIDs that
	// are already in priorBoundary (already stored) before filling remaining
	// slots with the smallest hashes of the rest. This prevents re-ingestion
	// of already-stored items: under the pure smallest-hash rule a batch of
	// new items with smaller hashes would evict high-hash stored items from bg
	// even though those items were already ingested — they would then look new
	// on the very next fetch and duplicate forever.
	//
	// Partition order: bg is sorted ascending; walk it once to separate prior
	// GUIDs (already stored) from rest (new or unknown), preserving sort order
	// within each group. Keep all prior GUIDs first (up to cap), then fill
	// remaining slots with the smallest-hash rest items. Dropped GUIDs must
	// not be ingested at all (the gate in the second pass below):
	// ingested-but-unremembered items duplicate on every subsequent fetch.
	var dropped map[uint32]struct{}
	if len(bg) > maxBoundaryGUIDs {
		slog.Warn("boundary GUIDs over cap, skipping over-cap items", "url", c.URL, "total", len(bg), "cap", maxBoundaryGUIDs)
		prior := bg[:0:0] // already-stored GUIDs from bg (sorted)
		rest := bg[:0:0]  // new GUIDs from bg (sorted)
		for _, g := range bg {
			if _, ok := priorBoundary[g]; ok {
				prior = append(prior, g)
			} else {
				rest = append(rest, g)
			}
		}
		// Keep all prior up to cap, then fill with smallest-hash rest.
		kept := make([]uint32, 0, maxBoundaryGUIDs)
		kept = append(kept, prior...)
		if len(kept) > maxBoundaryGUIDs {
			kept = kept[:maxBoundaryGUIDs]
		}
		remaining := maxBoundaryGUIDs - len(kept)
		if remaining > len(rest) {
			remaining = len(rest)
		}
		kept = append(kept, rest[:remaining]...)
		slices.Sort(kept) // restore sorted order for deterministic bg
		dropped = make(map[uint32]struct{}, len(bg)-len(kept))
		for _, g := range bg {
			dropped[g] = struct{}{}
		}
		for _, g := range kept {
			delete(dropped, g)
		}
		bg = kept
	}

	// Second pass: run the module pipeline for the items committed to ingestion.
	// Asset self-hosting (the "#"-marker upload) is deferred to uploadAssets below
	// so it can run concurrently across the feed's items.
	var items []*Item
	for _, cand := range candidates {
		i := cand.item
		// Only bg-class items (dateless or at/above the new watermark) can be
		// in dropped — anything below maxPub is protected by Watermark itself
		// next fetch and needs no bg slot.
		if _, skip := dropped[i.GUID]; skip {
			continue
		}

		if err := processItem(ctx, processor, pipeline, i); err != nil {
			// One bad item must not discard the whole feed's batch. Config
			// errors (unknown pipe token / bad params) are caught up front by
			// Module.Validate in Feed.Fetch, so an error here is a per-item
			// runtime failure: skip just this item. It stays recorded in
			// boundary, so it is not retried next fetch.
			slog.Warn("dropping item: pipeline error", "url", c.URL, "link", i.Link, "err", err)
			continue
		}
		// A pipeline step may deliberately drop an item by setting i.Drop=true
		// (e.g. #filter or an external mod emitting {"drop":true}). The item
		// is NOT appended to items and NOT asset-uploaded, but its GUID was
		// already recorded in boundary above, so it stays in BoundaryGUIDs and
		// is not re-evaluated on subsequent fetches — identical to the existing
		// per-item skip behaviour above.
		if i.Drop {
			continue
		}
		items = append(items, &Item{
			Feed:      c,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: cand.pub,
		})
	}

	// Store-side end-of-pipeline step (kept out of processItem, which stays a
	// pure, store-free transform): self-host each item's "#"-marked assets.
	if err := run.uploadAssets(ctx, items); err != nil {
		return nil, err
	}

	if len(items) > 0 {
		c.LastNew = run.fetchedAt
	}
	c.Watermark = maxPub
	c.BoundaryGUIDs = bg
	c.ETag = result.ETag
	c.LastModified = result.LastModified
	return items, nil
}

// uploadAssets is the end-of-pipeline self-hosting step: it rewrites each item's
// "#"-upload markers to their final assets/ store keys (the per-item work lives
// in rewriteItemAssets). Marker-bearing items are processed concurrently;
// marker-less items are skipped without spawning a goroutine (the common case:
// #feed feeds emit no markers). The run-global asset worker pool lives on the
// shared assetFetcher and is held by the singleflight LEADER job only (see
// UploadCacheRef), so this fan-out is unbounded per feed but the actual
// peek/transcode/upload concurrency across ALL feeds stays capped at cap(a.sem).
// The per-feed errgroup returns the first hard upload error and cancels its
// siblings via gctx — which also lets a follower coalescing on a shared asset
// bail promptly (DoChan caller-select) — failing the whole feed; the caller
// leaves feed state (watermark, dedup, etag) untouched, so a transient store
// error self-heals next fetch while a persistent one wedges the feed until the
// store recovers.
func (run *fetchRun) uploadAssets(ctx context.Context, items []*Item) error {
	g, gctx := errgroup.WithContext(ctx)
	for _, i := range items {
		if !mod.HasAssetMarkers(i.Content) {
			continue
		}
		g.Go(func() error {
			return run.rewriteItemAssets(gctx, i)
		})
	}
	return g.Wait()
}

// rewriteItemAssets rewrites one item's "#"-upload markers to assets/ keys via
// UploadCacheRef. errNotAsset references (bare #fragments, paths escaping the
// cache dir) are declined and left untouched; any other upload failure is
// returned (failing the feed).
func (run *fetchRun) rewriteItemAssets(ctx context.Context, i *Item) (err error) {
	// On a hard upload error RewriteAttrs's returned content is unused: the error
	// fails the feed (uploadAssets → fetchURL returns no items), so the item — and
	// this i.Content write — is discarded and never observed.
	i.Content, err = mod.RewriteAttrs(i.Content, func(local string) (string, bool, error) {
		key, err := run.assets.UploadCacheRef(ctx, run.cacheDir, local)
		switch {
		case err == nil:
			return key, true, nil
		case errors.Is(err, errNotAsset):
			return "", false, nil
		case errors.Is(err, errCorruptAsset):
			// Broken source bytes won't get better on retry: decline the
			// marker (the article publishes without working media, the reader
			// collapses the dead element) instead of wedging the feed forever.
			slog.Warn("declining corrupt media asset", "asset", local, "link", i.Link, "err", err)
			return "", false, nil
		default:
			return "", false, fmt.Errorf("self-host asset %q: %w", local, err)
		}
	})
	return err
}

func uint32Set(s []uint32) map[uint32]struct{} {
	m := make(map[uint32]struct{}, len(s))
	for _, v := range s {
		m[v] = struct{}{}
	}
	return m
}
