package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	"srrb/ingest"
	"srrb/mod"
)

// maxBoundaryGUIDs caps the persisted per-feed BoundaryGUIDs array. Real
// publishers expose at most a few hundred items per response; without a cap,
// one misbehaving feed (thousands of dateless or same-second items) bloats
// db.gz — the one no-cache object every reader polls — permanently. See the
// cap logic in fetchURL for the over-cap semantics.
const maxBoundaryGUIDs = 1024

// pipeBase is the token expanded inline to the root pipe at the
// position where it appears in a feed's Pipe slice.
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
	LastNew int64    `json:"last_new,omitempty"`
	Tag     string   `json:"tag,omitempty"`
	Pipe    []string `json:"pipe,omitempty"`
	// Ingest is the feed-level extraction strategy. Empty falls through
	// to the db.gz root Ingest → built-in "#feed".
	Ingest   string `json:"ingest,omitempty"`
	TotalArt int    `json:"total_art"`
	AddIdx   int    `json:"add_idx"`
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
	cacheDir   string
	fetchedAt  int64
	rootPipe   []string
	rootIngest string
}

func (c *Feed) Fetch(ctx context.Context, run *fetchRun, buf []byte, processor *mod.Module) {
	c.newItems = c.newItems[:0]
	pipe := resolvePipe(run.rootPipe, c.Pipe)
	// Validate the resolved pipeline once, before the item loop. A bad token
	// (unknown built-in, stray #base, malformed params) is a config error that
	// would fail identically for every item; surface it loudly here instead of
	// letting fetchURL skip every item one by one.
	if err := processor.Validate(ctx, pipe); err != nil {
		err = fmt.Errorf("invalid pipeline %v: %w", pipe, err)
		slog.Error("feed pipeline invalid; skipping fetch", "feed", c, "err", err)
		c.FetchError = err.Error()
		c.FailStreak++
		return
	}
	ingestName := ingest.Select(c.Ingest, run.rootIngest)
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
	// semantics over carry-over).
	priorWatermark := c.Watermark
	priorBoundary := uint32Set(c.BoundaryGUIDs)

	maxPub := priorWatermark
	boundary := make(map[uint32]int64)

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

	// Second pass: pipeline + asset upload for the items committed to
	// ingestion.
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
		// Store-side end-of-pipeline step, kept out of processItem (which stays a
		// pure, store-free transform): scan the item's self-hostable attributes
		// (img/video src/poster, a href — see mod.RewriteAttrs) for upload markers
		// and rewrite them to their final store keys. A marker is a value starting
		// with "#" whose remainder names a regular file the fetcher left in
		// run.cacheDir (e.g. "#/photo.jpg"); a "#..." naming no such file is an
		// ordinary in-page fragment (#section), left as-is.
		//
		// A failed upload (store error, or an UploadCacheRef guard tripping on
		// oversize/traversal) hard-fails the whole feed fetch rather than
		// publish an item still pointing at "#/..." for an asset that never
		// reached the store. Feed state (watermark, dedup, etag) is left
		// untouched on the error path, so a transient store failure self-heals
		// next fetch; a permanently-rejected asset (e.g. over SRR_MAX_ASSET_SIZE)
		// wedges the feed until it is fixed.
		//
		// RewriteAttrs handles the marker convention: it skips content with no
		// marker-shaped attribute (the common case, as built-in #feed feeds never
		// emit markers) and hands fn the path with the "#" already stripped.
		i.Content, err = mod.RewriteAttrs(i.Content, func(local string) (string, bool, error) {
			key, err := run.assets.UploadCacheRef(ctx, run.cacheDir, local)
			switch {
			case err == nil:
				return key, true, nil
			case errors.Is(err, errNotAsset):
				// Not a real upload marker: a bare fragment (#section → "section")
				// names no file in the cache dir, and a value escaping the dir
				// (e.g. "#../secret", attacker-influenced content) must be declined
				// rather than wedge the feed permanently. Genuine in-cache upload
				// failures (oversize, store error) still fail the feed below.
				return "", false, nil
			default:
				return "", false, fmt.Errorf("self-host asset %q: %w", local, err)
			}
		})
		if err != nil {
			return nil, err
		}
		items = append(items, &Item{
			Feed:      c,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: cand.pub,
		})
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

func uint32Set(s []uint32) map[uint32]struct{} {
	m := make(map[uint32]struct{}, len(s))
	for _, v := range s {
		m[v] = struct{}{}
	}
	return m
}
