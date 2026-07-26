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
// lowered --keep-manifests) drains over several runs instead of stretching a
// single fetch cycle. The deletes themselves fan out (store.RmAll), but each
// generation still costs its own manifest READ, and those stay sequential
// because the low-water mark advances one generation at a time.
const gcMaxSweep = 64

// gcMaxOrphans bounds the ORPHAN half of the list-mode sweep for the same
// reason gcMaxSweep bounds the generation half: the first run against a store
// that has been leaking crash orphans for months should not spend a
// five-minute fetch cycle reclaiming them all at once. Unlike the drain,
// nothing has to be remembered to resume — the next run lists again and finds
// whatever is left — so the cap costs only latency to full reclamation.
const gcMaxOrphans = 1000

// rmParallel is the fan-out width every reclaim path hands store.RmAll (the
// GC sweeps, expiration's asset deletes, `srr frontend update`'s orphan
// removal): the same bound the rest of the writer puts on its concurrent store
// round-trips. The floor covers the paths kong never ran — Workers is 0, and
// globals itself is nil, when a test drives one of these functions directly.
func rmParallel() int {
	if globals == nil {
		return 1
	}
	return max(1, globals.Workers)
}

// manifestSeries is the series the generation manifests live in. It is a
// PackSeries row like any other (bare stems, `manifest/<m>.gz`), which is what
// makes manifests visible to a listing — and why the list-mode sweep has to
// treat them by GENERATION NUMBER rather than by name reachability: no `names`
// table ever lists a manifest.
const manifestSeries = "manifest"

// manifestKey resolves the key of generation manifest m. Its own "manifest"
// series in the PackSeries grammar, bare stems only — the manifest counter IS
// the name.
func manifestKey(m int) string {
	return fmt.Sprintf("%s/%d.gz", manifestSeries, m)
}

// Manifest is one complete, self-contained description of one store state
// (§4.2). It embeds the very same ManifestState and ManifestWriterState structs
// DBCore embeds, so those halves cannot drift from the in-memory core by
// omission: adding a field to either lands it in the published object. Only
// Feeds is projected, because a feed splits (§5.2) — its reader-facing half
// rides here and its config half rides config.gz.
//
// A manifest is therefore also the point-in-time snapshot the retired db/
// series existed to be (§10.1): restoring a store is writing {"v":3,"m":<older>}
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

// manifestSig is the byte signature of everything a published manifest carries
// EXCEPT its generation number and fetched_at — the two fields that move on a
// cycle that changed nothing a reader observes. Commit compares it against the
// signature captured at open (manifestSigAtOpen) to decide whether a new
// generation is warranted: a cycle that only advanced the clock flips the
// ~60-byte root with the SAME m and leaves the manifest — and every reader's
// cached copy and the edge cache in front of it — untouched (§4.1/§8.1, G2).
//
// The encoding is deterministic (Go sorts map keys; the names table's runs and
// the feed projection are order-free), so equal content yields equal bytes.
func (o *DB) manifestSig() ([]byte, error) {
	m := o.buildManifest(0)
	m.FetchedAt = 0
	return json.Marshal(m)
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
	rc, err := getOptional(ctx, o.Backend, dbFileKey)
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
// The rule is one; the SWEEP has two shapes, because "what the store holds" is
// a question only a listable backend can answer:
//
//   - gcSweepList — the backend lists (local, SFTP, S3/R2, i.e. production).
//     Ask the store what it holds, delete the pack-grammar objects no in-window
//     generation can reach. That reclaims what the drain does AND what it never
//     could: an object a crashed cycle wrote and no manifest ever named.
//   - gcSweepDrain — the backend cannot list (plain HTTP). Walk the superseded
//     generations one by one, deleting what each names and the window does not.
//     A crash orphan stays unfindable; nothing else can be done from here.
//
// Both share the reachable set below, and both leave `gcm` a LOW-WATER mark
// that advances only over generations actually cleared — the sweep is
// warn-only, so a missed or failed run must never permanently strand a name.
// Rm is silent on missing keys.
//
// Both also issue their deletes through store.RmAll, which is what makes that
// low-water rule cheap to honour: one bounded fan-out per group of dead keys
// (one batched DeleteObjects call on S3) reporting WHICH keys survived, so a
// partial failure leaves the generation uncleared without discarding the
// deletes that did land.
func (o *DB) GC(ctx context.Context, keep int) error {
	c := &o.core
	if c.ManifestNum == 0 {
		// Nothing has been published, so nothing in the store is superseded and
		// nothing here can distinguish an orphan from an object this very cycle
		// is about to name.
		return nil
	}
	// Never sweep the current generation: clamp the cutoff to m-1. The flag is
	// already floored at the compile-time K in main, but GC stays self-safe for
	// any caller — a keep <= 0 would otherwise make the cutoff reach m and delete
	// the manifest the root names, bricking the store on a crash before the
	// republishing Commit.
	cutoff := min(c.ManifestNum-keep, c.ManifestNum-1)

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
	keys, floor, err := o.manifestObjectKeys(ctx, oldest)
	if err != nil {
		// Nothing may be reclaimed on incomplete knowledge of what is still
		// reachable: bail rather than delete an object a stale reader resolves.
		return fmt.Errorf("gc: reading manifest %d for the reachable set: %w", oldest, err)
	}
	for _, k := range keys {
		live[k] = true
	}

	err = o.gcSweepList(ctx, cutoff, live, floor)
	if !errors.Is(err, errors.ErrUnsupported) {
		return err
	}
	return o.gcSweepDrain(ctx, cutoff, live)
}

// gcSweepList is the sweep for a backend that can enumerate its own objects.
//
// The reachable set above is exact for objects a SUPERSEDED generation names,
// but a listing also turns up objects created INSIDE the window — the tail
// generation g published and generation g+1 replaced, with cutoff still below
// both — and those are named by neither the oldest in-window manifest nor the
// current one while a reader parked on g still needs them. Reading all K
// manifests would settle it; one number already does:
//
//	Stems come from a per-series counter that only ever counts up, so an object
//	whose stem is BELOW the oldest in-window manifest's `next` for that series
//	was created at or before that generation. If that generation does not name
//	it either, its contiguous liveness interval ended at or before the window
//	opened, and NO in-window generation names it. Deletable.
//	An object at or above that floor was created inside the window: it may be
//	the very object a mid-window reader resolves, so it is left alone and
//	becomes deletable on its own terms once the window slides past it.
//
// That floor is also what makes crash orphans reclaimable at all — a stem
// written by a cycle that died before publishing is below the floor as soon as
// the window moves on, and no manifest anywhere has to know it existed. And it
// is what keeps a CONCURRENT writer safe: a peer that stole or forced the lease
// draws its stems from the same published `names.next`, so everything it has in
// flight sits at or above the floor and is never a candidate here.
//
// Cost: one listing of each series per run, i.e. per fetch cycle. That is a
// page per ~1000 objects — single digits of requests on any store this writer
// has produced — against a cycle that already reads and writes packs.
//
// Every List runs BEFORE any delete, so a backend that turns out not to support
// listing reports errors.ErrUnsupported with the store untouched and GC falls
// back to the drain.
func (o *DB) gcSweepList(ctx context.Context, cutoff int, live map[string]bool, floor map[string]int) error {
	c := &o.core

	var orphans []string
	present := map[int]bool{} // the generation manifests the store actually holds
	for _, s := range store.PackSeries {
		keys, err := o.List(ctx, s.Name+"/")
		if err != nil {
			return fmt.Errorf("gc: listing %s/: %w", s.Name, err)
		}
		for _, k := range keys {
			// THE SAFETY LINE OF THIS WHOLE SWEEP: only a name the write-once pack
			// grammar can produce is ever a candidate. Everything else a listing
			// may turn up — an AtomicPut staging leftover, a retired kind-lettered
			// name, anything an operator dropped in the tree — answers false and is
			// never deleted. assets/, out/, inbox/, db.gz, config.gz, sitemap.txt
			// and the frontend shell are outside the listed series entirely.
			series, stem, ok := store.ParsePackKey(k)
			if !ok || series != s.Name {
				continue
			}
			if series == manifestSeries {
				// No `names` table lists a manifest, so reachability says nothing
				// about one: generations are swept by NUMBER, below.
				present[stem] = true
				continue
			}
			if live[k] || stem >= floor[series] {
				continue
			}
			orphans = append(orphans, k)
		}
	}

	// The objects first, then the manifests that name them: a crash in between
	// leaves objects a still-present superseded manifest lists, which the next
	// listing reclaims anyway — the reverse order would be the one that loses
	// track of anything.
	slices.Sort(orphans)
	if len(orphans) > gcMaxOrphans {
		// Worth an INFO: a backlog this size is a store that has been leaking,
		// and the operator should see it drain rather than wonder why one run
		// did not finish the job. The routine handful stays at DEBUG.
		slog.Info("gc: more unreferenced objects than one run reclaims; draining over subsequent runs",
			"found", len(orphans), "reclaiming", gcMaxOrphans)
		orphans = orphans[:gcMaxOrphans]
	} else if len(orphans) > 0 {
		slog.Debug("gc reclaiming unreferenced objects", "objects", len(orphans))
	}
	if failed, err := store.RmAll(ctx, o.Backend, orphans, rmParallel()); err != nil {
		// Whatever did delete stays deleted; the next run lists again and finds
		// only what is left. The generation half is skipped for this run —
		// nothing may advance the low-water mark on a store that just refused a
		// delete.
		return fmt.Errorf("gc: reclaiming %d of %d unreferenced object(s): %w", len(failed), len(orphans), err)
	}

	// The superseded generations, oldest first. Each is read before it is
	// dropped, for the one thing the listing above cannot cover: a manifest may
	// name an object OUTSIDE the pack grammar — an S32-era manifest still inside
	// the window lists the retired kind-lettered tails, delta segments and
	// summaries (§10.1) — and that is the only chance anything has to reclaim
	// them. Its pack-grammar names need no second pass: a generation at or below
	// the cutoff drew every stem it holds below the floor, so the orphan sweep
	// already covered them.
	swept := c.GCManifest
	from := max(c.GCManifest+1, 1)
	to := min(cutoff, from+gcMaxSweep-1)
	for g := from; g <= to; g++ {
		if present[g] {
			keys, _, err := o.manifestObjectKeys(ctx, g)
			if err != nil {
				slog.Warn("gc: superseded manifest unreadable; its pack objects still reclaim by listing, any legacy names it held do not",
					"generation", g, "error", err)
			}
			var legacy []string
			for _, k := range keys {
				if live[k] {
					continue
				}
				if _, _, isPack := store.ParsePackKey(k); isPack {
					continue
				}
				legacy = append(legacy, k)
			}
			if _, err := store.RmAll(ctx, o.Backend, legacy, rmParallel()); err != nil {
				// A generation only counts as cleared when EVERY name it holds
				// is gone: leave gcm below it so the next run retries exactly
				// this generation.
				c.GCManifest = swept
				return fmt.Errorf("gc generation %d: %w", g, err)
			}
			if err := o.Rm(ctx, manifestKey(g)); err != nil {
				c.GCManifest = swept
				return fmt.Errorf("gc manifest %d: %w", g, err)
			}
		}
		swept = g
	}
	c.GCManifest = swept
	return nil
}

// gcSweepDrain is the sweep for a backend that cannot list: a LOW-WATER drain
// over the superseded generations, for exactly the reason the retired
// GCLatestSwept was one — the sweep is warn-only, so a missed or failed run
// must never permanently strand a name and the next advancing run has to resume
// where the last one stopped. `gcm` advances only over generations actually
// cleared, and per-run work is capped at gcMaxSweep.
//
// Its blind spot is the finding that motivated List: an object no manifest ever
// named — what a cycle that died between writing a pack and publishing its
// manifest leaves behind — is unreachable from here and stays in the store
// forever.
func (o *DB) gcSweepDrain(ctx context.Context, cutoff int, live map[string]bool) error {
	c := &o.core
	from := max(c.GCManifest+1, 1)
	to := min(cutoff, from+gcMaxSweep-1)
	if to < from {
		return nil
	}

	swept := c.GCManifest
	for g := from; g <= to; g++ {
		keys, _, err := o.manifestObjectKeys(ctx, g)
		if err != nil {
			// An unreadable superseded manifest is reclaimed as itself: its
			// objects stay as garbage rather than risking a delete on a guess.
			slog.Warn("gc: superseded manifest unreadable; dropping it without sweeping its objects",
				"generation", g, "error", err)
		}
		dead := make([]string, 0, len(keys))
		for _, k := range keys {
			if !live[k] {
				dead = append(dead, k)
			}
		}
		if _, err := store.RmAll(ctx, o.Backend, dead, rmParallel()); err != nil {
			// Same rule as the list shape: a generation with a surviving name is
			// not cleared, so gcm stays where the last clean run left it.
			c.GCManifest = swept
			return fmt.Errorf("gc generation %d: %w", g, err)
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

// manifestObjectKeys lists every object generation g names, plus that
// generation's per-series stem counters (`names.next`) — the FLOOR
// gcSweepList's orphan rule is stated in. The two ride together because they
// come from one read of one object, and a caller that had the keys but not the
// floor would have to fetch the manifest twice.
func (o *DB) manifestObjectKeys(ctx context.Context, g int) ([]string, map[string]int, error) {
	buf, err := o.readGz(ctx, manifestKey(g))
	if err != nil {
		return nil, nil, err
	}
	return manifestNamesOf(buf)
}

// manifestNamesOf reads a manifest's `names` object LENIENTLY rather than
// through the typed model, because the grace window can still hold S32-era
// manifests written before the cutover — the ones whose name lists carry the
// retired kind-lettered keys. That is precisely how those legacy tails, delta
// segments and summaries reclaim themselves (§10.1): they are named by a
// manifest inside the window, so the sweep reaches them. It is a read-only
// compatibility shim with a bounded life of K generations, not a second naming
// model.
//
// It is a free function so the read-only checkers (`srr inspect --validate`'s
// orphan report) can use the same lenient parse from a keyGetter.
func manifestNamesOf(buf []byte) ([]string, map[string]int, error) {
	var doc struct {
		Names map[string]json.RawMessage `json:"names"`
	}
	if err := json.Unmarshal(buf, &doc); err != nil {
		return nil, nil, err
	}
	var out []string
	next := map[string]int{}
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
			// A manifest that carries no counters (or one this shim cannot read)
			// leaves the floor at zero, which makes every series' orphan rule
			// vacuously false — conservative in exactly the right direction.
			if err := json.Unmarshal(raw, &next); err != nil {
				next = map[string]int{}
			}
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
	return out, next, nil
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
