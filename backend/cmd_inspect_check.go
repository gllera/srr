package main

import (
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
	cache := map[int][]ArticleData{}
	loadCached := func(pid int) []ArticleData {
		if e, ok := cache[pid]; ok {
			return e
		}
		e, err := loadDataPack(fetch, dataKeyFor(core, pid))
		if err != nil {
			fmt.Printf("[bounds-vs-data] fetch %s: %v\n", dataKeyFor(core, pid), err)
			return nil
		}
		cache[pid] = e
		return e
	}

	oob, mismatch := 0, 0
	for chron := range core.TotalArticles {
		n := packIdxFor(chron, len(packs))
		pack := packs[n]
		idxSub := int(pack.chanIDs[chron-n*idxPackSize])
		pid, offset := pack.getPackRef(chron)

		entries := loadCached(pid)
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
	fmt.Printf("[bounds-vs-data] scanned %d chronIdx, %d data packs cached: %d out-of-range, %d chan_id mismatches\n",
		core.TotalArticles, len(cache), oob, mismatch)
	return oob + mismatch
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

	idxCount := map[int]int{}
	idxFirst := map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.chanIDs {
			sid := int(s)
			idxCount[sid]++
			if _, ok := idxFirst[sid]; !ok {
				idxFirst[sid] = base + i
			}
		}
	}
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
		for s := range idxChanSlots {
			expected := cur.chanCounts[s] + cur.ownChanCounts[s]
			if next.chanCounts[s] != expected {
				fmt.Printf("[chan-counts] pack %d sub %d: header=%d but pack %d ended with cumulative %d\n",
					next.packIndex, s, next.chanCounts[s], cur.packIndex, expected)
				issues++
			}
		}
	}
	for s := range idxChanSlots {
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
	count := map[int]int{}
	first := map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.chanIDs {
			sid := int(s)
			if _, ok := core.Channels[sid]; ok {
				continue
			}
			count[sid]++
			if _, ok := first[sid]; !ok {
				first[sid] = base + i
			}
		}
	}
	if len(count) == 0 {
		fmt.Println("[unknown-chans] all idx chan_ids are registered")
		return 0
	}
	for sid, c := range count {
		fmt.Printf("[unknown-chans] chan_id %d: %d entries (first chron %d) — frontend renders \"[DELETED]\"\n",
			sid, c, first[sid])
	}
	return len(count)
}

// checkIdxSummary verifies the published idx header summary
// (idx/h<hdrs>.gz) against db.gz and the finalized packs: coverage may lag
// numFinalized (SyncIdxSummary is warn-only in fetch — readers fall back to
// eager idx loading) but never exceed it, and each 1036-byte chunk must
// equal the verbatim header of the finalized pack it covers.
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
	if len(buf) != core.HdrPacks*idxHeaderSize {
		fmt.Printf("[idx-summary] %s has %d bytes but hdrs=%d expects %d\n",
			key, len(buf), core.HdrPacks, core.HdrPacks*idxHeaderSize)
		return 1
	}
	issues := 0
	for k := range core.HdrPacks {
		chunk := buf[k*idxHeaderSize:]
		p := packs[k]
		if binary.LittleEndian.Uint32(chunk[0:]) != p.fetchedAtBase ||
			binary.LittleEndian.Uint32(chunk[4:]) != p.packIDBase ||
			binary.LittleEndian.Uint32(chunk[8:]) != p.packOffBase {
			fmt.Printf("[idx-summary] pack %d: summary bases (%d,%d,%d) != header (%d,%d,%d)\n", k,
				binary.LittleEndian.Uint32(chunk[0:]), binary.LittleEndian.Uint32(chunk[4:]),
				binary.LittleEndian.Uint32(chunk[8:]), p.fetchedAtBase, p.packIDBase, p.packOffBase)
			issues++
			continue
		}
		for s := range idxChanSlots {
			if got := binary.LittleEndian.Uint32(chunk[idxStateSize+s*4:]); got != p.chanCounts[s] {
				fmt.Printf("[idx-summary] pack %d sub %d: summary chanCount=%d but header has %d\n",
					k, s, got, p.chanCounts[s])
				issues++
				break
			}
		}
	}
	if issues == 0 {
		fmt.Printf("[idx-summary] %s matches %d finalized pack header(s)\n", key, core.HdrPacks)
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
