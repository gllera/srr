package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"srr/store"
)

// The stop-anytime crash harness (TST1).
//
// The commit protocol spans five or more ordered store mutations per dirty
// cycle — pack saves, the summaries, the seen sidecar, the GC deletes, the
// manifest, the root flip, the lock release — and docs/MANIFEST-SPEC.md §6.1
// makes ONE claim about all of them:
//
//	every mutation writes only new immutable objects, then one immutable
//	manifest naming them, then flips the root. A crash at any point before the
//	root flip leaves unreferenced objects and changes nothing a reader can
//	observe. A crash after the flip has already succeeded. There is no third
//	case.
//
// That claim used to be checked by hand, once, per release. This harness
// mechanizes it: it counts every mutation a clean scripted run makes, then
// replays the script once per mutation index, halting at that index. After each
// halt it reopens the store, runs the full `srr inspect --validate` sweep, and
// re-runs the remaining script to convergence — asserting that the committed
// state is always a whole number of cycles (batches are all-or-nothing), that
// no chron ever moved (M8), that the next cycle can always take the lock, and
// that convergence lands exactly on the clean run's state.

// errCrashHalt is the mutation refusal stopAfterN returns once its budget is
// spent. Deliberately NOT os.ErrExist: on the publishManifest and lock paths
// that sentinel means something else entirely.
var errCrashHalt = errors.New("simulated halt: process killed mid-cycle")

// stopAfterN wraps a Backend and refuses every mutation past the k-th, standing
// in for a process killed mid-cycle. Refusal happens BEFORE the call reaches the
// real backend, so a halted write leaves no partial object — which is what a
// SIGKILL between two store round-trips looks like.
//
// Reads are always let through: the halt models a dead writer, and the reopen
// that follows it must see everything the writer managed to publish.
type stopAfterN struct {
	store.Backend
	// left is the remaining mutation budget; attempts counts every mutation
	// tried, budget or not, which is how the harness sizes its k loop.
	left     int
	attempts int
}

func (s *stopAfterN) mutate() error {
	s.attempts++
	if s.left <= 0 {
		return errCrashHalt
	}
	s.left--
	return nil
}

func (s *stopAfterN) Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error {
	if err := s.mutate(); err != nil {
		return err
	}
	return s.Backend.Put(ctx, key, r, ignoreExisting)
}

func (s *stopAfterN) AtomicPut(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta) error {
	if err := s.mutate(); err != nil {
		return err
	}
	return s.Backend.AtomicPut(ctx, key, r, meta)
}

func (s *stopAfterN) PutIfVersion(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta, want string) (string, error) {
	if err := s.mutate(); err != nil {
		return "", err
	}
	return s.Backend.PutIfVersion(ctx, key, r, meta, want)
}

func (s *stopAfterN) Rm(ctx context.Context, key string) error {
	if err := s.mutate(); err != nil {
		return err
	}
	return s.Backend.Rm(ctx, key)
}

// The scripted run. Cycles land a day apart with two articles each, against one
// feed whose three-day retention window keeps expiration firing; --max-deltas 2
// makes every third cycle a consolidation and the rest delta cycles.
//
// crashWarmCycles exists for the GC: the sweep only reclaims below m − K, and K
// is floored at the compile-time keepManifests (main.go), so the store has to
// carry more than that many generations before a single Rm happens. The warm-up
// runs once and is snapshotted; the k loop replays only the tail cycles, which
// then cross every write path the crash argument covers — delta emit, tail
// consolidation, summary and meta sync, expiration, the seen sidecar, real GC
// deletes, the manifest publish, the root flip and the lock release.
const (
	crashWarmCycles  = keepManifests + 2
	crashTotalCycles = crashWarmCycles + 6
	crashPerCycle    = 2
	crashExpireDays  = 3
	crashBaseTime    = 1_700_000_000
	crashFeedURL     = "https://example.com/crash"
)

// crashFeed returns the script's feed, adding it on the first cycle of a store
// that has none (a halt before cycle 0 committed loses the subscription too).
func crashFeed(db *DB) (*Feed, error) {
	for _, ch := range db.core.Feeds {
		if ch.URL == crashFeedURL {
			return ch, nil
		}
	}
	ch := &Feed{Title: "crash", URL: crashFeedURL, ExpireDays: crashExpireDays}
	if err := db.AddFeed(ch); err != nil {
		return nil, err
	}
	return ch, nil
}

// crashCycle replays cycle i against the store in globals.Store, taking the
// store-writer lock and opening its own handle exactly as runFetch's withDBCtx
// does, then running the steps in cmd_fetch.go's order with cmd_fetch.go's error
// contract: the four derived steps are warn-only (their failure must never
// discard the durable batch), the seen sidecar and the commit are fatal to the
// cycle.
func crashCycle(ctx context.Context, i int, halt *stopAfterN) error {
	release, err := acquireStoreWriter(ctx)
	if err != nil {
		return err
	}
	defer release()

	db, err := NewDB(ctx, true)
	if err != nil {
		return fmt.Errorf("open store for cycle %d: %w", i, err)
	}
	defer db.Close(ctx)
	// Wrapped AFTER the open, so the halt models a writer dying inside the
	// cycle: the lock release in Close is inside the budget, the reads that
	// reconstruct the state are not.
	if halt != nil {
		halt.Backend = db.Backend
		db.Backend = halt
	}

	db.core.FetchedAt = crashBaseTime + int64(i)*86400
	today := uint16(db.core.FetchedAt / 86400)

	ch, err := crashFeed(db)
	if err != nil {
		return err
	}

	items := make([]*Item, crashPerCycle)
	for j := range items {
		items[j] = &Item{
			Feed: ch,
			// ~300 bytes an article against the 1 KB PackSize below, so the
			// script rolls data packs and exercises the idx boundary footer.
			Title:     fmt.Sprintf("c%d-a%d", i, j),
			Content:   strings.Repeat("x", 300),
			Link:      fmt.Sprintf("%s/%d/%d", crashFeedURL, i, j),
			Published: db.core.FetchedAt + int64(j),
		}
		// One dedup stamp per article, so the seen pool is dirty every cycle and
		// SyncSeen actually publishes an object for the harness to halt inside.
		db.seen.stamp(ch.id, uint32(i*crashPerCycle+j+1), today)
	}

	written, err := db.PutArticles(ctx, items)
	if err != nil {
		return err
	}
	_ = db.SyncIdxSummary(ctx)
	_ = db.SyncMeta(ctx, written)
	_ = db.ExpireArticles(ctx, db.core.FetchedAt)
	if err := db.SyncSeen(ctx); err != nil {
		return err
	}
	_ = db.GC(ctx, globals.KeepManifests)
	return db.Commit(ctx)
}

// crashScript runs cycles [from, to) and returns the index of the first cycle
// that failed (to, when every one committed).
func crashScript(ctx context.Context, from, to int, halt *stopAfterN) (int, error) {
	for i := from; i < to; i++ {
		if err := crashCycle(ctx, i, halt); err != nil {
			return i, err
		}
	}
	return to, nil
}

// crashState is what the harness compares across runs: everything a reader or
// the next writer can observe about the committed store.
type crashState struct {
	total  int
	titles []string
	addIdx int
	xp     int
}

// crashRead reopens the committed store and projects it. A store with no root at
// all (a halt before the very first commit) reports the zero state.
func crashRead(t *testing.T, ctx context.Context) crashState {
	t.Helper()
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer db.Close(ctx)

	st := crashState{total: db.core.TotalArticles}
	for _, ch := range db.core.Feeds {
		if ch.URL == crashFeedURL {
			st.addIdx, st.xp = ch.AddIdx, ch.Expired
		}
	}
	// walkArticles streams the pack region and the live delta chain in one
	// chron-ordered pass, so the projection crosses the seam the way readers do.
	if err := db.walkArticles(ctx, 0, st.total, func(ad *ArticleData) error {
		st.titles = append(st.titles, ad.Title)
		return nil
	}); err != nil {
		t.Fatalf("walk committed articles: %v", err)
	}
	return st
}

// crashValidate runs the full `srr inspect --validate` sweep — bounds-vs-data,
// db-meta, feed-count continuity, the delta chain, M2/M3/M4/M5 on the manifest
// and chron permanence (M8) across the grace window — over whatever the store
// committed. A store that has never published a root has nothing to validate.
func crashValidate(t *testing.T, ctx context.Context, what string) {
	t.Helper()
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("%s: reopen store: %v", what, err)
	}
	m := db.core.ManifestNum
	db.Close(ctx)
	if m == 0 {
		return
	}
	var buf bytes.Buffer
	if err := (&InspectCmd{Chron: -1, Validate: true, out: &buf}).Run(); err != nil {
		t.Fatalf("%s: inspect --validate: %v\n%s", what, err, buf.String())
	}
}

// crashLockProbe asserts the store is still writable: a halt must never leave a
// marker that only a human with --force can clear. This is the assertion the
// SIGKILL wedge (REL3) fails.
func crashLockProbe(t *testing.T, ctx context.Context, k int) {
	t.Helper()
	release, err := acquireStoreWriter(ctx)
	if err != nil {
		t.Fatalf("after a halt at mutation %d: acquire store writer: %v", k, err)
	}
	defer release()
	db, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("after a halt at mutation %d, the store is wedged against the next writer: %v", k, err)
	}
	db.Close(ctx)
}

// crashSetup points globals at a fresh empty store shaped for the script. The
// grace window is the production one (main.go floors --keep-manifests at the
// compile-time contract), so the GC behaves exactly as it does in the field.
func crashSetup(t *testing.T) {
	t.Helper()
	globals = &Globals{
		PackSize:      1, // KB — roll data packs aggressively
		Store:         t.TempDir(),
		Workers:       2,
		MaxFeedSize:   defaultMaxFeedSize,
		CacheDir:      t.TempDir(),
		MaxDeltas:     2,       // every third cycle consolidates
		MaxDeltaBytes: 1 << 20, // KB — never the trigger; --max-deltas is
		KeepManifests: keepManifests,
	}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	t.Cleanup(func() { finalGzip = gzipBest })
	metaTailMemo.reset()
}

// crashSnapshot copies the current store aside; crashRestore stands a fresh copy
// of it up as the store for one halt iteration, so every k starts from the same
// warmed state without replaying the warm-up.
func crashSnapshot(t *testing.T) string {
	t.Helper()
	snap := t.TempDir()
	if err := os.CopyFS(snap, os.DirFS(globals.Store)); err != nil {
		t.Fatalf("snapshot store: %v", err)
	}
	return snap
}

func crashRestore(t *testing.T, snap string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS(snap)); err != nil {
		t.Fatalf("restore store snapshot: %v", err)
	}
	globals.Store = dir
	// A halt is a dead process: the next cycle starts with a cold meta-tail
	// memo, and trusting one the crashed handle populated would hide exactly
	// the read-back path recovery depends on.
	metaTailMemo.reset()
}

func TestCrashHaltAtEveryMutation(t *testing.T) {
	ctx := context.Background()
	crashSetup(t)

	// Warm the store past the GC grace window, then snapshot it: every halt
	// iteration replays only the scripted tail from this state.
	if stopped, err := crashScript(ctx, 0, crashWarmCycles, nil); stopped != crashWarmCycles {
		t.Fatalf("warm-up failed at cycle %d: %v", stopped, err)
	}
	snap := crashSnapshot(t)

	// The clean reference run: the state every halt must converge back to, and
	// the mutation count that sizes the k loop.
	count := &stopAfterN{left: 1 << 30}
	if stopped, err := crashScript(ctx, crashWarmCycles, crashTotalCycles, count); stopped != crashTotalCycles {
		t.Fatalf("the clean reference run failed at cycle %d: %v", stopped, err)
	}
	want := crashRead(t, ctx)
	if want.total != crashTotalCycles*crashPerCycle {
		t.Fatalf("reference run stored %d articles, want %d", want.total, crashTotalCycles*crashPerCycle)
	}
	if want.xp == 0 {
		t.Fatal("reference run expired nothing; the script no longer exercises expiration")
	}
	crashValidate(t, ctx, "reference run")

	total := count.attempts
	if total < crashTotalCycles-crashWarmCycles {
		t.Fatalf("the scripted tail made only %d mutations; the harness would not cover the commit path", total)
	}
	t.Logf("scripted tail makes %d store mutations across %d cycles", total, crashTotalCycles-crashWarmCycles)

	for k := range total {
		t.Run(fmt.Sprintf("halt_after_%d", k), func(t *testing.T) {
			crashRestore(t, snap)
			halt := &stopAfterN{left: k}
			stopped, haltErr := crashScript(ctx, crashWarmCycles, crashTotalCycles, halt)
			if halt.attempts <= k {
				t.Fatalf("budget %d was never spent (%d mutations attempted) — this k halts nothing", k, halt.attempts)
			}
			// stopped == crashTotalCycles is legal: the refused mutation was one
			// of the post-commit warn-only ones (a GC delete, the lock release),
			// which by contract must not fail the cycle. Every assertion below
			// still applies — including the lock probe, which is the only thing
			// that sees a halt in the release.

			// The halt is a crash: everything after it is a fresh process
			// reading only what the store committed.
			metaTailMemo.reset()
			crashValidate(t, ctx, fmt.Sprintf("after halting at mutation %d (%v)", k, haltErr))
			got := crashRead(t, ctx)

			// A batch is all-or-nothing: the committed store must sit on a cycle
			// boundary. A partial batch would mean a reader can observe half of
			// a cycle that never committed.
			if got.total%crashPerCycle != 0 {
				t.Fatalf("committed %d articles — not a whole number of %d-article batches", got.total, crashPerCycle)
			}
			resume := got.total / crashPerCycle
			if resume > stopped {
				t.Fatalf("store holds %d cycles but cycle %d never returned", resume, stopped)
			}
			// M8: no chron was renumbered. Every chron the store still holds
			// must carry exactly the article the clean run put there.
			for i, title := range got.titles {
				if title != want.titles[i] {
					t.Fatalf("chron %d holds %q, want %q — a chron moved across the halt", i, title, want.titles[i])
				}
			}

			// Re-run to convergence, unhalted, exactly as the next cron tick
			// would: the feed re-delivers the batch the crashed cycle lost. The
			// first of these cycles is also what proves the halt left no lock,
			// no half-written object and no unusable name behind.
			if stopped, err := crashScript(ctx, resume, crashTotalCycles, nil); stopped != crashTotalCycles {
				t.Fatalf("recovery run failed at cycle %d: %v", stopped, err)
			}
			crashValidate(t, ctx, fmt.Sprintf("after recovering from a halt at mutation %d", k))
			if got := crashRead(t, ctx); !crashEqual(got, want) {
				t.Fatalf("recovered state %+v, want %+v", got, want)
			}
			// The store must still be WRITABLE. A halt inside Close's lock
			// release leaves `.locked` behind, and the recovery run above only
			// notices when it has a cycle left to run — so probe it explicitly.
			crashLockProbe(t, ctx, k)
		})
	}
}

func crashEqual(a, b crashState) bool {
	return a.total == b.total && a.addIdx == b.addIdx && a.xp == b.xp &&
		strings.Join(a.titles, "\x00") == strings.Join(b.titles, "\x00")
}
