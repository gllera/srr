package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"slices"

	"golang.org/x/sync/errgroup"
)

// Physical compaction — docs/MANIFEST-SPEC.md §9.2, the one operation in the
// whole system that removes bytes.
//
// Every article below its feed's AddIdx is already LOGICALLY deleted
// (expiration bumps AddIdx past a feed's aged-out prefix; a reused feed id's
// dead incarnation sits there too). Its idx entry, data line and meta card
// slot still exist because packs and idx headers are immutable and chronIdx is
// a PERMANENT address (invariant M8) — device-local state (read frontiers, the
// ★-Saved queue, shared #pos links) is keyed on it, so no generation may ever
// renumber a chron. Compaction reclaims those bytes WITHOUT renumbering:
//
//   - data/ packs holding an expired line are rewritten under a FRESH stem with
//     that line replaced by a TOMBSTONE that keeps f/a/p and drops t/l/c/g.
//   - meta/ shards holding an expired card are rewritten under a fresh stem with
//     that card reduced to {f,w} (title dropped) and the bloom rebuilt over the
//     surviving titles.
//   - idx/ is left entirely untouched (its entries are already 2 bytes each), so
//     numFinalizedIdx, the header cumulative counts, hsum and every chron→pack
//     mapping stay valid with ZERO device-state migration.
//   - the assets/ objects the expired articles referenced are deleted (mostly a
//     no-op — expiration deleted them already; id-reuse orphans are the real
//     reclaim).
//
// A single manifest lists the new data/meta stems at the SAME positions the old
// ones held and flips the root; the old objects stay reachable through the GC
// grace window for stale tabs, then §7's sweep reclaims them. total_art, every
// feed's total_art/add_idx/xp, next_pid, pack_off, fetched_at monotonicity and
// the 5k/50k strides are all unchanged by construction — the universal crash
// argument (§6.1) and every existing invariant carry over verbatim.
//
// It is deliberately OPT-IN (`srr compact`, default off) and never something a
// fetch cycle does silently: it is the only op that drops payload bytes, so an
// operator asks for it explicitly.

// CompactCmd is `srr compact`.
type CompactCmd struct {
	DryRun bool `short:"n" name:"dry-run" help:"Report what compaction would reclaim (expired articles, packs/shards rewritten, assets deleted) and exit without touching the store."`
}

func (o *CompactCmd) Run() error {
	// Dry run opens read-only and takes no lock; a real compaction is a store
	// writer like a fetch cycle. --force overrides the lock via the global.
	return withDB(!o.DryRun, func(ctx context.Context, db *DB) error {
		return db.Compact(ctx, o.DryRun)
	})
}

// articleTombstone is the compacted data line of an expired article: f/a/p
// retained, t/l/c/g dropped. Content is deliberately ABSENT rather than "" —
// that absence is the sentinel a reader uses to render the "no longer stored"
// state (§9.3). ArticleData.Content has no omitempty, so a tombstone cannot be
// an ArticleData; it needs its own encoder.
type articleTombstone struct {
	FeedID    int   `json:"f"`
	FetchedAt int64 `json:"a"`
	Published int64 `json:"p,omitempty"`
}

// Compact rewrites the consolidated pack region, emptying the payloads of
// already-expired articles into tombstones and reclaiming their assets, then
// publishes one generation naming the rewritten packs beside the old ones. The
// live delta region is left untouched: it holds the newest articles, which are
// essentially never expired (expiry removes OLD, low-chron articles), and any
// rare expired delta payload compacts on a later run once it consolidates.
func (o *DB) Compact(ctx context.Context, dryRun bool) error {
	c := &o.core
	if c.legacyRoot != nil {
		return fmt.Errorf("compact: store is still on the pre-cutover root; a locked fetch/maintenance cycle migrates it first")
	}
	if c.TotalArticles == 0 {
		slog.Info("compact: empty store, nothing to reclaim")
		return nil
	}

	fetch := func(key string) ([]byte, error) { return o.readGz(ctx, key) }
	packs, _, err := loadIdxPacks(fetch, c)
	if err != nil {
		return fmt.Errorf("compact: load idx packs: %w", err)
	}

	// Plan the rewrite from the idx entries alone: an article at chron is expired
	// iff its feed exists and chron < that feed's AddIdx. A removed feed (no
	// AddIdx) keeps its content — [DELETED] but still loadable, the existing
	// tombstone.e2e contract.
	tc := tailCovered(c)
	metaCoverage := c.metaPacks()*metaPackSize + c.MetaTail
	dataExpired := map[int]map[int]bool{} // data packID  -> offset within pack -> expired
	metaExpired := map[int]map[int]bool{} // meta shard    -> local position    -> expired
	totalExpired := 0
	for chron := 0; chron < tc; chron++ {
		p := packIdxFor(chron, len(packs))
		pack := packs[p]
		feedID := int(pack.feedIDs[chron-p*idxPackSize])
		f := c.Feeds[feedID]
		if f == nil || chron >= f.AddIdx {
			continue
		}
		totalExpired++
		pid, off := pack.getPackRef(chron)
		markExpired(dataExpired, pid, off)
		if chron < metaCoverage {
			markExpired(metaExpired, chron/metaPackSize, chron%metaPackSize)
		}
	}

	if totalExpired == 0 {
		slog.Info("compact: no expired payloads to reclaim", "total_art", c.TotalArticles, "consolidated", tc)
		return nil
	}

	if dryRun {
		slog.Info("compact (dry run): would reclaim expired payloads — nothing written",
			"expired_articles", totalExpired, "data_packs", len(dataExpired), "meta_shards", len(metaExpired))
		if c.numDeltas() > 0 {
			slog.Info("compact (dry run): the live delta region is left untouched; its (rare) expired payloads compact after it consolidates",
				"delta_articles", c.DeltaArticles)
		}
		return nil
	}

	// Stage every name change on a clone and adopt it only once all the new
	// objects are durable — the SyncMeta idiom, so a mid-flight save failure
	// leaves the live table pristine.
	names := c.Names.clone()
	assetKeys := map[string]struct{}{}
	var contentDropped int64

	dataTail := names.series(dataSeries).Tail
	for _, pid := range slices.Sorted(maps.Keys(dataExpired)) {
		dropped, err := o.compactDataPack(ctx, c, names, pid, pid == dataTail, dataExpired[pid], assetKeys)
		if err != nil {
			return err
		}
		contentDropped += dropped
	}

	metaTail := names.series(metaSeries).Tail
	rebuiltFinalized := false
	for _, s := range slices.Sorted(maps.Keys(metaExpired)) {
		if s != metaTail {
			rebuiltFinalized = true
		}
		if err := o.compactMetaShard(ctx, c, names, s, s == metaTail, metaExpired[s]); err != nil {
			return err
		}
	}
	// A rewritten finalized shard changed its bloom, so the bloom summary
	// (concatenation of the finalized blooms) must be republished under a fresh
	// stem too. The idx header summary is untouched — idx/ is never rewritten.
	if rebuiltFinalized {
		if err := o.rebuildMetaSummary(ctx, c, names); err != nil {
			return err
		}
	}

	// Reclaim the expired articles' assets BEFORE the flip: the tombstones drop
	// the content that references them, so once this generation is live nothing
	// can re-find those keys. All-or-nothing — a delete failure aborts with the
	// old (committed) packs still naming the keys, so a retry re-collects and
	// re-deletes idempotently. (Rm is silent on missing, which is the common
	// case: expiration deleted most of these already.) AssetBytes is left
	// untouched — expiration owns that counter; re-deleting an already-counted
	// key must not double-decrement, and the id-reuse orphans that remain are the
	// same approximate-skew class as expiration's cross-feed shared assets.
	if err := o.rmAssets(ctx, assetKeys); err != nil {
		return fmt.Errorf("compact: reclaim expired assets: %w", err)
	}

	// Every new object is durable and every asset is reclaimed: adopt the staged
	// names, sweep the grace window, and flip the root onto this generation.
	c.Names = names
	metaTailMemo.reset() // the meta tail moved to a fresh stem; drop the process memo keyed on the old one
	if err := o.GC(ctx, globals.KeepManifests); err != nil {
		slog.Warn("compact: gc sweep", "error", err)
	}
	if err := o.Commit(ctx); err != nil {
		return err
	}
	slog.Info("compacted store",
		"expired_articles", totalExpired, "data_packs", len(dataExpired), "meta_shards", len(metaExpired),
		"assets_deleted", len(assetKeys), "content_bytes_reclaimed", contentDropped, "manifest", c.ManifestNum)
	return nil
}

// markExpired records that position pos of container k holds an expired article.
func markExpired(m map[int]map[int]bool, k, pos int) {
	set := m[k]
	if set == nil {
		set = map[int]bool{}
		m[k] = set
	}
	set[pos] = true
}

// compactDataPack rewrites one data pack under a fresh stem: expired offsets
// become tombstones (their asset refs collected into assetKeys first), every
// survivor is copied verbatim (byte-identical, so the reader's cache-first path
// is unaffected). Returns the uncompressed content bytes dropped. Finalized
// packs recompress with zopfli like the writer; the tail keeps fast gzip.
func (o *DB) compactDataPack(ctx context.Context, c *DBCore, names *ManifestNames, pid int, isTail bool, expired map[int]bool, assetKeys map[string]struct{}) (int64, error) {
	key, err := c.Names.key(dataSeries, pid)
	if err != nil {
		return 0, fmt.Errorf("compact: data pack %d: %w", pid, err)
	}
	raw, err := o.readGz(ctx, key)
	if err != nil {
		return 0, fmt.Errorf("compact: read data pack %d: %w", pid, err)
	}
	lines, arts, err := splitDataPack(raw)
	if err != nil {
		return 0, fmt.Errorf("compact: parse data pack %d: %w", pid, err)
	}
	var dropped int64
	p := newPack()
	for i := range arts {
		if expired[i] {
			collectAssetRefs(arts[i].Content, assetKeys)
			tomb, err := jsonEncode(&articleTombstone{FeedID: arts[i].FeedID, FetchedAt: arts[i].FetchedAt, Published: arts[i].Published})
			if err != nil {
				return 0, err
			}
			dropped += int64(len(lines[i]) - len(tomb))
			if _, err := p.Write(tomb); err != nil {
				return 0, err
			}
		} else if _, err := p.Write(lines[i]); err != nil {
			return 0, err
		}
	}
	stem := names.alloc(dataSeries)
	newKey := fmt.Sprintf("%s/%d.gz", dataSeries, stem)
	if isTail {
		err = o.savePack(ctx, newKey, p)
	} else {
		err = o.savePackFinal(ctx, newKey, p)
	}
	if err != nil {
		return 0, err
	}
	if err := names.putAt(dataSeries, pid, stem); err != nil {
		return 0, err
	}
	return dropped, nil
}

// compactMetaShard rewrites one meta shard under a fresh stem, dropping the
// title of every expired card (keeping {f,w}); a finalized shard's bloom is
// rebuilt over the survivors, the tail shard carries none.
func (o *DB) compactMetaShard(ctx context.Context, c *DBCore, names *ManifestNames, s int, isTail bool, expired map[int]bool) error {
	key, err := c.Names.key(metaSeries, s)
	if err != nil {
		return fmt.Errorf("compact: meta shard %d: %w", s, err)
	}
	buf, err := o.readGz(ctx, key)
	if err != nil {
		return fmt.Errorf("compact: read meta shard %d: %w", s, err)
	}
	body := buf
	if !isTail {
		if len(buf) < searchBloomBytes {
			return fmt.Errorf("compact: meta shard %d shorter than its bloom header (%d bytes)", s, len(buf))
		}
		body = buf[searchBloomBytes:]
	}
	newLines, err := tombstoneMetaLines(body, expired)
	if err != nil {
		return fmt.Errorf("compact: meta shard %d: %w", s, err)
	}
	stem := names.alloc(metaSeries)
	newKey := fmt.Sprintf("%s/%d.gz", metaSeries, stem)
	if isTail {
		p := newPack()
		for _, line := range newLines {
			if _, err := p.Write(line); err != nil {
				return err
			}
		}
		if err := o.savePack(ctx, newKey, p); err != nil {
			return err
		}
	} else if err := o.saveMetaShard(ctx, newKey, newLines); err != nil {
		return err
	}
	return names.putAt(metaSeries, s, stem)
}

// tombstoneMetaLines returns the shard's JSONL lines with each expired card
// reduced to {f,w} (title dropped) and every survivor kept verbatim.
func tombstoneMetaLines(body []byte, expired map[int]bool) ([][]byte, error) {
	var out [][]byte
	i := 0
	for _, line := range bytes.SplitAfter(body, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		if expired[i] {
			var e MetaEntry
			if err := json.Unmarshal(bytes.TrimRight(line, "\n"), &e); err != nil {
				return nil, fmt.Errorf("card %d: %w", i, err)
			}
			tomb, err := jsonEncode(&MetaEntry{FeedID: e.FeedID, When: e.When})
			if err != nil {
				return nil, err
			}
			out = append(out, tomb)
		} else {
			out = append(out, line)
		}
		i++
	}
	return out, nil
}

// rebuildMetaSummary republishes the bloom summary (concatenation of the
// finalized shards' blooms) under a fresh stem, reading each shard's CURRENT
// bloom from the staged name table so rewritten shards contribute their new one.
func (o *DB) rebuildMetaSummary(ctx context.Context, c *DBCore, names *ManifestNames) error {
	nf := c.metaPacks()
	if nf == 0 {
		return nil
	}
	stem := names.alloc(metaSeries)
	sum := SummaryName{Series: metaSeries, Stem: stem, Covers: nf}
	if err := o.saveSummary(ctx, nf, func(k int) ([]byte, error) {
		key, err := names.key(metaSeries, k)
		if err != nil {
			return nil, err
		}
		return o.readPackHeader(ctx, key, searchBloomBytes)
	}, sum.key()); err != nil {
		return err
	}
	names.SSum = &sum
	return nil
}

// rmAssets deletes the collected asset keys, bounded like ExpireArticles' own
// delete phase. Rm is silent on missing, so already-expired assets cost nothing.
func (o *DB) rmAssets(ctx context.Context, keys map[string]struct{}) error {
	if len(keys) == 0 {
		return nil
	}
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(max(1, globals.Workers))
	for key := range keys {
		g.Go(func() error {
			if err := o.Rm(gctx, key); err != nil {
				return fmt.Errorf("delete %s: %w", key, err)
			}
			return nil
		})
	}
	return g.Wait()
}
