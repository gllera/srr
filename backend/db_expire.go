package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"
	"sync"

	"golang.org/x/net/html"
	"golang.org/x/sync/errgroup"

	"srr/store"
)

// errExpireDone stops the expiration walk at the first article young enough
// to keep: fetched_at is globally monotone in chron order (each batch is
// stamped with its cycle timestamp), so nothing past it can be expired. A
// third package sentinel beside errNotFeed/errNotAsset — walkArticles'
// callback contract has no other early-stop channel.
var errExpireDone = errors.New("expire walk done")

// ExpireArticles applies each feed's ExpireDays retention policy: articles
// of that feed fetched more than ExpireDays·24h before now are expired —
// the assets/ objects their content references are RELEASED (and deleted once
// nothing references them) and the feed's AddIdx is bumped past them (logical
// deletion; packs are immutable). Feed.Expired accumulates the expired entry
// count so readers can correct the immutable idx-header cumulative counts
// (visible-before-P == header count − Expired for packs past AddIdx — see the
// data contract).
//
// LIVENESS. An assets/ key is a content hash, so one object commonly serves
// several articles across several feeds. Expiration therefore does not delete
// what an expiring article references; it decrements that reference in the
// asset refcount sidecar (asset_refs.go) and deletes only what reaches zero.
// A shared object survives its first expiring referrer, which is the whole
// point of that file — read its coverage discussion before changing anything
// here, because the ONE case that still deletes without a liveness check is the
// region the sidecar makes no claim about (articles stored before it existed),
// and that region only drains.
//
// ASSET BYTES. Each deleted object's size (measured by Stat just before the
// delete) is released from the feed the sidecar recorded as its OWNER — the
// feed charged for the upload — not from whichever feed happened to expire it.
// That is what makes Feed.AssetBytes track a feed's own live footprint: bytes
// are charged once at upload and released once when the object actually leaves
// the store, by the same feed. (Two residual skews, both narrow and both
// pre-existing: an object uploaded during feed A's fetch but first STORED in
// feed B's article is charged to A and released from B, and `srr asset heal`
// can change an object's size under the counter — see cmd_asset.go.)
//
// All-or-nothing: any walk or delete failure returns before ANY AddIdx/
// Expired/AssetBytes/refcount change is applied, so the next cycle recomputes
// the same window and retries idempotently (Rm is silent on missing).
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
	// released counts, per asset key, how many COVERED expiring articles
	// referenced it — the decrements to apply to the sidecar once every delete
	// has landed. uncovered maps a key referenced by an article the sidecar
	// makes no claim about to the first such feed in chron order, which is the
	// pre-refcount AssetBytes attribution preserved verbatim for that region.
	released := map[string]int{}
	uncovered := map[string]int{}
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
		covered := o.refs.covers(chron)
		for key := range refs {
			if covered {
				// One release per (article, key) — collectAssetRefs already
				// deduped the content's mentions, exactly as it did when
				// PutArticles counted this article.
				released[key]++
				continue
			}
			// First expiring referent wins the AssetBytes attribution (chron
			// order, deterministic); the delete itself is deduped by the map.
			if _, ok := uncovered[key]; !ok {
				uncovered[key] = ad.FeedID
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

	// Which of the harvested keys are provably dead. plan mutates nothing: the
	// releases are applied only after every delete has landed, so a failure
	// leaves the counts exactly where this same walk will find them next cycle.
	dead, owners, kept, unknown := o.refs.plan(released, uncovered)
	if unknown > 0 {
		// Covered articles whose keys the sidecar has no count for: damage, not
		// a decision. Keeping them leaks bytes an operator can reclaim; deleting
		// them would lose media no article can get back.
		slog.Warn("expiring articles referenced assets the refcount sidecar cannot account for; keeping them",
			"objects", unknown)
	}

	// Measure, then delete: Stat every key first so a stat failure aborts with
	// nothing deleted (a clean all-or-nothing retry). freed is the per-feed
	// AssetBytes reduction — what actually leaves the store, released from the
	// feed the sidecar charged for the upload (or, in the uncovered region, the
	// first expiring referrer, as before). A key an aborted predecessor
	// already deleted counts as 0 (absent → fs.ErrNotExist, tolerated HERE and
	// only here — retry idempotence needs it, and a real error still aborts
	// with nothing deleted); a mid-delete Rm failure
	// therefore loses the decrement for the keys it did delete — accepted skew,
	// the price of not writing a second commit between the deletes and the
	// counters. Both phases fan their
	// independent per-key round-trips out under one bound — they are WAN calls
	// made while the fetch cycle holds the store lock, and the sums commute —
	// with the measure phase completing in full first, which is the
	// no-Rm-before-every-Stat boundary the all-or-nothing retry depends on.
	freed := map[int]int64{}
	var freedBytes int64
	var mu sync.Mutex
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(rmParallel())
	for _, key := range dead {
		owner := owners[key]
		g.Go(func() error {
			size, err := o.Stat(gctx, key)
			if errors.Is(err, fs.ErrNotExist) {
				size = 0
			} else if err != nil {
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
	// The delete phase is store.RmAll's shape exactly (a bounded fan-out, one
	// batched call where the backend has one), and unlike the measure phase it
	// wants every delete ATTEMPTED rather than a first-error abort: the ones
	// that land are bytes genuinely reclaimed, and the retry re-stats the rest.
	if _, err := store.RmAll(ctx, o.Backend, dead, rmParallel()); err != nil {
		return fmt.Errorf("deleting expired assets: %w", err)
	}
	// Every delete landed, so the references these articles held are gone for
	// good: subtract them, dropping the entries that reached zero. Applied here
	// and not in the walk so the whole step stays all-or-nothing.
	o.refs.apply(released)

	expired := 0
	for id, idx := range newAddIdx {
		ch := c.Feeds[id]
		ch.AddIdx = idx
		ch.Expired += newlyExpired[id] // advanced-only feeds add the map default 0
		// Clamped: the owner recorded at upload can be a feed that has since
		// been removed and its id reused, and the uncovered region still
		// attributes to the expiring feed rather than the uploader.
		ch.AssetBytes = max(0, ch.AssetBytes-freed[id])
		expired += newlyExpired[id]
	}
	slog.Info("expired articles", "articles", expired, "assets", len(dead), "asset_bytes", freedBytes, "feeds", len(newlyExpired), "advanced", advanced,
		"assets_still_referenced", kept, "assets_unaccounted", unknown)
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
	if content == "" || !strings.Contains(content, assetPrefix) {
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
