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
	issues += checkChanCountsContinuity(packs)
	issues += checkFetchedAtsContinuity(packs)
	issues += checkUnknownChanIDs(core, packs)
	issues += checkLatestFiles(fetch, core)
	issues += checkIdxSummary(fetch, core, packs)
	issues += checkSearch(fetch, core)

	fmt.Println()
	if issues == 0 {
		fmt.Println("OK: all checks passed")
		return nil
	}
	return fmt.Errorf("%d issue(s) found", issues)
}

// checkBoundsVsData walks every chronIdx and verifies the resolved
// (packId, offset) lands inside an existing data-pack entry whose
// chan_id matches the idx pack's chan_id.
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
		idxSub := int(pack.chanIDs[chron-n*idxPackSize])
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
		if entries[offset].ChannelID != idxSub {
			fmt.Printf("[bounds-vs-data] chron %d: chan_id mismatch idx=%d data=%d (packId=%d offset=%d)\n",
				chron, idxSub, entries[offset].ChannelID, pid, offset)
			mismatch++
		}
	}
	fmt.Printf("[bounds-vs-data] scanned %d chronIdx, %d data packs visited: %d out-of-range, %d chan_id mismatches\n",
		core.TotalArticles, loaded, oob, mismatch)
	return oob + mismatch
}

// chanIDStats walks every idx entry once, returning per-chan_id entry counts
// and first-occurrence chrons. Shared by checkDBMeta (registered channels)
// and checkUnknownChanIDs (unregistered ones).
func chanIDStats(packs []*idxPack) (count, first map[int]int) {
	count, first = map[int]int{}, map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.chanIDs {
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

	idxCount, idxFirst := chanIDStats(packs)
	chanIDs := make([]int, 0, len(core.Channels))
	for id := range core.Channels {
		chanIDs = append(chanIDs, id)
	}
	sort.Ints(chanIDs)
	for _, id := range chanIDs {
		sub := core.Channels[id]
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
	fmt.Printf("[db-meta] checked total_art, next_pid, pack_off, and %d subscriptions\n", len(chanIDs))
	return issues
}

// checkChanCountsContinuity verifies header chanCounts[s] in pack i+1
// equals chanCounts[s] + ownChanCounts[s] from pack i. Only meaningful
// once total_art crosses idxPackSize.
func checkChanCountsContinuity(packs []*idxPack) int {
	if len(packs) < 2 {
		fmt.Println("[chan-counts] only 1 idx pack; continuity check skipped")
		return 0
	}
	issues := 0
	for i := 0; i < len(packs)-1; i++ {
		cur, next := packs[i], packs[i+1]
		// Check every slot either pack carries: a later-added channel widens
		// next's header beyond cur's, and the bounded accessors read 0 for ids
		// a pack doesn't reach.
		slots := max(cur.numSlots, next.numSlots)
		for s := range slots {
			expected := cur.chanCount(s) + cur.ownChanCount(s)
			if next.chanCount(s) != expected {
				fmt.Printf("[chan-counts] pack %d sub %d: header=%d but pack %d ended with cumulative %d\n",
					next.packIndex, s, next.chanCount(s), cur.packIndex, expected)
				issues++
			}
		}
	}
	for s := range packs[0].numSlots {
		if packs[0].chanCounts[s] != 0 {
			fmt.Printf("[chan-counts] pack 0 sub %d: header=%d but expected 0 (no articles before first pack)\n",
				s, packs[0].chanCounts[s])
			issues++
		}
	}
	if issues == 0 {
		fmt.Printf("[chan-counts] %d pack boundary transitions consistent\n", len(packs)-1)
	}
	return issues
}

// checkFetchedAtsContinuity verifies header fetchedAt_base in pack i+1
// equals the cumulative fetched_at at the end of pack i. Pack 0's base
// must be 0 (no time has passed before the first article). A drift here
// silently breaks findChronForTimestamp's binary search.
func checkFetchedAtsContinuity(packs []*idxPack) int {
	issues := 0
	if packs[0].fetchedAtBase != 0 {
		fmt.Printf("[fetched-ats] pack 0 fetchedAt_base=%d but expected 0\n", packs[0].fetchedAtBase)
		issues++
	}
	for i := 0; i < len(packs)-1; i++ {
		cur, next := packs[i], packs[i+1]
		last := cur.fetchedAts[len(cur.fetchedAts)-1]
		if next.fetchedAtBase != last {
			fmt.Printf("[fetched-ats] pack %d fetchedAt_base=%d but pack %d ended at %d\n",
				next.packIndex, next.fetchedAtBase, cur.packIndex, last)
			issues++
		}
	}
	if issues == 0 {
		if len(packs) == 1 {
			fmt.Println("[fetched-ats] pack 0 base=0 OK (single pack)")
		} else {
			fmt.Printf("[fetched-ats] %d pack boundary transitions consistent\n", len(packs)-1)
		}
	}
	return issues
}

// checkUnknownChanIDs flags any idx entry whose channel byte isn't
// registered in db.channels.
func checkUnknownChanIDs(core *DBCore, packs []*idxPack) int {
	count, first := chanIDStats(packs)
	unknown := 0
	for sid, c := range count {
		if _, ok := core.Channels[sid]; ok {
			continue
		}
		fmt.Printf("[unknown-chans] chan_id %d: %d entries (first chron %d) — frontend renders \"[DELETED]\"\n",
			sid, c, first[sid])
		unknown++
	}
	if unknown == 0 {
		fmt.Println("[unknown-chans] all idx chan_ids are registered")
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
		hdr, err := parseIdxPack(buf[off:end], k, 0)
		if err != nil {
			fmt.Printf("[idx-summary] pack %d chunk: %v\n", k, err)
			issues++
			off = end
			continue
		}
		off = end
		p := packs[k]
		if hdr.fetchedAtBase != p.fetchedAtBase || hdr.packIDBase != p.packIDBase || hdr.packOffBase != p.packOffBase {
			fmt.Printf("[idx-summary] pack %d: summary bases (%d,%d,%d) != header (%d,%d,%d)\n", k,
				hdr.fetchedAtBase, hdr.packIDBase, hdr.packOffBase,
				p.fetchedAtBase, p.packIDBase, p.packOffBase)
			issues++
			continue
		}
		slots := max(hdr.numSlots, p.numSlots)
		mismatched := false
		for s := range slots {
			if hdr.chanCount(s) != p.chanCount(s) {
				fmt.Printf("[idx-summary] pack %d sub %d: summary chanCount=%d but header has %d\n",
					k, s, hdr.chanCount(s), p.chanCount(s))
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

// checkSearch verifies the search/ series against db.gz: coverage
// (srch/srcht) may lag numFinalized (SyncSearch is warn-only in fetch —
// readers keep search disabled until the next run heals) but never
// overclaim; the latest tail must hold exactly srcht entries; every covered
// finalized shard must hold idxPackSize entries behind its bloom header,
// every title's grams must probe positive in that bloom (the no-false-
// negatives contract the reader's pruning relies on), and the summary must
// equal the concatenated shard blooms byte-for-byte.
func checkSearch(fetch keyGetter, core *DBCore) int {
	nf := numFinalizedIdx(core.TotalArticles)
	if core.SearchPacks > nf {
		fmt.Printf("[search] srch=%d but only %d finalized idx packs exist\n", core.SearchPacks, nf)
		return 1
	}
	if core.SearchTail < 0 || core.SearchTail > idxPackSize ||
		core.SearchPacks*idxPackSize+core.SearchTail > core.TotalArticles {
		fmt.Printf("[search] inconsistent coverage: srch=%d srcht=%d total_art=%d\n",
			core.SearchPacks, core.SearchTail, core.TotalArticles)
		return 1
	}
	if core.SearchPacks == 0 && core.SearchTail == 0 {
		fmt.Println("[search] no search coverage published (srch=0, srcht=0)")
		return 0
	}
	if core.SearchPacks < nf {
		fmt.Printf("[search] warning: srch=%d lags %d finalized packs (readers keep search disabled; next fetch rebuilds)\n",
			core.SearchPacks, nf)
	}
	issues := 0

	latestSearch := latestKey(core, "search")
	if buf, err := fetch(latestSearch); err != nil {
		fmt.Printf("[search] %s missing or corrupt: %v\n", latestSearch, err)
		issues++
	} else if entries, err := parseSearchEntries(buf); err != nil {
		fmt.Printf("[search] %s: %v\n", latestSearch, err)
		issues++
	} else if len(entries) != core.SearchTail {
		fmt.Printf("[search] srcht=%d but %s has %d entries\n", core.SearchTail, latestSearch, len(entries))
		issues++
	}

	if core.SearchPacks == 0 {
		if issues == 0 {
			fmt.Printf("[search] %s holds the %d-entry tail (no finalized shards)\n", latestSearch, core.SearchTail)
		}
		return issues
	}

	sumKey := searchSummaryKey(core.SearchPacks)
	sum, err := fetch(sumKey)
	if err != nil {
		fmt.Printf("[search] %s missing or corrupt: %v\n", sumKey, err)
		sum = nil
		issues++
	} else if len(sum) != core.SearchPacks*searchBloomBytes {
		fmt.Printf("[search] %s has %d bytes but srch=%d expects %d\n",
			sumKey, len(sum), core.SearchPacks, core.SearchPacks*searchBloomBytes)
		sum = nil
		issues++
	}

	for k := range core.SearchPacks {
		key := finalizedSearchKey(k)
		buf, err := fetch(key)
		if err != nil {
			fmt.Printf("[search] %s missing or corrupt: %v\n", key, err)
			issues++
			continue
		}
		if len(buf) < searchBloomBytes {
			fmt.Printf("[search] %s has %d bytes, shorter than the bloom header\n", key, len(buf))
			issues++
			continue
		}
		bloom := buf[:searchBloomBytes]
		if sum != nil && !bytes.Equal(sum[k*searchBloomBytes:(k+1)*searchBloomBytes], bloom) {
			fmt.Printf("[search] shard %d: summary bloom != shard bloom header\n", k)
			issues++
		}
		entries, err := parseSearchEntries(buf[searchBloomBytes:])
		if err != nil {
			fmt.Printf("[search] %s: %v\n", key, err)
			issues++
			continue
		}
		if len(entries) != idxPackSize {
			fmt.Printf("[search] %s has %d entries, want %d\n", key, len(entries), idxPackSize)
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
			fmt.Printf("[search] shard %d: %d gram(s) absent from its bloom (reader pruning would miss results)\n", k, missing)
			issues++
		}
	}

	if issues == 0 {
		fmt.Printf("[search] %d shard(s), %s, and the %d-entry tail consistent\n",
			core.SearchPacks, sumKey, core.SearchTail)
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
