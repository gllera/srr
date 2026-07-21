package main

import (
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

func (o *InspectCmd) inspectOne(fetch keyGetter, core *DBCore, packs []*idxPack, deltas []ArticleData, chron int) error {
	if chron >= core.TotalArticles {
		return fmt.Errorf("chron %d out of range (total_art=%d)", chron, core.TotalArticles)
	}
	n := packIdxFor(chron, len(packs))
	pack := packs[n]
	idxSub := int(pack.feedIDs[chron-n*idxPackSize])
	pid, offset := pack.getPackRef(chron)

	fmt.Fprintf(o.w(), "\nchron %d:\n", chron)
	fmt.Fprintf(o.w(), "  idx pack %d  entry feed_id=%d\n", n, idxSub)

	var entries []ArticleData
	if pid == deltaPackID {
		// Delta-region chron: content lives in the parsed chain, not a pack.
		fmt.Fprintf(o.w(), "  resolved -> delta chain  offset=%d\n", offset)
		entries = deltas
	} else {
		key := dataKeyFor(core, pid)
		fmt.Fprintf(o.w(), "  resolved -> %s  packId=%d  offset=%d\n", key, pid, offset)
		var err error
		entries, err = loadDataPack(fetch, key)
		if err != nil {
			return err
		}
	}
	fmt.Fprintf(o.w(), "  data pack entries: %d\n", len(entries))

	if offset >= len(entries) {
		fmt.Fprintf(o.w(), "  *** OUT OF RANGE: frontend will throw 'Cannot read properties of undefined (reading 'f')' ***\n")
		return fmt.Errorf("offset %d >= entries %d", offset, len(entries))
	}
	a := entries[offset]
	if a.FeedID != idxSub {
		fmt.Fprintf(o.w(), "  *** SUB_ID MISMATCH: idx=%d data=%d ***\n", idxSub, a.FeedID)
	}
	fmt.Fprintf(o.w(), "  data feed_id: %d\n", a.FeedID)
	fmt.Fprintf(o.w(), "  fetched_at: %d\n", a.FetchedAt)
	fmt.Fprintf(o.w(), "  title: %s\n", truncStr(a.Title, 100))
	fmt.Fprintf(o.w(), "  link: %s\n", a.Link)
	if ch := core.Feeds[idxSub]; ch != nil {
		fmt.Fprintf(o.w(), "  feed: %s (tag=%q)\n", ch.Title, ch.Tag)
	} else {
		fmt.Fprintf(o.w(), "  *** feed %d not in feeds ***\n", idxSub)
	}
	if a.FeedID != idxSub {
		return fmt.Errorf("feed_id mismatch")
	}
	return nil
}

// addFilterToken resolves one filter token — a numeric feed_id, else a tag
// name — into feeds (feed_id → add_idx), skipping feeds without articles.
// Mirrors the frontend's filter resolution; shared by filterReport and
// fromHashReport so the two inspect modes can't drift.
func addFilterToken(core *DBCore, token string, feeds map[int]int) {
	if id, err := strconv.Atoi(token); err == nil {
		if ch := core.Feeds[id]; ch != nil && ch.TotalArt > 0 {
			feeds[id] = ch.AddIdx
		}
		return
	}
	for id, ch := range core.Feeds {
		if ch.Tag == token && ch.TotalArt > 0 {
			feeds[id] = ch.AddIdx
		}
	}
}

// filterReport mirrors frontend filter logic: a filter token is a
// numeric feed_id or a tag name. Reports total count, chron range, and
// count above the optional floor — same numbers the frontend computes
// for filteredTotal / filteredLeft.
func (o *InspectCmd) filterReport(core *DBCore, packs []*idxPack, token string, floor int) error {
	feeds := map[int]int{} // feed_id -> add_idx
	addFilterToken(core, token, feeds)
	if len(feeds) == 0 {
		return fmt.Errorf("filter %q resolved to 0 feeds with articles", token)
	}

	feedIDs := slices.Sorted(maps.Keys(feeds))
	feedTotal := 0
	for _, id := range feedIDs {
		feedTotal += core.Feeds[id].TotalArt - core.Feeds[id].Expired
	}

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

	fmt.Fprintf(o.w(), "\nfilter %q -> %d feed(s): %v\n", token, len(feeds), feedIDs)
	for _, id := range feedIDs {
		ch := core.Feeds[id]
		fmt.Fprintf(o.w(), "  feed %d: %q tag=%q total_art=%d add_idx=%d expired=%d\n",
			id, ch.Title, ch.Tag, ch.TotalArt, ch.AddIdx, ch.Expired)
	}
	fmt.Fprintf(o.w(), "\nfilter.feedTotal (sum of feed.total_art - expired) = %d\n", feedTotal)
	fmt.Fprintf(o.w(), "matches in idx                              = %d\n", count)
	if count != feedTotal {
		fmt.Fprintf(o.w(), "  *** mismatch: filter would show wrong counter in UI ***\n")
	}
	if count > 0 {
		fmt.Fprintf(o.w(), "first matching chron                        = %d\n", firstChron)
		fmt.Fprintf(o.w(), "last matching chron                         = %d\n", lastChron)
		fmt.Fprintf(o.w(), "matches with chron >= floor(%d)              = %d\n", floor, aboveFloor)
	}
	if count != feedTotal {
		return fmt.Errorf("filter count %d != feed_total %d", count, feedTotal)
	}
	return nil
}

// listTagsReport mirrors frontend groupFeedsByTag: one line per tag
// with feed count and total article count.
func (o *InspectCmd) listTagsReport(core *DBCore) error {
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
	names := slices.Sorted(maps.Keys(tags))
	fmt.Fprintf(o.w(), "\ntags (%d):\n", len(names))
	for _, n := range names {
		t := tags[n]
		fmt.Fprintf(o.w(), "  %-20s  %3d feeds  %5d articles\n", n, t.feeds, t.articles)
	}
	if untagged.feeds > 0 {
		fmt.Fprintf(o.w(), "  %-20s  %3d feeds  %5d articles\n", "(untagged)", untagged.feeds, untagged.articles)
	}
	return nil
}

// fromHashReport replays nav.fromHash on a frontend URL hash like
// "0,2485!big_info": parses floor/pos/tokens, resolves filter, decides
// whether resolve(true) or last() runs, prints the resulting article.
func (o *InspectCmd) fromHashReport(fetch keyGetter, core *DBCore, packs []*idxPack, deltas []ArticleData, hash string) error {
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

	fmt.Fprintf(o.w(), "\nhash %q -> floor=%d pos_str=%q tokens=%v\n", hash, floor, posStr, tokens)

	feeds := map[int]int{}
	for _, token := range tokens {
		addFilterToken(core, token, feeds)
	}
	activeFilter := len(tokens) > 0 && len(feeds) > 0
	if len(tokens) > 0 && !activeFilter {
		fmt.Fprintf(o.w(), "  filter tokens %v resolved to 0 feeds -> falls back to no filter\n", tokens)
	}
	if activeFilter {
		ids := slices.Sorted(maps.Keys(feeds))
		fmt.Fprintf(o.w(), "  filter active: %d feed(s) %v\n", len(feeds), ids)
	} else {
		fmt.Fprintln(o.w(), "  filter inactive")
	}

	pos, err := strconv.Atoi(posStr)
	if err != nil || pos < 0 || pos >= core.TotalArticles {
		pos = core.TotalArticles - 1
		fmt.Fprintf(o.w(), "  pos clamped to %d\n", pos)
	} else {
		fmt.Fprintf(o.w(), "  pos=%d\n", pos)
	}

	n := packIdxFor(pos, len(packs))
	posFeedID := int(packs[n].feedIDs[pos-n*idxPackSize])
	matches := true
	if activeFilter {
		addIdx, ok := feeds[posFeedID]
		matches = ok && pos >= addIdx
	}
	fmt.Fprintf(o.w(), "  pos feed_id=%d matches filter=%v\n", posFeedID, matches)

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
			fmt.Fprintln(o.w(), "  no matching article above floor — frontend would show '(no matching articles)'")
			return nil
		}
		fmt.Fprintf(o.w(), "  pos doesn't match -> last() jumps to chron %d\n", finalPos)
	} else {
		fmt.Fprintf(o.w(), "  pos matches -> resolve(true), stays at chron %d\n", finalPos)
	}
	return o.inspectOne(fetch, core, packs, deltas, finalPos)
}
