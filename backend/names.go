package main

import (
	"encoding/json"
	"fmt"
	"slices"
)

// The object-name table — docs/MANIFEST-SPEC.md §4.5, "names are listed, never
// derived".
//
// Every immutable object a generation writes draws its stem from a per-series
// monotone counter that is never reused, so `idx/812.gz` means "idx-series
// object #812" and nothing more; the ordered list below says which stride
// region it holds. There is NO computed-name fallback anywhere in the writer or
// the reader: two ways to learn a name means two truths that can disagree, and
// every disagreement is a 404 storm on live readers.
//
// The table is carried by the manifest and by nothing else. It is the whole
// reason `seq`, `nd`, `next_pid`-as-a-name, `hdrs`, `mp` and `gen` no longer
// exist: each of them was a counter whose only job was to let a reader
// RECONSTRUCT a name.
//
// §4.6 constraint, honored: series live in a MAP keyed by directory name.
// Nothing here assumes there are exactly three of them, that idx and meta are
// distinct, or that a stride is a particular number — merging idx/ and meta/
// (ARC6) stays a manifest-shape change and nothing else.

// manifestSingletonKeys are the keys inside `names` that are NOT a pack series.
// A series may never be called one of these; assertNamesDisjoint proves it at
// startup so the flat encoding below can never be ambiguous.
var manifestSingletonKeys = []string{"deltas", "seen", "hsum", "ssum", "next"}

// SeriesNames is one pack series' positional name list. Entry i names the
// object holding that series' i-th stride region; the list is dense from Base
// (invariant M5), which is what lets floor(chron/stride) index it.
//
// In memory the stems are expanded (the writer indexes and replaces them); on
// the wire they are run-length encoded — stems are handed out in write order,
// so a pristine store's list is exactly one run and a 1M-article store's three
// lists total ~120 bytes.
type SeriesNames struct {
	// Base is the positional index of the first listed entry: 0 for idx/meta,
	// 1 for data (the writer has always skipped data/0, and v2 does not
	// renumber existing idx footers, so that quirk is preserved).
	Base int
	// Stems holds one stem per position, starting at Base.
	Stems []int
	// Tail is the positional index of the write-once TAIL entry, -1 when the
	// series has none (an all-delta store never consolidated one; a meta
	// projection whose coverage is inexact never published one). It is the one
	// entry the GC can drop under a stale reader, so it is the one that takes
	// the reader's guarded-reload path.
	Tail int
}

// seriesNamesWire is the on-the-wire shape: {b, r, l}. `l` is a pointer so
// position 0 (a single-pack store whose only entry IS the tail) survives
// omitempty.
type seriesNamesWire struct {
	Base int      `json:"b,omitempty"`
	Runs [][2]int `json:"r,omitempty"`
	Tail *int     `json:"l,omitempty"`
}

func (s SeriesNames) MarshalJSON() ([]byte, error) {
	w := seriesNamesWire{Base: s.Base, Runs: runsOf(s.Stems)}
	if s.Tail >= 0 {
		t := s.Tail
		w.Tail = &t
	}
	return json.Marshal(w)
}

func (s *SeriesNames) UnmarshalJSON(data []byte) error {
	var w seriesNamesWire
	if err := json.Unmarshal(data, &w); err != nil {
		return err
	}
	*s = SeriesNames{Base: w.Base, Tail: -1}
	for _, r := range w.Runs {
		if r[1] < 0 {
			return fmt.Errorf("negative run length %d", r[1])
		}
		for i := range r[1] {
			s.Stems = append(s.Stems, r[0]+i)
		}
	}
	if w.Tail != nil {
		s.Tail = *w.Tail
		if s.Tail < s.Base || s.Tail >= s.Base+len(s.Stems) {
			return fmt.Errorf("tail position %d outside the listed range [%d, %d)", s.Tail, s.Base, s.Base+len(s.Stems))
		}
	}
	return nil
}

// runsOf run-length encodes consecutive stems into [firstStem, count] pairs.
func runsOf(stems []int) [][2]int {
	var out [][2]int
	for i := 0; i < len(stems); {
		j := i + 1
		for j < len(stems) && stems[j] == stems[j-1]+1 {
			j++
		}
		out = append(out, [2]int{stems[i], j - i})
		i = j
	}
	return out
}

// StemRef names one singleton object: the series it lives in plus its stem.
// The series is explicit rather than hard-coded on the reader side, so a future
// merged series (ARC6) needs no reader change.
type StemRef struct {
	Series string `json:"s"`
	Stem   int    `json:"stem"`
}

func (r StemRef) key() string { return fmt.Sprintf("%s/%d.gz", r.Series, r.Stem) }

// SummaryName is a derived summary object: a StemRef plus the count of
// finalized packs it covers. Coverage rides NEXT TO the name instead of inside
// it (the retired h<N>/s<N> naming), so the reader's "summary lags → fall back
// to eager idx loading" path is a comparison of two numbers in one object
// rather than a name-vs-count handshake.
type SummaryName struct {
	Series string `json:"s"`
	Stem   int    `json:"stem"`
	Covers int    `json:"covers"`
}

func (s SummaryName) key() string { return fmt.Sprintf("%s/%d.gz", s.Series, s.Stem) }

// DeltaNames is the ordered live delta chain: stems in the data series, oldest
// first. Each segment holds one dirty cycle's whole batch as data-pack JSONL.
type DeltaNames struct {
	Series string `json:"s"`
	Stems  []int  `json:"r"`
}

func (d DeltaNames) keys() []string {
	out := make([]string, len(d.Stems))
	for i, s := range d.Stems {
		out[i] = fmt.Sprintf("%s/%d.gz", d.Series, s)
	}
	return out
}

// ManifestNames is the `names` object: every live object of the store, listed.
type ManifestNames struct {
	Series map[string]*SeriesNames
	// Deltas is the live delta chain (the data series' retired `d` kind).
	Deltas DeltaNames
	// Seen names the dedup sidecar object. Nil when the store has none (no
	// dirty cycle has ever written one), so every listed name exists (M4).
	Seen *StemRef
	// HSum / SSum are the idx header summary and the meta bloom summary; nil
	// when the store publishes none.
	HSum *SummaryName
	SSum *SummaryName
	// Next is the per-series stem counter: the next free stem. Monotone,
	// never reused, persisted here (invariant M3).
	Next map[string]int

	// overrides exists ONLY while a pre-cutover store is open and unmigrated
	// (root.go). Those stores hold objects under the retired kind-lettered
	// names, which have no bare-stem form: the table reserves the fresh stem
	// each will be re-published under and maps it back to the name currently on
	// disk, so a READ-ONLY session resolves real keys and never publishes the
	// table. migrateRoot copies the objects and drops the map; it is nil — and
	// unreachable — for every store this binary has ever committed.
	overrides map[string]string
}

func newManifestNames() *ManifestNames {
	return &ManifestNames{
		Series: map[string]*SeriesNames{},
		Deltas: DeltaNames{Series: dataSeries},
		Next:   map[string]int{},
	}
}

const (
	idxSeries  = "idx"
	dataSeries = "data"
	metaSeries = "meta"
	seenSeries = "seen"
)

func (n ManifestNames) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(n.Series)+len(manifestSingletonKeys))
	for name, s := range n.Series {
		if slices.Contains(manifestSingletonKeys, name) {
			return nil, fmt.Errorf("pack series %q collides with a reserved manifest names key", name)
		}
		out[name] = s
	}
	if len(n.Deltas.Stems) > 0 {
		out["deltas"] = n.Deltas
	}
	if n.Seen != nil {
		out["seen"] = n.Seen
	}
	if n.HSum != nil {
		out["hsum"] = n.HSum
	}
	if n.SSum != nil {
		out["ssum"] = n.SSum
	}
	if len(n.Next) > 0 {
		out["next"] = n.Next
	}
	return json.Marshal(out)
}

func (n *ManifestNames) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*n = *newManifestNames()
	for key, val := range raw {
		var err error
		switch key {
		case "deltas":
			err = json.Unmarshal(val, &n.Deltas)
		case "seen":
			err = json.Unmarshal(val, &n.Seen)
		case "hsum":
			err = json.Unmarshal(val, &n.HSum)
		case "ssum":
			err = json.Unmarshal(val, &n.SSum)
		case "next":
			err = json.Unmarshal(val, &n.Next)
		default:
			// Anything else is a series. Deliberately open: a future merged
			// idx+meta series (ARC6) parses here with no code change.
			var s SeriesNames
			if err = json.Unmarshal(val, &s); err == nil {
				n.Series[key] = &s
			}
		}
		if err != nil {
			return fmt.Errorf("manifest names %q: %w", key, err)
		}
	}
	if n.Deltas.Series == "" {
		n.Deltas.Series = dataSeries
	}
	return nil
}

// series returns (creating if absent) the positional list of one series.
func (n *ManifestNames) series(name string) *SeriesNames {
	s := n.Series[name]
	if s == nil {
		base := 0
		if name == dataSeries {
			base = 1
		}
		s = &SeriesNames{Base: base, Tail: -1}
		n.Series[name] = s
	}
	return s
}

// resolve applies the pre-cutover override map (nil in steady state).
func (n *ManifestNames) resolve(key string) string {
	if v, ok := n.overrides[key]; ok {
		return v
	}
	return key
}

// key resolves the object holding a series' position. It fails loudly rather
// than fabricating a name: under this model a name is LISTED, so an absent
// position means the chron arithmetic and the published names disagree.
func (n *ManifestNames) key(series string, pos int) (string, error) {
	s := n.series(series)
	i := pos - s.Base
	if i < 0 || i >= len(s.Stems) {
		return "", fmt.Errorf("%s: the store names no object at position %d (%d listed from %d)",
			series, pos, len(s.Stems), s.Base)
	}
	return n.resolve(fmt.Sprintf("%s/%d.gz", series, s.Stems[i])), nil
}

// deltaKeys / seenKey / hsumKey / ssumKey are the singleton accessors. They go
// through resolve for the same reason key does; "" means the store names none.
func (n *ManifestNames) deltaKeys() []string {
	out := n.Deltas.keys()
	for i, k := range out {
		out[i] = n.resolve(k)
	}
	return out
}

func (n *ManifestNames) seenKey() string {
	if n.Seen == nil {
		return ""
	}
	return n.resolve(n.Seen.key())
}

func (n *ManifestNames) hsumKey() string {
	if n.HSum == nil {
		return ""
	}
	return n.resolve(n.HSum.key())
}

func (n *ManifestNames) ssumKey() string {
	if n.SSum == nil {
		return ""
	}
	return n.resolve(n.SSum.key())
}

// tailKey resolves a series' tail object, "" when it has none.
func (n *ManifestNames) tailKey(series string) string {
	s := n.series(series)
	if s.Tail < 0 {
		return ""
	}
	k, err := n.key(series, s.Tail)
	if err != nil {
		return ""
	}
	return k
}

// alloc hands out the next stem of a series and advances its counter. The
// counter is monotone and never reused (M3), which is what makes a rebuild or a
// compaction write NEW names beside the old ones instead of overwriting them.
func (n *ManifestNames) alloc(series string) int {
	stem := n.Next[series]
	n.Next[series] = stem + 1
	return stem
}

// putAt places a stem at a series position, extending the list by exactly one
// or replacing an existing entry. A gap is refused: positional density (M5) is
// what lets floor(chron/stride) index the list.
func (n *ManifestNames) putAt(series string, pos, stem int) error {
	s := n.series(series)
	i := pos - s.Base
	switch {
	case i < 0:
		return fmt.Errorf("%s: position %d is below the series base %d", series, pos, s.Base)
	case i < len(s.Stems):
		s.Stems[i] = stem
	case i == len(s.Stems):
		s.Stems = append(s.Stems, stem)
	default:
		return fmt.Errorf("%s: position %d would leave a hole (%d listed from %d)", series, pos, len(s.Stems), s.Base)
	}
	return nil
}

// setTail places a freshly-written tail object at its position and records it
// as the series' tail.
func (n *ManifestNames) setTail(series string, pos, stem int) error {
	if err := n.putAt(series, pos, stem); err != nil {
		return err
	}
	n.series(series).Tail = pos
	return nil
}

// truncate drops every position at or above pos (used when a rebuild restarts
// a derived series from scratch) and forgets the tail.
func (n *ManifestNames) truncate(series string, pos int) {
	s := n.series(series)
	if i := pos - s.Base; i >= 0 && i < len(s.Stems) {
		s.Stems = s.Stems[:i]
	}
	s.Tail = -1
}

// finalizedCount is how many positions a series lists BELOW its tail — the
// meaning the retired `hdrs`/`mp` counters carried.
func (n *ManifestNames) finalizedCount(series string) int {
	s := n.series(series)
	c := len(s.Stems)
	if s.Tail >= 0 {
		c--
	}
	return c
}

// keys lists every object this table names, in no particular order. The GC's
// reachability set (§7) and `srr inspect --validate`'s existence probe (M4)
// both consume it.
func (n *ManifestNames) keys() []string {
	var out []string
	for name, s := range n.Series {
		for _, stem := range s.Stems {
			out = append(out, n.resolve(fmt.Sprintf("%s/%d.gz", name, stem)))
		}
	}
	out = append(out, n.deltaKeys()...)
	for _, k := range []string{n.seenKey(), n.hsumKey(), n.ssumKey()} {
		if k != "" {
			out = append(out, k)
		}
	}
	return out
}

// clone deep-copies the table so a caller can stage name changes and adopt
// them only once every object it names is durable.
func (n *ManifestNames) clone() *ManifestNames {
	out := newManifestNames()
	for name, s := range n.Series {
		out.Series[name] = &SeriesNames{Base: s.Base, Stems: slices.Clone(s.Stems), Tail: s.Tail}
	}
	out.Deltas = DeltaNames{Series: n.Deltas.Series, Stems: slices.Clone(n.Deltas.Stems)}
	if n.Seen != nil {
		s := *n.Seen
		out.Seen = &s
	}
	if n.HSum != nil {
		s := *n.HSum
		out.HSum = &s
	}
	if n.SSum != nil {
		s := *n.SSum
		out.SSum = &s
	}
	for k, v := range n.Next {
		out.Next[k] = v
	}
	return out
}

// --- convenience accessors on the core -------------------------------------

// numDeltas is the live delta-segment count — what the retired `nd` field was.
func (c *DBCore) numDeltas() int { return len(c.Names.Deltas.Stems) }

// metaPacks is the finalized meta-shard count — what the retired `mp` field
// was.
func (c *DBCore) metaPacks() int { return c.Names.finalizedCount(metaSeries) }

// hdrPacks is the idx header summary's coverage — what the retired `hdrs`
// field was.
func (c *DBCore) hdrPacks() int {
	if c.Names.HSum == nil {
		return 0
	}
	return c.Names.HSum.Covers
}
