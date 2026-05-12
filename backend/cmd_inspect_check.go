package main

import (
	"fmt"
	"sort"
)

func validateAll(fetch fetcher, core *DBCore, packs []*inspIdx) error {
	fmt.Println()
	issues := 0

	issues += checkBoundsVsData(fetch, core, packs)
	issues += checkDBMeta(fetch, core, packs)
	issues += checkSubCountsContinuity(packs)
	issues += checkFetchedAtsContinuity(packs)
	issues += checkUnknownSubIDs(core, packs)
	issues += checkLatestFiles(fetch, core)

	fmt.Println()
	if issues == 0 {
		fmt.Println("OK: all checks passed")
		return nil
	}
	return fmt.Errorf("%d issue(s) found", issues)
}

// checkBoundsVsData walks every chronIdx and verifies the resolved
// (packId, offset) lands inside an existing data-pack entry whose
// sub_id matches the idx pack's sub_id.
func checkBoundsVsData(fetch fetcher, core *DBCore, packs []*inspIdx) int {
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
		idxSub := int(pack.subIDs[chron-n*idxPackSize])
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
		if entries[offset].SubID != idxSub {
			fmt.Printf("[bounds-vs-data] chron %d: sub_id mismatch idx=%d data=%d (packId=%d offset=%d)\n",
				chron, idxSub, entries[offset].SubID, pid, offset)
			mismatch++
		}
	}
	fmt.Printf("[bounds-vs-data] scanned %d chronIdx, %d data packs cached: %d out-of-range, %d sub_id mismatches\n",
		core.TotalArticles, len(cache), oob, mismatch)
	return oob + mismatch
}

// checkDBMeta cross-checks db.gz fields against actual pack contents.
func checkDBMeta(fetch fetcher, core *DBCore, packs []*inspIdx) int {
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

	latestKey := fmt.Sprintf("data/%v.gz", core.DataToggle)
	latest, err := loadDataPack(fetch, latestKey)
	if err != nil {
		fmt.Printf("[db-meta] fetch %s: %v\n", latestKey, err)
		issues++
	} else if len(latest) != core.PackOffset {
		fmt.Printf("[db-meta] pack_off=%d but %s has %d entries\n", core.PackOffset, latestKey, len(latest))
		issues++
	}

	idxCount := map[int]int{}
	idxFirst := map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.subIDs {
			sid := int(s)
			idxCount[sid]++
			if _, ok := idxFirst[sid]; !ok {
				idxFirst[sid] = base + i
			}
		}
	}
	subIDs := make([]int, 0, len(core.Subscriptions))
	for id := range core.Subscriptions {
		subIDs = append(subIDs, id)
	}
	sort.Ints(subIDs)
	for _, id := range subIDs {
		sub := core.Subscriptions[id]
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
	fmt.Printf("[db-meta] checked total_art, next_pid, pack_off, and %d subscriptions\n", len(subIDs))
	return issues
}

// checkSubCountsContinuity verifies header subCounts[s] in pack i+1
// equals subCounts[s] + ownSubCounts[s] from pack i. Only meaningful
// once total_art crosses idxPackSize.
func checkSubCountsContinuity(packs []*inspIdx) int {
	if len(packs) < 2 {
		fmt.Println("[sub-counts] only 1 idx pack; continuity check skipped")
		return 0
	}
	issues := 0
	for i := 0; i < len(packs)-1; i++ {
		cur, next := packs[i], packs[i+1]
		for s := range 256 {
			expected := cur.subCounts[s] + cur.ownSubCounts[s]
			if next.subCounts[s] != expected {
				fmt.Printf("[sub-counts] pack %d sub %d: header=%d but pack %d ended with cumulative %d\n",
					next.packIndex, s, next.subCounts[s], cur.packIndex, expected)
				issues++
			}
		}
	}
	for s := range 256 {
		if packs[0].subCounts[s] != 0 {
			fmt.Printf("[sub-counts] pack 0 sub %d: header=%d but expected 0 (no articles before first pack)\n",
				s, packs[0].subCounts[s])
			issues++
		}
	}
	if issues == 0 {
		fmt.Printf("[sub-counts] %d pack boundary transitions consistent\n", len(packs)-1)
	}
	return issues
}

// checkFetchedAtsContinuity verifies header fetchedAt_base in pack i+1
// equals the cumulative fetched_at at the end of pack i. Pack 0's base
// must be 0 (no time has passed before the first article). A drift here
// silently breaks findChronForTimestamp's binary search.
func checkFetchedAtsContinuity(packs []*inspIdx) int {
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

// checkUnknownSubIDs flags any idx entry whose sub byte isn't
// registered in db.subscriptions.
func checkUnknownSubIDs(core *DBCore, packs []*inspIdx) int {
	count := map[int]int{}
	first := map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.subIDs {
			sid := int(s)
			if _, ok := core.Subscriptions[sid]; ok {
				continue
			}
			count[sid]++
			if _, ok := first[sid]; !ok {
				first[sid] = base + i
			}
		}
	}
	if len(count) == 0 {
		fmt.Println("[unknown-subs] all idx sub_ids are registered")
		return 0
	}
	for sid, c := range count {
		fmt.Printf("[unknown-subs] sub_id %d: %d entries (first chron %d) — frontend renders \"[DELETED]\"\n",
			sid, c, first[sid])
	}
	return len(count)
}

// checkLatestFiles confirms the latest idx and data pack files
// (named after data_tog) actually exist and decompress.
func checkLatestFiles(fetch fetcher, core *DBCore) int {
	issues := 0
	for _, prefix := range []string{"idx", "data"} {
		key := fmt.Sprintf("%s/%v.gz", prefix, core.DataToggle)
		if _, err := fetch(key); err != nil {
			fmt.Printf("[latest-files] %s missing or corrupt: %v\n", key, err)
			issues++
		}
	}
	if issues == 0 {
		fmt.Printf("[latest-files] idx/%v.gz and data/%v.gz present\n", core.DataToggle, core.DataToggle)
	}
	return issues
}
