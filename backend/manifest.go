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

	"srr/store"
)

// The generation manifest — docs/MANIFEST-SPEC.md.
//
// Every Commit publishes one immutable manifest/<m>.gz naming, explicitly,
// every live object of every series plus all reader-visible state, then flips
// the ~60-byte root at db.gz to point at it.
//
// THE UNIVERSAL CRASH ARGUMENT (§6.1) — stated once here, and the reason no
// other function in this backend carries a publish-order proof of its own:
//
//	Every mutation writes only new immutable objects, then one immutable
//	manifest naming them, then flips the root. A crash at any point before the
//	root flip leaves unreferenced objects in the store and changes nothing a
//	reader can observe. A crash after the flip has already succeeded. There is
//	no third case.
//
// Two properties make it airtight, and both hold by construction: no reader can
// learn a name before the root names it (names are listed, never derived —
// names.go), and the root flip is a single-object atomic write.

// keepManifests is K, the GC grace window of §7: how many generations stale an
// open tab's root may be before it must self-heal. It replaces the four
// per-feature GC window formulas the cutover retired (§10.6) with one plain
// count. 32 is comfortably wider than the pre-cutover effective tail window
// (latestKeep + 2·maxDeltas + 1 = 27 at the default --max-deltas 12).
const keepManifests = 32

// gcMaxSweep bounds how many generations one GC run reclaims, so a large
// one-time backlog (a long-missed warn-only sweep, or the first run after a
// lowered --keep-manifests) drains over several runs instead of issuing
// thousands of sequential store deletes inside a single fetch cycle.
const gcMaxSweep = 64

// manifestKey resolves the key of generation manifest m. Its own "manifest"
// series in the PackSeries grammar, bare stems only — the manifest counter IS
// the name.
func manifestKey(m int) string {
	return fmt.Sprintf("manifest/%d.gz", m)
}

// Manifest is one complete, self-contained description of one store state
// (§4.2). It embeds the very same ManifestState and ManifestWriterState structs
// DBCore embeds, so those halves cannot drift from the in-memory core by
// omission: adding a field to either lands it in the published object. Only
// Feeds is projected, because a feed splits (§5.2) — its reader-facing half
// rides here and its config half rides config.gz.
//
// A manifest is therefore also the point-in-time snapshot the retired db/
// series existed to be (§10.1): restoring a store is writing {"v":2,"m":<older>}
// over db.gz.
type Manifest struct {
	Version int `json:"v"`
	Num     int `json:"m"`
	ManifestState
	ManifestWriterState
	// Names lists every live object, explicitly, per series (§4.5).
	Names *ManifestNames `json:"names"`
	// Feeds is the reader-facing projection of the store's feeds, keyed by id.
	Feeds map[int]FeedPublic `json:"feeds"`
}

// buildManifest projects the in-memory core into the manifest generation m
// publishes.
func (o *DB) buildManifest(m int) Manifest {
	c := &o.core
	feeds := make(map[int]FeedPublic, len(c.Feeds))
	for id, ch := range c.Feeds {
		feeds[id] = feedPublicOf(ch)
	}
	return Manifest{
		Version:             dbFormatVersion,
		Num:                 m,
		ManifestState:       c.ManifestState,
		ManifestWriterState: c.ManifestWriterState,
		Names:               c.Names,
		Feeds:               feeds,
	}
}

// publishManifest writes manifest/<ManifestNum+1>.gz and, on success, advances
// the in-memory counter so the caller's Commit flips the root onto it.
//
// Publication is an EXCLUSIVE CREATE (§6.2), not an AtomicPut: every backend
// implements it (O_EXCL on local, If-None-Match on S3/HTTP — the same primitive
// `.locked` uses), so a second writer that raced past a stale or --force'd lock
// fails loudly on the name it must publish BEFORE it can flip the root. That
// turns the manifest counter into a poor-man's compare-and-swap on the commit
// itself, strictly better than the advisory lock alone.
//
// The one stated exception is the retry-after-crash path: a crash between
// publishing manifest/<m+1>.gz and flipping the root leaves that name taken on
// an object nothing references. Resolution rule (§6.2, verbatim): re-read the
// root; if the store's root.m is still below the attempted number the orphan is
// provably unreferenced garbage — its own listed objects are unreferenced
// too — and may be overwritten. A collision against a root that HAS advanced is
// a real peer writer, and that is fatal for the cycle.
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

// GC is ONE RULE (§7): delete what the last K manifests do not name.
//
// It replaces GCLatest, GCSummaries, GCMetaSummaries, the db/ snapshot sweep,
// and the four window formulas (latestKeep, gcSweepWindow, 2·maxDeltas, the
// per-summary windows) that used to derive their cutoffs — §10.6.
//
// Without a store List (STO1 open) the sweep is a LOW-WATER drain on the
// manifest counter, for exactly the reason the retired GCLatestSwept was one:
// the sweep is warn-only, so a missed or failed run must never permanently
// strand a name, and the next advancing run has to resume where the last one
// stopped. `gcm` advances only over generations actually cleared, and per-run
// work is capped at gcMaxSweep. Rm is silent on missing keys.
func (o *DB) GC(ctx context.Context, keep int) error {
	c := &o.core
	cutoff := c.ManifestNum - keep
	from := max(c.GCManifest+1, 1)
	to := min(cutoff, from+gcMaxSweep-1)
	if to < from {
		return nil
	}

	// The reachable set is union(names(cutoff+1 … m)) — but it collapses to ONE
	// manifest read, and the reason is worth stating because it is the property
	// opaque stems buy:
	//
	//	A stem is never reused, and a position is only ever replaced by a NEWER
	//	stem, so an object's liveness across generations is a CONTIGUOUS
	//	interval. An object named by a generation g <= cutoff that is still
	//	named by some generation g' > cutoff is therefore named by every
	//	generation between them — including the oldest one in the window.
	//
	// So the oldest in-window manifest is the whole reachable set, plus the
	// generation this cycle is about to publish (already in hand as c.Names,
	// and not yet on disk).
	live := map[string]bool{}
	for _, k := range c.Names.keys() {
		live[k] = true
	}
	oldest := min(max(cutoff+1, 1), c.ManifestNum)
	keys, err := o.manifestObjectKeys(ctx, oldest)
	if err != nil {
		// Nothing may be reclaimed on incomplete knowledge of what is still
		// reachable: bail rather than delete an object a stale reader resolves.
		return fmt.Errorf("gc: reading manifest %d for the reachable set: %w", oldest, err)
	}
	for _, k := range keys {
		live[k] = true
	}

	swept := c.GCManifest
	for g := from; g <= to; g++ {
		keys, err := o.manifestObjectKeys(ctx, g)
		if err != nil {
			// An unreadable superseded manifest is reclaimed as itself: its
			// objects stay as garbage rather than risking a delete on a guess.
			slog.Warn("gc: superseded manifest unreadable; dropping it without sweeping its objects",
				"generation", g, "error", err)
		}
		for _, k := range keys {
			if live[k] {
				continue
			}
			if err := o.Rm(ctx, k); err != nil {
				c.GCManifest = swept
				return fmt.Errorf("gc generation %d: %w", g, err)
			}
		}
		if err := o.Rm(ctx, manifestKey(g)); err != nil {
			c.GCManifest = swept
			return fmt.Errorf("gc manifest %d: %w", g, err)
		}
		swept = g
	}
	c.GCManifest = swept
	return nil
}

// manifestObjectKeys lists every object generation g names.
//
// It reads the `names` object LENIENTLY rather than through the typed model,
// because the grace window can still hold S32-era manifests written before the
// cutover — the ones whose name lists carry the retired kind-lettered keys.
// That is precisely how those legacy tails, delta segments and summaries
// reclaim themselves (§10.1): they are named by a manifest inside the window,
// so this sweep reaches them. It is a read-only compatibility shim with a
// bounded life of K generations, not a second naming model.
func (o *DB) manifestObjectKeys(ctx context.Context, g int) ([]string, error) {
	buf, err := o.readGz(ctx, manifestKey(g))
	if err != nil {
		return nil, err
	}
	var doc struct {
		Names map[string]json.RawMessage `json:"names"`
	}
	if err := json.Unmarshal(buf, &doc); err != nil {
		return nil, err
	}
	var out []string
	add := func(k string) {
		if k != "" {
			out = append(out, k)
		}
	}
	stems := func(series string, runs [][2]int) {
		for _, r := range runs {
			for i := range r[1] {
				add(fmt.Sprintf("%s/%d.gz", series, r[0]+i))
			}
		}
	}
	for key, raw := range doc.Names {
		switch key {
		case "next":
		case "deltas":
			var legacy []string
			if json.Unmarshal(raw, &legacy) == nil {
				for _, k := range legacy {
					add(k)
				}
				continue
			}
			var d DeltaNames
			if json.Unmarshal(raw, &d) == nil {
				for _, k := range d.keys() {
					add(k)
				}
			}
		case "seen":
			var legacy string
			if json.Unmarshal(raw, &legacy) == nil {
				add(legacy)
				continue
			}
			var r StemRef
			if json.Unmarshal(raw, &r) == nil {
				add(r.key())
			}
		case "hsum", "ssum":
			var legacy struct {
				Key string `json:"key"`
			}
			if json.Unmarshal(raw, &legacy) == nil && legacy.Key != "" {
				add(legacy.Key)
				continue
			}
			var s SummaryName
			if json.Unmarshal(raw, &s) == nil {
				add(s.key())
			}
		default: // a pack series
			var row struct {
				Runs [][2]int `json:"r"`
				Tail string   `json:"t"` // the retired S32 tail shape
			}
			if json.Unmarshal(raw, &row) != nil {
				continue
			}
			stems(key, row.Runs)
			add(row.Tail)
		}
	}
	return out, nil
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
