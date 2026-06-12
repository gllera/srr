package main

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func inspectOne(fetch keyGetter, core *DBCore, packs []*idxPack, chron int) error {
	if chron >= core.TotalArticles {
		return fmt.Errorf("chron %d out of range (total_art=%d)", chron, core.TotalArticles)
	}
	n := packIdxFor(chron, len(packs))
	pack := packs[n]
	idxSub := int(pack.chanIDs[chron-n*idxPackSize])
	pid, offset := pack.getPackRef(chron)
	key := dataKeyFor(core, pid)

	local := chron - n*idxPackSize
	blocks := pack.fetchedAts[local]
	recoveredTs := (core.FirstFetchedAt/fetchedAtBlock + int64(blocks)) * fetchedAtBlock

	fmt.Printf("\nchron %d:\n", chron)
	fmt.Printf("  idx pack %d  entry chan_id=%d  fetchedAt_blocks=%d\n", n, idxSub, blocks)
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
	if a.ChannelID != idxSub {
		fmt.Printf("  *** SUB_ID MISMATCH: idx=%d data=%d ***\n", idxSub, a.ChannelID)
	}
	storedBlock := a.FetchedAt / fetchedAtBlock
	expectedBlock := core.FirstFetchedAt/fetchedAtBlock + int64(blocks)
	tsMismatch := storedBlock != expectedBlock
	fmt.Printf("  data chan_id: %d\n", a.ChannelID)
	fmt.Printf("  fetched_at: data=%d  idx-recovered=%d  (block-aligned match=%v)\n",
		a.FetchedAt, recoveredTs, !tsMismatch)
	if tsMismatch {
		fmt.Printf("  *** TIMESTAMP MISMATCH: idx block=%d data block=%d ***\n", expectedBlock, storedBlock)
	}
	fmt.Printf("  title: %s\n", truncStr(a.Title, 100))
	fmt.Printf("  link: %s\n", a.Link)
	if ch := core.Channels[idxSub]; ch != nil {
		fmt.Printf("  channel: %s (tag=%q)\n", ch.Title, ch.Tag)
	} else {
		fmt.Printf("  *** channel %d not in channels ***\n", idxSub)
	}
	if a.ChannelID != idxSub {
		return fmt.Errorf("chan_id mismatch")
	}
	if tsMismatch {
		return fmt.Errorf("timestamp mismatch")
	}
	return nil
}

// filterReport mirrors frontend filter logic: a filter token is a
// numeric chan_id or a tag name. Reports total count, chron range, and
// count above the optional floor — same numbers the frontend computes
// for filteredTotal / filteredLeft.
func filterReport(core *DBCore, packs []*idxPack, token string, floor int) error {
	channels := map[int]int{} // chan_id -> add_idx
	if n, err := strconv.Atoi(token); err == nil {
		if ch := core.Channels[n]; ch != nil && ch.TotalArt > 0 {
			channels[n] = ch.AddIdx
		}
	} else {
		for id, ch := range core.Channels {
			if ch.Tag == token && ch.TotalArt > 0 {
				channels[id] = ch.AddIdx
			}
		}
	}
	if len(channels) == 0 {
		return fmt.Errorf("filter %q resolved to 0 channels with articles", token)
	}

	chanTotal := 0
	chanIDs := make([]int, 0, len(channels))
	for id := range channels {
		chanIDs = append(chanIDs, id)
		chanTotal += core.Channels[id].TotalArt
	}
	sort.Ints(chanIDs)

	count, aboveFloor, firstChron, lastChron := 0, 0, -1, -1
	for chron := range core.TotalArticles {
		n := packIdxFor(chron, len(packs))
		pack := packs[n]
		sid := int(pack.chanIDs[chron-n*idxPackSize])
		addIdx, ok := channels[sid]
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

	fmt.Printf("\nfilter %q -> %d channel(s): %v\n", token, len(channels), chanIDs)
	for _, id := range chanIDs {
		ch := core.Channels[id]
		fmt.Printf("  channel %d: %q tag=%q total_art=%d add_idx=%d\n",
			id, ch.Title, ch.Tag, ch.TotalArt, ch.AddIdx)
	}
	fmt.Printf("\nfilter.chanTotal (sum of channel.total_art) = %d\n", chanTotal)
	fmt.Printf("matches in idx                              = %d\n", count)
	if count != chanTotal {
		fmt.Printf("  *** mismatch: filter would show wrong counter in UI ***\n")
	}
	if count > 0 {
		fmt.Printf("first matching chron                        = %d\n", firstChron)
		fmt.Printf("last matching chron                         = %d\n", lastChron)
		fmt.Printf("matches with chron >= floor(%d)              = %d\n", floor, aboveFloor)
	}
	if count != chanTotal {
		return fmt.Errorf("filter count %d != chan_total %d", count, chanTotal)
	}
	return nil
}

// listTagsReport mirrors frontend groupChannelsByTag: one line per tag
// with channel count and total article count.
func listTagsReport(core *DBCore) error {
	type tagInfo struct {
		channels int
		articles int
	}
	tags := map[string]*tagInfo{}
	untagged := &tagInfo{}
	for _, ch := range core.Channels {
		if ch.TotalArt == 0 {
			continue
		}
		if ch.Tag == "" {
			untagged.channels++
			untagged.articles += ch.TotalArt
			continue
		}
		t := tags[ch.Tag]
		if t == nil {
			t = &tagInfo{}
			tags[ch.Tag] = t
		}
		t.channels++
		t.articles += ch.TotalArt
	}
	names := make([]string, 0, len(tags))
	for n := range tags {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Printf("\ntags (%d):\n", len(names))
	for _, n := range names {
		t := tags[n]
		fmt.Printf("  %-20s  %3d channels  %5d articles\n", n, t.channels, t.articles)
	}
	if untagged.channels > 0 {
		fmt.Printf("  %-20s  %3d channels  %5d articles\n", "(untagged)", untagged.channels, untagged.articles)
	}
	return nil
}

// fromHashReport replays nav.fromHash on a frontend URL hash like
// "0,2485!big_info": parses floor/pos/tokens, resolves filter, decides
// whether resolve(true) or last() runs, prints the resulting article.
func fromHashReport(fetch keyGetter, core *DBCore, packs []*idxPack, hash string) error {
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

	channels := map[int]int{}
	for _, token := range tokens {
		if id, err := strconv.Atoi(token); err == nil {
			if ch := core.Channels[id]; ch != nil && ch.TotalArt > 0 {
				channels[id] = ch.AddIdx
			}
		} else {
			for id, ch := range core.Channels {
				if ch.Tag == token && ch.TotalArt > 0 {
					channels[id] = ch.AddIdx
				}
			}
		}
	}
	activeFilter := len(tokens) > 0 && len(channels) > 0
	if len(tokens) > 0 && !activeFilter {
		fmt.Printf("  filter tokens %v resolved to 0 channels -> falls back to no filter\n", tokens)
	}
	if activeFilter {
		ids := make([]int, 0, len(channels))
		for id := range channels {
			ids = append(ids, id)
		}
		sort.Ints(ids)
		fmt.Printf("  filter active: %d channel(s) %v\n", len(channels), ids)
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
	posChanID := int(packs[n].chanIDs[pos-n*idxPackSize])
	matches := true
	if activeFilter {
		addIdx, ok := channels[posChanID]
		matches = ok && pos >= addIdx
	}
	fmt.Printf("  pos chan_id=%d matches filter=%v\n", posChanID, matches)

	finalPos := pos
	if !matches {
		finalPos = -1
		for c := core.TotalArticles - 1; c >= floor; c-- {
			pn := packIdxFor(c, len(packs))
			sid := int(packs[pn].chanIDs[c-pn*idxPackSize])
			if !activeFilter {
				finalPos = c
				break
			}
			addIdx, ok := channels[sid]
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
