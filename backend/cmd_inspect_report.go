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
	idxSub := int(pack.feedIDs[chron-n*idxPackSize])
	pid, offset := pack.getPackRef(chron)
	key := dataKeyFor(core, pid)

	fmt.Printf("\nchron %d:\n", chron)
	fmt.Printf("  idx pack %d  entry feed_id=%d\n", n, idxSub)
	fmt.Printf("  resolved -> %s  packId=%d  offset=%d\n", key, pid, offset)

	entries, err := loadDataPack(fetch, key)
	if err != nil {
		return err
	}
	fmt.Printf("  data pack entries: %d\n", len(entries))

	if offset >= len(entries) {
		fmt.Printf("  *** OUT OF RANGE: frontend will throw 'Cannot read properties of undefined (reading 'f')' ***\n")
		return fmt.Errorf("offset %d >= entries %d", offset, len(entries))
	}
	a := entries[offset]
	if a.FeedID != idxSub {
		fmt.Printf("  *** SUB_ID MISMATCH: idx=%d data=%d ***\n", idxSub, a.FeedID)
	}
	fmt.Printf("  data feed_id: %d\n", a.FeedID)
	fmt.Printf("  fetched_at: %d\n", a.FetchedAt)
	fmt.Printf("  title: %s\n", truncStr(a.Title, 100))
	fmt.Printf("  link: %s\n", a.Link)
	if ch := core.Feeds[idxSub]; ch != nil {
		fmt.Printf("  feed: %s (tag=%q)\n", ch.Title, ch.Tag)
	} else {
		fmt.Printf("  *** feed %d not in feeds ***\n", idxSub)
	}
	if a.FeedID != idxSub {
		return fmt.Errorf("feed_id mismatch")
	}
	return nil
}

// filterReport mirrors frontend filter logic: a filter token is a
// numeric feed_id or a tag name. Reports total count, chron range, and
// count above the optional floor — same numbers the frontend computes
// for filteredTotal / filteredLeft.
func filterReport(core *DBCore, packs []*idxPack, token string, floor int) error {
	feeds := map[int]int{} // feed_id -> add_idx
	if n, err := strconv.Atoi(token); err == nil {
		if ch := core.Feeds[n]; ch != nil && ch.TotalArt > 0 {
			feeds[n] = ch.AddIdx
		}
	} else {
		for id, ch := range core.Feeds {
			if ch.Tag == token && ch.TotalArt > 0 {
				feeds[id] = ch.AddIdx
			}
		}
	}
	if len(feeds) == 0 {
		return fmt.Errorf("filter %q resolved to 0 feeds with articles", token)
	}

	feedTotal := 0
	feedIDs := make([]int, 0, len(feeds))
	for id := range feeds {
		feedIDs = append(feedIDs, id)
		feedTotal += core.Feeds[id].TotalArt - core.Feeds[id].Expired
	}
	sort.Ints(feedIDs)

	count, aboveFloor, firstChron, lastChron := 0, 0, -1, -1
	for chron := range core.TotalArticles {
		n := packIdxFor(chron, len(packs))
		pack := packs[n]
		sid := int(pack.feedIDs[chron-n*idxPackSize])
		addIdx, ok := feeds[sid]
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

	fmt.Printf("\nfilter %q -> %d feed(s): %v\n", token, len(feeds), feedIDs)
	for _, id := range feedIDs {
		ch := core.Feeds[id]
		fmt.Printf("  feed %d: %q tag=%q total_art=%d add_idx=%d expired=%d\n",
			id, ch.Title, ch.Tag, ch.TotalArt, ch.AddIdx, ch.Expired)
	}
	fmt.Printf("\nfilter.feedTotal (sum of feed.total_art - expired) = %d\n", feedTotal)
	fmt.Printf("matches in idx                              = %d\n", count)
	if count != feedTotal {
		fmt.Printf("  *** mismatch: filter would show wrong counter in UI ***\n")
	}
	if count > 0 {
		fmt.Printf("first matching chron                        = %d\n", firstChron)
		fmt.Printf("last matching chron                         = %d\n", lastChron)
		fmt.Printf("matches with chron >= floor(%d)              = %d\n", floor, aboveFloor)
	}
	if count != feedTotal {
		return fmt.Errorf("filter count %d != feed_total %d", count, feedTotal)
	}
	return nil
}

// listTagsReport mirrors frontend groupFeedsByTag: one line per tag
// with feed count and total article count.
func listTagsReport(core *DBCore) error {
	type tagInfo struct {
		feeds    int
		articles int
	}
	tags := map[string]*tagInfo{}
	untagged := &tagInfo{}
	for _, ch := range core.Feeds {
		if ch.TotalArt == 0 {
			continue
		}
		if ch.Tag == "" {
			untagged.feeds++
			untagged.articles += ch.TotalArt - ch.Expired
			continue
		}
		t := tags[ch.Tag]
		if t == nil {
			t = &tagInfo{}
			tags[ch.Tag] = t
		}
		t.feeds++
		t.articles += ch.TotalArt - ch.Expired
	}
	names := make([]string, 0, len(tags))
	for n := range tags {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Printf("\ntags (%d):\n", len(names))
	for _, n := range names {
		t := tags[n]
		fmt.Printf("  %-20s  %3d feeds  %5d articles\n", n, t.feeds, t.articles)
	}
	if untagged.feeds > 0 {
		fmt.Printf("  %-20s  %3d feeds  %5d articles\n", "(untagged)", untagged.feeds, untagged.articles)
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

	feeds := map[int]int{}
	for _, token := range tokens {
		if id, err := strconv.Atoi(token); err == nil {
			if ch := core.Feeds[id]; ch != nil && ch.TotalArt > 0 {
				feeds[id] = ch.AddIdx
			}
		} else {
			for id, ch := range core.Feeds {
				if ch.Tag == token && ch.TotalArt > 0 {
					feeds[id] = ch.AddIdx
				}
			}
		}
	}
	activeFilter := len(tokens) > 0 && len(feeds) > 0
	if len(tokens) > 0 && !activeFilter {
		fmt.Printf("  filter tokens %v resolved to 0 feeds -> falls back to no filter\n", tokens)
	}
	if activeFilter {
		ids := make([]int, 0, len(feeds))
		for id := range feeds {
			ids = append(ids, id)
		}
		sort.Ints(ids)
		fmt.Printf("  filter active: %d feed(s) %v\n", len(feeds), ids)
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
	posFeedID := int(packs[n].feedIDs[pos-n*idxPackSize])
	matches := true
	if activeFilter {
		addIdx, ok := feeds[posFeedID]
		matches = ok && pos >= addIdx
	}
	fmt.Printf("  pos feed_id=%d matches filter=%v\n", posFeedID, matches)

	finalPos := pos
	if !matches {
		finalPos = -1
		for c := core.TotalArticles - 1; c >= floor; c-- {
			pn := packIdxFor(c, len(packs))
			sid := int(packs[pn].feedIDs[c-pn*idxPackSize])
			if !activeFilter {
				finalPos = c
				break
			}
			addIdx, ok := feeds[sid]
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
