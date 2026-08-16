package main

import (
	"context"
	"fmt"
	"sort"
)

// Read-side mirror of the binary idx pack format (the writer lives in
// db_pack.go). parseIdxPack is the byte-for-byte Go mirror of
// frontend/src/js/idx.ts makeIdxPack().parse(); getPackRef mirrors
// frontend/src/js/data.ts getPackRef(). Every read-side command
// (inspect/check/report, art) goes through this one parser, so the
// format has exactly one Go reader to keep in sync with the frontend.

// keyGetter abstracts "fetch + gunzip a store key" so the same read path
// works over a local store handle and a live HTTP CDN.
type keyGetter func(key string) ([]byte, error)

// fetcher adapts an open DB to the keyGetter the read-side parsers consume.
func (o *DB) fetcher(ctx context.Context) keyGetter {
	return func(key string) ([]byte, error) { return o.readGz(ctx, key) }
}

type idxBound struct {
	packID     int
	startChron int
}

type idxPack struct {
	packIndex     int
	packSize      int
	feedIDs       []uint16
	bounds        []idxBound
	packIDBase    uint32
	packOffBase   uint32
	numSlots      int
	feedCounts    []uint32 // cumulative before this pack (len numSlots)
	ownFeedCounts []uint32 // counted during parse (len = store high-water slots)
}

// feedIDAt returns the feed owning an ABSOLUTE chron, the sibling of
// getPackRef's addressing: packIndex is this pack's position, so subtracting
// its base chron is what turns a global address into a local entry index. It
// exists so the one place that spells that arithmetic is the file that mirrors
// the binary format (and frontend idx.ts), not each of its callers.
func (p *idxPack) feedIDAt(chron int) int {
	return int(p.feedIDs[chron-p.packIndex*idxPackSize])
}

// feedCount returns the cumulative count for id, 0 when id is beyond this
// pack's slots (a feed added after the pack was written).
func (p *idxPack) feedCount(id int) uint32 {
	if id < 0 || id >= p.numSlots {
		return 0
	}
	return p.feedCounts[id]
}

// ownFeedCount returns how many of this pack's entries belong to feed id.
// ownFeedCounts is sized to the store high-water (feedSlots), NOT this pack's
// numSlots: a feed added after the pack's header was frozen has id >= numSlots
// yet entries inside the pack, and both readers must still count them — see
// feedSlots and idx.ts makeIdxPack().parse() (sized to the threaded `slots`).
func (p *idxPack) ownFeedCount(id int) uint32 {
	if id < 0 || id >= len(p.ownFeedCounts) {
		return 0
	}
	return p.ownFeedCounts[id]
}

// feedSlots mirrors data.ts (slots = max(feed id)+1, or 1 when there are no
// feeds): the width parseIdxPack sizes ownFeedCounts to. It is the store
// high-water, deliberately not a pack's own numSlots — see ownFeedCount.
func feedSlots(core *DBCore) int {
	slots := 1
	for id := range core.Feeds {
		if id+1 > slots {
			slots = id + 1
		}
	}
	return slots
}

// deltaPackID is the sentinel data-pack id of the delta region's synthetic
// bound: getPackRef returns it for chrons at/above tailCovered, telling the
// caller the article lives in the parsed delta chain (offset = chron −
// tailCovered), not in any data pack.
const deltaPackID = -1

// parseDeltaChain is THE delta-chain reader: it fetches the segments the
// manifest lists, oldest first, and returns them as one chron-ordered chain —
// both the parsed articles and each entry's verbatim JSONL line bytes, since
// consolidation re-emits those bytes rather than re-encoding them. It is the
// authority for every chron at/above tailCovered.
//
// Chain CONTIGUITY was an arithmetic invariant only while the names were
// derived from a generation range; the listed chain IS the chain now
// (docs/MANIFEST-SPEC.md §13, DELTA-TAIL I1 retired as arithmetic, preserved as
// content). What survives verbatim is the accounting cross-check: each segment
// non-empty, and the total line count equals DeltaArticles (M6).
//
// Both entry points are thin wrappers over this body: the read side's
// loadDeltas (inspect, art, loadIdxPacks) and the writer's memoizing
// DB.loadDeltaChain (db_pack.go). They used to be near-identical copies of it —
// two places to state what a valid chain is, and so two places that could
// disagree about one.
func parseDeltaChain(fetch keyGetter, core *DBCore) (*deltaChain, error) {
	keys := core.Names.deltaKeys()
	if core.DeltaArticles < 0 || core.DeltaArticles > core.TotalArticles ||
		(len(keys) == 0) != (core.DeltaArticles == 0) {
		return nil, fmt.Errorf("inconsistent delta chain: %d segment(s), na=%d, total_art=%d",
			len(keys), core.DeltaArticles, core.TotalArticles)
	}
	chain := &deltaChain{}
	if len(keys) == 0 {
		return chain, nil
	}
	chain.Arts = make([]ArticleData, 0, core.DeltaArticles)
	chain.Lines = make([][]byte, 0, core.DeltaArticles)
	// The segments are independent objects and the chain is assembled in key
	// order regardless of completion order, so they are fetched concurrently:
	// serially this was --max-deltas (12 by default) round-trips of latency,
	// paid once per cycle on the locked path and again per read-tool run.
	bufs, err := gatherOrdered(len(keys), func(k int) ([]byte, error) {
		buf, err := fetch(keys[k])
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", keys[k], err)
		}
		return buf, nil
	})
	if err != nil {
		return nil, err
	}
	for i, key := range keys {
		lines, entries, err := splitDataPack(bufs[i])
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		if len(entries) == 0 {
			return nil, fmt.Errorf("%s: empty delta segment", key)
		}
		chain.Arts = append(chain.Arts, entries...)
		chain.Lines = append(chain.Lines, lines...)
	}
	if len(chain.Arts) != core.DeltaArticles {
		return nil, fmt.Errorf("delta chain holds %d articles but the store says na=%d",
			len(chain.Arts), core.DeltaArticles)
	}
	return chain, nil
}

// loadDeltas is the read side's view of the chain: the parsed articles alone.
// The one delta loader inspect and art go through.
func loadDeltas(fetch keyGetter, core *DBCore) ([]ArticleData, error) {
	chain, err := parseDeltaChain(fetch, core)
	if err != nil {
		return nil, err
	}
	return chain.Arts, nil
}

// idxTailKey names the tail idx object a store with a consolidated tail MUST
// have. Past tc > 0 the tail holds 1..50000 entries, so an empty name is
// name-table corruption, not an empty store — and the writer (checkTailIntact)
// and the reader (loadLatestIdx) have to answer that identically, or the
// writer sails past a store every reader is already failing to parse.
func idxTailKey(core *DBCore, tc int) (string, error) {
	key := core.Names.tailKey(idxSeries)
	if key == "" {
		return "", fmt.Errorf("the store consolidated %d article(s) but names no idx tail", tc)
	}
	return key, nil
}

// loadLatestIdx parses the physical tail idx pack (idx/L<tailGen>, covering
// chrons [nf·50k, tailCovered)) and extends it with the delta articles' feed
// ids, so every consumer sees ONE uniform latest pack spanning the whole tail
// [nf·50k, total_art) — countLeft/find*/feedIDStats need no delta awareness.
// The delta region's bound carries the deltaPackID sentinel; content lookups
// for it must go to the deltas slice, never to a data pack. A store whose
// whole content is deltas (tailCovered == 0: delta cycles from empty — no
// tail pack was ever written) synthesizes an empty base pack.
func loadLatestIdx(fetch keyGetter, core *DBCore, deltas []ArticleData, slots int) (*idxPack, error) {
	nf := numFinalizedIdx(core.TotalArticles)
	tc := tailCovered(core)
	var pack *idxPack
	if tc > 0 {
		key, err := idxTailKey(core, tc)
		if err != nil {
			return nil, err
		}
		buf, err := fetch(key)
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", key, err)
		}
		pack, err = parseIdxPack(buf, nf, tc-nf*idxPackSize, slots)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
	} else {
		pack = &idxPack{
			packIndex:     nf,
			numSlots:      0,
			feedCounts:    nil,
			ownFeedCounts: make([]uint32, slots),
		}
	}
	if len(deltas) > 0 {
		for i := range deltas {
			f := deltas[i].FeedID
			pack.feedIDs = append(pack.feedIDs, uint16(f))
			if f >= 0 && f < len(pack.ownFeedCounts) {
				pack.ownFeedCounts[f]++
			}
		}
		pack.bounds = append(pack.bounds, idxBound{deltaPackID, tc})
		pack.packSize += len(deltas)
	}
	return pack, nil
}

// loadIdxPacks fetches and parses every idx pack named by core: the finalized
// numeric names plus the L<tailGen> tail extended with the live delta chain
// (returned alongside, since delta-region content lookups need it — see
// deltaPackID). Returns nils for an empty store.
func loadIdxPacks(fetch keyGetter, core *DBCore) ([]*idxPack, []ArticleData, error) {
	if core.TotalArticles == 0 {
		return nil, nil, nil
	}
	numFinalized := numFinalizedIdx(core.TotalArticles)
	slots := feedSlots(core)
	out := make([]*idxPack, numFinalized+1)
	// Names and sizes resolve first (pure arithmetic over the table, and a
	// disagreement between the two should fail before any I/O), then the packs
	// are fetched concurrently: one finalized pack per 50,000 articles means a
	// serial walk is 20 round-trips at 1M articles, before `srr art` or the MCP
	// list tool can emit anything.
	keys := make([]string, numFinalized)
	sizes := make([]int, numFinalized)
	for p := range numFinalized {
		key, size, err := idxKeyAndSize(core, p)
		if err != nil {
			return nil, nil, err
		}
		keys[p], sizes[p] = key, size
	}
	bufs, err := gatherOrdered(numFinalized, func(p int) ([]byte, error) {
		buf, err := fetch(keys[p])
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", keys[p], err)
		}
		return buf, nil
	})
	if err != nil {
		return nil, nil, err
	}
	for p := range numFinalized {
		pack, err := parseIdxPack(bufs[p], p, sizes[p], slots)
		if err != nil {
			return nil, nil, fmt.Errorf("parse %s: %w", keys[p], err)
		}
		out[p] = pack
	}
	deltas, err := loadDeltas(fetch, core)
	if err != nil {
		return nil, nil, err
	}
	latest, err := loadLatestIdx(fetch, core, deltas, slots)
	if err != nil {
		return nil, nil, err
	}
	out[numFinalized] = latest
	return out, deltas, nil
}

// parseIdxPack is the byte-for-byte mirror of
// frontend/src/js/idx.ts makeIdxPack().parse(). The BYTES are decoded by the
// generated idxDecode (idx_layout.gen.go, emitted from the one layout
// declaration in idx_layout.go that also emits the TS reader's decoders), so
// what is mirrored here is only the SEMANTICS on top of them: the store
// high-water sizing of ownFeedCounts and the chron→data-pack bounds walk.
func parseIdxPack(buf []byte, packIndex, packSize, slots int) (*idxPack, error) {
	raw, err := idxDecode(buf, packSize)
	if err != nil {
		return nil, err
	}
	pack := &idxPack{
		packIndex:     packIndex,
		packSize:      packSize,
		feedIDs:       raw.FeedIDs,
		packIDBase:    raw.PackIDBase,
		packOffBase:   raw.PackOffBase,
		numSlots:      raw.NumSlots,
		feedCounts:    raw.FeedCounts,
		ownFeedCounts: make([]uint32, slots),
	}

	// Bounds come from the header bases + the boundary footer (the u16 LE local
	// indices at which the data packId advances), reconstructed with the same
	// push condition the old per-entry delta_pack_id decode used.
	packID := int(pack.packIDBase)
	packOff := int(pack.packOffBase)
	baseChron := packIndex * idxPackSize
	if packOff > 0 {
		pack.bounds = append(pack.bounds, idxBound{packID, baseChron - packOff})
	}
	bi := 0
	for i, sub := range raw.FeedIDs {
		if int(sub) < slots {
			pack.ownFeedCounts[sub]++
		}
		if bi < len(raw.Boundaries) && raw.Boundaries[bi] == i {
			packID++
			bi++
		}
		if len(pack.bounds) == 0 || pack.bounds[len(pack.bounds)-1].packID != packID {
			pack.bounds = append(pack.bounds, idxBound{packID, baseChron + i})
		}
	}
	return pack, nil
}

// getPackRef mirrors frontend/src/js/data.ts getPackRef().
func (p *idxPack) getPackRef(chron int) (packID, offset int) {
	idx := sort.Search(len(p.bounds), func(i int) bool {
		return p.bounds[i].startChron > chron
	}) - 1
	b := p.bounds[idx]
	return b.packID, chron - b.startChron
}

// packAt is packIdxFor's lookup form: the pack holding chron. Callers that
// also need the position keep packIdxFor; the rest say what they mean.
func packAt(packs []*idxPack, chron int) *idxPack {
	return packs[packIdxFor(chron, len(packs))]
}

// packIdxFor mirrors frontend/src/js/data.ts packIdx(): the index of the
// idx pack holding chron, clamped to the last pack.
func packIdxFor(chron, n int) int {
	p := chron / idxPackSize
	if p >= n {
		return n - 1
	}
	return p
}
