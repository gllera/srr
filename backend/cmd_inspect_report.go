package main

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func inspectOne(fetch fetcher, core *DBCore, packs []*inspIdx, chron int) error {
	if chron >= core.TotalArticles {
		return fmt.Errorf("chron %d out of range (total_art=%d)", chron, core.TotalArticles)
	}
	n := packIdxFor(chron, len(packs))
	pack := packs[n]
	idxSub := int(pack.subIDs[chron-n*idxPackSize])
	pid, offset := pack.getPackRef(chron)
	key := dataKeyFor(core, pid)

	local := chron - n*idxPackSize
	blocks := pack.fetchedAts[local]
	recoveredTs := (core.FirstFetchedAt/28800 + int64(blocks)) * 28800

	fmt.Printf("\nchron %d:\n", chron)
	fmt.Printf("  idx pack %d  entry sub_id=%d  fetchedAt_blocks=%d\n", n, idxSub, blocks)
	fmt.Printf("  resolved -> %s  packId=%d  offset=%d\n", key, pid, offset)

	entries, err := loadDataPack(fetch, key)
	if err != nil {
		return err
	}
	fmt.Printf("  data pack entries: %d\n", len(entries))

	if offset >= len(entries) {
		fmt.Printf("  *** OUT OF RANGE: frontend will throw 'Cannot read properties of undefined (reading 's')' ***\n")
		return fmt.Errorf("offset %d >= entries %d", offset, len(entries))
	}
	a := entries[offset]
	if a.SubID != idxSub {
		fmt.Printf("  *** SUB_ID MISMATCH: idx=%d data=%d ***\n", idxSub, a.SubID)
	}
	storedBlock := a.FetchedAt / 28800
	expectedBlock := core.FirstFetchedAt/28800 + int64(blocks)
	tsMismatch := storedBlock != expectedBlock
	fmt.Printf("  data sub_id: %d\n", a.SubID)
	fmt.Printf("  fetched_at: data=%d  idx-recovered=%d  (block-aligned match=%v)\n",
		a.FetchedAt, recoveredTs, !tsMismatch)
	if tsMismatch {
		fmt.Printf("  *** TIMESTAMP MISMATCH: idx block=%d data block=%d ***\n", expectedBlock, storedBlock)
	}
	fmt.Printf("  title: %s\n", truncStr(a.Title, 100))
	fmt.Printf("  link: %s\n", a.Link)
	if sub := core.Subscriptions[idxSub]; sub != nil {
		fmt.Printf("  sub: %s (tag=%q)\n", sub.Title, sub.Tag)
	} else {
		fmt.Printf("  *** sub %d not in subscriptions ***\n", idxSub)
	}
	if a.SubID != idxSub {
		return fmt.Errorf("sub_id mismatch")
	}
	if tsMismatch {
		return fmt.Errorf("timestamp mismatch")
	}
	return nil
}

// filterReport mirrors frontend filter logic: a filter token is a
// numeric sub_id or a tag name. Reports total count, chron range, and
// count above the optional floor — same numbers the frontend computes
// for filteredTotal / filteredLeft.
func filterReport(core *DBCore, packs []*inspIdx, token string, floor int) error {
	subs := map[int]int{} // sub_id -> add_idx
	if n, err := strconv.Atoi(token); err == nil {
		if sub := core.Subscriptions[n]; sub != nil && sub.TotalArt > 0 {
			subs[n] = sub.AddIdx
		}
	} else {
		for id, sub := range core.Subscriptions {
			if sub.Tag == token && sub.TotalArt > 0 {
				subs[id] = sub.AddIdx
			}
		}
	}
	if len(subs) == 0 {
		return fmt.Errorf("filter %q resolved to 0 subscriptions with articles", token)
	}

	subTotal := 0
	subIDs := make([]int, 0, len(subs))
	for id := range subs {
		subIDs = append(subIDs, id)
		subTotal += core.Subscriptions[id].TotalArt
	}
	sort.Ints(subIDs)

	count, aboveFloor, firstChron, lastChron := 0, 0, -1, -1
	for chron := range core.TotalArticles {
		n := packIdxFor(chron, len(packs))
		pack := packs[n]
		sid := int(pack.subIDs[chron-n*idxPackSize])
		addIdx, ok := subs[sid]
		if !ok || chron < addIdx {
			continue
		}
		count++
		if chron >= floor {
			aboveFloor++
		}
		if firstChron < 0 {
			firstChron = chron
		}
		lastChron = chron
	}

	fmt.Printf("\nfilter %q -> %d sub(s): %v\n", token, len(subs), subIDs)
	for _, id := range subIDs {
		sub := core.Subscriptions[id]
		fmt.Printf("  sub %d: %q tag=%q total_art=%d add_idx=%d\n",
			id, sub.Title, sub.Tag, sub.TotalArt, sub.AddIdx)
	}
	fmt.Printf("\nfilter.subTotal (sum of sub.total_art) = %d\n", subTotal)
	fmt.Printf("matches in idx                        = %d\n", count)
	if count != subTotal {
		fmt.Printf("  *** mismatch: filter would show wrong counter in UI ***\n")
	}
	if count > 0 {
		fmt.Printf("first matching chron                  = %d\n", firstChron)
		fmt.Printf("last matching chron                   = %d\n", lastChron)
		fmt.Printf("matches with chron >= floor(%d)        = %d\n", floor, aboveFloor)
	}
	if count != subTotal {
		return fmt.Errorf("filter count %d != sub_total %d", count, subTotal)
	}
	return nil
}

// listTagsReport mirrors frontend groupSubsByTag: one line per tag
// with sub count and total article count.
func listTagsReport(core *DBCore) error {
	type tagInfo struct {
		subs     int
		articles int
	}
	tags := map[string]*tagInfo{}
	untagged := &tagInfo{}
	for _, sub := range core.Subscriptions {
		if sub.TotalArt == 0 {
			continue
		}
		if sub.Tag == "" {
			untagged.subs++
			untagged.articles += sub.TotalArt
			continue
		}
		t := tags[sub.Tag]
		if t == nil {
			t = &tagInfo{}
			tags[sub.Tag] = t
		}
		t.subs++
		t.articles += sub.TotalArt
	}
	names := make([]string, 0, len(tags))
	for n := range tags {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Printf("\ntags (%d):\n", len(names))
	for _, n := range names {
		t := tags[n]
		fmt.Printf("  %-20s  %3d subs  %5d articles\n", n, t.subs, t.articles)
	}
	if untagged.subs > 0 {
		fmt.Printf("  %-20s  %3d subs  %5d articles\n", "(untagged)", untagged.subs, untagged.articles)
	}
	return nil
}

// fromHashReport replays nav.fromHash on a frontend URL hash like
// "0,2485!big_info": parses floor/pos/tokens, resolves filter, decides
// whether resolve(true) or last() runs, prints the resulting article.
func fromHashReport(fetch fetcher, core *DBCore, packs []*inspIdx, hash string) error {
	hash = strings.TrimPrefix(hash, "#")
	main, tokensPart, _ := strings.Cut(hash, "!")
	floorStr, posStr, hasComma := strings.Cut(main, ",")
	if !hasComma {
		posStr = floorStr
		floorStr = ""
	}

	floor := 0
	if f, err := strconv.Atoi(floorStr); err == nil && f > 0 {
		floor = f
	}

	var tokens []string
	if tokensPart != "" {
		for t := range strings.SplitSeq(tokensPart, "+") {
			if t == "" {
				continue
			}
			if dec, err := url.QueryUnescape(t); err == nil {
				tokens = append(tokens, dec)
			} else {
				tokens = append(tokens, t)
			}
		}
	}

	fmt.Printf("\nhash %q -> floor=%d pos_str=%q tokens=%v\n", hash, floor, posStr, tokens)

	subs := map[int]int{}
	for _, token := range tokens {
		if id, err := strconv.Atoi(token); err == nil {
			if sub := core.Subscriptions[id]; sub != nil && sub.TotalArt > 0 {
				subs[id] = sub.AddIdx
			}
		} else {
			for id, sub := range core.Subscriptions {
				if sub.Tag == token && sub.TotalArt > 0 {
					subs[id] = sub.AddIdx
				}
			}
		}
	}
	activeFilter := len(tokens) > 0 && len(subs) > 0
	if len(tokens) > 0 && !activeFilter {
		fmt.Printf("  filter tokens %v resolved to 0 subs -> falls back to no filter\n", tokens)
	}
	if activeFilter {
		ids := make([]int, 0, len(subs))
		for id := range subs {
			ids = append(ids, id)
		}
		sort.Ints(ids)
		fmt.Printf("  filter active: %d sub(s) %v\n", len(subs), ids)
	} else {
		fmt.Println("  filter inactive")
	}

	pos, err := strconv.Atoi(posStr)
	if err != nil || pos < 0 || pos >= core.TotalArticles {
		pos = core.TotalArticles - 1
		fmt.Printf("  pos clamped to %d\n", pos)
	} else {
		fmt.Printf("  pos=%d\n", pos)
	}

	n := packIdxFor(pos, len(packs))
	posSubID := int(packs[n].subIDs[pos-n*idxPackSize])
	matches := true
	if activeFilter {
		addIdx, ok := subs[posSubID]
		matches = ok && pos >= addIdx
	}
	fmt.Printf("  pos sub_id=%d matches filter=%v\n", posSubID, matches)

	finalPos := pos
	if !matches {
		finalPos = -1
		for c := core.TotalArticles - 1; c >= floor; c-- {
			pn := packIdxFor(c, len(packs))
			sid := int(packs[pn].subIDs[c-pn*idxPackSize])
			if !activeFilter {
				finalPos = c
				break
			}
			addIdx, ok := subs[sid]
			if ok && c >= addIdx {
				finalPos = c
				break
			}
		}
		if finalPos < 0 {
			fmt.Println("  no matching article above floor — frontend would show '(no matching articles)'")
			return nil
		}
		fmt.Printf("  pos doesn't match -> last() jumps to chron %d\n", finalPos)
	} else {
		fmt.Printf("  pos matches -> resolve(true), stays at chron %d\n", finalPos)
	}
	return inspectOne(fetch, core, packs, finalPos)
}
