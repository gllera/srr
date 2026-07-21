package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"srr/store"
)

// The commit root and the one-way migration into it — docs/MANIFEST-SPEC.md
// §4.1 and §11.
//
// db.gz keeps its key, its `no-cache, must-revalidate` treatment and its gzip
// framing, and carries nothing but a pointer:
//
//	{"v":2,"m":1743,"t":1753027200}
//
// Everything a reader needs lives in the immutable manifest/<m>.gz that pointer
// names; everything only the operator's tooling needs lives in the backend-only
// config.gz sidecar. `t` is here as well as in the manifest so a cycle that
// changed nothing else (a fully backoff-thinned poll, a zero-feed maintenance
// cycle) rewrites ~60 bytes and leaves `m` — and therefore every reader's cached
// manifest — untouched.

// RootState is the db.gz document. Nothing else: in particular NOT total_art,
// seq or gen — any of them here would be a second source of truth for something
// the manifest owns.
type RootState struct {
	// Version is the root format version (dbFormatVersion). NewDB refuses a
	// store written by a newer srr rather than silently dropping the fields it
	// cannot represent; data.ts parseDb takes the same reject through its
	// error-popup path.
	Version int `json:"v"`
	// ManifestNum names manifest/<m>.gz — the current generation. Monotone, +1
	// per publishing Commit, never reused (M2/M3).
	ManifestNum int `json:"m"`
	// FetchedAt is the last cycle's fetch timestamp, duplicated out of the
	// manifest so an idle cycle costs a reader ~60 bytes and no manifest fetch.
	FetchedAt int64 `json:"t,omitempty"`
}

// legacyCore is the PRE-CUTOVER db.gz document (format v1): one JSON object
// carrying the whole store state, the operator's configuration, and the ~14
// counters a reader used to DERIVE object names from. It exists for exactly one
// purpose — reading a store written before the cutover so the first locked
// session can migrate it (§11) — and is never written by this binary.
type legacyCore struct {
	Version     int   `json:"v"`
	ManifestNum int   `json:"m"`
	FetchedAt   int64 `json:"fetched_at"`

	TotalArticles int         `json:"total_art"`
	MetaTail      int         `json:"mt"`
	DeltaArticles int         `json:"na"`
	Head          []MetaEntry `json:"head"`
	HeadBase      int         `json:"hb"`

	Recipes   map[string]Recipe `json:"recipes"`
	DedupDays int               `json:"dd"`
	Out       []OutFeed         `json:"out"`

	PackOffset int              `json:"pack_off"`
	NextPackID int              `json:"next_pid"`
	DeltaBytes int64            `json:"dby"`
	GCManifest int              `json:"gcm"`
	Inbox      map[string]int64 `json:"inbox"`

	// The retired name-derivation counters (§5.1), read only to reconstruct
	// the object names the migration then re-publishes under opaque stems.
	Seq           int  `json:"seq"`
	SeenFlag      bool `json:"sf"`
	Gen           int  `json:"gen"`
	HdrPacks      int  `json:"hdrs"`
	MetaPacks     int  `json:"mp"`
	NumDeltas     int  `json:"nd"`
	GCLatestSwept int  `json:"gcs"`

	Feeds map[int]*Feed `json:"feeds"`
}

// The legacy key grammar. Kind letters (L/d/h/s) and the db/ snapshot series
// are retired (§10.1–§10.3); these helpers survive ONLY so the migration can
// find the objects it re-publishes and reap what it supersedes.
func legacyGenKey(series string, g int) string { return fmt.Sprintf("%s/L%d.gz", series, g) }
func legacyDeltaKey(g int) string              { return fmt.Sprintf("data/d%d.gz", g) }
func legacySummaryKey(n int) string            { return fmt.Sprintf("idx/h%d.gz", n) }
func legacyMetaSummaryKey(n int) string        { return fmt.Sprintf("meta/s%d.gz", n) }
func legacyDBSnapshotKey(g int) string         { return fmt.Sprintf("db/%d.gz", g) }
func legacySeenSlotKey(flag bool) string {
	if flag {
		return "seen.1.gz"
	}
	return "seen.0.gz"
}

// legacyTailGen is the generation naming the consolidated tail packs of a
// pre-cutover store.
func (l *legacyCore) tailGen() int { return l.Seq - l.NumDeltas }

// legacyState projects the pre-cutover document onto the v2 in-memory core.
// The name-derivation counters do not survive the projection — namesFromLegacy
// turns them into an explicit name table instead.
func (l *legacyCore) state() *DBCore {
	c := &DBCore{
		Version:     l.Version,
		ManifestNum: l.ManifestNum,
		ManifestState: ManifestState{
			FetchedAt:     l.FetchedAt,
			TotalArticles: l.TotalArticles,
			MetaTail:      l.MetaTail,
			DeltaArticles: l.DeltaArticles,
			Head:          l.Head,
			HeadBase:      l.HeadBase,
		},
		StoreConfig: StoreConfig{Recipes: l.Recipes, DedupDays: l.DedupDays, Out: l.Out},
		ManifestWriterState: ManifestWriterState{
			PackOffset: l.PackOffset,
			NextPackID: l.NextPackID,
			DeltaBytes: l.DeltaBytes,
			GCManifest: l.GCManifest,
			Inbox:      l.Inbox,
		},
		Feeds: l.Feeds,
	}
	return c
}

// namesFromLegacy reconstructs the object-name table of a pre-cutover store
// from the counters that used to derive it. Finalized packs already carry bare
// stems (idx/0.gz, data/1.gz, meta/0.gz), so they are adopted verbatim and each
// series' counter starts just above them; the kind-lettered objects (tails,
// deltas, summaries) have no bare-stem form and are listed here under their
// LEGACY keys, which migrateRoot then re-publishes under fresh stems.
//
// It is used unmigrated by the read-only tools (`srr inspect`, `srr art ls`
// against a store no locked session has touched yet), which resolve names
// through the table like everything else and never publish it.
func namesFromLegacy(l *legacyCore) (*ManifestNames, []legacyObject) {
	n := newManifestNames()
	// legacy pairs each pre-cutover key with the fresh stem reserved for it;
	// migrateRoot copies one to the other.
	var legacy []legacyObject
	stemKey := func(series string, stem int) string { return fmt.Sprintf("%s/%d.gz", series, stem) }

	nf := numFinalizedIdx(l.TotalArticles)
	tc := l.TotalArticles - l.DeltaArticles
	tg := l.tailGen()

	idx := n.series(idxSeries)
	for p := range nf {
		idx.Stems = append(idx.Stems, p)
	}
	n.Next[idxSeries] = nf

	data := n.series(dataSeries)
	for p := 1; p < l.NextPackID; p++ {
		data.Stems = append(data.Stems, p)
	}
	n.Next[dataSeries] = max(l.NextPackID, 1)

	meta := n.series(metaSeries)
	for p := range l.MetaPacks {
		meta.Stems = append(meta.Stems, p)
	}
	n.Next[metaSeries] = l.MetaPacks
	n.Next[seenSeries] = 0

	if tc > 0 {
		stem := n.alloc(idxSeries)
		idx.Stems = append(idx.Stems, stem)
		idx.Tail = nf
		legacy = append(legacy, legacyObject{legacyGenKey(idxSeries, tg), stemKey(idxSeries, stem)})

		stem = n.alloc(dataSeries)
		data.Stems = append(data.Stems, stem)
		data.Tail = l.NextPackID
		legacy = append(legacy, legacyObject{legacyGenKey(dataSeries, tg), stemKey(dataSeries, stem)})

		// The meta tail is named only when the published coverage is exact —
		// the same condition the reader's metaReady() gate applies, so every
		// listed name exists (M4) and a short list degrades exactly as before.
		if l.MetaPacks*metaPackSize+l.MetaTail == tc {
			stem = n.alloc(metaSeries)
			meta.Stems = append(meta.Stems, stem)
			meta.Tail = l.MetaPacks
			legacy = append(legacy, legacyObject{legacyGenKey(metaSeries, tg), stemKey(metaSeries, stem)})
		}
	}

	for g := tg + 1; g <= l.Seq; g++ {
		stem := n.alloc(dataSeries)
		n.Deltas.Stems = append(n.Deltas.Stems, stem)
		legacy = append(legacy, legacyObject{legacyDeltaKey(g), stemKey(dataSeries, stem)})
	}
	if l.HdrPacks > 0 {
		n.HSum = &SummaryName{Series: idxSeries, Stem: n.alloc(idxSeries), Covers: l.HdrPacks}
		legacy = append(legacy, legacyObject{legacySummaryKey(l.HdrPacks), n.HSum.key()})
	}
	if l.MetaPacks > 0 {
		n.SSum = &SummaryName{Series: metaSeries, Stem: n.alloc(metaSeries), Covers: l.MetaPacks}
		legacy = append(legacy, legacyObject{legacyMetaSummaryKey(l.MetaPacks), n.SSum.key()})
	}
	// Until the migration copies them, those stems resolve to the names the
	// objects actually carry on disk — so a read-only session on an unmigrated
	// store reads real keys and publishes nothing (see ManifestNames.overrides).
	n.overrides = map[string]string{}
	for _, o := range legacy {
		n.overrides[o.to] = o.from
	}
	return n, legacy
}

// legacyObject pairs a pre-cutover object key with the opaque-stem key the
// migration re-publishes it under.
type legacyObject struct{ from, to string }

// loadStore resolves the store root through whichever shape it carries and
// returns the in-memory core, INCLUDING its object-name table. It is the single
// root resolver: NewDB and the read-only tools (`srr inspect`, `srr art ls`)
// both go through it, so the writer and the checkers can never disagree about
// what a store's objects are called.
//
// The returned core carries no configuration for a v2 store — that lives in
// config.gz, which only the callers that need it read (NewDB always; inspect
// for its cross-check).
func loadStore(fetch keyGetter) (*DBCore, error) {
	data, err := fetch(dbFileKey)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", dbFileKey, err)
	}
	return parseStoreRoot(data, fetch)
}

func parseStoreRoot(data []byte, fetch keyGetter) (*DBCore, error) {
	var root RootState
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
	}
	// Refuse a store from the future: this binary cannot represent fields it
	// does not know, so opening it — even read-only, since any later Commit
	// would write back the truncated state — is how skew silently loses data.
	if root.Version > dbFormatVersion {
		return nil, fmt.Errorf("%s was written by a newer srr (format v%d, this binary supports v%d) — refusing to open; update srr",
			dbFileKey, root.Version, dbFormatVersion)
	}
	if root.Version < dbFormatVersion {
		// Only the PRE-manifest document is a legacy root this binary can read.
		// A v2 root would be one written by an intermediate build of the cutover
		// itself: its manifest carries the transitional `names` encoding, which
		// this binary would silently misread as an empty store. No deployed
		// store is ever in that state (the dual-write release kept db.gz at v1),
		// so say so rather than guess.
		if root.Version > 1 {
			return nil, fmt.Errorf("%s is at format v%d, an intermediate build of the manifest cutover (this binary reads v1 and v%d) — refusing to open",
				dbFileKey, root.Version, dbFormatVersion)
		}
		var l legacyCore
		if err := json.Unmarshal(data, &l); err != nil {
			return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
		}
		c := l.state()
		c.Names, c.legacyKeys = namesFromLegacy(&l)
		c.legacyRoot = &l
		if err := validateCore(c); err != nil {
			return nil, err
		}
		return c, nil
	}

	if root.ManifestNum <= 0 {
		return nil, fmt.Errorf("decode %s: a v%d root must name a manifest (m=%d)", dbFileKey, dbFormatVersion, root.ManifestNum)
	}
	key := manifestKey(root.ManifestNum)
	buf, err := fetch(key)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", key, err)
	}
	var man Manifest
	if err := json.Unmarshal(buf, &man); err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	if man.Num != root.ManifestNum {
		return nil, fmt.Errorf("%s declares generation %d but %s names %d", key, man.Num, dbFileKey, root.ManifestNum)
	}
	if man.Version > dbFormatVersion {
		return nil, fmt.Errorf("%s was written by a newer srr (format v%d, this binary supports v%d)", key, man.Version, dbFormatVersion)
	}
	c := &DBCore{
		Version:             root.Version,
		ManifestNum:         root.ManifestNum,
		ManifestState:       man.ManifestState,
		ManifestWriterState: man.ManifestWriterState,
		Names:               man.Names,
		Feeds:               map[int]*Feed{},
	}
	// The root's `t` is authoritative for freshness: an idle cycle rewrites it
	// and leaves the manifest — and therefore its fetched_at — untouched.
	if root.FetchedAt > c.FetchedAt {
		c.FetchedAt = root.FetchedAt
	}
	if c.Names == nil {
		c.Names = newManifestNames()
	}
	for id, fp := range man.Feeds {
		f := &Feed{id: id}
		applyFeedPublic(f, fp)
		c.Feeds[id] = f
	}
	if err := validateCore(c); err != nil {
		return nil, err
	}
	return c, nil
}

// validateCore range-checks the integers that address objects, so hostile or
// corrupt state fails with a clear decode error instead of fabricating keys or
// allocating on a bogus size (B8/B11).
func validateCore(c *DBCore) error {
	switch {
	case c.TotalArticles < 0:
		return fmt.Errorf("decode %s: total_art %d is negative", dbFileKey, c.TotalArticles)
	case c.NextPackID < 0:
		return fmt.Errorf("decode %s: next_pid %d is negative", dbFileKey, c.NextPackID)
	case c.PackOffset < 0:
		return fmt.Errorf("decode %s: pack_off %d is negative", dbFileKey, c.PackOffset)
	case c.ManifestNum < 0:
		return fmt.Errorf("decode %s: m %d is negative", dbFileKey, c.ManifestNum)
	case c.GCManifest < 0 || c.GCManifest > c.ManifestNum:
		return fmt.Errorf("decode %s: gcm %d out of range [0, m=%d]", dbFileKey, c.GCManifest, c.ManifestNum)
	case c.DeltaArticles < 0 || c.DeltaArticles > c.TotalArticles:
		return fmt.Errorf("decode %s: na %d out of range [0, total_art=%d]", dbFileKey, c.DeltaArticles, c.TotalArticles)
	case (c.numDeltas() == 0) != (c.DeltaArticles == 0):
		return fmt.Errorf("decode %s: %d delta segment(s) named for %d delta article(s)", dbFileKey, c.numDeltas(), c.DeltaArticles)
	}
	for id := range c.Feeds {
		if id < 0 || id >= feedIDCeiling {
			return fmt.Errorf("decode %s: feed id %d out of range [0, %d]", dbFileKey, id, feedIDCeiling-1)
		}
	}
	return nil
}

// applyFeedPublic copies the manifest's reader-facing half onto a feed. The
// config half arrives separately from config.gz (§5.2), and the seen sidecar
// hydrates the rest.
func applyFeedPublic(f *Feed, p FeedPublic) {
	f.Title = p.Title
	f.URL = p.URL
	f.Watermark = p.Watermark
	f.FetchError = p.FetchError
	f.LastOK = p.LastOK
	f.FailStreak = p.FailStreak
	f.LastNew = p.LastNew
	f.Tag = p.Tag
	f.NoTitle = p.NoTitle
	f.ExpireDays = p.ExpireDays
	f.Expired = p.Expired
	f.TotalArt = p.TotalArt
	f.AddIdx = p.AddIdx
	f.ContentBytes = p.ContentBytes
	f.AssetBytes = p.AssetBytes
}

// applyFeedConfig copies the sidecar's backend-only half onto a feed.
func applyFeedConfig(f *Feed, c FeedConfig) {
	f.Recipe = c.Recipe
	f.Ingest = c.Ingest
	f.Pipe = c.Pipe
	f.DedupDays = c.DedupDays
	f.DedupTitle = c.DedupTitle
}

// migrateRoot converts a pre-cutover store to the v2 layout, in the first
// LOCKED session that opens it (§11 step 3). It is additive and idempotent in
// the only sense that matters: it writes new objects and mutates nothing that
// exists, so a crash before Commit leaves unreferenced garbage and a store
// still readable by its legacy root — the universal crash argument (§6.1),
// applied to the migration itself.
//
// The kind-lettered objects (idx|data|meta/L<g>, data/d<g>, idx/h<N>,
// meta/s<N>) have no bare-stem form, so each is COPIED to the fresh stem the
// name table already reserved for it. The finalized packs keep their names —
// they were already bare stems — so the copy is bounded by the tail packs, the
// live delta chain and the two summaries, whatever the store's size.
//
// It also reaps what the cutover retires and no manifest will ever name: the
// db/ snapshot series (§10.1) and the superseded seen ping/pong slot (§10.2).
// The ACTIVE seen slot and the legacy kind-lettered objects are left alone —
// the S32-era manifests still inside the K-generation grace window name them,
// so §7's unreachability sweep reclaims them on its own schedule, and a reader
// still holding a pre-cutover root keeps working until it does.
func (o *DB) migrateRoot(ctx context.Context) error {
	l := o.core.legacyRoot
	if l == nil {
		return nil
	}
	slog.Info("migrating store root to the generation-manifest model (docs/MANIFEST-SPEC.md §11)",
		"from_version", l.Version, "to_version", dbFormatVersion, "objects", len(o.core.legacyKeys))

	for _, obj := range o.core.legacyKeys {
		if err := o.copyObject(ctx, obj.from, obj.to); err != nil {
			return fmt.Errorf("migrate %s -> %s: %w", obj.from, obj.to, err)
		}
	}
	// Every reserved stem now holds real bytes, so the table stops redirecting
	// and the store speaks one layout from here on.
	o.core.Names.overrides = nil

	// The dedup sidecar moves by REWRITE rather than copy: the pool is already
	// in memory and SyncSeen owns the one encoder. Forcing it dirty publishes
	// seen/<stem>.gz under the new naming in this same session, which is what
	// lets the superseded ping/pong slots be reaped below.
	if o.seen != nil {
		o.seen.dirty = true
		if err := o.SyncSeen(ctx); err != nil {
			return fmt.Errorf("migrate seen sidecar: %w", err)
		}
	}

	o.core.legacyRoot = nil
	o.core.legacyKeys = nil
	// Reaped AFTER the root flip, warn-only, for the same reason every other
	// post-commit step is: the state they described is already durable.
	o.legacyReap = append(o.legacyReap, legacySeenSlotKey(l.SeenFlag), legacySeenSlotKey(!l.SeenFlag), seenLegacyKey)
	for g := max(l.GCLatestSwept+1, 1); g <= l.tailGen() && g <= l.GCLatestSwept+gcMaxSweep; g++ {
		o.legacyReap = append(o.legacyReap, legacyDBSnapshotKey(g))
	}
	return nil
}

// copyObject streams one store object to a new key. Used only by migrateRoot.
func (o *DB) copyObject(ctx context.Context, from, to string) error {
	rc, err := o.Get(ctx, from, false)
	if err != nil {
		return err
	}
	defer rc.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(rc); err != nil {
		return err
	}
	return o.AtomicPut(ctx, to, bytes.NewReader(buf.Bytes()), store.ObjectMeta{})
}

// reapLegacy removes what the cutover retired, after the root flip made the
// replacement durable. Warn-only and best-effort: everything here is
// unreferenced by construction, so a failure leaks a small object rather than
// risking anything.
func (o *DB) reapLegacy(ctx context.Context) {
	if len(o.legacyReap) == 0 {
		return
	}
	for _, key := range o.legacyReap {
		if err := o.Rm(ctx, key); err != nil {
			slog.Warn("reap retired object", "key", key, "error", err)
			return
		}
	}
	slog.Info("reaped retired pre-cutover objects", "count", len(o.legacyReap))
	o.legacyReap = nil
}
