package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"reflect"
	"slices"
)

// checkManifest is the safety net that makes the S32 dual-write trustworthy:
// it cross-checks the published manifest/<m>.gz and config.gz against the
// legacy db.gz they were derived from, and fails loudly on any divergence.
//
// Nothing reads either object yet, so a silent drift between them and db.gz
// would surface for the first time at S34 — on a store whose root has already
// flipped, i.e. exactly when it is unfixable. This check is what turns that
// class of bug into a `srr inspect --validate` failure today.
//
// Three independent layers, deliberately not one deep-equal:
//
//  1. STATE — every manifest field against the db.gz field it mirrors. Since
//     Manifest embeds the very same ManifestState/ManifestWriterState structs
//     DBCore embeds, this compares whole values: a field added to either group
//     is covered without anyone extending this function.
//  2. NAMES — every name against the LEGACY DERIVATION that computes it today
//     (finalizedIdxKey/dataKeyFor/latestKey/deltaKey/summaryKey/…). This is the
//     load-bearing half: it states, checkably, that "the manifest names exactly
//     what a legacy reader would compute", which is the entire premise of S33's
//     reader swap. It is written against those functions, not against
//     buildManifest, so a bug in the builder cannot hide behind itself.
//  3. EXISTENCE + DENSITY — every singleton name resolves to a real object
//     (invariant M4), and manifests exist across the grace window (M2). The
//     finalized packs are not re-probed: checkBoundsVsData / checkIdxSummary /
//     checkMeta already fetch and parse every one of them, and the name lists'
//     LENGTHS are checked in layer 2.
func (o *InspectCmd) checkManifest(fetch keyGetter, core *DBCore) int {
	if core.ManifestNum == 0 {
		fmt.Fprintln(o.w(), "[manifest] no manifest published (m=0: a store no manifest-writing srr has committed)")
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

	if man.Version != manifestVersion {
		bad("%s: v=%d, want %d", key, man.Version, manifestVersion)
	}
	if man.Num != core.ManifestNum {
		bad("%s: m=%d but db.gz names %d", key, man.Num, core.ManifestNum)
	}

	// (1) State. Whole-group comparison — see the doc comment.
	if !reflect.DeepEqual(man.ManifestState, core.ManifestState) {
		bad("manifest state diverges from db.gz: %s", diffJSON(man.ManifestState, core.ManifestState))
	}
	if !reflect.DeepEqual(man.ManifestWriterState, core.ManifestWriterState) {
		bad("manifest writer state diverges from db.gz: %s", diffJSON(man.ManifestWriterState, core.ManifestWriterState))
	}
	wantFeeds := map[int]FeedPublic{}
	for id, ch := range core.Feeds {
		wantFeeds[id] = feedPublicOf(ch)
	}
	for _, id := range slices.Sorted(maps.Keys(wantFeeds)) {
		got, ok := man.Feeds[id]
		if !ok {
			bad("feed %d (%q) is in db.gz but not in the manifest", id, wantFeeds[id].Title)
			continue
		}
		if !reflect.DeepEqual(got, wantFeeds[id]) {
			bad("feed %d (%q) diverges: %s", id, wantFeeds[id].Title, diffJSON(got, wantFeeds[id]))
		}
	}
	for _, id := range slices.Sorted(maps.Keys(man.Feeds)) {
		if _, ok := wantFeeds[id]; !ok {
			bad("feed %d is in the manifest but not in db.gz", id)
		}
	}

	// (2) Names vs the legacy derivations.
	tc := tailCovered(core)
	nf := numFinalizedIdx(core.TotalArticles)

	wantIdx := make([]string, 0, nf+1)
	for n := range nf {
		wantIdx = append(wantIdx, finalizedIdxKey(n))
	}
	wantData := make([]string, 0, core.NextPackID+1)
	for range 1 { // position 0 is never produced — the writer skips data/0
		wantData = append(wantData, "")
	}
	for n := 1; n < core.NextPackID; n++ {
		wantData = append(wantData, finalizedDataKey(n))
	}
	wantMeta := make([]string, 0, core.MetaPacks+1)
	for n := range core.MetaPacks {
		wantMeta = append(wantMeta, finalizedMetaKey(n))
	}
	if tc > 0 {
		wantIdx = append(wantIdx, latestKey(core, "idx"))
		wantData = append(wantData, latestKey(core, "data"))
		if core.MetaPacks*metaPackSize+core.MetaTail == tc {
			wantMeta = append(wantMeta, latestKey(core, "meta"))
		}
	}
	for _, s := range []struct {
		series string
		want   []string
	}{{"idx", wantIdx}, {"data", wantData}, {"meta", wantMeta}} {
		got, ok := man.Names.Series[s.series]
		if !ok {
			bad("names has no %q series", s.series)
			continue
		}
		if keys := got.Keys(s.series); !slices.Equal(keys, s.want) {
			bad("%s series names diverge from the legacy derivation:\n    manifest: %v\n    derived:  %v",
				s.series, keys, s.want)
		}
	}
	// The manifest must not invent series the store does not have.
	for _, name := range slices.Sorted(maps.Keys(man.Names.Series)) {
		if name != "idx" && name != "data" && name != "meta" {
			bad("names carries an unknown series %q", name)
		}
	}

	wantDeltas := []string{}
	for g := tailGen(core) + 1; g <= core.Seq; g++ {
		wantDeltas = append(wantDeltas, deltaKey(g))
	}
	if got := man.Names.Deltas; !slices.Equal(nonNil(got), wantDeltas) {
		bad("delta chain names diverge: manifest %v, derived %v", got, wantDeltas)
	}
	checkSummary := func(what string, got *SummaryName, covers int, key string) {
		if covers == 0 {
			if got != nil {
				bad("%s named %q but db.gz publishes no summary", what, got.Key)
			}
			return
		}
		switch {
		case got == nil:
			bad("%s absent but db.gz publishes %s (covering %d)", what, key, covers)
		case got.Key != key || got.Covers != covers:
			bad("%s is {%s, %d} but db.gz derives {%s, %d}", what, got.Key, got.Covers, key, covers)
		}
	}
	checkSummary("hsum", man.Names.HSum, core.HdrPacks, summaryKey(core.HdrPacks))
	checkSummary("ssum", man.Names.SSum, core.MetaPacks, metaSummaryKey(core.MetaPacks))

	// The seen slot may legitimately be unnamed (a store whose active slot is
	// unreadable, or that has never written one) — but a NAMED slot must be the
	// one core.SeenFlag points at, since that pointer is the whole atomicity
	// contract between the article batch and its dedup state.
	if man.Names.Seen != "" && man.Names.Seen != seenSlotKey(core.SeenFlag) {
		bad("seen slot named %q but sf=%v names %q", man.Names.Seen, core.SeenFlag, seenSlotKey(core.SeenFlag))
	}

	// (3) Existence of every singleton, and manifest density across the window.
	probe := []string{}
	probe = append(probe, man.Names.Deltas...)
	for _, s := range man.Names.Series {
		if s.Tail != "" {
			probe = append(probe, s.Tail)
		}
	}
	if man.Names.Seen != "" {
		probe = append(probe, man.Names.Seen)
	}
	if man.Names.HSum != nil {
		probe = append(probe, man.Names.HSum.Key)
	}
	if man.Names.SSum != nil {
		probe = append(probe, man.Names.SSum.Key)
	}
	slices.Sort(probe)
	for _, k := range probe {
		if _, err := fetch(k); err != nil {
			bad("M4 violated: %s names %q, which is missing or corrupt: %v", key, k, err)
		}
	}

	// M2: manifests exist for every m in (gcm, root.m]. Bounded to the grace
	// window — anything below it is GC's to have removed.
	//
	// WARN-only, deliberately, and only while S32 holds: the window exists so a
	// reader whose root is up to K generations stale can still resolve its own
	// snapshot, and under S32 no reader fetches a manifest at all. A hole is
	// therefore a future risk, not a present defect — and the one way to get
	// one today is an operator clearing manifest/* (a rollback the additive
	// dual-write is explicitly meant to survive), which would otherwise hard-fail
	// validation for K generations after a completely safe act. It must become
	// an issue at S34, when a stale root really can point into the window.
	from := max(core.GCManifest+1, core.ManifestNum-keepManifests+1, 1)
	holes := 0
	for g := from; g < core.ManifestNum; g++ {
		if _, err := fetch(manifestKey(g)); err != nil {
			holes++
		}
	}
	if holes > 0 {
		fmt.Fprintf(o.w(), "[manifest] warning: %d of the %d manifest(s) in the grace window (%d, %d] are missing "+
			"(harmless until readers follow the indirection; the GC low-water gcm=%d closes the gap as it advances)\n",
			holes, core.ManifestNum-from, from-1, core.ManifestNum, core.GCManifest)
	}

	issues += o.checkConfigSidecar(fetch, core, true)
	if issues == 0 {
		fmt.Fprintf(o.w(), "[manifest] %s matches db.gz: %d feed(s), %d name(s) probed\n",
			key, len(man.Feeds), len(probe))
	}
	return issues
}

// checkConfigSidecar compares config.gz against the configuration db.gz still
// owns. `expected` is whether the store should have published one at all: a
// store that has committed under an S32+ binary always has, and its absence is
// then a real gap; a pre-S32 store legitimately has none (§4.3 — absence means
// "all defaults", which is exactly how the store behaves without it).
func (o *InspectCmd) checkConfigSidecar(fetch keyGetter, core *DBCore, expected bool) int {
	got, err := loadConfigSidecar(fetch)
	if err != nil {
		if !expected {
			fmt.Fprintln(o.w(), "[manifest] no config.gz (legal: absence means all-default configuration)")
			return 0
		}
		fmt.Fprintf(o.w(), "[manifest] %s missing or corrupt: %v\n", configFileKey, err)
		return 1
	}
	want := configSidecar{Version: manifestVersion, StoreConfig: core.StoreConfig, Feeds: map[int]FeedConfig{}}
	for id, ch := range core.Feeds {
		if cfg := feedConfigOf(ch); !cfg.isZero() {
			want.Feeds[id] = cfg
		}
	}
	if got.Version != manifestVersion {
		fmt.Fprintf(o.w(), "[manifest] %s: v=%d, want %d\n", configFileKey, got.Version, manifestVersion)
		return 1
	}
	if !configEqual(*got, want) {
		fmt.Fprintf(o.w(), "[manifest] %s diverges from the configuration in db.gz: %s\n",
			configFileKey, diffJSON(*got, want))
		return 1
	}
	fmt.Fprintf(o.w(), "[manifest] %s matches the configuration in db.gz (%d recipe(s), %d out slot(s), %d feed override(s))\n",
		configFileKey, len(want.Recipes), len(want.Out), len(want.Feeds))
	return 0
}

// diffJSON renders two values as compact JSON for a divergence message. The
// point is to name the actual differing bytes rather than dump Go structs.
func diffJSON(got, want any) string {
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	return fmt.Sprintf("\n    published: %s\n    db.gz:     %s", g, w)
}

// nonNil normalizes a nil slice to an empty one so slices.Equal treats "absent"
// and "empty" as the same thing — which on the wire they are (omitempty).
func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
