package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"slices"

	"srr/mod"
	"srr/store"
)

// Keyword watchlists — the per-ARTICLE classification axis (finding FMT5),
// docs/MANIFEST-SPEC.md §4.8.
//
// WHY IT EXISTS. Every classification this store had was per FEED: a tag groups
// subscriptions, and that is the only lane the reader can offer. But the thing
// an operator actually watches for — a price drop, a name they track, a CVE
// keyword — cuts ACROSS feeds and lands on individual articles. A watch rule is
// a named predicate evaluated once, at ingest, against the article as stored;
// its answer is one bit.
//
// WHAT IT IS. Three pieces, each in the object that owns its kind of truth:
//
//	the RULES     — name → #filter-syntax match spec, in the backend-only
//	                config.gz (StoreConfig.Watch). Operator configuration lives
//	                there, exactly like recipes, dedup tuning and the syndication
//	                slots; publishing what someone watches for is the leak the
//	                store-visibility split was taken to close.
//	the ROSTER    — name → coverage floor, in the manifest
//	                (ManifestState.WatchFrom + WatchCovered). A lane needs a
//	                label and a reader needs to know where the lane legitimately
//	                begins, so those are reader-facing; the pattern is not.
//	the BITS      — one chron-aligned bitmap object per stride region, in the
//	                watch/ series. Write-once, manifest-named, immutable,
//	                reclaimed by §7's one GC rule like everything else.
//
// CHRON ALIGNMENT IS THE WHOLE DESIGN (invariant M8). Bit i of the object at
// position p describes chron p*watchPackSize + i. Nothing else. That is why the
// axis survives both operations that remove articles without moving them:
//
//	EXPIRATION is logical — add_idx advances, packs and idx headers are
//	immutable, chrons do not move. An expired article's bit stays set and stays
//	pointed at the same article; every reader already filters chron < add_idx,
//	so the lane hides it for the same reason the list does. Nothing to do.
//	COMPACTION (`srr compact`) rewrites data lines and meta cards under fresh
//	stems and leaves idx/ — and this series — entirely untouched, precisely
//	because it must not renumber. So the bits stay aligned by construction, and
//	watch/ needs no entry in the compaction plan at all.
//
// The one honest residual, stated rather than hidden: a rebuild of a stride
// region (the read-back failure path below) re-derives bits from the data
// packs, and a COMPACTED article's tombstone has no title or content — so a
// rebuild over an already-compacted region would clear those bits. Only expired
// chrons compact, and expired chrons are already filtered out of every lane, so
// the effect is invisible; it is written down because the next person to widen
// either feature needs to know the two interact at all.
//
// RULE CHANGES ARE APPLY-FORWARD-ONLY. See ManifestState.WatchFrom: `srr watch
// set` stamps the coverage floor at the store's current article count, in the
// same locked Commit that publishes the rule, and nothing lowers it afterwards.
// The alternative — walking the whole data series under .locked to backfill —
// is the thing FMT2b already refused for the same reason: that walk grows with
// the store and can approach the 15-minute lease TTL, which is a correctness
// bound (a stolen lease lets two writers overwrite each other's packs), not
// headroom. There is deliberately no backfill verb.

const (
	// watchSeries is the bitmaps' own pack series (store.PackSeries).
	watchSeries = "watch"
	// watchDocVersion is the bitmap object body's own format version. A body
	// this binary cannot read is treated as damage, never guessed at.
	watchDocVersion = 1
)

// watchPackSize is the watch/ stride: how many CHRONS one bitmap object covers.
// Bit i of the object at position p describes chron p*watchPackSize + i,
// forever — the bitmap is chron-aligned and chronIdx is a permanent address
// (invariant M8), so the two arithmetics are one arithmetic.
//
// Equal to idxPackSize deliberately rather than coincidentally: a reader
// walking a lane already knows an entry's idx position, and sharing the stride
// makes chron→watch-position the SAME division it already did. At this stride
// one rule costs 6,250 bytes per full region, and gzips to nearly nothing while
// the plane is sparse — which a watchlist is by definition.
//
// A var, not a const, for one reason: the region-split and seam tests have to
// CROSS a boundary, and at 50,000 that costs 100k articles per assertion. It is
// shrunk under test exactly as assetInMemoryMax and maxOutPayload are, and is
// exported to the frontend contract (WATCH_PACK_SIZE) from this value — so a
// deliberate change here still regenerates format.gen.ts and fails
// `make generate-check` until it is committed.
var watchPackSize = idxPackSize

// validateWatchName bounds a rule name. It is not a store key — the name is a
// JSON map key inside the bitmap object and the manifest, never a path — but it
// IS reader-displayed and operator-typed, so keep it legible and quoting-free.
// Spelled out rather than as a character class because the error should say
// which rule was rejected and why.
func validateWatchName(name string) error {
	switch {
	case name == "":
		return fmt.Errorf("watch rule name is required")
	case len(name) > 64:
		return fmt.Errorf("watch rule name %q is longer than 64 bytes", name)
	}
	for _, r := range name {
		if r <= ' ' || r == '"' || r == 0x7f {
			return fmt.Errorf("watch rule name %q must not contain whitespace, quotes or control characters", name)
		}
	}
	return nil
}

// watchDoc is one stride region's bitmap object: gzipped JSON, one base64 plane
// per rule that has at least one hit in the region.
//
// JSON+base64 rather than a packed binary body, for the reason asset_refs.go
// picked JSON: these objects are small (watchPackSize/8 bytes per rule at their
// very largest) and overwhelmingly zeros, so gzip reclaims essentially all of
// base64's expansion, while `zcat | jq keys` telling an operator which lanes an
// object carries is worth more than the last few percent. The layout is also
// self-describing, which is what lets a rule appear, disappear and reappear
// without any object ever needing a schema migration.
type watchDoc struct {
	Version int `json:"v"`
	// Base is the chron of bit 0 — position*watchPackSize. Redundant with the
	// object's position in the name list and cross-checked against it, in the
	// same spirit as next_pid: a bitmap that cannot prove which chrons it
	// describes is worse than no bitmap.
	Base int `json:"base"`
	// N is how many chrons this object describes: watchPackSize for a finalized
	// region, fewer for the tail.
	N int `json:"n"`
	// Bits maps a rule name to its plane: ceil(N/8) bytes, LSB-first, so chron
	// Base+i is byte i>>3 bit i&7. A rule with no hit in the region is omitted.
	Bits map[string]string `json:"bits,omitempty"`
}

// watchPlanes is the in-memory form of one region: rule name → plane bytes.
type watchPlanes map[string][]byte

// watchPlaneBytes is a plane's length for a region of n chrons.
func watchPlaneBytes(n int) int { return (n + 7) / 8 }

// set marks chron offset i (relative to the region base) for one rule,
// allocating the plane lazily so a rule that never fires costs nothing.
func (p watchPlanes) set(rule string, i, n int) {
	plane := p[rule]
	if plane == nil {
		plane = make([]byte, watchPlaneBytes(n))
		p[rule] = plane
	}
	plane[i>>3] |= 1 << (i & 7)
}

// encode renders the region, dropping all-zero planes so an object carries only
// the lanes that actually have a hit in it.
func (p watchPlanes) encode(base, n int) watchDoc {
	doc := watchDoc{Version: watchDocVersion, Base: base, N: n}
	for rule, plane := range p {
		if !slices.ContainsFunc(plane, func(b byte) bool { return b != 0 }) {
			continue
		}
		if doc.Bits == nil {
			doc.Bits = map[string]string{}
		}
		doc.Bits[rule] = base64.StdEncoding.EncodeToString(plane)
	}
	return doc
}

// parseWatchDoc decodes a bitmap object and checks it describes the region the
// caller expected. STRICT, like parseAssetRefs: the caller's answer to "this
// object is damaged" (rebuild the region from the data packs) is correct and
// cheap, while quietly adopting a half-understood body would carry wrong bits
// forward into every object written after it — and those are immutable.
func parseWatchDoc(data []byte, wantBase, wantN int) (watchPlanes, error) {
	var doc watchDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	if doc.Version != watchDocVersion {
		return nil, fmt.Errorf("watch bitmap: unsupported version %d", doc.Version)
	}
	if doc.Base != wantBase {
		return nil, fmt.Errorf("watch bitmap: describes chrons from %d, expected %d", doc.Base, wantBase)
	}
	// The tail region GROWS between cycles, so a read-back legitimately covers
	// fewer chrons than the caller is about to write — but never more, which
	// would mean the object describes chrons the store does not have.
	if doc.N < 0 || doc.N > wantN {
		return nil, fmt.Errorf("watch bitmap: covers %d chron(s), the region holds %d", doc.N, wantN)
	}
	planes := watchPlanes{}
	for rule, b64 := range doc.Bits {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("watch bitmap: rule %q: %w", rule, err)
		}
		if len(raw) != watchPlaneBytes(doc.N) {
			return nil, fmt.Errorf("watch bitmap: rule %q has %d plane byte(s), want %d for %d chron(s)",
				rule, len(raw), watchPlaneBytes(doc.N), doc.N)
		}
		// Grow to the region the caller is writing. The extra bytes are zero,
		// which is exactly "no hits yet in the chrons that just arrived".
		if grown := watchPlaneBytes(wantN); len(raw) < grown {
			raw = append(raw, make([]byte, grown-len(raw))...)
		}
		planes[rule] = raw
	}
	return planes, nil
}

// watchRules compiles the store's rule set. A spec that will not compile is
// WARNED and skipped for this cycle rather than failing it: `srr watch set`
// already rejects a malformed spec at declaration, so reaching here means a
// hand-edited config.gz — and one bad rule must not stop the other lanes, nor a
// fetch cycle whose articles are already durable.
func watchRules(specs map[string]string) map[string]*mod.Match {
	out := make(map[string]*mod.Match, len(specs))
	for _, name := range slices.Sorted(maps.Keys(specs)) {
		m, err := mod.ParseMatch(specs[name])
		if err != nil {
			slog.Warn("watch rule will not compile; its lane is not updated this cycle",
				"rule", name, "spec", specs[name], "error", err)
			continue
		}
		out[name] = m
	}
	return out
}

// SyncWatch reconciles the watch/ series with the store: it evaluates every
// rule over the chrons published since the last successful run and republishes
// the bitmap objects those chrons fall in, under FRESH stems.
//
// WARN-ONLY at the call site, like SyncMeta and SyncIdxSummary and for the same
// reason: a derived index must never discard a durable article batch. What
// makes that safe here is WatchCovered — it advances only on success, so a
// failed run leaves an exact, self-healing gap rather than a silent hole. The
// next run re-evaluates precisely [WatchCovered, TotalArticles), from `written`
// when the batch covers it and from walkArticles when it does not.
//
// `written` is the slice PutArticles returned (the batch, in chron order),
// which the caller already has in hand for SyncMeta. It is the fast path and
// nothing more: correctness comes from the walk fallback.
func (o *DB) SyncWatch(ctx context.Context, written []ArticleData) error {
	c := &o.core

	if len(c.Watch) == 0 {
		o.resetWatch()
		return nil
	}

	rules := watchRules(c.Watch)
	from, unstamped := o.reconcileWatchRoster(rules)

	// The evaluation range. Per rule the gap is [max(from[r], covered), total);
	// the run's start is the earliest of those, and each chron then sets bits
	// only for the rules whose floor it is at or above.
	total := c.TotalArticles
	start := total
	for _, f := range from {
		start = min(start, max(f, c.WatchCovered))
	}
	// A rule whose floor was never published gets stamped at exactly the chron
	// this run starts from — the earliest it can honestly claim, since those are
	// the articles it is about to read. Stamping at TotalArticles instead would
	// skip the very batch in hand for no reason.
	for _, name := range unstamped {
		from[name] = start
	}
	if start >= total {
		// Nothing new to describe — either an idle cycle or a store whose only
		// rules were declared at the current head. Coverage still advances: the
		// per-rule ranges it now claims are empty, which is true.
		c.WatchCovered = total
		return nil
	}

	pStart := start / watchPackSize
	last := (total - 1) / watchPackSize

	// Extending a PARTIAL region means carrying its published bits forward, so
	// the object is read back. A read-back that fails is not fatal and not
	// silently accepted either: the region is rebuilt from its own base, which
	// re-derives exactly the bits that were there. That costs one stride's walk,
	// once, versus permanently publishing an object missing the bits it used to
	// carry.
	var seed watchPlanes
	if base := pStart * watchPackSize; start > base {
		if key, err := c.Names.key(watchSeries, pStart); err == nil {
			n := min(total-base, watchPackSize)
			if buf, rerr := o.readGz(ctx, key); rerr != nil {
				slog.Warn("watch bitmap read-back failed; rebuilding the region from the data packs", "key", key, "error", rerr)
				start = base
			} else if seed, rerr = parseWatchDoc(buf, base, n); rerr != nil {
				slog.Warn("watch bitmap unreadable; rebuilding the region from the data packs", "key", key, "error", rerr)
				seed, start = nil, base
			}
		} else {
			// The series names no object at this position, so there are no bits
			// to carry: the run simply starts mid-region and every chron below
			// `start` reads 0 — correctly, since each rule's own floor gates it.
			slog.Debug("watch series names no object at the region being extended; starting it mid-region",
				"position", pStart, "start", start)
		}
	}

	// One plane set per region in the run. Normally exactly one — a batch
	// crossing a watchPackSize boundary is the only way to get more.
	regions := make([]watchPlanes, last-pStart+1)
	for i := range regions {
		regions[i] = watchPlanes{}
	}
	// The seed carries forward only the planes of rules that still EXIST. A
	// removed (or uncompilable) rule's plane stops being republished the moment
	// it leaves the roster, so its lane disappears from the tail rather than
	// riding along as dead weight — and a rule later re-declared under the same
	// name starts on a clean plane instead of inheriting a predecessor's bits.
	for name, plane := range seed {
		if _, live := rules[name]; live {
			regions[0][name] = plane
		}
	}

	eval := func(chron int, ad *ArticleData) {
		ri := chron/watchPackSize - pStart
		base := (ri + pStart) * watchPackSize
		n := min(total-base, watchPackSize)
		for name, m := range rules {
			if chron < from[name] || !m.Match(ad.Title, ad.Content, ad.Lang) {
				continue
			}
			regions[ri].set(name, chron-base, n)
		}
	}

	// Fast path: the batch this cycle wrote covers the gap exactly. It always
	// does in steady state — for a delta cycle and a consolidation cycle alike,
	// since PutArticles accounts every article exactly once regardless of which
	// path materialized it, so written[i] is at chron total-len(written)+i.
	if fastBase := total - len(written); len(written) > 0 && fastBase <= start {
		for i := start - fastBase; i < len(written); i++ {
			eval(fastBase+i, &written[i])
		}
	} else {
		chron := start
		if err := o.walkArticles(ctx, start, total, func(ad *ArticleData) error {
			eval(chron, ad)
			chron++
			return nil
		}); err != nil {
			return fmt.Errorf("watch: reading chrons [%d, %d): %w", start, total, err)
		}
	}

	// Stage every name on a clone and adopt it only once every object it names
	// is durable — the SyncMeta idiom. A half-published run would otherwise
	// leave the manifest naming an object the store does not hold (M4).
	names := c.Names.clone()
	s := names.series(watchSeries)
	if len(s.Stems) == 0 {
		// First object ever (or the first after the last rule was removed and
		// the row dropped). The series BASE is that position: positions below it
		// are not part of the series, which is what lets a store declare its
		// first rule at chron 500,000 without publishing ten empty objects to
		// satisfy positional density (M5). data/ uses the same mechanism for its
		// never-written position 0.
		s.Base = pStart
	}
	for p := pStart; p <= last; p++ {
		base := p * watchPackSize
		n := min(total-base, watchPackSize)
		body, err := gzipJSON(regions[p-pStart].encode(base, n))
		if err != nil {
			return err
		}
		stem := names.alloc(watchSeries)
		key := fmt.Sprintf("%s/%d.gz", watchSeries, stem)
		if err := o.AtomicPut(ctx, key, bytes.NewReader(body), store.ObjectMeta{}); err != nil {
			return fmt.Errorf("write %s: %w", key, err)
		}
		if p == last {
			err = names.setTail(watchSeries, p, stem)
		} else {
			err = names.putAt(watchSeries, p, stem)
		}
		if err != nil {
			return err
		}
	}
	c.Names = names
	c.WatchFrom = from
	c.WatchCovered = total
	return nil
}

// resetWatch returns the store to "this store has no watch rules", which is
// also "this store never had any": no roster, no coverage, and no series row at
// all. Dropping the row is what makes the bitmap objects unreachable so §7's
// one GC rule reclaims them — the series' stem counter deliberately stays, so a
// rule declared later comes back on FRESH names beside whatever a stale reader
// still holds (M3).
//
// Called from both ends of the rule set's life: `srr watch rm` of the last rule
// (so the store is clean the moment the operator says so) and SyncWatch (so a
// store whose config lost its rules some other way converges too).
func (o *DB) resetWatch() {
	c := &o.core
	if len(c.WatchFrom) == 0 && c.WatchCovered == 0 && c.Names.Series[watchSeries] == nil {
		return
	}
	c.WatchFrom, c.WatchCovered = nil, 0
	c.Names.dropSeries(watchSeries)
}

// reconcileWatchRoster brings the published roster in line with the rule set,
// returning the floors it knows and the rule names that still need one (the
// caller stamps those once it has computed where this run starts).
//
// Three divergences are possible and each has one right answer:
//
//   - a roster entry with no rule. The rule was removed and the manifest kept
//     it, or a hand-edited config dropped it — the rules (config.gz) and the
//     roster (the manifest) are written by one Commit but as TWO objects, and
//     §6.4's ordering leaves a window. Forget it: its lane is gone, and its
//     planes stop being written into new objects immediately.
//   - a rule whose SPEC will not compile. Same as above from here — watchRules
//     already warned — so the lane is dropped rather than published with
//     nothing maintaining it. Fixing the spec restarts it, which is the honest
//     answer: bits produced by a predicate nobody can read describe nothing.
//   - a rule with no roster entry. The rule was added and the manifest publish
//     lost it. It is stamped by the caller at this run's start chron: the same
//     apply-forward answer `srr watch set` gives, from the earliest chron this
//     run can honestly claim.
//
// Never LOWERS an existing floor. Lowering would claim coverage over chrons no
// published object describes.
func (o *DB) reconcileWatchRoster(rules map[string]*mod.Match) (map[string]int, []string) {
	c := &o.core
	from := make(map[string]int, len(rules))
	var unstamped []string
	for _, name := range slices.Sorted(maps.Keys(rules)) {
		f, ok := c.WatchFrom[name]
		if !ok {
			unstamped = append(unstamped, name)
			continue
		}
		// A floor past the store's own head is nonsense only a hand-edit could
		// produce; clamp rather than let it silently disable the lane forever.
		from[name] = min(f, c.TotalArticles)
	}
	return from, unstamped
}

// loadWatchRegion reads the bitmap object covering a chron and reports which
// rules claim it. Read-side helper for `srr inspect` and the tests — the writer
// above never needs it, since it only ever extends the region it is already
// holding.
func (o *DB) loadWatchRegion(ctx context.Context, chron int) (watchPlanes, int, error) {
	c := &o.core
	p := chron / watchPackSize
	key, err := c.Names.key(watchSeries, p)
	if err != nil {
		return nil, 0, err
	}
	buf, err := o.readGz(ctx, key)
	if err != nil {
		return nil, 0, err
	}
	base := p * watchPackSize
	n := min(c.TotalArticles-base, watchPackSize)
	planes, err := parseWatchDoc(buf, base, n)
	return planes, base, err
}

// watched reports whether a rule's plane claims a chron. The coverage gate is
// the caller's: a chron outside [WatchFrom[rule], WatchCovered) has no answer
// here, and a zero bit there means "never evaluated", not "no match".
func (p watchPlanes) watched(rule string, offset int) bool {
	plane := p[rule]
	if plane == nil || offset < 0 || offset>>3 >= len(plane) {
		return false
	}
	return plane[offset>>3]&(1<<(offset&7)) != 0
}
