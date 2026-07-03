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
	assetKeys := map[string]struct{}{}
	cur := minStart
	err := o.walkArticles(ctx, minStart, c.TotalArticles, func(ad *ArticleData) error {
		chron := cur
		cur++
		if ad.FetchedAt >= maxCutoff {
			return errExpireDone
		}
		cutoff, ok := cutoffs[ad.FeedID]
		if !ok || chron < c.Feeds[ad.FeedID].AddIdx || ad.FetchedAt >= cutoff {
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
		ch.Expired += newlyExpired[id]
		expired += newlyExpired[id]
	}
	slog.Info("expired articles", "articles", expired, "assets", len(assetKeys), "feeds", len(newAddIdx))
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
