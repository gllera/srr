package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// InspectCmd mirrors the frontend's bounds-based pack lookup
// (frontend/src/js/idx.ts + data.ts) so a pass here means the read
// path the browser uses is consistent with the pack files on disk.
type InspectCmd struct {
	URL      string `optional:"" help:"HTTP base URL (e.g., http://localhost:3000). Overrides --store."`
	Chron    int    `default:"-1" help:"Inspect a specific chronIdx; omit for other modes."`
	Validate bool   `help:"Walk every chronIdx and report any pack inconsistency (bounds, db meta, subCounts/fetchedAts continuity, unknown sub_ids, latest-pack files)."`
	Filter   string `help:"Tag name or numeric sub_id; reports count and chron range matching the filter (mirrors frontend filter logic)."`
	Floor    int    `default:"0" help:"Optional floor chronIdx for --filter."`
	FromHash string `help:"Replay nav.fromHash on a frontend URL hash like '0,2485!big_info': resolves filter, decides resolve()/last(), prints final article."`
	ListTags bool   `help:"List tags and their sub/article counts (mirrors frontend groupSubsByTag)."`
}

type inspBound struct {
	packID     int
	startChron int
}

type inspIdx struct {
	packIndex     int
	packSize      int
	subIDs        []byte
	fetchedAts    []uint32 // per-entry cumulative fetched_at (8h blocks since first_fetched)
	bounds        []inspBound
	fetchedAtBase uint32
	packIDBase    uint32
	packOffBase   uint32
	subCounts     [256]uint32 // from header (cumulative before this pack)
	ownSubCounts  [256]uint32 // counted during parse (in this pack only)
}

type fetcher func(key string) ([]byte, error)

func (o *InspectCmd) Run() error {
	ctx := context.Background()
	fetch, cleanup, err := o.openFetcher(ctx)
	if err != nil {
		return err
	}
	if cleanup != nil {
		defer cleanup()
	}

	core, err := loadCore(fetch)
	if err != nil {
		return err
	}
	fmt.Printf("db: total_art=%d  next_pid=%d  data_tog=%v  pack_off=%d  first_fetched=%d\n",
		core.TotalArticles, core.NextPackID, core.DataToggle, core.PackOffset, core.FirstFetchedAt)

	if core.TotalArticles == 0 {
		fmt.Println("no articles")
		return nil
	}

	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		return err
	}
	for _, p := range packs {
		fmt.Printf("idx pack %d: %d entries, %d bounds (first=%+v last=%+v)\n",
			p.packIndex, p.packSize, len(p.bounds), p.bounds[0], p.bounds[len(p.bounds)-1])
	}

	if o.Validate {
		return validateAll(fetch, core, packs)
	}
	if o.ListTags {
		return listTagsReport(core)
	}
	if o.FromHash != "" {
		return fromHashReport(fetch, core, packs, o.FromHash)
	}
	if o.Filter != "" {
		return filterReport(core, packs, o.Filter, o.Floor)
	}
	if o.Chron < 0 {
		fmt.Println("(use --chron, --validate, --filter, --from-hash, or --list-tags)")
		return nil
	}
	return inspectOne(fetch, core, packs, o.Chron)
}

func (o *InspectCmd) openFetcher(ctx context.Context) (fetcher, func(), error) {
	if o.URL != "" {
		return httpFetcher(o.URL), nil, nil
	}
	db, err := NewDB(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	return func(key string) ([]byte, error) {
		return db.readGz(ctx, key)
	}, func() { db.Close(ctx) }, nil
}

func httpFetcher(base string) fetcher {
	return func(key string) ([]byte, error) {
		u, err := url.JoinPath(base, key)
		if err != nil {
			return nil, err
		}
		res, err := http.Get(u)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET %s: %d", u, res.StatusCode)
		}
		gz, err := gzip.NewReader(res.Body)
		if err != nil {
			return nil, fmt.Errorf("gunzip %s: %w", key, err)
		}
		defer gz.Close()
		return io.ReadAll(gz)
	}
}

func loadCore(fetch fetcher) (*DBCore, error) {
	data, err := fetch(dbFileKey)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", dbFileKey, err)
	}
	var c DBCore
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
	}
	return &c, nil
}

func loadIdxPacks(fetch fetcher, core *DBCore) ([]*inspIdx, error) {
	numFinalized := (core.TotalArticles - 1) / idxPackSize
	out := make([]*inspIdx, numFinalized+1)
	for p := 0; p <= numFinalized; p++ {
		var key string
		if p < numFinalized {
			key = fmt.Sprintf("idx/%d.gz", p)
		} else {
			key = fmt.Sprintf("idx/%v.gz", core.DataToggle)
		}
		size := idxPackSize
		if p == numFinalized {
			size = core.TotalArticles - p*idxPackSize
		}
		buf, err := fetch(key)
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", key, err)
		}
		pack, err := parseInspIdx(buf, p, size)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		out[p] = pack
	}
	return out, nil
}

// parseInspIdx is the byte-for-byte mirror of
// frontend/src/js/idx.ts makeIdxPack().parse().
func parseInspIdx(buf []byte, packIndex, packSize int) (*inspIdx, error) {
	if len(buf) < idxHeaderSize {
		return nil, fmt.Errorf("short header: %d < %d", len(buf), idxHeaderSize)
	}
	expected := idxHeaderSize + packSize*2
	if len(buf) < expected {
		return nil, fmt.Errorf("short body: have %d, want %d (header+%d entries)", len(buf), expected, packSize)
	}

	pack := &inspIdx{
		packIndex:     packIndex,
		packSize:      packSize,
		subIDs:        make([]byte, packSize),
		fetchedAts:    make([]uint32, packSize),
		fetchedAtBase: binary.LittleEndian.Uint32(buf[0:]),
		packIDBase:    binary.LittleEndian.Uint32(buf[4:]),
		packOffBase:   binary.LittleEndian.Uint32(buf[8:]),
	}
	for s := range 256 {
		pack.subCounts[s] = binary.LittleEndian.Uint32(buf[12+s*4:])
	}

	packID := int(pack.packIDBase)
	packOff := int(pack.packOffBase)
	fetchedAt := pack.fetchedAtBase
	baseChron := packIndex * idxPackSize
	if packOff > 0 {
		pack.bounds = append(pack.bounds, inspBound{packID, baseChron - packOff})
	}
	for i := range packSize {
		off := idxHeaderSize + i*2
		packed := buf[off+1]
		if packed>>7 != 0 {
			packID++
		}
		fetchedAt += uint32(packed & 0x7F)
		sub := buf[off]
		pack.subIDs[i] = sub
		pack.fetchedAts[i] = fetchedAt
		pack.ownSubCounts[sub]++
		if len(pack.bounds) == 0 || pack.bounds[len(pack.bounds)-1].packID != packID {
			pack.bounds = append(pack.bounds, inspBound{packID, baseChron + i})
		}
	}
	return pack, nil
}

// getPackRef mirrors frontend/src/js/data.ts getPackRef().
func (p *inspIdx) getPackRef(chron int) (packID, offset int) {
	idx := sort.Search(len(p.bounds), func(i int) bool {
		return p.bounds[i].startChron > chron
	}) - 1
	b := p.bounds[idx]
	return b.packID, chron - b.startChron
}

func packIdxFor(chron, n int) int {
	p := chron / idxPackSize
	if p >= n {
		return n - 1
	}
	return p
}

func dataKeyFor(core *DBCore, packID int) string {
	if packID < core.NextPackID {
		return fmt.Sprintf("data/%d.gz", packID)
	}
	return fmt.Sprintf("data/%v.gz", core.DataToggle)
}

func loadDataPack(fetch fetcher, key string) ([]ArticleData, error) {
	data, err := fetch(key)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", key, err)
	}
	var entries []ArticleData
	dec := json.NewDecoder(bytes.NewReader(data))
	for dec.More() {
		var a ArticleData
		if err := dec.Decode(&a); err != nil {
			return nil, fmt.Errorf("decode %s: %w", key, err)
		}
		entries = append(entries, a)
	}
	return entries, nil
}

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

	// total_art
	totalEntries := 0
	for _, p := range packs {
		totalEntries += p.packSize
	}
	if totalEntries != core.TotalArticles {
		fmt.Printf("[db-meta] total_art=%d but idx packs hold %d entries\n", core.TotalArticles, totalEntries)
		issues++
	}

	// next_pid: should equal the latest pack's last bound's packID
	last := packs[len(packs)-1]
	maxPackID := last.bounds[len(last.bounds)-1].packID
	if maxPackID != core.NextPackID {
		fmt.Printf("[db-meta] next_pid=%d but latest idx bound's packId=%d\n", core.NextPackID, maxPackID)
		issues++
	}

	// pack_off: should equal entry count of the latest data pack
	latestKey := fmt.Sprintf("data/%v.gz", core.DataToggle)
	latest, err := loadDataPack(fetch, latestKey)
	if err != nil {
		fmt.Printf("[db-meta] fetch %s: %v\n", latestKey, err)
		issues++
	} else if len(latest) != core.PackOffset {
		fmt.Printf("[db-meta] pack_off=%d but %s has %d entries\n", core.PackOffset, latestKey, len(latest))
		issues++
	}

	// per-sub: total_art and add_idx
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
	// Pack 0 should record all-zero subCounts (cumulative before first pack is 0).
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

// checkUnknownSubIDs flags any idx entry whose sub byte isn't
// registered in db.subscriptions. Each unknown sub_id is reported
// once with its first chronIdx and total occurrences.
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

func truncStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
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

// listTagsReport mirrors frontend groupSubsByTag: one line per tag
// with sub count and total article count. Useful when triaging "filter X
// is wrong" without knowing what tags exist.
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
