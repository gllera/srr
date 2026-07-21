package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sync/atomic"

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
	id    int
	Title string `json:"title"`
	URL   string `json:"url"`
	// ETag / LastModified are the HTTP conditional-fetch validators. They are
	// backend-only fetch state the reader ignores, so they live in the seen.gz
	// sidecar (json:"-": in-memory here, never written to the hot db.gz).
	// Hydrated onto the feed by seenPool.hydrateFeeds in NewDB and pulled back by
	// seenPool.snapshotHTTP in SyncSeen. A lagging validator only costs a
	// redundant full fetch (dedup then suppresses), so sidecar persistence is
	// safe. See backend/SEEN-POOL-PLAN.md.
	ETag         string `json:"-"`
	LastModified string `json:"-"`
	// Watermark is the max published unix-second ever seen across fetches.
	Watermark int64 `json:"wm,omitempty"`
	// BoundaryGUIDs is the dedup window: the GUIDs from the most recent
	// non-empty fetch whose pub >= Watermark or == 0 (dateless). Backend-only
	// and reader-ignored, so — like ETag/LastModified — it lives in the seen.gz
	// sidecar (json:"-": in-memory here). Hydrated by seenPool.hydrateFeeds,
	// pulled back by seenPool.snapshotHTTP. Relocated out of the hot db.gz
	// (2026-07: it was ~56% of the compressed db.gz every reader re-downloads);
	// this branch's ping/pong seen slots make that relocation atomic with the
	// article commit (see SEEN-PINGPONG-PLAN.md). No migration: a pre-relocation
	// db.gz's inline "bg" is simply ignored (json:"-" skips it) — the sidecar
	// rebuilds bg on the next fetch, and Watermark (which STAYS in db.gz, also
	// reader-displayed) floors dated duplicates meanwhile, so at most one cycle
	// of dateless/at-watermark items could re-ingest once.
	BoundaryGUIDs []uint32 `json:"-"`
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
	// DedupDays is the per-feed seen.gz horizon in days: how long the pool
	// remembers this feed's item GUIDs (and folded titles, when DedupTitle) after
	// they leave the feed window, suppressing re-promotion duplicates. 0 inherits
	// the store default (DBCore.DedupDays, else defaultDedupDays); >0 overrides
	// it; -1 disables the pool for this feed (exact bg-only dedup). Resolved by
	// (*Feed).dedupDays. Backend-only, like recipe/ingest/pipe.
	DedupDays int `json:"dd,omitempty"`
	// DedupTitle opts this feed into the title dedup axis: the pool also
	// remembers each item's folded-title hash, catching a re-promotion that mints
	// a fresh GUID for the same headline. Off by default (titles are far less
	// unique than GUIDs) and gated by !NoTitle. Backend-only.
	DedupTitle bool `json:"dt,omitempty"`
	// Expired is the cumulative count of this feed's expired idx entries (the
	// entries in [incarnation start, AddIdx)). Finalized idx headers are
	// immutable all-time cumulative counts (writeIdxHeader sources them from
	// TotalArt), so readers subtract Expired to count only visible articles.
	// Starts at 0 on AddFeed (id reuse included); never decreases otherwise.
	Expired  int `json:"xp,omitempty"`
	TotalArt int `json:"total_art"`
	AddIdx   int `json:"add_idx"`
	// ContentBytes is the cumulative uncompressed size in bytes of the article
	// JSONL lines this feed added to data/ packs (bumped per article by
	// PutArticles, before gzip; idx/meta overhead not included). Never
	// decreases — expiration is logical deletion, the pack bytes stay.
	ContentBytes int64 `json:"cb,omitempty"`
	// AssetBytes tracks the store footprint of this feed's self-hosted assets:
	// bumped by the stored payload size (post-asset-process) when its items
	// upload assets/ objects — counted once at the actual Put, so content-hash
	// dedup hits add nothing and a shared asset is charged to the feed whose
	// fetch uploaded it first — and reduced (clamped at 0) when expiration
	// deletes those objects (ExpireArticles stats each key before the Rm).
	// Approximate by design: a cross-feed shared asset can be charged to one
	// feed and expired via another's article.
	AssetBytes int64 `json:"ab,omitempty"`
	newItems   []*Item
	// seenStamps is the per-run scratch of pool stamps this feed collected in its
	// first pass — the GUID hash of every current-window item, plus each item's
	// folded-title hash when the title axis is on. Assigned only at fetchURL's
	// successful tail (past the stale/empty guards) and merged into the pool
	// single-threaded after the fan-out. Lowercase so it never serializes to
	// db.gz (mirrors newItems).
	seenStamps []uint32
}

func (c *Feed) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int("id", c.id),
		slog.String("title", c.Title),
	)
}

// dedupDays resolves this feed's effective seen.gz horizon from its own
// DedupDays and the store default (DBCore.DedupDays, passed in): a positive day
// count when the pool is active, or dedupDisabled (a non-positive sentinel) when
// the feed opts out. Only the per-feed value may disable (-1); a store default
// <= 0 is treated as unset and falls through to defaultDedupDays (there is no
// store-wide off switch — per-feed -1 is that lever).
func (c *Feed) dedupDays(store int) int {
	switch {
	case c.DedupDays == dedupDisabled:
		return dedupDisabled
	case c.DedupDays > 0:
		return c.DedupDays
	case store > 0:
		return store
	default:
		return defaultDedupDays
	}
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
	// seen is the persistent dedup pool, read-only during the concurrent
	// fan-out (the cycle-start snapshot, like each feed's priorBoundary). May be
	// nil (pool never loaded / disabled) — seenPool's methods are nil-safe.
	// Stamps are buffered per feed (Feed.seenStamps) and merged into it
	// single-threaded after g.Wait().
	seen *seenPool
	// dedupDays is the store-default horizon (DBCore.DedupDays), threaded onto
	// the run so each feed's fetchURL can resolve its effective horizon (and the
	// disabled gate) during the lock-free fan-out, before the pool is written.
	dedupDays int
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
		if ctx.Err() != nil {
			// Run shutdown (SIGTERM/SIGINT) cancelled this fetch mid-flight — not a
			// feed fault. Leave FetchError/FailStreak/vitals untouched: on stores
			// that ignore ctx (local/SFTP) the cycle still commits, so recording the
			// error would flip healthy feeds to "err" on a graceful stop. (On S3 the
			// commit itself aborts, so nothing persists either way.)
			slog.Debug("feed fetch cancelled by shutdown", "feed", c, "url", c.URL)
			return
		}
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

	// Reset the per-fetch stamp scratch up front, so every early return below
	// (ingest error, 304, empty/all-nil, stale) leaves it empty and stamps
	// nothing into the pool. It is populated only at the successful tail, past
	// the stale/empty guards.
	c.seenStamps = nil

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

	// Persistent-dedup gate for this feed: a positive effective horizon means
	// the seen.gz pool is active (the store default rides run.dedupDays so this
	// resolves during the lock-free fan-out); the title axis additionally needs
	// DedupTitle and a titled feed. seenBefore is the pool half of the
	// already-seen test — the other half is priorBoundary (bg) below — and, like
	// it, it never raises the watermark. window buffers this feed's pool updates.
	poolOn := c.dedupDays(run.dedupDays) > 0
	dtOn := poolOn && c.DedupTitle && !c.NoTitle
	seenBefore := func(i *mod.RawItem) bool {
		if !poolOn {
			return false // disabled feed: exact bg-only behavior
		}
		if run.seen.has(c.id, i.GUID) {
			return true
		}
		// Empty titles are excluded from the title axis: foldSearchText("") is ""
		// and titleHash("") is one fixed value, so every titleless item would
		// collide on it and all but one would be silently dropped forever. A
		// titled feed (not NoTitle) can still carry occasional titleless posts.
		return dtOn && i.Title != "" && run.seen.has(c.id, titleHash(i.Title))
	}
	// stampSrc buffers the (guid, title) of every current-window item; the flat
	// stamps are built at the successful tail, AFTER the over-cap `dropped` set is
	// known, so a dropped item is never remembered (see the tail).
	type stampSrc struct {
		guid  uint32
		title string
	}
	var window []stampSrc

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

		// Buffer every current-window item (ingested or already-seen), not only
		// new ones, so a long-lived window item's clock stays fresh in the pool
		// until it disappears. Which of these are actually stamped is decided at
		// the successful tail, once the over-cap `dropped` set is known. A
		// disabled feed (poolOn == false) buffers nothing.
		if poolOn {
			window = append(window, stampSrc{i.GUID, i.Title})
		}

		if pubUnix == 0 {
			hasDateless = true
		} else if pubUnix > maxSeen {
			maxSeen = pubUnix
		}

		if _, prev := priorBoundary[i.GUID]; prev || seenBefore(i) {
			// A GUID we have already seen — in the current bg snapshot
			// (priorBoundary) or the persistent pool (seenBefore): keep deduping
			// it, but do NOT let a publisher re-dating an existing post raise
			// Watermark. Otherwise a genuinely-new article later dated between the
			// old and the bumped value is permanently and silently dropped by the
			// watermark check. This is exactly what fixes re-promotion: the pool
			// remembers the GUID long after it fell out of the small bg snapshot.
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

	// An all-nil (or otherwise emptied-after-nil-skip) response carried no usable
	// item — e.g. an external strategy emitting {"items":[null]}. len(result.Items)
	// was non-zero so the early empty-guard above didn't fire, but nothing
	// survived: treat it like a 200-with-zero-items, advancing the HTTP validators
	// while preserving Watermark/BoundaryGUIDs, so this transient malformed fetch
	// doesn't wipe bg and re-ingest the remembered window as duplicates next time.
	if len(boundary) == 0 {
		c.ETag = result.ETag
		c.LastModified = result.LastModified
		return nil, nil
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

	// BoundaryGUIDs must remember as much of the current feed window as the cap
	// allows so a feed that re-dates its whole window to ~now on every rebuild
	// (fresh pubDates, stable GUIDs) still dedups — the watermark can't skip
	// re-dated items because they always sit above it. Two dedup classes:
	//
	//   must — dateless (p==0) or p >= maxPub: the watermark will NOT skip these
	//     next fetch, so each must either live in bg or be skipped from
	//     ingestion, else it re-ingests forever.
	//   opt  — p < maxPub: the watermark skips these next fetch WHEN the feed
	//     keeps their date stable. We still remember them (most-recent first, up
	//     to the remaining cap) so a re-dating feed's whole window dedups; but
	//     evicting one is safe — it stays watermark-protected in the stable
	//     case — so an opt GUID is never dropped from ingestion.
	type datedGUID struct {
		g uint32
		p int64
	}
	must := make([]uint32, 0, len(boundary))
	opt := make([]datedGUID, 0, len(boundary))
	for g, p := range boundary {
		if p == 0 || p >= maxPub {
			must = append(must, g)
		} else {
			opt = append(opt, datedGUID{g, p})
		}
	}
	slices.Sort(must)

	// Cap the must class at maxBoundaryGUIDs. When over cap, prefer retaining
	// GUIDs already in priorBoundary (already stored) before filling remaining
	// slots with the smallest hashes of the rest: under a pure smallest-hash
	// rule a batch of new items with smaller hashes would evict high-hash stored
	// items even though those were already ingested — they would then look new,
	// and duplicate forever, on the very next fetch. Over-cap must GUIDs are
	// dropped and skipped from ingestion (the gate in the second pass below);
	// ingesting one without remembering it duplicates it every subsequent fetch.
	var dropped map[uint32]struct{}
	if len(must) > maxBoundaryGUIDs {
		slog.Warn("boundary GUIDs over cap, skipping over-cap items", "url", c.URL, "total", len(must), "cap", maxBoundaryGUIDs)
		prior := must[:0:0] // already-stored GUIDs from must (sorted)
		rest := must[:0:0]  // new GUIDs from must (sorted)
		for _, g := range must {
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
		remaining := min(maxBoundaryGUIDs-len(kept), len(rest))
		kept = append(kept, rest[:remaining]...)
		dropped = make(map[uint32]struct{}, len(must)-len(kept))
		for _, g := range must {
			dropped[g] = struct{}{}
		}
		for _, g := range kept {
			delete(dropped, g)
		}
		must = kept
	}

	// Fill any cap slots the must class left free with the most-recent protected
	// (opt) GUIDs — a higher pub is likelier to still be in the window next
	// fetch; ties broken by hash for determinism. Evicting an opt GUID here
	// never skips ingestion, so opt never contributes to dropped.
	bg := must
	if remaining := maxBoundaryGUIDs - len(bg); remaining > 0 && len(opt) > 0 {
		slices.SortFunc(opt, func(x, y datedGUID) int {
			if c := cmp.Compare(y.p, x.p); c != 0 {
				return c
			}
			return cmp.Compare(x.g, y.g)
		})
		for _, d := range opt[:min(remaining, len(opt))] {
			bg = append(bg, d.g)
		}
	}
	slices.Sort(bg)

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
			Lang:      i.Lang,
		})
	}

	// Store-side end-of-pipeline step (kept out of processItem, which stays a
	// pure, store-free transform): self-host each item's "#"-marked assets.
	if err := run.uploadAssets(ctx, c, items); err != nil {
		return nil, err
	}

	if len(items) > 0 {
		c.LastNew = run.fetchedAt
	}
	// A partial response (parse stopped at a malformed mid-feed element) keeps
	// the prior Watermark — the same preservation NotModified and the
	// stale-response guard apply. Advancing it would let a first-subscribe
	// truncation raise wm past the never-ingested older backlog, so the refetch
	// (forced by the withheld validators — result.ETag/LastModified are empty
	// here, clearing the stored ones below) would watermark-skip it anyway. The
	// prefix items ingested above sit in bg/the seen pool, so the refetch dedups
	// them and ingests only the remainder.
	if !result.Partial {
		c.Watermark = maxPub
	}
	c.BoundaryGUIDs = bg
	// Commit the pool stamps only here — past the all-nil and stale-response
	// guards' early returns — so a transient stale/empty copy never refreshes
	// the pool (its clock must not tick on a response that carried no fresh
	// window). An over-cap `dropped` item is skipped from ingestion AND left out
	// of bg; stamping a NEVER-stored one would let seenBefore suppress it forever
	// instead of letting it retry once the window shrinks below the cap. But a
	// dropped item the pool ALREADY knows (has) is genuinely stored — a
	// re-promotion whose GUID aged out of bg but not the pool — so un-stamping it
	// would age it out and re-ingest it as a duplicate; keep refreshing it. Hence
	// skip only when dropped AND unknown. (The pool holds only stored GUIDs, so a
	// hit is safe to keep; has is nil-safe, so a pool-less run drops all dropped.)
	// The single-threaded merge into run.seen runs after g.Wait().
	if poolOn {
		stamps := make([]uint32, 0, len(window))
		for _, s := range window {
			if _, dropped := dropped[s.guid]; dropped && !run.seen.has(c.id, s.guid) {
				continue
			}
			stamps = append(stamps, s.guid)
			if dtOn && s.title != "" { // empty titles never enter the title axis (see seenBefore)
				stamps = append(stamps, titleHash(s.title))
			}
		}
		c.seenStamps = stamps
	}
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
func (run *fetchRun) uploadAssets(ctx context.Context, c *Feed, items []*Item) error {
	var uploaded atomic.Int64
	g, gctx := errgroup.WithContext(ctx)
	for _, i := range items {
		if !mod.HasAssetMarkers(i.Content) {
			continue
		}
		g.Go(func() error {
			return run.rewriteItemAssets(gctx, i, &uploaded)
		})
	}
	err := g.Wait()
	// Charge the feed even when the batch fails: the Puts that did complete are
	// in the store regardless, and content-addressing means the retry next fetch
	// dedups against them and adds nothing. Written after Wait, so only this
	// feed's worker goroutine ever touches the field.
	c.AssetBytes += uploaded.Load()
	return err
}

// rewriteItemAssets rewrites one item's "#"-upload markers to assets/ keys via
// UploadCacheRef. errNotAsset references (bare #fragments, paths escaping the
// cache dir) are declined and left untouched; any other upload failure is
// returned (failing the feed). Bytes UploadCacheRef actually Put (nonzero only
// when this call led the upload) accumulate into uploaded, the feed's
// AssetBytes accounting.
func (run *fetchRun) rewriteItemAssets(ctx context.Context, i *Item, uploaded *atomic.Int64) (err error) {
	// On a hard upload error RewriteAttrs's returned content is unused: the error
	// fails the feed (uploadAssets → fetchURL returns no items), so the item — and
	// this i.Content write — is discarded and never observed.
	i.Content, err = mod.RewriteAttrs(i.Content, func(local string) (string, bool, error) {
		key, n, err := run.assets.UploadCacheRef(ctx, run.cacheDir, local)
		uploaded.Add(n)
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
