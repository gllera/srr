package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"

	"srr/store"
)

// The generation manifest — docs/MANIFEST-SPEC.md.
//
// Every Commit publishes one immutable manifest/<m>.gz naming, explicitly,
// every live object of every series plus all reader-visible state. This is the
// S32 half of the cutover: the manifest is written IN ADDITION to today's full
// db.gz, nothing reads it yet, and deleting every manifest/* from a store
// leaves it fully functional under the legacy paths.
//
// The universal crash argument (§6.1) the model exists for:
//
//	Every mutation writes only new immutable objects, then one immutable
//	manifest naming them, then flips the root. A crash at any point before the
//	root flip leaves unreferenced objects in the store and changes nothing a
//	reader can observe. A crash after the flip has already succeeded.
//
// Under S32 the root flip is still Commit's AtomicPut of the full db.gz.

const (
	// manifestVersion is the format version stamped INSIDE a manifest, and the
	// version the v2 root will carry at S34. It is deliberately NOT
	// dbFormatVersion: db.gz stays at v1 for this whole release so every
	// deployed reader keeps parsing it, while the manifest — an object no
	// deployed reader fetches — is born v2.
	manifestVersion = 2
	// keepManifests is K, the GC grace window of §7: how many generations stale
	// an open tab's root may be before it must self-heal. 32 is comfortably
	// wider than today's effective tail window (latestKeep + 2·maxDeltas + 1 =
	// 27 at the default --max-deltas 12) and is a plain count rather than a
	// derivation. Only manifests are swept on it in S32 — the pack sweeps stay
	// exactly as they are until S34 retires them.
	keepManifests = 32
)

// manifestKey resolves the key of generation manifest m. Its own "manifest"
// series in the PackSeries grammar, bare stems only — the manifest counter IS
// the name.
func manifestKey(m int) string {
	return fmt.Sprintf("manifest/%d.gz", m)
}

// Manifest is one complete, self-contained description of one store state
// (§4.2). It embeds the very same ManifestState and ManifestWriterState structs
// DBCore embeds, so those halves cannot drift from db.gz by omission: adding a
// field to either lands it in both objects. Only Feeds is projected, because a
// manifest carries the reader-facing half of a feed and NOT its config (§5.2).
type Manifest struct {
	Version int `json:"v"`
	Num     int `json:"m"`
	ManifestState
	ManifestWriterState
	// Names lists every live object, explicitly, per series. There is no
	// computed-name fallback (§4.5) — two ways to learn a name means two truths
	// that can disagree.
	Names ManifestNames `json:"names"`
	// Feeds is the reader-facing projection of DBCore.Feeds, keyed by id.
	Feeds map[int]FeedPublic `json:"feeds"`
}

// SeriesNames is one pack series' positional name list (§4.5). Entry i names
// the object holding that series' i-th stride region; the list is dense from
// Base (invariant M5), which is what lets floor(chron/stride) index it.
//
// Runs are RLE'd over BARE stems — `[[firstStem, count], …]` — because stems
// are assigned in write order, so a pristine store's list is one contiguous
// run. Tail is the S32 deviation the spec's §11.1 calls for: this release
// carries the LEGACY names verbatim, and the current tail pack is named
// idx|data|meta/L<tailGen>.gz, which has no bare-stem form. It occupies the one
// position immediately after the last run. Opaque stems arrive at S34, and the
// Tail field disappears with the kind letters it exists to express.
type SeriesNames struct {
	Base int      `json:"b,omitempty"`
	Runs [][2]int `json:"r,omitempty"`
	Tail string   `json:"t,omitempty"`
}

// SummaryName is a derived summary object: its key plus the count of finalized
// packs it covers. Under S34 the key becomes a bare stem (§10.3) and the
// coverage stops being encoded in the name; carrying `covers` next to the name
// already is what makes that a deletion rather than a redesign.
type SummaryName struct {
	Key    string `json:"key"`
	Covers int    `json:"covers"`
}

// manifestSingletonKeys are the keys inside `names` that are NOT a pack series.
// A series may never be called one of these; assertNamesDisjoint proves it at
// startup so the flat encoding below can never be ambiguous.
var manifestSingletonKeys = []string{"deltas", "seen", "hsum", "ssum"}

// ManifestNames is the `names` object. Series are held in a MAP, not in three
// named fields, because §4.6 requires that nothing assume there are exactly
// three series, that idx and meta are distinct, or that a stride is a
// particular number — ARC6 (merging idx/ and meta/) must stay a manifest-shape
// change and nothing else. The custom (Un)MarshalJSON flattens the map next to
// the singletons so the wire shape is the one §12 documents.
type ManifestNames struct {
	Series map[string]SeriesNames
	// Deltas is the ordered live delta chain — the data series' `d` kind today.
	Deltas []string
	// Seen names the active dedup sidecar slot. Empty when the store has none
	// (a store no dirty cycle has ever written), so every listed name exists
	// (invariant M4).
	Seen string
	// HSum / SSum are the idx header summary and the meta bloom summary; nil
	// when the store publishes none.
	HSum *SummaryName
	SSum *SummaryName
}

func (n ManifestNames) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(n.Series)+len(manifestSingletonKeys))
	for name, s := range n.Series {
		if slices.Contains(manifestSingletonKeys, name) {
			return nil, fmt.Errorf("pack series %q collides with a reserved manifest names key", name)
		}
		out[name] = s
	}
	if len(n.Deltas) > 0 {
		out["deltas"] = n.Deltas
	}
	if n.Seen != "" {
		out["seen"] = n.Seen
	}
	if n.HSum != nil {
		out["hsum"] = n.HSum
	}
	if n.SSum != nil {
		out["ssum"] = n.SSum
	}
	return json.Marshal(out)
}

func (n *ManifestNames) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*n = ManifestNames{Series: map[string]SeriesNames{}}
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
		default:
			// Anything else is a series. Deliberately open: a future merged
			// idx+meta series (ARC6) parses here with no code change.
			var s SeriesNames
			if err = json.Unmarshal(val, &s); err == nil {
				n.Series[key] = s
			}
		}
		if err != nil {
			return fmt.Errorf("manifest names %q: %w", key, err)
		}
	}
	return nil
}

// Keys expands a series' positional list into index→key, series being the
// directory the bare stems live in. Position Base+i comes from the runs; the
// tail, when present, occupies the single position after them.
func (s SeriesNames) Keys(series string) []string {
	out := make([]string, 0, s.Base)
	for range s.Base {
		out = append(out, "") // positions below Base are not part of this series
	}
	for _, r := range s.Runs {
		for i := range r[1] {
			out = append(out, fmt.Sprintf("%s/%d.gz", series, r[0]+i))
		}
	}
	if s.Tail != "" {
		out = append(out, s.Tail)
	}
	return out
}

// contiguousRun builds the single-run RLE covering `count` bare stems starting
// at `first`. Every list a pristine SRR store produces is exactly one run —
// stems are assigned in write order — so this is the whole encoder until S35's
// compaction can rewrite a pack under a fresh stem.
func contiguousRun(first, count int) [][2]int {
	if count <= 0 {
		return nil
	}
	return [][2]int{{first, count}}
}

// buildManifest projects the in-memory core into the manifest generation m
// publishes. It NAMES what today's derivation functions compute — that
// equivalence is what `srr inspect --validate`'s manifest check asserts
// independently, and what makes S33's reader swap a pure indirection.
func (o *DB) buildManifest(m int) Manifest {
	c := &o.core
	tc := tailCovered(c)

	feeds := make(map[int]FeedPublic, len(c.Feeds))
	for id, ch := range c.Feeds {
		feeds[id] = feedPublicOf(ch)
	}

	names := ManifestNames{Series: map[string]SeriesNames{}}

	// idx: finalized packs idx/0..nf-1 at positions 0..nf-1, then the tail.
	nf := numFinalizedIdx(c.TotalArticles)
	idx := SeriesNames{Runs: contiguousRun(0, nf)}
	// data: finalized packs are 1..NextPackID-1 — the writer has always skipped
	// data/0 — so the list is based at 1, and the tail sits at position
	// NextPackID, which is exactly what dataKeyFor resolves.
	data := SeriesNames{Base: 1, Runs: contiguousRun(1, max(c.NextPackID-1, 0))}
	if tc > 0 {
		idx.Tail = latestKey(c, "idx")
		data.Tail = latestKey(c, "data")
	}
	names.Series["idx"] = idx
	names.Series["data"] = data

	// meta: the published coverage only. A warn-only SyncMeta failure leaves
	// mp/mt behind the store, and the tail it would have written may not exist
	// — so the tail is named only when the coverage is exact, which is the same
	// condition the reader's metaReady() gate already uses. Every listed name
	// then exists (M4), and a short list degrades exactly as today.
	meta := SeriesNames{Runs: contiguousRun(0, c.MetaPacks)}
	if tc > 0 && c.MetaPacks*metaPackSize+c.MetaTail == tc {
		meta.Tail = latestKey(c, "meta")
	}
	names.Series["meta"] = meta

	for g := tailGen(c) + 1; g <= c.Seq; g++ {
		names.Deltas = append(names.Deltas, deltaKey(g))
	}
	if o.seenSlot != "" {
		names.Seen = o.seenSlot
	}
	if c.HdrPacks > 0 {
		names.HSum = &SummaryName{Key: summaryKey(c.HdrPacks), Covers: c.HdrPacks}
	}
	if c.MetaPacks > 0 {
		names.SSum = &SummaryName{Key: metaSummaryKey(c.MetaPacks), Covers: c.MetaPacks}
	}

	return Manifest{
		Version:             manifestVersion,
		Num:                 m,
		ManifestState:       c.ManifestState,
		ManifestWriterState: c.ManifestWriterState,
		Names:               names,
		Feeds:               feeds,
	}
}

// publishManifest writes manifest/<ManifestNum+1>.gz and, on success, advances
// the in-memory counter so the caller's Commit publishes it. Called by Commit
// BEFORE the root flip, per §6.1.
//
// Publication is an EXCLUSIVE CREATE (§6.2), not an AtomicPut: every backend
// implements it (O_EXCL on local, If-None-Match on S3/HTTP — the same primitive
// `.locked` uses), so a second writer that raced past a stale or --force'd lock
// fails loudly on the name it must publish BEFORE it can flip the root. That
// turns the manifest counter into a poor-man's compare-and-swap on the commit
// itself, which is strictly better than the advisory lock alone and is what
// makes S32→S34 implementable before REL3's lease+CAS lands.
//
// The one stated exception is the retry-after-crash path: a crash between
// publishing manifest/<m+1>.gz and flipping the root leaves that name taken on
// an object nothing references. Resolution rule (§6.2, verbatim): re-read the
// root; if the store's root.m is still below the attempted number the orphan is
// provably unreferenced garbage — its own listed objects are unreferenced
// too — and may be overwritten. Re-reading is what keeps the CAS honest: a
// collision against a root that HAS advanced is a real peer writer, and that is
// fatal for the cycle.
func (o *DB) publishManifest(ctx context.Context) error {
	m := o.core.ManifestNum + 1
	body, err := gzipJSON(o.buildManifest(m))
	if err != nil {
		return fmt.Errorf("encode manifest %d: %w", m, err)
	}
	key := manifestKey(m)

	err = o.Put(ctx, key, bytes.NewReader(body), false)
	if errors.Is(err, os.ErrExist) {
		rootM, rerr := o.readRootManifestNum(ctx)
		if rerr != nil {
			return fmt.Errorf("publish %s: name already taken and the root could not be re-read to classify it: %w", key, rerr)
		}
		if rootM >= m {
			return fmt.Errorf("publish %s: already published and the store root is at m=%d — another writer holds this store; aborting before the root flip", key, rootM)
		}
		slog.Info("overwriting an orphan manifest left by a crashed cycle (unreferenced: the store root is older)",
			"key", key, "root_m", rootM)
		if err := o.AtomicPut(ctx, key, bytes.NewReader(body), store.ObjectMeta{}); err != nil {
			return fmt.Errorf("overwrite orphan %s: %w", key, err)
		}
	} else if err != nil {
		return fmt.Errorf("publish %s: %w", key, err)
	}

	o.core.ManifestNum = m
	return nil
}

// readRootManifestNum re-reads the store's db.gz and returns its manifest
// counter. Used only on the exclusive-create collision path, so the extra GET
// costs nothing in steady state. A store with no db.gz yet reads as 0.
func (o *DB) readRootManifestNum(ctx context.Context) (int, error) {
	rc, err := o.Get(ctx, dbFileKey, true)
	if err != nil {
		return 0, err
	}
	if rc == nil {
		return 0, nil
	}
	defer rc.Close()
	data, err := gunzip(rc)
	if err != nil {
		return 0, fmt.Errorf("decompress %s: %w", dbFileKey, err)
	}
	var root RootState
	if err := json.Unmarshal(data, &root); err != nil {
		return 0, fmt.Errorf("decode %s: %w", dbFileKey, err)
	}
	return root.ManifestNum, nil
}

// GCManifests is §7's one rule, applied to the manifest series only: delete
// what the last K manifests do not name. Under S32 the pack objects are still
// owned by the legacy sweeps (GCLatest/GCSummaries/GCMetaSummaries), which S34
// merges into this function — so all this reclaims for now is the manifests
// themselves, which no deployed reader has ever fetched.
//
// A LOW-WATER drain, for exactly the reason GCLatestSwept is one: the sweep is
// warn-only, so a missed or failed run must never permanently strand a name,
// and the next advancing run has to resume where the last one stopped. Bounded
// per run by gcMaxSweep so a long-missed sweep drains across runs instead of
// issuing thousands of deletes in one cycle. Rm is silent on missing keys.
func (o *DB) GCManifests(ctx context.Context, keep int) error {
	c := &o.core
	cutoff := c.ManifestNum - keep
	from := max(c.GCManifest+1, 1)
	to := min(cutoff, from+gcMaxSweep-1)
	swept := c.GCManifest
	for g := from; g <= to; g++ {
		if err := o.Rm(ctx, manifestKey(g)); err != nil {
			c.GCManifest = swept
			return fmt.Errorf("gc manifest %d: %w", g, err)
		}
		swept = g
	}
	c.GCManifest = swept
	return nil
}

// gzipJSON encodes v as gzipped JSON with the same settings every other SRR
// JSON object uses (no HTML escaping, stdlib gzip).
func gzipJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	enc := json.NewEncoder(gz)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
