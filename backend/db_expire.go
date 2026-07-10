package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"golang.org/x/net/html"
	"golang.org/x/sync/errgroup"
)

// errExpireDone stops the expiration walk at the first article young enough
// to keep: fetched_at is globally monotone in chron order (each batch is
// stamped with its cycle timestamp), so nothing past it can be expired. A
// third package sentinel beside errNotFeed/errNotAsset — walkArticles'
// callback contract has no other early-stop channel.
var errExpireDone = errors.New("expire walk done")

// ExpireArticles applies each feed's ExpireDays retention policy: articles
// of that feed fetched more than ExpireDays·24h before now are expired —
// every assets/ key their content references is deleted from the store and
// the feed's AddIdx is bumped past them (logical deletion; packs are
// immutable). Feed.Expired accumulates the expired entry count so readers
// can correct the immutable idx-header cumulative counts (visible-before-P
// == header count − Expired for packs past AddIdx — see the data contract).
// Each deleted asset's size (measured by Stat just before the delete) reduces
// the expiring feed's AssetBytes, keeping that counter tracking the feed's
// live asset footprint.
//
// All-or-nothing: any walk or delete failure returns before ANY AddIdx/
// Expired change is applied, so the next cycle recomputes the same window
// and retries idempotently (Rm is silent on missing). NOTE (accepted design
// trade-off): there is no liveness check — an asset shared with a still-live
// article is deleted too; the reader collapses the broken media and
// `srr asset heal --create` is the repair path.
//
// Dormant-feed frontier advance: an expiring feed that saw no LIVE own entry
// in the walked window and expired nothing this cycle has its AddIdx advanced
// to the stop frontier (the chron where the early stop fired, or the store
// end). Every own entry in [AddIdx, stopChron) is either live (which pins the
// feed here) or expired this cycle (which records the natural prefix end
// instead), so an advancing feed skips a region with ZERO own entries:
// Expired is untouched and the reader/inspect invariant (own live entries at
// chron >= AddIdx == TotalArt − Expired) holds. Without this, a fully-expired
// feed that stops posting would pin minStart at its last article forever
// while the stop frontier advances with the clock — every cycle re-reading a
// growing window of OTHER feeds' data packs, expiring nothing.
func (o *DB) ExpireArticles(ctx context.Context, now int64) error {
	c := &o.core
	cutoffs := map[int]int64{} // feed id → fetched_at cutoff (exclusive)
	minStart := c.TotalArticles
	var maxCutoff int64
	for id, ch := range c.Feeds {
		if ch.ExpireDays <= 0 {
			continue
		}
		cutoffs[id] = now - int64(ch.ExpireDays)*86400
		minStart = min(minStart, ch.AddIdx)
		maxCutoff = max(maxCutoff, cutoffs[id])
	}
	if len(cutoffs) == 0 || minStart >= c.TotalArticles {
		return nil
	}

	newAddIdx := map[int]int{}
	newlyExpired := map[int]int{}
	sawLive := map[int]bool{}
	assetOwner := map[string]int{} // asset key → the expiring feed that first referenced it
	cur := minStart
	stopChron := c.TotalArticles // walk-exhausted default; entries [minStart, stopChron) were fully processed
	err := o.walkArticles(ctx, minStart, c.TotalArticles, func(ad *ArticleData) error {
		chron := cur
		cur++
		if ad.FetchedAt >= maxCutoff {
			stopChron = chron
			return errExpireDone
		}
		cutoff, ok := cutoffs[ad.FeedID]
		if !ok || chron < c.Feeds[ad.FeedID].AddIdx {
			return nil
		}
		if ad.FetchedAt >= cutoff {
			// Live for its own feed even though below maxCutoff (per-feed
			// windows differ): pins this feed's frontier — AddIdx never
			// skips a live own article.
			sawLive[ad.FeedID] = true
			return nil
		}
		newAddIdx[ad.FeedID] = chron + 1
		newlyExpired[ad.FeedID]++
		refs := map[string]struct{}{}
		collectAssetRefs(ad.Content, refs)
		for key := range refs {
			// First expiring referent wins the AssetBytes attribution (chron
			// order, deterministic); the delete itself is deduped by the map.
			if _, ok := assetOwner[key]; !ok {
				assetOwner[key] = ad.FeedID
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errExpireDone) {
		return fmt.Errorf("expire walk: %w", err)
	}

	// Advance dormant frontiers to the stop chron (see the doc comment): a
	// feed with no live own entry and no expiry this cycle owns zero entries
	// in [AddIdx, stopChron), so the jump changes no counts — it only unpins
	// minStart for the next cycle.
	advanced := 0
	for id := range cutoffs {
		if sawLive[id] {
			continue
		}
		if _, expiredSome := newAddIdx[id]; expiredSome {
			continue
		}
		if stopChron <= c.Feeds[id].AddIdx {
			continue
		}
		newAddIdx[id] = stopChron
		advanced++
	}
	if len(newAddIdx) == 0 {
		return nil
	}

	// Measure, then delete: Stat every key first so a stat failure aborts with
	// nothing deleted (a clean all-or-nothing retry). freed is the per-feed
	// AssetBytes reduction — what actually leaves the store, attributed to the
	// expiring feed that referenced the key. A key an aborted predecessor
	// already deleted stats as 0 (missing → (0, nil)); a mid-delete Rm failure
	// therefore loses the decrement for the keys it did delete — accepted skew,
	// same class as the no-liveness-check trade-off. Each phase fans out over a
	// bounded errgroup — the per-key calls are independent WAN round-trips made
	// while the fetch cycle holds the store lock, and the sums commute — with
	// the Wait between the phases preserving the no-Rm-before-every-Stat
	// boundary the all-or-nothing retry depends on.
	freed := map[int]int64{}
	var freedBytes int64
	var mu sync.Mutex
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(max(1, globals.Workers)) // Workers is 0 when the CLI didn't run (tests)
	for key, owner := range assetOwner {
		g.Go(func() error {
			size, err := o.Stat(gctx, key)
			if err != nil {
				return fmt.Errorf("stat %s: %w", key, err)
			}
			mu.Lock()
			freed[owner] += size
			freedBytes += size
			mu.Unlock()
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	g, gctx = errgroup.WithContext(ctx)
	g.SetLimit(max(1, globals.Workers))
	for key := range assetOwner {
		g.Go(func() error {
			if err := o.Rm(gctx, key); err != nil {
				return fmt.Errorf("delete %s: %w", key, err)
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}

	expired := 0
	for id, idx := range newAddIdx {
		ch := c.Feeds[id]
		ch.AddIdx = idx
		ch.Expired += newlyExpired[id] // advanced-only feeds add the map default 0
		// Clamped: a cross-feed shared asset may have been charged to the
		// uploading feed but expired via another's article (see Feed.AssetBytes).
		ch.AssetBytes = max(0, ch.AssetBytes-freed[id])
		expired += newlyExpired[id]
	}
	slog.Info("expired articles", "articles", expired, "assets", len(assetOwner), "asset_bytes", freedBytes, "feeds", len(newlyExpired), "advanced", advanced)
	return nil
}

// collectAssetRefs adds every self-hosted asset key (assets/…) referenced by
// content's media/link attributes (the outAssetAttrs set, via the shared
// visitAssetAttrs walk) to keys. Candidates are validated against the strict
// assetKeyRe grammar, not a bare prefix — these keys feed Rm, which
// path-joins on local/SFTP, so adversarial feed content like
// `assets/../victim` must never be harvested (a rejected key is simply not
// deleted: leak-safe, never delete-unsafe). Same fast path as
// rewriteAssetURLs; unparseable HTML contributes nothing — the content
// already published as-is, and an error here would wedge retention forever.
func collectAssetRefs(content string, keys map[string]struct{}) {
	if content == "" || !strings.Contains(content, assetKeyPrefix) {
		return
	}
	nodes, err := parseBodyFragment(content)
	if err != nil {
		return
	}
	visitAssetAttrs(nodes, func(a *html.Attribute) {
		if assetKeyRe.MatchString(a.Val) {
			keys[a.Val] = struct{}{}
		}
	})
}
