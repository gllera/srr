package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// errValidation marks a store-consistency failure (as opposed to a config or
// IO error), so `srr inspect --validate` can exit with its own code and a cron
// health check can tell "the store is broken" from "I could not look".
var errValidation = errors.New("store validation failed")

// inspectIssue is one check's result in --json mode: the check name, how many
// problems it found, and its verbatim human detail lines. A cron health check
// can branch on ok/issues without scraping English.
type inspectIssue struct {
	Check  string `json:"check"`
	Issues int    `json:"issues"`
	Detail string `json:"detail,omitempty"`
}

func (o *InspectCmd) validateAll(fetch keyGetter, core *DBCore, packs []*idxPack, deltas []ArticleData) error {
	checks := []struct {
		name string
		run  func() int
	}{
		{"delta-chain", func() int { return o.checkDeltaChain(fetch, core, packs, deltas) }},
		{"bounds-vs-data", func() int { return o.checkBoundsVsData(fetch, core, packs, deltas) }},
		{"db-meta", func() int { return o.checkDBMeta(fetch, core, packs) }},
		{"feed-counts-continuity", func() int { return o.checkFeedCountsContinuity(packs) }},
		{"unknown-feed-ids", func() int { return o.checkUnknownFeedIDs(core, packs) }},
		{"latest-files", func() int { return o.checkLatestFiles(fetch, core) }},
		{"idx-summary", func() int { return o.checkIdxSummary(fetch, core, packs) }},
		{"meta", func() int { return o.checkMeta(fetch, core) }},
		{"manifest", func() int { return o.checkManifest(fetch, core) }},
	}

	if o.JSON {
		// Each check keeps printing exactly as it always has — into a per-check
		// buffer that becomes its `detail`. One document, no interleaving, and
		// the human wording stays the single source of the diagnosis.
		sink := o.w()
		results := make([]inspectIssue, 0, len(checks))
		total := 0
		for _, c := range checks {
			var buf bytes.Buffer
			saved := o.out
			o.out = &buf
			n := c.run()
			o.out = saved
			total += n
			results = append(results, inspectIssue{Check: c.name, Issues: n, Detail: strings.TrimSpace(buf.String())})
		}
		enc := json.NewEncoder(sink)
		enc.SetIndent("", "  ")
		if err := enc.Encode(map[string]any{"ok": total == 0, "issues": results}); err != nil {
			return err
		}
		if total > 0 {
			return fmt.Errorf("%d issue(s) found: %w", total, errValidation)
		}
		return nil
	}

	fmt.Fprintln(o.w())
	issues := 0
	for _, c := range checks {
		issues += c.run()
	}

	fmt.Fprintln(o.w())
	if issues == 0 {
		fmt.Fprintln(o.w(), "OK: all checks passed")
		return nil
	}
	return fmt.Errorf("%d issue(s) found: %w", issues, errValidation)
}

// checkDeltaChain validates the delta-region invariants against db.gz. The
// hard structural half of I1 (chain contiguity, per-segment parse, Σ lines ==
// na) already gated loadIdxPacks — reaching here means it held; what remains
// are the db.gz-level consistency claims: the I2 stratum invariant (no 5k
// meta stratum — and hence no 50k idx boundary — strictly inside the delta
// region, which is what lets every reader run its numFinalized* formulas on
// total_art verbatim) and fetched_at monotonicity across the pack↔delta seam
// (expiration's early-stop and the chron-order contract both assume it).
func (o *InspectCmd) checkDeltaChain(fetch keyGetter, core *DBCore, packs []*idxPack, deltas []ArticleData) int {
	if core.NumDeltas == 0 {
		fmt.Fprintln(o.w(), "[delta-chain] no live deltas (nd=0)")
		return 0
	}
	issues := 0
	tc := tailCovered(core)
	if numFinalizedMeta(core.TotalArticles) != numFinalizedMeta(tc) {
		fmt.Fprintf(o.w(), "[delta-chain] I2 violated: a meta stratum lies inside the delta region (tc=%d total_art=%d)\n",
			tc, core.TotalArticles)
		issues++
	}
	for i := 1; i < len(deltas); i++ {
		if deltas[i].FetchedAt < deltas[i-1].FetchedAt {
			fmt.Fprintf(o.w(), "[delta-chain] fetched_at not monotone inside the chain at delta offset %d\n", i)
			issues++
			break
		}
	}
	// The other monotonicity half: the seam itself. The last consolidated
	// article (chron tc-1) must not be newer than the first delta — the packs
	// hold every older article, so a seam inversion breaks the global
	// fetched_at order ExpireArticles' early-stop and the chron-order contract
	// assume. (tc==0 is the all-delta store: no packed article to compare.)
	if tc > 0 && len(deltas) > 0 {
		n := (tc - 1) / idxPackSize
		pid, off := packs[n].getPackRef(tc - 1)
		last, err := loadDataPack(fetch, dataKeyFor(core, pid))
		if err != nil {
			fmt.Fprintf(o.w(), "[delta-chain] seam check: fetch last consolidated article (chron %d): %v\n", tc-1, err)
			issues++
		} else if off < len(last) && last[off].FetchedAt > deltas[0].FetchedAt {
			fmt.Fprintf(o.w(), "[delta-chain] fetched_at not monotone across the pack↔delta seam (chron %d=%d > chron %d=%d)\n",
				tc-1, last[off].FetchedAt, tc, deltas[0].FetchedAt)
			issues++
		}
	}
	if issues == 0 {
		fmt.Fprintf(o.w(), "[delta-chain] %d segment(s), %d article(s), seam at chron %d consistent\n",
			core.NumDeltas, core.DeltaArticles, tc)
	}
	return issues
}

// checkBoundsVsData walks every chronIdx and verifies the resolved
// (packId, offset) lands inside an existing data-pack entry whose
// feed_id matches the idx pack's feed_id.
func (o *InspectCmd) checkBoundsVsData(fetch keyGetter, core *DBCore, packs []*idxPack, deltas []ArticleData) int {
	// Chron order keeps (packId, offset) monotonic, so one resident pack
	// suffices (the walkArticles pattern) — caching every decoded pack would
	// hold the whole store's article content at peak. Delta-region chrons
	// (pid == deltaPackID) resolve against the parsed chain instead.
	var entries []ArticleData
	loadedPid, loaded := -1, 0
	load := func(pid int) []ArticleData {
		if pid == deltaPackID {
			return deltas
		}
		if pid == loadedPid {
			return entries
		}
		e, err := loadDataPack(fetch, dataKeyFor(core, pid))
		if err != nil {
			fmt.Fprintf(o.w(), "[bounds-vs-data] fetch %s: %v\n", dataKeyFor(core, pid), err)
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
			fmt.Fprintf(o.w(), "[bounds-vs-data] chron %d: packId=%d offset=%d >= entries=%d (frontend crashes on this chronIdx)\n",
				chron, pid, offset, len(entries))
			oob++
			continue
		}
		if entries[offset].FeedID != idxSub {
			fmt.Fprintf(o.w(), "[bounds-vs-data] chron %d: feed_id mismatch idx=%d data=%d (packId=%d offset=%d)\n",
				chron, idxSub, entries[offset].FeedID, pid, offset)
			mismatch++
		}
	}
	fmt.Fprintf(o.w(), "[bounds-vs-data] scanned %d chronIdx, %d data packs visited: %d out-of-range, %d feed_id mismatches\n",
		core.TotalArticles, loaded, oob, mismatch)
	return oob + mismatch
}

// feedIDStats walks every idx entry once, returning per-feed_id entry
// counts: all-time, and live (entries at chron >= the feed's AddIdx; an
// unregistered id has no AddIdx, so its live tally counts everything and
// is simply unused). Shared by checkDBMeta (registered feeds) and
// checkUnknownFeedIDs (unregistered ones).
func feedIDStats(packs []*idxPack, feeds map[int]*Feed) (count, live map[int]int) {
	count, live = map[int]int{}, map[int]int{}
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, s := range p.feedIDs {
			sid := int(s)
			count[sid]++
			if ch := feeds[sid]; ch == nil || base+i >= ch.AddIdx {
				live[sid]++
			}
		}
	}
	return count, live
}

// checkDBMeta cross-checks db.gz fields against actual pack contents.
func (o *InspectCmd) checkDBMeta(fetch keyGetter, core *DBCore, packs []*idxPack) int {
	issues := 0

	totalEntries := 0
	for _, p := range packs {
		totalEntries += p.packSize
	}
	if totalEntries != core.TotalArticles {
		fmt.Fprintf(o.w(), "[db-meta] total_art=%d but idx packs hold %d entries\n", core.TotalArticles, totalEntries)
		issues++
	}

	// next_pid describes the consolidated data series only, so skip the
	// delta-region sentinel bound when reading the newest real packId; a store
	// whose whole content is deltas (tailCovered == 0) has no real bound and
	// no latest data pack — its consolidated state must still be pristine.
	last := packs[len(packs)-1]
	maxPackID := deltaPackID
	for i := len(last.bounds) - 1; i >= 0; i-- {
		if last.bounds[i].packID != deltaPackID {
			maxPackID = last.bounds[i].packID
			break
		}
	}
	if tailCovered(core) == 0 {
		if core.NextPackID != 0 || core.PackOffset != 0 {
			fmt.Fprintf(o.w(), "[db-meta] all-delta store but next_pid=%d pack_off=%d (want 0/0)\n",
				core.NextPackID, core.PackOffset)
			issues++
		}
	} else {
		if maxPackID != core.NextPackID {
			fmt.Fprintf(o.w(), "[db-meta] next_pid=%d but latest idx bound's packId=%d\n", core.NextPackID, maxPackID)
			issues++
		}

		latestData := latestKey(core, "data")
		latest, err := loadDataPack(fetch, latestData)
		if err != nil {
			fmt.Fprintf(o.w(), "[db-meta] fetch %s: %v\n", latestData, err)
			issues++
		} else if len(latest) != core.PackOffset {
			fmt.Fprintf(o.w(), "[db-meta] pack_off=%d but %s has %d entries\n", core.PackOffset, latestData, len(latest))
			issues++
		}
	}

	idxCount, idxLive := feedIDStats(packs, core.Feeds)
	feedIDs := slices.Sorted(maps.Keys(core.Feeds))
	for _, id := range feedIDs {
		sub := core.Feeds[id]
		actual := idxCount[id]
		if actual != sub.TotalArt {
			fmt.Fprintf(o.w(), "[db-meta] sub %d (%q): total_art=%d but idx has %d entries\n",
				id, sub.Title, sub.TotalArt, actual)
			issues++
		}
		// Entries before add_idx are expected (expiration, feed-id reuse; the
		// all-time total_art check above still assumes no id reuse — a known,
		// pre-existing limitation); add_idx and the expired counter just have
		// to stay in range.
		if sub.AddIdx < 0 || sub.AddIdx > core.TotalArticles {
			fmt.Fprintf(o.w(), "[db-meta] sub %d (%q): add_idx=%d out of range [0, %d]\n",
				id, sub.Title, sub.AddIdx, core.TotalArticles)
			issues++
		}
		if sub.Expired < 0 || sub.Expired > sub.TotalArt {
			fmt.Fprintf(o.w(), "[db-meta] sub %d (%q): expired=%d out of range [0, total_art=%d]\n",
				id, sub.Title, sub.Expired, sub.TotalArt)
			issues++
		}
		// Cross-check the (AddIdx, Expired) pair against the packs: the idx
		// entries at chron >= add_idx are exactly the live articles the reader
		// counts (total_art - expired). An in-range but inconsistent pair
		// silently skews every live count. Reuse-proof: a reused id's legacy
		// entries sit below add_idx.
		if idxLive[id] != sub.TotalArt-sub.Expired {
			fmt.Fprintf(o.w(), "[db-meta] sub %d (%q): live entries=%d but total_art-expired=%d\n",
				id, sub.Title, idxLive[id], sub.TotalArt-sub.Expired)
			issues++
		}
	}
	fmt.Fprintf(o.w(), "[db-meta] checked total_art, next_pid, pack_off, and %d subscriptions\n", len(feedIDs))
	return issues
}

// checkFeedCountsContinuity verifies header feedCounts[s] in pack i+1
// equals feedCounts[s] + ownFeedCounts[s] from pack i. Only meaningful
// once total_art crosses idxPackSize.
func (o *InspectCmd) checkFeedCountsContinuity(packs []*idxPack) int {
	if len(packs) < 2 {
		fmt.Fprintln(o.w(), "[feed-counts] only 1 idx pack; continuity check skipped")
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
				fmt.Fprintf(o.w(), "[feed-counts] pack %d sub %d: header=%d but pack %d ended with cumulative %d\n",
					next.packIndex, s, next.feedCount(s), cur.packIndex, expected)
				issues++
			}
		}
	}
	for s := range packs[0].numSlots {
		if packs[0].feedCounts[s] != 0 {
			fmt.Fprintf(o.w(), "[feed-counts] pack 0 sub %d: header=%d but expected 0 (no articles before first pack)\n",
				s, packs[0].feedCounts[s])
			issues++
		}
	}
	if issues == 0 {
		fmt.Fprintf(o.w(), "[feed-counts] %d pack boundary transitions consistent\n", len(packs)-1)
	}
	return issues
}

// checkUnknownFeedIDs flags any idx entry whose feed byte isn't
// registered in db.feeds.
func (o *InspectCmd) checkUnknownFeedIDs(core *DBCore, packs []*idxPack) int {
	count, _ := feedIDStats(packs, core.Feeds)
	unknown := 0
	for sid, c := range count {
		if _, ok := core.Feeds[sid]; ok {
			continue
		}
		fmt.Fprintf(o.w(), "[unknown-feeds] feed_id %d: %d entries — frontend renders \"[DELETED]\"\n",
			sid, c)
		unknown++
	}
	if unknown == 0 {
		fmt.Fprintln(o.w(), "[unknown-feeds] all idx feed_ids are registered")
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
func (o *InspectCmd) checkIdxSummary(fetch keyGetter, core *DBCore, packs []*idxPack) int {
	numFinalized := numFinalizedIdx(core.TotalArticles)
	if core.HdrPacks > numFinalized {
		fmt.Fprintf(o.w(), "[idx-summary] hdrs=%d but only %d finalized idx packs exist\n", core.HdrPacks, numFinalized)
		return 1
	}
	if core.HdrPacks < numFinalized {
		fmt.Fprintf(o.w(), "[idx-summary] warning: hdrs=%d lags %d finalized packs (readers fall back to eager idx loading; next fetch rebuilds)\n",
			core.HdrPacks, numFinalized)
	}
	if core.HdrPacks == 0 {
		fmt.Fprintln(o.w(), "[idx-summary] no summary expected (hdrs=0)")
		return 0
	}
	key := summaryKey(core.HdrPacks)
	buf, err := fetch(key)
	if err != nil {
		fmt.Fprintf(o.w(), "[idx-summary] %s missing or corrupt: %v\n", key, err)
		return 1
	}
	issues := 0
	off := 0
	for k := range core.HdrPacks {
		if off+idxHeaderPrefix > len(buf) {
			fmt.Fprintf(o.w(), "[idx-summary] %s: truncated at chunk %d/%d (offset %d of %d)\n",
				key, k, core.HdrPacks, off, len(buf))
			return issues + 1
		}
		numSlots := int(binary.LittleEndian.Uint32(buf[off+idxStateSize:]))
		end := off + idxHeaderPrefix + numSlots*4
		if end > len(buf) {
			fmt.Fprintf(o.w(), "[idx-summary] %s: chunk %d claims %d slots running past the buffer (%d > %d)\n",
				key, k, numSlots, end, len(buf))
			return issues + 1
		}
		// Header-only decode (packSize 0 ⇒ no entries parsed), so the
		// ownFeedCounts slot width is irrelevant here.
		hdr, err := parseIdxPack(buf[off:end], k, 0, 0)
		if err != nil {
			fmt.Fprintf(o.w(), "[idx-summary] pack %d chunk: %v\n", k, err)
			issues++
			off = end
			continue
		}
		off = end
		p := packs[k]
		if hdr.packIDBase != p.packIDBase || hdr.packOffBase != p.packOffBase {
			fmt.Fprintf(o.w(), "[idx-summary] pack %d: summary bases (%d,%d) != header (%d,%d)\n", k,
				hdr.packIDBase, hdr.packOffBase, p.packIDBase, p.packOffBase)
			issues++
			continue
		}
		slots := max(hdr.numSlots, p.numSlots)
		mismatched := false
		for s := range slots {
			if hdr.feedCount(s) != p.feedCount(s) {
				fmt.Fprintf(o.w(), "[idx-summary] pack %d sub %d: summary feedCount=%d but header has %d\n",
					k, s, hdr.feedCount(s), p.feedCount(s))
				mismatched = true
			}
		}
		if mismatched {
			issues++
		}
	}
	if off != len(buf) {
		fmt.Fprintf(o.w(), "[idx-summary] %s: %d byte(s) consumed but buffer is %d (extra trailing data)\n",
			key, off, len(buf))
		issues++
	}
	if issues == 0 {
		fmt.Fprintf(o.w(), "[idx-summary] %s matches %d finalized pack header(s)\n", key, core.HdrPacks)
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
func (o *InspectCmd) checkMeta(fetch keyGetter, core *DBCore) int {
	nf := numFinalizedMeta(core.TotalArticles)
	if core.MetaPacks > nf {
		fmt.Fprintf(o.w(), "[meta] mp=%d but only %d finalized meta shards exist\n", core.MetaPacks, nf)
		return 1
	}
	// The meta series covers the consolidated region only — overclaiming past
	// tailCovered (not just TotalArticles) is corruption: delta-region cards
	// are the resident chain's, never a shard's.
	if core.MetaTail < 0 || core.MetaTail > metaPackSize ||
		core.MetaPacks*metaPackSize+core.MetaTail > tailCovered(core) {
		fmt.Fprintf(o.w(), "[meta] inconsistent coverage: mp=%d mt=%d tc=%d total_art=%d\n",
			core.MetaPacks, core.MetaTail, tailCovered(core), core.TotalArticles)
		return 1
	}
	if core.MetaPacks == 0 && core.MetaTail == 0 {
		fmt.Fprintln(o.w(), "[meta] no meta coverage published (mp=0, mt=0)")
		return 0
	}
	if core.MetaPacks < nf {
		fmt.Fprintf(o.w(), "[meta] warning: mp=%d lags %d finalized shards (readers keep search disabled; next fetch rebuilds)\n",
			core.MetaPacks, nf)
	}
	issues := 0

	latestMeta := latestKey(core, "meta")
	if buf, err := fetch(latestMeta); err != nil {
		fmt.Fprintf(o.w(), "[meta] %s missing or corrupt: %v\n", latestMeta, err)
		issues++
	} else if entries, err := parseMetaEntries(buf); err != nil {
		fmt.Fprintf(o.w(), "[meta] %s: %v\n", latestMeta, err)
		issues++
	} else if len(entries) != core.MetaTail {
		fmt.Fprintf(o.w(), "[meta] mt=%d but %s has %d entries\n", core.MetaTail, latestMeta, len(entries))
		issues++
	}

	if core.MetaPacks == 0 {
		if issues == 0 {
			fmt.Fprintf(o.w(), "[meta] %s holds the %d-entry tail (no finalized shards)\n", latestMeta, core.MetaTail)
		}
		return issues
	}

	sumKey := metaSummaryKey(core.MetaPacks)
	sum, err := fetch(sumKey)
	if err != nil {
		fmt.Fprintf(o.w(), "[meta] %s missing or corrupt: %v\n", sumKey, err)
		sum = nil
		issues++
	} else if len(sum) != core.MetaPacks*searchBloomBytes {
		fmt.Fprintf(o.w(), "[meta] %s has %d bytes but mp=%d expects %d\n",
			sumKey, len(sum), core.MetaPacks, core.MetaPacks*searchBloomBytes)
		sum = nil
		issues++
	}

	for k := range core.MetaPacks {
		key := finalizedMetaKey(k)
		buf, err := fetch(key)
		if err != nil {
			fmt.Fprintf(o.w(), "[meta] %s missing or corrupt: %v\n", key, err)
			issues++
			continue
		}
		if len(buf) < searchBloomBytes {
			fmt.Fprintf(o.w(), "[meta] %s has %d bytes, shorter than the bloom header\n", key, len(buf))
			issues++
			continue
		}
		bloom := buf[:searchBloomBytes]
		if sum != nil && !bytes.Equal(sum[k*searchBloomBytes:(k+1)*searchBloomBytes], bloom) {
			fmt.Fprintf(o.w(), "[meta] shard %d: summary bloom != shard bloom header\n", k)
			issues++
		}
		entries, err := parseMetaEntries(buf[searchBloomBytes:])
		if err != nil {
			fmt.Fprintf(o.w(), "[meta] %s: %v\n", key, err)
			issues++
			continue
		}
		if len(entries) != metaPackSize {
			fmt.Fprintf(o.w(), "[meta] %s has %d entries, want %d\n", key, len(entries), metaPackSize)
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
			fmt.Fprintf(o.w(), "[meta] shard %d: %d gram(s) absent from its bloom (reader pruning would miss results)\n", k, missing)
			issues++
		}
	}

	if issues == 0 {
		fmt.Fprintf(o.w(), "[meta] %d shard(s), %s, and the %d-entry tail consistent\n",
			core.MetaPacks, sumKey, core.MetaTail)
	}
	return issues
}

// checkLatestFiles confirms the tail idx and data pack files (the current
// L<tailGen> generation) actually exist and decompress. A store whose whole
// content is deltas never wrote a tail generation — nothing to check (the
// delta segments themselves already gated loadIdxPacks).
func (o *InspectCmd) checkLatestFiles(fetch keyGetter, core *DBCore) int {
	if tailCovered(core) == 0 {
		fmt.Fprintln(o.w(), "[latest-files] all-delta store: no tail generation expected")
		return 0
	}
	issues := 0
	for _, prefix := range []string{"idx", "data"} {
		key := latestKey(core, prefix)
		if _, err := fetch(key); err != nil {
			fmt.Fprintf(o.w(), "[latest-files] %s missing or corrupt: %v\n", key, err)
			issues++
		}
	}
	if issues == 0 {
		fmt.Fprintf(o.w(), "[latest-files] %s and %s present\n", latestKey(core, "idx"), latestKey(core, "data"))
	}
	return issues
}
