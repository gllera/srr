package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"
)

func validateAll(fetch keyGetter, core *DBCore, packs []*idxPack) error {
	fmt.Println()
	issues := 0

	issues += checkBoundsVsData(fetch, core, packs)
	issues += checkDBMeta(fetch, core, packs)
	issues += checkFeedCountsContinuity(packs)
	issues += checkUnknownFeedIDs(core, packs)
	issues += checkLatestFiles(fetch, core)
	issues += checkIdxSummary(fetch, core, packs)
	issues += checkMeta(fetch, core)

	fmt.Println()
	if issues == 0 {
		fmt.Println("OK: all checks passed")
		return nil
	}
	return fmt.Errorf("%d issue(s) found", issues)
}

// checkBoundsVsData walks every chronIdx and verifies the resolved
// (packId, offset) lands inside an existing data-pack entry whose
// feed_id matches the idx pack's feed_id.
func checkBoundsVsData(fetch keyGetter, core *DBCore, packs []*idxPack) int {
	// Chron order keeps (packId, offset) monotonic, so one resident pack
	// suffices (the walkArticles pattern) — caching every decoded pack would
	// hold the whole store's article content at peak.
	var entries []ArticleData
	loadedPid, loaded := -1, 0
	load := func(pid int) []ArticleData {
		if pid == loadedPid {
			return entries
		}
		e, err := loadDataPack(fetch, dataKeyFor(core, pid))
		if err != nil {
			fmt.Printf("[bounds-vs-data] fetch %s: %v\n", dataKeyFor(core, pid), err)
			e = nil
		}
		entries, loadedPid = e, pid
		loaded++
		return entries
	}

	oob, mismatch := 0, 0
	for chron := range core.TotalArticles {
		n := packIdxFor(chron, len(packs))
		pack := packs[n]
		idxSub := int(pack.feedIDs[chron-n*idxPackSize])
		pid, offset := pack.getPackRef(chron)

		entries := load(pid)
		if entries == nil {
			oob++
			continue
		}
		if offset >= len(entries) {
			fmt.Printf("[bounds-vs-data] chron %d: packId=%d offset=%d >= entries=%d (frontend crashes on this chronIdx)\n",
				chron, pid, offset, len(entries))
			oob++
			continue
		}
		if entries[offset].FeedID != idxSub {
			fmt.Printf("[bounds-vs-data] chron %d: feed_id mismatch idx=%d data=%d (packId=%d offset=%d)\n",
				chron, idxSub, entries[offset].FeedID, pid, offset)
			mismatch++
		}
	}
	fmt.Printf("[bounds-vs-data] scanned %d chronIdx, %d data packs visited: %d out-of-range, %d feed_id mismatches\n",
		core.TotalArticles, loaded, oob, mismatch)
	return oob + mismatch
}

// feedIDStats walks every idx entry once, returning per-feed_id entry counts
// and first-occurrence chrons. Shared by checkDBMeta (registered feeds)
// and checkUnknownFeedIDs (unregistered ones).
func feedIDStats(packs []*idxPack) (count, first map[int]int) {
	count, first = map[int]int{}, map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.feedIDs {
			sid := int(s)
			count[sid]++
			if _, ok := first[sid]; !ok {
				first[sid] = base + i
			}
		}
	}
	return count, first
}

// checkDBMeta cross-checks db.gz fields against actual pack contents.
func checkDBMeta(fetch keyGetter, core *DBCore, packs []*idxPack) int {
	issues := 0

	totalEntries := 0
	for _, p := range packs {
		totalEntries += p.packSize
	}
	if totalEntries != core.TotalArticles {
		fmt.Printf("[db-meta] total_art=%d but idx packs hold %d entries\n", core.TotalArticles, totalEntries)
		issues++
	}

	last := packs[len(packs)-1]
	maxPackID := last.bounds[len(last.bounds)-1].packID
	if maxPackID != core.NextPackID {
		fmt.Printf("[db-meta] next_pid=%d but latest idx bound's packId=%d\n", core.NextPackID, maxPackID)
		issues++
	}

	latestData := latestKey(core, "data")
	latest, err := loadDataPack(fetch, latestData)
	if err != nil {
		fmt.Printf("[db-meta] fetch %s: %v\n", latestData, err)
		issues++
	} else if len(latest) != core.PackOffset {
		fmt.Printf("[db-meta] pack_off=%d but %s has %d entries\n", core.PackOffset, latestData, len(latest))
		issues++
	}

	idxCount, idxFirst := feedIDStats(packs)
	feedIDs := make([]int, 0, len(core.Feeds))
	for id := range core.Feeds {
		feedIDs = append(feedIDs, id)
	}
	sort.Ints(feedIDs)
	for _, id := range feedIDs {
		sub := core.Feeds[id]
		actual := idxCount[id]
		if actual != sub.TotalArt {
			fmt.Printf("[db-meta] sub %d (%q): total_art=%d but idx has %d entries\n",
				id, sub.Title, sub.TotalArt, actual)
			issues++
		}
		if first, ok := idxFirst[id]; ok && first < sub.AddIdx {
			fmt.Printf("[db-meta] sub %d (%q): add_idx=%d but first idx occurrence at chron %d\n",
				id, sub.Title, sub.AddIdx, first)
			issues++
		}
	}
	fmt.Printf("[db-meta] checked total_art, next_pid, pack_off, and %d subscriptions\n", len(feedIDs))
	return issues
}

// checkFeedCountsContinuity verifies header feedCounts[s] in pack i+1
// equals feedCounts[s] + ownFeedCounts[s] from pack i. Only meaningful
// once total_art crosses idxPackSize.
func checkFeedCountsContinuity(packs []*idxPack) int {
	if len(packs) < 2 {
		fmt.Println("[feed-counts] only 1 idx pack; continuity check skipped")
		return 0
	}
	issues := 0
	for i := 0; i < len(packs)-1; i++ {
		cur, next := packs[i], packs[i+1]
		// Check every slot either pack carries: a later-added feed widens
		// next's header beyond cur's, and the bounded accessors read 0 for ids
		// a pack doesn't reach.
		slots := max(cur.numSlots, next.numSlots)

		// Tally cur's own per-slot counts directly from the immutable feedIDs
		// slice rather than cur.ownFeedCount(). ownFeedCounts is sized to
		// feedSlots(core) = max(current feed id)+1; deleting the highest-id
		// feed shrinks that below a finalized pack's immutable numSlots, so
		// ownFeedCount(deletedId) silently returns 0 and produces a spurious
		// mismatch against next's on-disk header.  Reading feedIDs avoids that
		// dependency on the current feed registry entirely.
		curOwn := make([]uint32, slots)
		for _, id := range cur.feedIDs {
			if int(id) < slots {
				curOwn[id]++
			}
		}

		for s := range slots {
			expected := cur.feedCount(s) + curOwn[s]
			if next.feedCount(s) != expected {
				fmt.Printf("[feed-counts] pack %d sub %d: header=%d but pack %d ended with cumulative %d\n",
					next.packIndex, s, next.feedCount(s), cur.packIndex, expected)
				issues++
			}
		}
	}
	for s := range packs[0].numSlots {
		if packs[0].feedCounts[s] != 0 {
			fmt.Printf("[feed-counts] pack 0 sub %d: header=%d but expected 0 (no articles before first pack)\n",
				s, packs[0].feedCounts[s])
			issues++
		}
	}
	if issues == 0 {
		fmt.Printf("[feed-counts] %d pack boundary transitions consistent\n", len(packs)-1)
	}
	return issues
}

// checkUnknownFeedIDs flags any idx entry whose feed byte isn't
// registered in db.feeds.
func checkUnknownFeedIDs(core *DBCore, packs []*idxPack) int {
	count, first := feedIDStats(packs)
	unknown := 0
	for sid, c := range count {
		if _, ok := core.Feeds[sid]; ok {
			continue
		}
		fmt.Printf("[unknown-feeds] feed_id %d: %d entries (first chron %d) — frontend renders \"[DELETED]\"\n",
			sid, c, first[sid])
		unknown++
	}
	if unknown == 0 {
		fmt.Println("[unknown-feeds] all idx feed_ids are registered")
	}
	return unknown
}

// checkIdxSummary verifies the published idx header summary
// (idx/h<hdrs>.gz) against db.gz and the finalized packs: coverage may lag
// numFinalized (SyncIdxSummary is warn-only in fetch — readers fall back to
// eager idx loading) but never exceed it, and each variable-length chunk must
// equal the verbatim header of the finalized pack it covers. The summary is a
// concatenation of headers whose stride varies with each pack's numSlots, so
// the walk reads numSlots from each prefix to advance; it must consume the
// buffer exactly. Chunks are decoded through parseIdxPack (packSize 0 = header
// only) so the summary is read by the same parser as the packs themselves.
func checkIdxSummary(fetch keyGetter, core *DBCore, packs []*idxPack) int {
	numFinalized := numFinalizedIdx(core.TotalArticles)
	if core.HdrPacks > numFinalized {
		fmt.Printf("[idx-summary] hdrs=%d but only %d finalized idx packs exist\n", core.HdrPacks, numFinalized)
		return 1
	}
	if core.HdrPacks < numFinalized {
		fmt.Printf("[idx-summary] warning: hdrs=%d lags %d finalized packs (readers fall back to eager idx loading; next fetch rebuilds)\n",
			core.HdrPacks, numFinalized)
	}
	if core.HdrPacks == 0 {
		fmt.Println("[idx-summary] no summary expected (hdrs=0)")
		return 0
	}
	key := summaryKey(core.HdrPacks)
	buf, err := fetch(key)
	if err != nil {
		fmt.Printf("[idx-summary] %s missing or corrupt: %v\n", key, err)
		return 1
	}
	issues := 0
	off := 0
	for k := range core.HdrPacks {
		if off+idxHeaderPrefix > len(buf) {
			fmt.Printf("[idx-summary] %s: truncated at chunk %d/%d (offset %d of %d)\n",
				key, k, core.HdrPacks, off, len(buf))
			return issues + 1
		}
		numSlots := int(binary.LittleEndian.Uint32(buf[off+idxStateSize:]))
		end := off + idxHeaderPrefix + numSlots*4
		if end > len(buf) {
			fmt.Printf("[idx-summary] %s: chunk %d claims %d slots running past the buffer (%d > %d)\n",
				key, k, numSlots, end, len(buf))
			return issues + 1
		}
		// Header-only decode (packSize 0 ⇒ no entries parsed), so the
		// ownFeedCounts slot width is irrelevant here.
		hdr, err := parseIdxPack(buf[off:end], k, 0, 0)
		if err != nil {
			fmt.Printf("[idx-summary] pack %d chunk: %v\n", k, err)
			issues++
			off = end
			continue
		}
		off = end
		p := packs[k]
		if hdr.packIDBase != p.packIDBase || hdr.packOffBase != p.packOffBase {
			fmt.Printf("[idx-summary] pack %d: summary bases (%d,%d) != header (%d,%d)\n", k,
				hdr.packIDBase, hdr.packOffBase, p.packIDBase, p.packOffBase)
			issues++
			continue
		}
		slots := max(hdr.numSlots, p.numSlots)
		mismatched := false
		for s := range slots {
			if hdr.feedCount(s) != p.feedCount(s) {
				fmt.Printf("[idx-summary] pack %d sub %d: summary feedCount=%d but header has %d\n",
					k, s, hdr.feedCount(s), p.feedCount(s))
				mismatched = true
			}
		}
		if mismatched {
			issues++
		}
	}
	if off != len(buf) {
		fmt.Printf("[idx-summary] %s: %d byte(s) consumed but buffer is %d (extra trailing data)\n",
			key, off, len(buf))
		issues++
	}
	if issues == 0 {
		fmt.Printf("[idx-summary] %s matches %d finalized pack header(s)\n", key, core.HdrPacks)
	}
	return issues
}

// checkMeta verifies the meta/ series against db.gz: coverage
// (mp/mt) may lag numFinalizedMeta (SyncMeta is warn-only in fetch —
// readers keep search disabled until the next run heals) but never
// overclaim; the latest tail must hold exactly mt entries; every covered
// finalized shard must hold metaPackSize entries behind its bloom header,
// every title's grams must probe positive in that bloom (the no-false-
// negatives contract the reader's pruning relies on), and the summary must
// equal the concatenated shard blooms byte-for-byte.
func checkMeta(fetch keyGetter, core *DBCore) int {
	nf := numFinalizedMeta(core.TotalArticles)
	if core.MetaPacks > nf {
		fmt.Printf("[meta] mp=%d but only %d finalized meta shards exist\n", core.MetaPacks, nf)
		return 1
	}
	if core.MetaTail < 0 || core.MetaTail > metaPackSize ||
		core.MetaPacks*metaPackSize+core.MetaTail > core.TotalArticles {
		fmt.Printf("[meta] inconsistent coverage: mp=%d mt=%d total_art=%d\n",
			core.MetaPacks, core.MetaTail, core.TotalArticles)
		return 1
	}
	if core.MetaPacks == 0 && core.MetaTail == 0 {
		fmt.Println("[meta] no meta coverage published (mp=0, mt=0)")
		return 0
	}
	if core.MetaPacks < nf {
		fmt.Printf("[meta] warning: mp=%d lags %d finalized shards (readers keep search disabled; next fetch rebuilds)\n",
			core.MetaPacks, nf)
	}
	issues := 0

	latestMeta := latestKey(core, "meta")
	if buf, err := fetch(latestMeta); err != nil {
		fmt.Printf("[meta] %s missing or corrupt: %v\n", latestMeta, err)
		issues++
	} else if entries, err := parseMetaEntries(buf); err != nil {
		fmt.Printf("[meta] %s: %v\n", latestMeta, err)
		issues++
	} else if len(entries) != core.MetaTail {
		fmt.Printf("[meta] mt=%d but %s has %d entries\n", core.MetaTail, latestMeta, len(entries))
		issues++
	}

	if core.MetaPacks == 0 {
		if issues == 0 {
			fmt.Printf("[meta] %s holds the %d-entry tail (no finalized shards)\n", latestMeta, core.MetaTail)
		}
		return issues
	}

	sumKey := metaSummaryKey(core.MetaPacks)
	sum, err := fetch(sumKey)
	if err != nil {
		fmt.Printf("[meta] %s missing or corrupt: %v\n", sumKey, err)
		sum = nil
		issues++
	} else if len(sum) != core.MetaPacks*searchBloomBytes {
		fmt.Printf("[meta] %s has %d bytes but mp=%d expects %d\n",
			sumKey, len(sum), core.MetaPacks, core.MetaPacks*searchBloomBytes)
		sum = nil
		issues++
	}

	for k := range core.MetaPacks {
		key := finalizedMetaKey(k)
		buf, err := fetch(key)
		if err != nil {
			fmt.Printf("[meta] %s missing or corrupt: %v\n", key, err)
			issues++
			continue
		}
		if len(buf) < searchBloomBytes {
			fmt.Printf("[meta] %s has %d bytes, shorter than the bloom header\n", key, len(buf))
			issues++
			continue
		}
		bloom := buf[:searchBloomBytes]
		if sum != nil && !bytes.Equal(sum[k*searchBloomBytes:(k+1)*searchBloomBytes], bloom) {
			fmt.Printf("[meta] shard %d: summary bloom != shard bloom header\n", k)
			issues++
		}
		entries, err := parseMetaEntries(buf[searchBloomBytes:])
		if err != nil {
			fmt.Printf("[meta] %s: %v\n", key, err)
			issues++
			continue
		}
		if len(entries) != metaPackSize {
			fmt.Printf("[meta] %s has %d entries, want %d\n", key, len(entries), metaPackSize)
			issues++
			continue
		}
		missing := 0
		for _, e := range entries {
			eachSearchGram(foldSearchText(e.Title), func(gram string) {
				if !bloomHas(bloom, gram) {
					missing++
				}
			})
		}
		if missing > 0 {
			fmt.Printf("[meta] shard %d: %d gram(s) absent from its bloom (reader pruning would miss results)\n", k, missing)
			issues++
		}
	}

	if issues == 0 {
		fmt.Printf("[meta] %d shard(s), %s, and the %d-entry tail consistent\n",
			core.MetaPacks, sumKey, core.MetaTail)
	}
	return issues
}

// checkLatestFiles confirms the latest idx and data pack files
// (the current L<seq> generation) actually exist and decompress.
func checkLatestFiles(fetch keyGetter, core *DBCore) int {
	issues := 0
	for _, prefix := range []string{"idx", "data"} {
		key := latestKey(core, prefix)
		if _, err := fetch(key); err != nil {
			fmt.Printf("[latest-files] %s missing or corrupt: %v\n", key, err)
			issues++
		}
	}
	if issues == 0 {
		fmt.Printf("[latest-files] %s and %s present\n", latestKey(core, "idx"), latestKey(core, "data"))
	}
	return issues
}
