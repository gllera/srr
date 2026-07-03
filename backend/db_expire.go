package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"golang.org/x/net/html"
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
	assetKeys := map[string]struct{}{}
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
		collectAssetRefs(ad.Content, assetKeys)
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

	for key := range assetKeys {
		if err := o.Rm(ctx, key); err != nil {
			return fmt.Errorf("delete %s: %w", key, err)
		}
	}

	expired := 0
	for id, idx := range newAddIdx {
		ch := c.Feeds[id]
		ch.AddIdx = idx
		ch.Expired += newlyExpired[id] // advanced-only feeds add the map default 0
		expired += newlyExpired[id]
	}
	slog.Info("expired articles", "articles", expired, "assets", len(assetKeys), "feeds", len(newlyExpired), "advanced", advanced)
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
