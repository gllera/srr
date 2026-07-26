package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"

	"srr/store"
)

// checkManifest validates the store's commit model: the root, the manifest it
// names, the object-name table inside it, and the config sidecar beside it.
//
// The reader now boots THROUGH the manifest, so this is not a dual-write safety
// net any more — it is the structural check on the object every reader reads
// first. Four layers, deliberately not one deep-equal:
//
//  1. STATE — the manifest against the core loaded from it. Since Manifest
//     embeds the very same ManifestState/ManifestWriterState structs DBCore
//     embeds, this compares whole values: a field added to either group is
//     covered without anyone extending this function.
//  2. NAMES — the name table's own invariants: positional density from the
//     base (M5), name uniqueness / counter monotonicity (M3), and agreement
//     between the listed lengths and the chron arithmetic that indexes them.
//  3. EXISTENCE — every name resolves to a real object (M4). The finalized
//     packs are not re-probed: checkBoundsVsData / checkIdxSummary / checkMeta
//     already fetch and parse every one of them.
//  4. DENSITY — manifests exist for every generation in (gcm, m] (M2). A hole
//     is a HARD issue: a reader whose root is up to K generations stale
//     resolves its own snapshot through exactly those objects, so a missing one
//     is a reader that cannot boot.
func (o *InspectCmd) checkManifest(fetch keyGetter, core *DBCore) int {
	if core.legacyRoot != nil {
		fmt.Fprintf(o.w(), "[manifest] store is still on the pre-cutover root (v%d): the next locked session migrates it to v%d\n",
			core.legacyRoot.Version, dbFormatVersion)
		return o.checkConfigSidecar(fetch, core, false)
	}
	if core.ManifestNum == 0 {
		fmt.Fprintln(o.w(), "[manifest] empty store: no manifest published yet")
		return o.checkConfigSidecar(fetch, core, false)
	}

	key := manifestKey(core.ManifestNum)
	buf, err := fetch(key)
	if err != nil {
		fmt.Fprintf(o.w(), "[manifest] %s missing or corrupt: %v\n", key, err)
		return 1
	}
	var man Manifest
	if err := json.Unmarshal(buf, &man); err != nil {
		fmt.Fprintf(o.w(), "[manifest] %s: %v\n", key, err)
		return 1
	}

	issues := 0
	bad := func(format string, args ...any) {
		fmt.Fprintf(o.w(), "[manifest] "+format+"\n", args...)
		issues++
	}

	if man.Version != dbFormatVersion {
		bad("%s: v=%d, want %d", key, man.Version, dbFormatVersion)
	}
	if man.Num != core.ManifestNum {
		bad("%s: m=%d but the root names %d", key, man.Num, core.ManifestNum)
	}

	// (1) State. Whole-group comparison — see the doc comment.
	if !reflect.DeepEqual(man.ManifestState, core.ManifestState) {
		bad("manifest state diverges from the loaded core: %s", diffJSON(man.ManifestState, core.ManifestState))
	}
	if !reflect.DeepEqual(man.ManifestWriterState, core.ManifestWriterState) {
		bad("manifest writer state diverges from the loaded core: %s", diffJSON(man.ManifestWriterState, core.ManifestWriterState))
	}
	wantFeeds := map[int]FeedPublic{}
	for id, ch := range core.Feeds {
		wantFeeds[id] = feedPublicOf(ch)
	}
	for _, id := range slices.Sorted(maps.Keys(wantFeeds)) {
		got, ok := man.Feeds[id]
		if !ok {
			bad("feed %d (%q) is in the store but not in the manifest", id, wantFeeds[id].Title)
			continue
		}
		if !reflect.DeepEqual(got, wantFeeds[id]) {
			bad("feed %d (%q) diverges: %s", id, wantFeeds[id].Title, diffJSON(got, wantFeeds[id]))
		}
	}
	for _, id := range slices.Sorted(maps.Keys(man.Feeds)) {
		if _, ok := wantFeeds[id]; !ok {
			bad("feed %d is in the manifest but not in the store", id)
		}
	}

	// (2) Names.
	names := man.Names
	if names == nil {
		bad("%s carries no names object", key)
		return issues + o.checkConfigSidecar(fetch, core, true)
	}
	seen := map[string]bool{}
	for _, series := range slices.Sorted(maps.Keys(names.Series)) {
		s := names.Series[series]
		if s.Tail >= 0 && (s.Tail < s.Base || s.Tail >= s.Base+len(s.Stems)) {
			bad("%s tail position %d is outside the listed range [%d, %d)", series, s.Tail, s.Base, s.Base+len(s.Stems))
		}
		next := names.Next[series]
		for _, stem := range s.Stems {
			k := fmt.Sprintf("%s/%d.gz", series, stem)
			if seen[k] {
				bad("M3 violated: %s is listed twice", k)
			}
			seen[k] = true
			if stem >= next {
				bad("M3 violated: %s is at or above the series' next stem %d", k, next)
			}
		}
	}
	// Singletons (seen/hsum/ssum and each live delta) draw from the SAME
	// per-series counters, so M3 governs them too: a summary or delta stem must
	// be unique within its series and below that series' next. alloc keeps this
	// true at runtime; this catches a hand-edited or corrupt manifest that reused
	// a finalized-pack stem for a summary, or placed one at/above the counter.
	checkStem := func(series string, stem int) {
		k := fmt.Sprintf("%s/%d.gz", series, stem)
		if seen[k] {
			bad("M3 violated: %s is listed twice", k)
		}
		seen[k] = true
		if next, ok := names.Next[series]; ok && stem >= next {
			bad("M3 violated: %s is at or above the series' next stem %d", k, next)
		}
	}
	if names.Seen != nil {
		checkStem(names.Seen.Series, names.Seen.Stem)
	}
	if names.ARef != nil {
		checkStem(names.ARef.Series, names.ARef.Stem)
	}
	if names.HSum != nil {
		checkStem(names.HSum.Series, names.HSum.Stem)
	}
	if names.SSum != nil {
		checkStem(names.SSum.Series, names.SSum.Stem)
	}
	for _, stem := range names.Deltas.Stems {
		checkStem(names.Deltas.Series, stem)
	}
	tc := tailCovered(core)
	// M5/M6: the listed lengths must be exactly what chron arithmetic indexes.
	wantIdx := numFinalizedIdx(core.TotalArticles)
	if tc > 0 {
		wantIdx++
	}
	if got := len(names.series(idxSeries).Stems); got != wantIdx {
		bad("M5 violated: the idx series lists %d object(s) but total_art=%d (tc=%d) needs %d", got, core.TotalArticles, tc, wantIdx)
	}
	if got := names.series(dataSeries).Base + len(names.series(dataSeries).Stems); tc > 0 && got != core.NextPackID+1 {
		bad("M5 violated: the data series lists positions up to %d but next_pid=%d", got-1, core.NextPackID)
	}
	if tc > 0 && names.series(idxSeries).Tail != numFinalizedIdx(core.TotalArticles) {
		bad("M5 violated: the idx tail sits at position %d, not the finalized count %d",
			names.series(idxSeries).Tail, numFinalizedIdx(core.TotalArticles))
	}
	if tc > 0 && names.series(dataSeries).Tail != core.NextPackID {
		bad("M5 violated: the data tail sits at position %d but next_pid=%d", names.series(dataSeries).Tail, core.NextPackID)
	}
	if core.metaPacks()*metaPackSize+core.MetaTail > tc {
		bad("meta coverage %d overclaims the consolidated region (tc=%d)", core.metaPacks()*metaPackSize+core.MetaTail, tc)
	}
	if (len(names.Deltas.Stems) == 0) != (core.DeltaArticles == 0) {
		bad("M6 violated: %d delta segment(s) named for %d delta article(s)", len(names.Deltas.Stems), core.DeltaArticles)
	}
	if names.HSum != nil && names.HSum.Covers > numFinalizedIdx(core.TotalArticles) {
		bad("the idx header summary claims to cover %d finalized pack(s), more than the %d that exist",
			names.HSum.Covers, numFinalizedIdx(core.TotalArticles))
	}
	if names.SSum != nil && names.SSum.Covers != core.metaPacks() {
		bad("the meta bloom summary covers %d shard(s) but %d are listed", names.SSum.Covers, core.metaPacks())
	}

	// (3) Existence of every singleton and every tail. Rm is silent on missing
	// keys, so a name the manifest lists and the store does not hold is exactly
	// the failure M4 exists to catch.
	probe := names.Deltas.keys()
	for _, series := range slices.Sorted(maps.Keys(names.Series)) {
		if k := names.tailKey(series); k != "" {
			probe = append(probe, k)
		}
	}
	if names.Seen != nil {
		probe = append(probe, names.Seen.key())
	}
	if names.ARef != nil {
		probe = append(probe, names.ARef.key())
	}
	if names.HSum != nil {
		probe = append(probe, names.HSum.key())
	}
	if names.SSum != nil {
		probe = append(probe, names.SSum.key())
	}
	slices.Sort(probe)
	for _, k := range probe {
		if _, err := fetch(k); err != nil {
			bad("M4 violated: %s names %q, which is missing or corrupt: %v", key, k, err)
		}
	}

	// (3b) The asset refcount sidecar's body. Cheap (one small object, already
	// fetched by the probe above) and worth checking: those counts are the only
	// thing standing between a shared assets/ object and its first expiring
	// referrer, and a body this binary cannot read silently downgrades retention
	// to "keep everything I cannot prove dead". A coverage start past the
	// store's own article count would mean no article is ever covered.
	if names.ARef != nil {
		if buf, err := fetch(names.ARef.key()); err == nil {
			switch p, perr := parseAssetRefs(buf); {
			case perr != nil:
				bad("asset refcount sidecar %s is unreadable, so expiration will stop reclaiming asset bytes: %v", names.ARef.key(), perr)
			case p.covered > core.TotalArticles:
				bad("asset refcount sidecar counts from chron %d, past the store's %d article(s)", p.covered, core.TotalArticles)
			}
		}
	}

	// (4) M2: manifests exist for every m in (gcm, root.m], bounded to the
	// grace window. HARD, not a warning: a reader whose root is up to K
	// generations stale resolves its whole snapshot through the manifest that
	// root names, so a hole inside the window is a reader that cannot boot —
	// and, because the GC's reachable set is read from the oldest in-window
	// manifest, a hole also blinds the sweep.
	from := max(core.GCManifest+1, core.ManifestNum-keepManifests+1, 1)
	holes := 0
	for g := from; g < core.ManifestNum; g++ {
		if _, err := fetch(manifestKey(g)); err != nil {
			holes++
		}
	}
	if holes > 0 {
		bad("M2 violated: %d of the %d manifest(s) in the grace window (%d, %d] are missing — a reader whose root points inside the hole cannot resolve its snapshot",
			holes, core.ManifestNum-from, from-1, core.ManifestNum)
	}

	issues += o.checkConfigSidecar(fetch, core, true)
	if issues == 0 {
		fmt.Fprintf(o.w(), "[manifest] %s consistent: %d feed(s), %d object name(s) probed, %d generation(s) in the grace window\n",
			key, len(man.Feeds), len(probe), core.ManifestNum-from+1)
	}
	return issues
}

// checkConfigSidecar validates config.gz. It is the ONLY source of the
// operator's configuration now, so there is nothing to cross-check it against —
// what is checkable is that it parses, that this binary can represent it, and
// that every per-feed entry names a feed the store actually has. A stale entry
// is INERT by §4.3 (it is what makes the two-object mutations of §6.4 safe
// without a distributed commit), so it is reported and not counted as an issue.
//
// `expected` is whether the store should have published one at all: a store on
// the v2 root always has, and its absence is then a real gap; a store still on
// the pre-cutover root legitimately has none (absence means "all defaults",
// which is exactly how the store behaves without it).
func (o *InspectCmd) checkConfigSidecar(fetch keyGetter, core *DBCore, expected bool) int {
	got, err := loadConfigSidecar(fetch)
	if err != nil || got == nil {
		if !expected {
			fmt.Fprintln(o.w(), "[manifest] no config.gz (legal: absence means all-default configuration)")
			return 0
		}
		fmt.Fprintf(o.w(), "[manifest] %s missing or corrupt: %v\n", configFileKey, err)
		return 1
	}
	if got.Version > dbFormatVersion {
		fmt.Fprintf(o.w(), "[manifest] %s: v=%d, newer than this binary understands (v%d)\n",
			configFileKey, got.Version, dbFormatVersion)
		return 1
	}
	stale := 0
	for _, id := range slices.Sorted(maps.Keys(got.Feeds)) {
		if core.Feeds[id] == nil {
			stale++
		}
	}
	fmt.Fprintf(o.w(), "[manifest] %s parses: %d recipe(s), %d out slot(s), %d feed override(s)",
		configFileKey, len(got.Recipes), len(got.Out), len(got.Feeds))
	if stale > 0 {
		fmt.Fprintf(o.w(), " (%d for feeds the store no longer has — inert, swept by the next config write)", stale)
	}
	fmt.Fprintln(o.w())
	return 0
}

// orphanSamples caps how many orphan keys the report names. The COUNT is the
// actionable number; a handful of examples is what tells the operator which
// series leaked, and a store with thousands must not print thousands of lines.
const orphanSamples = 10

// checkOrphans reports pack-grammar objects the store HOLDS that no manifest in
// the grace window names — the class the GC's low-water drain structurally
// cannot see, since it only ever looks at names a manifest gave it. A cycle
// killed between writing a pack and publishing the manifest that would have
// named it leaves exactly this.
//
// INFORMATIONAL: it always returns 0 issues. An orphan wastes bytes and nothing
// else — no reader can address it, no invariant mentions it — and on a listable
// backend the GC now reclaims it on its own once the window slides past its
// stem. Failing `--validate` on one would turn a cron health check red over
// garbage that is already scheduled for collection.
//
// Unlike the GC's sweep this reads EVERY in-window manifest rather than the
// oldest: the GC has a cutoff and a stem floor to lean on, while a report meant
// to name leaks must not accuse an object that some mid-window generation still
// names. `srr inspect` is an operator command, and the whole window is the
// price of that precision.
func (o *InspectCmd) checkOrphans(fetch keyGetter, core *DBCore) int {
	switch {
	case o.lister == nil:
		fmt.Fprintln(o.w(), "[orphans] the inspected store cannot enumerate its objects (--url, or a plain HTTP store): skipped")
		return 0
	case core.legacyRoot != nil:
		fmt.Fprintln(o.w(), "[orphans] pre-cutover store: no manifest chain to compare a listing against")
		return 0
	case core.ManifestNum == 0:
		fmt.Fprintln(o.w(), "[orphans] empty store: nothing published to compare a listing against")
		return 0
	}

	live := map[string]bool{}
	for _, k := range core.Names.keys() {
		live[k] = true
	}
	from := max(core.GCManifest+1, core.ManifestNum-keepManifests+1, 1)
	for g := from; g < core.ManifestNum; g++ {
		buf, err := fetch(manifestKey(g))
		if err != nil {
			continue // a hole is M2's to report (checkManifest); don't double-report
		}
		keys, _, err := manifestNamesOf(buf)
		if err != nil {
			continue
		}
		for _, k := range keys {
			live[k] = true
		}
	}

	var orphans []string
	for _, s := range store.PackSeries {
		keys, err := o.lister(s.Name + "/")
		if err != nil {
			fmt.Fprintf(o.w(), "[orphans] listing %s/ failed: %v\n", s.Name, err)
			return 0
		}
		for _, k := range keys {
			series, stem, ok := store.ParsePackKey(k)
			if !ok || series != s.Name {
				// Not a name the write-once grammar can produce, so not something
				// any generation could have named — a staging leftover, a retired
				// kind-lettered name, an operator's own file. Never an orphan by
				// this report's definition, and never anything's to delete.
				continue
			}
			if series == manifestSeries {
				// A manifest is named by nothing, so reachability says nothing about
				// one. Only a generation ABOVE the root's is unreachable-and-
				// unreclaimable: that is a publish that crashed before the root flip
				// (§6.2 overwrites it on the retry). Generations below the window are
				// ordinary pending-GC work, not leaks.
				if stem > core.ManifestNum {
					orphans = append(orphans, k)
				}
				continue
			}
			if !live[k] {
				orphans = append(orphans, k)
			}
		}
	}

	if len(orphans) == 0 {
		fmt.Fprintf(o.w(), "[orphans] every pack-grammar object in the store is named by a generation in (%d, %d]\n", from-1, core.ManifestNum)
		return 0
	}
	slices.Sort(orphans)
	fmt.Fprintf(o.w(), "[orphans] %d object(s) no generation in (%d, %d] names — unreferenced bytes, not a consistency problem; a listing GC reclaims them as the window slides: %s\n",
		len(orphans), from-1, core.ManifestNum, strings.Join(orphans[:min(len(orphans), orphanSamples)], " "))
	return 0
}

// chronState is the chron-addressing state of one generation: the scalars and
// per-feed counters device-local state (read frontiers, ★-Saved chrons, shared
// #pos links) is anchored to. A renumbering (a physical drop that shifted
// addresses down, the one thing M8 forbids and the gate on S35's compaction)
// shows up as one of these DECREASING between generations.
type chronState struct {
	totalArt int
	nextPID  int
	feeds    map[int]FeedPublic
}

// checkChronPermanence enforces invariant M8 (docs/MANIFEST-SPEC.md §6.5, §9.6)
// across the last K manifests: no generation may renumber a chron. It is the
// loud check S35's physical compaction is gated on — compaction empties expired
// payloads in place (tombstones) and never moves an article, so every scalar
// below stays flat or grows across a compaction; a hypothetical renumbering
// would drop one and fail here.
//
// Comparisons that survive id reuse: total_art and next_pid are store-wide and
// only ever grow; per-feed total_art/add_idx/xp only ever grow FOR A GIVEN
// SOURCE, so a feed whose url changed between two generations (an id freed and
// reused for a different source, whose counters legitimately reset) is skipped.
func (o *InspectCmd) checkChronPermanence(fetch keyGetter, core *DBCore) int {
	if core.legacyRoot != nil {
		fmt.Fprintln(o.w(), "[chron-permanence] pre-cutover store: no manifest chain to check")
		return 0
	}
	if core.ManifestNum == 0 {
		fmt.Fprintln(o.w(), "[chron-permanence] empty store: nothing to check")
		return 0
	}

	from := max(core.GCManifest+1, core.ManifestNum-keepManifests+1, 1)
	states := make([]chronState, 0, core.ManifestNum-from+1)
	gens := make([]int, 0, core.ManifestNum-from+1)
	for g := from; g < core.ManifestNum; g++ {
		buf, err := fetch(manifestKey(g))
		if err != nil {
			// A hole is already M2's to report (checkManifest); a missing
			// generation can't be compared, so skip it here rather than
			// double-report.
			continue
		}
		var man Manifest
		if err := json.Unmarshal(buf, &man); err != nil {
			continue
		}
		states = append(states, chronState{totalArt: man.TotalArticles, nextPID: man.NextPackID, feeds: man.Feeds})
		gens = append(gens, g)
	}
	// The current generation (root.m) is the loaded core itself, not a re-read.
	cur := chronState{totalArt: core.TotalArticles, nextPID: core.NextPackID, feeds: map[int]FeedPublic{}}
	for id, ch := range core.Feeds {
		cur.feeds[id] = feedPublicOf(ch)
	}
	states = append(states, cur)
	gens = append(gens, core.ManifestNum)

	issues := 0
	bad := func(format string, args ...any) {
		fmt.Fprintf(o.w(), "[chron-permanence] "+format+"\n", args...)
		issues++
	}
	for i := 1; i < len(states); i++ {
		older, newer, og, ng := states[i-1], states[i], gens[i-1], gens[i]
		if newer.totalArt < older.totalArt {
			bad("M8 violated: total_art fell %d→%d between manifest %d and %d — a chron was renumbered", older.totalArt, newer.totalArt, og, ng)
		}
		if newer.nextPID < older.nextPID {
			bad("M8 violated: next_pid fell %d→%d between manifest %d and %d — a data position was renumbered", older.nextPID, newer.nextPID, og, ng)
		}
		for id, of := range older.feeds {
			nf, ok := newer.feeds[id]
			if !ok || nf.URL != of.URL {
				continue // feed removed, or id reused for a different source
			}
			if nf.TotalArt < of.TotalArt {
				bad("M8 violated: feed %d (%q) total_art fell %d→%d (manifest %d→%d)", id, of.Title, of.TotalArt, nf.TotalArt, og, ng)
			}
			if nf.AddIdx < of.AddIdx {
				bad("M8 violated: feed %d (%q) add_idx fell %d→%d (manifest %d→%d) — the read frontier it anchors would misaddress", id, of.Title, of.AddIdx, nf.AddIdx, og, ng)
			}
			if nf.Expired < of.Expired {
				bad("M8 violated: feed %d (%q) xp fell %d→%d (manifest %d→%d)", id, of.Title, of.Expired, nf.Expired, og, ng)
			}
		}
	}
	if issues == 0 {
		fmt.Fprintf(o.w(), "[chron-permanence] chron addresses stable across %d generation(s) in (%d, %d]\n", len(states), from-1, core.ManifestNum)
	}
	return issues
}

// diffJSON renders two values as compact JSON for a divergence message. The
// point is to name the actual differing bytes rather than dump Go structs.
func diffJSON(got, want any) string {
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	return fmt.Sprintf("\n    published: %s\n    resolved:  %s", g, w)
}
