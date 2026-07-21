package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The delta-segment tail test suite (docs/DELTA-TAIL-SPEC.md). The anchor is
// TestConsolidationEquivalence (§12.1): the delta path followed by a final
// consolidation must publish byte-identical packs to the MaxDeltas=0 kill
// switch (which IS the pre-delta writer — the rest of the package's tests run
// under it via setupTestDB's zero-value globals).

// deltaBatchScript is the shared deterministic batch script: per batch, the
// article count. Sized so the script crosses a data-pack roll many times
// (PackSize=1KB) and one 5k meta stratum (the 60-article batch after the big
// one crosses 5000, exercising the boundary-forced consolidation on the
// delta-driven store).
var deltaBatchScript = []int{3, 1, 5, 2, 40, 7, 2, 4900, 4, 60, 2, 1}

// lcg is a tiny deterministic pseudo-random byte source: article content must
// be incompressible enough to roll data packs, and byte-identical across the
// two driven stores.
type lcg uint32

func (l *lcg) next() uint32 {
	*l = *l*1664525 + 1013904223
	return uint32(*l)
}

func (l *lcg) content(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = chars[l.next()%uint32(len(chars))]
	}
	return string(b)
}

// driveDeltaStore replays deltaBatchScript against a fresh store under the
// given MaxDeltas (the LAST batch always runs with MaxDeltas=0, so a
// delta-driven store ends consolidated and comparable). Returns the store dir,
// the final core, and the highest live-delta count observed (so callers can
// assert the delta path actually ran).
func driveDeltaStore(t *testing.T, maxDeltas int) (string, *DBCore, int) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{
		PackSize:      1,
		Store:         dir,
		Workers:       1,
		MaxFeedSize:   defaultMaxFeedSize,
		CacheDir:      t.TempDir(),
		MaxDeltas:     maxDeltas,
		MaxDeltaBytes: 1 << 20, // keep the byte cap out of the way; the script tests the chain/boundary triggers
	}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	metaTailMemo.reset()
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	t.Cleanup(func() { db.Close(ctx) })

	feeds := make([]*Feed, 3)
	for i := range feeds {
		feeds[i] = &Feed{Title: fmt.Sprintf("feed-%d", i), URL: fmt.Sprintf("https://example.com/%d", i)}
		if err := db.AddFeed(feeds[i]); err != nil {
			t.Fatalf("AddFeed: %v", err)
		}
	}

	rng := lcg(42)
	maxNd := 0
	art := 0
	for bi, n := range deltaBatchScript {
		if bi == len(deltaBatchScript)-1 {
			globals.MaxDeltas = 0 // final consolidation, so both stores end comparable
		}
		db.core.FetchedAt = 1_700_000_000 + int64(bi)*300
		batch := make([]*Item, 0, n)
		for range n {
			// Lang on a deterministic subset: "g"-bearing lines and g-less
			// lines both cross the delta→consolidation seam byte-identically.
			batch = append(batch, &Item{
				Feed:      feeds[art%len(feeds)],
				Title:     fmt.Sprintf("title %d %s", art, rng.content(8)),
				Content:   rng.content(300),
				Link:      fmt.Sprintf("https://example.com/a/%d", art),
				Published: 1_600_000_000 + int64(art)*60,
				Lang:      []string{"", "es", "en"}[art%3],
			})
			art++
		}
		written, err := db.PutArticles(ctx, batch)
		if err != nil {
			t.Fatalf("batch %d: PutArticles: %v", bi, err)
		}
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatalf("batch %d: SyncIdxSummary: %v", bi, err)
		}
		if err := db.SyncMeta(ctx, written); err != nil {
			t.Fatalf("batch %d: SyncMeta: %v", bi, err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("batch %d: Commit: %v", bi, err)
		}
		if db.core.NumDeltas > maxNd {
			maxNd = db.core.NumDeltas
		}
	}
	core := db.core // copy
	return dir, &core, maxNd
}

// storeFingerprint reads the raw bytes of every pack name the final core
// claims: finalized idx/data/meta, the L<tailGen> tails, and the summaries.
func storeFingerprint(t *testing.T, dir string, c *DBCore) map[string][]byte {
	t.Helper()
	names := []string{latestKey(c, "idx"), latestKey(c, "data"), genKey("meta", tailGen(c))}
	for p := range numFinalizedIdx(c.TotalArticles) {
		names = append(names, finalizedIdxKey(p))
	}
	for id := 1; id < c.NextPackID; id++ {
		names = append(names, finalizedDataKey(id))
	}
	for s := range c.MetaPacks {
		names = append(names, finalizedMetaKey(s))
	}
	if c.HdrPacks > 0 {
		names = append(names, summaryKey(c.HdrPacks))
	}
	if c.MetaPacks > 0 {
		names = append(names, metaSummaryKey(c.MetaPacks))
	}
	out := map[string][]byte{}
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("fingerprint %s: %v", name, err)
		}
		out[name] = b
	}
	return out
}

// TestConsolidationEquivalence is the spec's §12.1 anchor: the same batch
// script through the delta path (+ final consolidation) and through the
// MaxDeltas=0 kill switch must publish byte-identical packs, tails, and
// summaries, and equal db.gz cores. This is what structurally catches the
// as-of-chron header rewind class of bug (consolidateTail's cnt vector).
func TestConsolidationEquivalence(t *testing.T) {
	dirA, coreA, maxNd := driveDeltaStore(t, 100)
	if maxNd == 0 {
		t.Fatal("delta-driven store never accumulated a delta — the equivalence test is vacuous")
	}
	dirB, coreB, _ := driveDeltaStore(t, 0)

	jsonA, err := jsonEncode(coreA)
	if err != nil {
		t.Fatal(err)
	}
	jsonB, err := jsonEncode(coreB)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(jsonA, jsonB) {
		t.Errorf("db.gz cores differ:\nA: %s\nB: %s", jsonA, jsonB)
	}

	fpA := storeFingerprint(t, dirA, coreA)
	fpB := storeFingerprint(t, dirB, coreB)
	if len(fpA) != len(fpB) {
		t.Errorf("published name sets differ: %d vs %d", len(fpA), len(fpB))
	}
	for name, a := range fpA {
		b, ok := fpB[name]
		if !ok {
			t.Errorf("%s: published by the delta-driven store only", name)
			continue
		}
		if !bytes.Equal(a, b) {
			t.Errorf("%s: bytes differ (%d vs %d bytes)", name, len(a), len(b))
		}
	}
}

// TestDeltaCycleWritesOnlyDelta pins G1: a delta cycle publishes exactly one
// new pack object (data/d<seq>) and leaves the tail packs byte-untouched,
// while the chain counters, the head projection, and SyncMeta's no-op all
// track it.
func TestDeltaCycleWritesOnlyDelta(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.MaxDeltas = 4
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	// Batch 1: consolidated base (forced), so a real tail exists.
	globals.MaxDeltas = 0
	c.FetchedAt = 1_700_000_000
	w1, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "base 1", Content: "c1", Published: 100},
		{Feed: ch, Title: "base 2", Content: "c2", Published: 200},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SyncMeta(ctx, w1); err != nil {
		t.Fatal(err)
	}
	tailIdx := latestKey(c, "idx")
	tailData := latestKey(c, "data")
	idxBefore, err := os.ReadFile(filepath.Join(dir, tailIdx))
	if err != nil {
		t.Fatal(err)
	}
	dataBefore, err := os.ReadFile(filepath.Join(dir, tailData))
	if err != nil {
		t.Fatal(err)
	}
	mp, mt := c.MetaPacks, c.MetaTail

	// Batch 2: delta cycle.
	globals.MaxDeltas = 4
	c.FetchedAt += 300
	w2, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: "delta 1", Content: "c3", Published: 300}})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SyncMeta(ctx, w2); err != nil {
		t.Fatal(err)
	}

	if c.NumDeltas != 1 || c.DeltaArticles != 1 || c.DeltaBytes == 0 {
		t.Errorf("chain counters: nd=%d na=%d dby=%d, want 1/1/>0", c.NumDeltas, c.DeltaArticles, c.DeltaBytes)
	}
	if got := latestKey(c, "idx"); got != tailIdx {
		t.Errorf("tail generation moved on a delta cycle: %s -> %s", tailIdx, got)
	}
	idxAfter, err := os.ReadFile(filepath.Join(dir, tailIdx))
	if err != nil {
		t.Fatal(err)
	}
	dataAfter, err := os.ReadFile(filepath.Join(dir, tailData))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(idxBefore, idxAfter) || !bytes.Equal(dataBefore, dataAfter) {
		t.Error("a delta cycle rewrote the tail packs")
	}
	raw := decompressGz(t, filepath.Join(dir, deltaKey(c.Seq)))
	entries, err := parseDataPack(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Title != "delta 1" {
		t.Errorf("delta segment holds %v", entries)
	}
	if c.MetaPacks != mp || c.MetaTail != mt {
		t.Errorf("SyncMeta advanced coverage on a delta cycle: mp %d->%d mt %d->%d", mp, c.MetaPacks, mt, c.MetaTail)
	}
	if end := c.HeadBase + len(c.Head); end != c.TotalArticles {
		t.Errorf("head end %d, want %d (extendHead must track delta cycles)", end, c.TotalArticles)
	}
	if c.Head[len(c.Head)-1].Title != "delta 1" {
		t.Errorf("head's newest card is %q", c.Head[len(c.Head)-1].Title)
	}
}

// TestDeltaWalkAndReadMirror pins the pack↔delta seam on the Go read side:
// walkArticles streams across it in order, loadIdxPacks extends the latest
// pack with the chain, and getPackRef resolves delta-region chrons to the
// sentinel.
func TestDeltaWalkAndReadMirror(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	titles := []string{"a0", "a1", "a2", "a3", "a4"}
	globals.MaxDeltas = 0
	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: titles[0], Content: "x", Published: 1},
		{Feed: ch, Title: titles[1], Content: "x", Published: 2},
	}); err != nil {
		t.Fatal(err)
	}
	globals.MaxDeltas = 8
	for i, title := range titles[2:] {
		c.FetchedAt += 300
		if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: title, Content: "x", Published: int64(3 + i)}}); err != nil {
			t.Fatal(err)
		}
	}
	if c.NumDeltas != 3 || tailCovered(c) != 2 {
		t.Fatalf("setup: nd=%d tc=%d, want 3/2", c.NumDeltas, tailCovered(c))
	}

	var got []string
	if err := db.walkArticles(ctx, 0, c.TotalArticles, func(ad *ArticleData) error {
		got = append(got, ad.Title)
		return nil
	}); err != nil {
		t.Fatalf("walkArticles: %v", err)
	}
	if fmt.Sprint(got) != fmt.Sprint(titles) {
		t.Errorf("walkArticles order: %v, want %v", got, titles)
	}

	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, deltas, err := loadIdxPacks(fetch, c)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if len(deltas) != 3 {
		t.Fatalf("loadIdxPacks deltas: %d, want 3", len(deltas))
	}
	latest := packs[len(packs)-1]
	if latest.packSize != c.TotalArticles {
		t.Errorf("extended latest pack holds %d entries, want %d", latest.packSize, c.TotalArticles)
	}
	if pid, off := latest.getPackRef(2); pid != deltaPackID || off != 0 {
		t.Errorf("getPackRef(2) = (%d,%d), want (%d,0)", pid, off, deltaPackID)
	}
	if pid, _ := latest.getPackRef(1); pid == deltaPackID {
		t.Error("getPackRef(1) resolved a consolidated chron to the delta sentinel")
	}
	count, _ := feedIDStats(packs, c.Feeds)
	if count[ch.id] != len(titles) {
		t.Errorf("feedIDStats counts %d entries, want %d (delta entries missing?)", count[ch.id], len(titles))
	}

	// The full validate sweep must hold on a mid-chain store.
	if err := ins.validateAll(fetch, c, packs, deltas); err != nil {
		t.Errorf("validateAll on a mid-chain store: %v", err)
	}
}

// TestDeltaChainSeamMonotonicity pins checkDeltaChain's seam half: the first
// delta must not predate the last consolidated article. The writer keeps this
// by construction (batches append in fetched_at order), so the check exists to
// catch a corrupted/hand-edited store — exactly what ExpireArticles' early-stop
// relies on holding globally across the pack↔delta seam.
func TestDeltaChainSeamMonotonicity(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	// Consolidate two articles into the tail (tc=2), then add a live chain.
	globals.MaxDeltas = 0
	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "a0", Content: "x", Published: 1},
		{Feed: ch, Title: "a1", Content: "x", Published: 2},
	}); err != nil {
		t.Fatal(err)
	}
	globals.MaxDeltas = 8
	for i := range 3 {
		c.FetchedAt += 300
		if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: fmt.Sprintf("d%d", i), Content: "x", Published: int64(3 + i)}}); err != nil {
			t.Fatal(err)
		}
	}
	if tailCovered(c) != 2 || c.NumDeltas != 3 {
		t.Fatalf("setup: tc=%d nd=%d, want 2/3", tailCovered(c), c.NumDeltas)
	}

	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, deltas, err := loadIdxPacks(fetch, c)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}

	// Healthy store: the seam is monotone (last consolidated fetched_at
	// 1_700_000_000 <= first delta 1_700_000_300).
	if got := ins.checkDeltaChain(fetch, c, packs, deltas); got != 0 {
		t.Errorf("healthy mid-chain store: checkDeltaChain reported %d issue(s), want 0", got)
	}

	// Invert the seam: make the first delta predate the last consolidated
	// article. The within-chain order stays monotone (deltas[1:] are still
	// later), so ONLY the seam check should fire.
	deltas[0].FetchedAt = 1
	if got := ins.checkDeltaChain(fetch, c, packs, deltas); got == 0 {
		t.Error("seam inversion (first delta older than the last consolidated article) went unflagged")
	}
}

// TestDeltaBoundaryForcesConsolidation pins invariant I2: a batch that would
// open a new 5k meta stratum consolidates in the same cycle, so no stratum
// ever lies inside the delta region and the reader's numFinalized* formulas
// stay total_art-based.
func TestDeltaBoundaryForcesConsolidation(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.MaxDeltas = 100
	globals.MaxDeltaBytes = 1 << 30
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	mkBatch := func(n int, base int64) []*Item {
		b := make([]*Item, n)
		for i := range b {
			b[i] = &Item{Feed: ch, Title: fmt.Sprintf("t%d", base+int64(i)), Content: "x", Published: base + int64(i)}
		}
		return b
	}

	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, mkBatch(4998, 0)); err != nil {
		t.Fatal(err)
	}
	if c.NumDeltas != 1 {
		t.Fatalf("first batch should be a delta cycle (nd=%d)", c.NumDeltas)
	}
	c.FetchedAt += 300
	w, err := db.PutArticles(ctx, mkBatch(10, 5000))
	if err != nil {
		t.Fatal(err)
	}
	if c.NumDeltas != 0 {
		t.Errorf("stratum-crossing batch did not consolidate (nd=%d)", c.NumDeltas)
	}
	if err := db.SyncMeta(ctx, w); err != nil {
		t.Fatal(err)
	}
	if c.MetaPacks != 1 || c.MetaTail != c.TotalArticles-metaPackSize {
		t.Errorf("meta coverage after boundary consolidation: mp=%d mt=%d total=%d", c.MetaPacks, c.MetaTail, c.TotalArticles)
	}
}

// TestDeltaByteCapForcesConsolidation drives shouldConsolidate's byte-cap
// clause (`--max-delta-bytes`/MaxDeltaBytes) — the one consolidation trigger
// every other delta test deliberately holds out of the way (cap = 1<<20). With
// the chain cap parked at 100 and batches far short of the 5k stratum, the ONLY
// thing that can force a consolidation is the accumulated delta byte total
// crossing the cap: the chain grows delta-by-delta, then the cycle that would
// push it over the cap consolidates instead.
func TestDeltaByteCapForcesConsolidation(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.MaxDeltas = 100   // chain cap far out of the way
	globals.MaxDeltaBytes = 4 // 4 KiB (shouldConsolidate shifts <<10)
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	// ~0.9 KiB of JSONL per single-article cycle, so a handful of deltas
	// accumulate past the 4 KiB cap — and every cycle stays well short of the
	// 5000-article stratum, so no boundary force can steal the consolidation.
	put := func(i int) {
		c.FetchedAt = 1_700_000_000 + int64(i)*300
		body := make([]byte, 880)
		for j := range body {
			body[j] = 'a' + byte((i+j)%26)
		}
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: ch, Title: fmt.Sprintf("t%d", i), Content: string(body), Published: int64(i + 1)},
		}); err != nil {
			t.Fatalf("batch %d: PutArticles: %v", i, err)
		}
	}

	capBytes := int64(globals.MaxDeltaBytes) << 10
	consolidatedAt := -1
	for i := range 50 {
		ndBefore, dbyBefore := c.NumDeltas, c.DeltaBytes
		put(i)
		if ndBefore > 0 && c.NumDeltas == 0 {
			consolidatedAt = i
			// The chain must have been UNDER the cap before this cycle (else a
			// prior cycle would already have consolidated) and this batch is
			// what pushed it over — i.e. the byte cap is what fired.
			if dbyBefore > capBytes {
				t.Errorf("chain sat at %d bytes (> cap %d) without consolidating earlier", dbyBefore, capBytes)
			}
			break
		}
	}
	if consolidatedAt < 2 {
		t.Fatalf("byte cap never forced a consolidation after a real delta chain (consolidatedAt=%d)", consolidatedAt)
	}
	if c.NumDeltas != 0 || c.DeltaArticles != 0 || c.DeltaBytes != 0 {
		t.Errorf("consolidation did not reset the chain: nd=%d na=%d dby=%d", c.NumDeltas, c.DeltaArticles, c.DeltaBytes)
	}
	// The consolidated tail round-trips every article across the pack↔delta seam.
	var got int
	if err := db.walkArticles(ctx, 0, c.TotalArticles, func(_ *ArticleData) error { got++; return nil }); err != nil {
		t.Fatalf("walkArticles after byte-cap consolidation: %v", err)
	}
	if got != c.TotalArticles {
		t.Errorf("walkArticles yielded %d articles, want %d", got, c.TotalArticles)
	}
}

// rewriteGz gzip-compresses raw and writes it to path, replacing the store
// object in place — used to plant a structurally-corrupt pack under a live db.gz.
func rewriteGz(t *testing.T, path string, raw []byte) {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestDeltaCheckTailIntactFatalOnCorruptTail pins the delta-cycle tail
// re-validation (checkTailIntact — the format-review's restored per-cycle
// check). A delta cycle never rewrites the consolidated tail, so a structurally
// corrupt tail idx (a non-atomic backend's partial prior consolidation, or
// store tampering) would otherwise go unseen by the writer for up to maxDeltas
// cycles while every reader is already failing to parse it. checkTailIntact
// re-loads and checks the tail each delta cycle, so real corruption fails the
// fetch loud and NOW — a transient read only warns, a structural mismatch is
// fatal.
func TestDeltaCheckTailIntactFatalOnCorruptTail(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	// Consolidate two articles into a real tail (tc=2, latestIdxEntryCount>0).
	globals.MaxDeltas = 0
	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "a0", Content: "x", Published: 1},
		{Feed: ch, Title: "a1", Content: "x", Published: 2},
	}); err != nil {
		t.Fatal(err)
	}

	// A healthy delta cycle onto the intact tail passes the check.
	globals.MaxDeltas = 8
	c.FetchedAt += 300
	if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: "d0", Content: "x", Published: 3}}); err != nil {
		t.Fatalf("healthy delta cycle rejected by checkTailIntact: %v", err)
	}

	// Corrupt the consolidated tail idx: strip everything after the fixed
	// header so db.gz's entry count no longer fits, then re-gzip in place.
	// checkLatestIdx reports a structural mismatch ("expects at least N bytes").
	tailIdx := latestKey(c, "idx")
	raw := decompressGz(t, filepath.Join(dir, tailIdx))
	rewriteGz(t, filepath.Join(dir, tailIdx), raw[:idxHeaderPrefix])

	// The next delta cycle must fail loudly rather than append onto the broken
	// tail — checkTailIntact runs before emitDelta.
	c.FetchedAt += 300
	_, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: "d1", Content: "x", Published: 4}})
	if err == nil {
		t.Fatal("delta cycle appended onto a corrupt consolidated tail without erroring")
	}
	if !strings.Contains(err.Error(), "consolidated tail idx corrupt") {
		t.Errorf("error = %v, want a checkTailIntact 'consolidated tail idx corrupt' failure", err)
	}
}

// TestGCLatestKeepsLiveChain pins the §8 respec: the GC horizon keys on the
// tail generation and spans the chain, so the current tail, the grace-window
// tail, and the just-consolidated deltas all survive while generations beyond
// the window are swept.
func TestGCLatestKeepsLiveChain(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.MaxDeltas = 2
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	// 12 dirty cycles at MaxDeltas=2: deltas at g=1,2,4,5,7,8,10,11 and
	// consolidations at g=3,6,9,12 (nd cap trips every third cycle).
	for i := range 12 {
		c.FetchedAt = 1_700_000_000 + int64(i)*300
		if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: fmt.Sprintf("t%d", i), Content: "x", Published: int64(i + 1)}}); err != nil {
			t.Fatal(err)
		}
	}
	if c.Seq != 12 || tailGen(c) != 12 || c.NumDeltas != 0 {
		t.Fatalf("setup: seq=%d tailGen=%d nd=%d", c.Seq, tailGen(c), c.NumDeltas)
	}

	if err := db.GCLatest(ctx, latestKeep); err != nil {
		t.Fatalf("GCLatest: %v", err)
	}
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return err == nil
	}
	// cutoff = 12 − 2 − 1 − 2·2 = 5, window 4+2=6 → swept g ∈ [1,5].
	for _, name := range []string{genKey("idx", 12), genKey("data", 12), genKey("idx", 6), deltaKey(10), deltaKey(11), deltaKey(7)} {
		if !exists(name) {
			t.Errorf("%s swept but inside the grace window", name)
		}
	}
	for _, name := range []string{genKey("idx", 3), genKey("data", 3), deltaKey(1), deltaKey(2), deltaKey(4), deltaKey(5)} {
		if exists(name) {
			t.Errorf("%s survived beyond the GC horizon", name)
		}
	}
}

// TestGCLatestLowWaterHealsBigJump pins the GC-stranding fix: GCLatest advances
// a persisted low-water mark (GCLatestSwept) and clears (GCLatestSwept, cutoff],
// so a jump larger than any fixed trailing window — a long-missed sweep (GC is
// warn-only, post-Commit) or a lowered --max-deltas — never permanently strands
// a tail generation. The pre-fix fixed window (gcSweepWindow+MaxDeltas) would
// leave every generation below it orphaned forever once tailGen raced ahead.
func TestGCLatestLowWaterHealsBigJump(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.MaxDeltas = 2
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	// 24 dirty cycles with NO interleaved GCLatest — every sweep "missed", so
	// tailGen races far ahead of the low-water (which starts at 0).
	for i := range 24 {
		c.FetchedAt = 1_700_000_000 + int64(i)*300
		if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: fmt.Sprintf("t%d", i), Content: "x", Published: int64(i + 1)}}); err != nil {
			t.Fatal(err)
		}
	}
	if c.Seq != 24 || tailGen(c) != 24 || c.GCLatestSwept != 0 {
		t.Fatalf("setup: seq=%d tailGen=%d swept=%d", c.Seq, tailGen(c), c.GCLatestSwept)
	}

	if err := db.GCLatest(ctx, latestKeep); err != nil {
		t.Fatalf("GCLatest: %v", err)
	}
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return err == nil
	}
	// cutoff = 24 − 2 − 1 − 2·2 = 17; one low-water run clears all of (0, 17].
	if c.GCLatestSwept != 17 {
		t.Fatalf("GCLatestSwept=%d, want 17", c.GCLatestSwept)
	}
	// The pre-fix fixed window (only g ∈ [12,17]) would have stranded these
	// forever; the low-water sweep reaches all the way back to generation 1.
	for _, name := range []string{genKey("idx", 3), genKey("data", 3), genKey("meta", 3), genKey("idx", 9), deltaKey(1), deltaKey(2), deltaKey(16)} {
		if exists(name) {
			t.Errorf("%s survived — low-water sweep failed to reach back past the old fixed window", name)
		}
	}
	// The grace window (g > cutoff) still survives untouched.
	for _, name := range []string{genKey("idx", 24), genKey("idx", 21), genKey("idx", 18), deltaKey(19), deltaKey(20)} {
		if !exists(name) {
			t.Errorf("%s swept but inside the grace window", name)
		}
	}
	// A second call with nothing advanced is a no-op (from > to), leaving the
	// low-water put.
	if err := db.GCLatest(ctx, latestKeep); err != nil {
		t.Fatalf("GCLatest (second): %v", err)
	}
	if c.GCLatestSwept != 17 {
		t.Fatalf("GCLatestSwept=%d after no-op second call, want 17", c.GCLatestSwept)
	}
}

// TestGCLatestPerRunCap pins the per-run bound: a backlog larger than gcMaxSweep
// drains across runs (advancing the low-water by at most gcMaxSweep each), so a
// single fetch cycle never issues an unbounded burst of store deletes, while
// still never stranding a generation.
func TestGCLatestPerRunCap(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.MaxDeltas = 0 // kill switch: every cycle consolidates, tailGen == Seq
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	// Push tailGen well past a single cap window without any GCLatest.
	for i := range gcMaxSweep + 30 {
		c.FetchedAt = 1_700_000_000 + int64(i)*300
		if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: fmt.Sprintf("t%d", i), Content: "x", Published: int64(i + 1)}}); err != nil {
			t.Fatal(err)
		}
	}
	cutoff := tailGen(c) - latestKeep - 1 // MaxDeltas==0
	if err := db.GCLatest(ctx, latestKeep); err != nil {
		t.Fatalf("GCLatest: %v", err)
	}
	if c.GCLatestSwept != gcMaxSweep {
		t.Fatalf("first run swept to %d, want the cap %d", c.GCLatestSwept, gcMaxSweep)
	}
	if err := db.GCLatest(ctx, latestKeep); err != nil {
		t.Fatalf("GCLatest (second): %v", err)
	}
	if c.GCLatestSwept != cutoff {
		t.Fatalf("second run swept to %d, want cutoff %d", c.GCLatestSwept, cutoff)
	}
}

// TestRemoveFeedDrainsLiveChain pins the id-reuse hazard fix (format-review
// HIGH finding): removing a feed while its articles sit in a live delta chain
// must consolidate the chain FIRST — otherwise a later add reusing the freed
// id makes the dead incarnation's in-chain entries indistinguishable from the
// new feed's during the consolidation replay, permanently corrupting the
// finalized headers it writes. With the drain, reuse is safe by construction:
// the replay after reuse only ever sees the new incarnation's entries.
func TestRemoveFeedDrainsLiveChain(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.MaxDeltas = 8
	globals.MaxDeltaBytes = 1 << 20
	old := &Feed{Title: "old", URL: "https://example.com/old"}
	keeper := &Feed{Title: "keeper", URL: "https://example.com/keep"}
	for _, ch := range []*Feed{old, keeper} {
		if err := db.AddFeed(ch); err != nil {
			t.Fatal(err)
		}
	}

	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: old, Title: "old 1", Content: "x", Published: 1},
		{Feed: keeper, Title: "keep 1", Content: "x", Published: 2},
	}); err != nil {
		t.Fatal(err)
	}
	c.FetchedAt += 300
	if _, err := db.PutArticles(ctx, []*Item{{Feed: old, Title: "old 2", Content: "x", Published: 3}}); err != nil {
		t.Fatal(err)
	}
	if c.NumDeltas != 2 {
		t.Fatalf("setup: nd=%d, want 2", c.NumDeltas)
	}

	if err := db.RemoveFeed(ctx, old.id); err != nil {
		t.Fatalf("RemoveFeed: %v", err)
	}
	if c.NumDeltas != 0 || c.DeltaArticles != 0 {
		t.Fatalf("removal did not drain the chain: nd=%d na=%d", c.NumDeltas, c.DeltaArticles)
	}
	if _, err := os.Stat(filepath.Join(dir, latestKey(c, "idx"))); err != nil {
		t.Fatalf("drain published no tail pack: %v", err)
	}

	// Reuse the freed id — safe now, because no live chain references it.
	reused := &Feed{Title: "reused", URL: "https://example.com/reused"}
	if err := db.AddFeed(reused); err != nil {
		t.Fatal(err)
	}
	if reused.id != old.id {
		t.Fatalf("expected AddFeed to reuse id %d, got %d", old.id, reused.id)
	}
	c.FetchedAt += 300
	if _, err := db.PutArticles(ctx, []*Item{{Feed: reused, Title: "new 1", Content: "x", Published: 4}}); err != nil {
		t.Fatal(err)
	}
	globals.MaxDeltas = 0 // force the post-reuse consolidation replay
	c.FetchedAt += 300
	if _, err := db.PutArticles(ctx, []*Item{{Feed: reused, Title: "new 2", Content: "x", Published: 5}}); err != nil {
		t.Fatal(err)
	}

	// The reuse invariant holds: live idx entries at chron >= AddIdx equal the
	// new incarnation's count — the cross-check `srr inspect --validate` runs.
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, _, err := loadIdxPacks(fetch, c)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	_, live := feedIDStats(packs, c.Feeds)
	if live[reused.id] != reused.TotalArt {
		t.Errorf("live entries for reused id: %d, want %d", live[reused.id], reused.TotalArt)
	}
	var titles []string
	if err := db.walkArticles(ctx, 0, c.TotalArticles, func(ad *ArticleData) error {
		titles = append(titles, ad.Title)
		return nil
	}); err != nil {
		t.Fatalf("walkArticles: %v", err)
	}
	want := []string{"old 1", "keep 1", "old 2", "new 1", "new 2"}
	if fmt.Sprint(titles) != fmt.Sprint(want) {
		t.Errorf("article sequence after drain+reuse: %v, want %v", titles, want)
	}
}

// TestRemoveDormantFeedSkipsDrain pins the membership gate: a feed with NO
// articles in the live delta chain (already consolidated into the packs) is
// removed WITHOUT a consolidation write — the chain (holding only OTHER feeds'
// entries) is left intact — because a reused id can never confuse a replay that
// holds none of the old incarnation's articles. This is what keeps a dormant
// feed removable even when a consolidation would fail, and reuse stays safe.
func TestRemoveDormantFeedSkipsDrain(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.MaxDeltas = 8
	globals.MaxDeltaBytes = 1 << 20
	dormant := &Feed{Title: "dormant", URL: "https://example.com/dormant"}
	active := &Feed{Title: "active", URL: "https://example.com/active"}
	for _, ch := range []*Feed{dormant, active} {
		if err := db.AddFeed(ch); err != nil {
			t.Fatal(err)
		}
	}

	// dormant posts once, then that entry is consolidated into the packs.
	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, []*Item{{Feed: dormant, Title: "dorm 1", Content: "x", Published: 1}}); err != nil {
		t.Fatal(err)
	}
	if err := db.DrainDeltas(ctx); err != nil {
		t.Fatalf("DrainDeltas: %v", err)
	}
	// Now only `active` posts — the live chain holds none of dormant's entries.
	for i := range 2 {
		c.FetchedAt += 300
		if _, err := db.PutArticles(ctx, []*Item{{Feed: active, Title: fmt.Sprintf("act %d", i), Content: "x", Published: int64(i + 2)}}); err != nil {
			t.Fatal(err)
		}
	}
	if c.NumDeltas != 2 {
		t.Fatalf("setup: nd=%d, want 2 (active's two cycles)", c.NumDeltas)
	}

	// Removing dormant must NOT drain the chain (it isn't in it).
	if err := db.RemoveFeed(ctx, dormant.id); err != nil {
		t.Fatalf("RemoveFeed: %v", err)
	}
	if c.NumDeltas != 2 || c.DeltaArticles != 2 {
		t.Fatalf("dormant removal drained the chain: nd=%d na=%d, want 2/2", c.NumDeltas, c.DeltaArticles)
	}
	if _, ok := c.Feeds[dormant.id]; ok {
		t.Fatalf("dormant feed still present after removal")
	}

	// Reuse the freed id while the chain is still live — safe, since the chain
	// holds no old-dormant entries; a later consolidation replay sees only the
	// new incarnation's entries at that id.
	reused := &Feed{Title: "reused", URL: "https://example.com/reused"}
	if err := db.AddFeed(reused); err != nil {
		t.Fatal(err)
	}
	if reused.id != dormant.id {
		t.Fatalf("expected AddFeed to reuse id %d, got %d", dormant.id, reused.id)
	}
	globals.MaxDeltas = 0 // force the post-reuse consolidation replay
	c.FetchedAt += 300
	if _, err := db.PutArticles(ctx, []*Item{{Feed: reused, Title: "reuse 1", Content: "x", Published: 9}}); err != nil {
		t.Fatal(err)
	}
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, _, err := loadIdxPacks(fetch, c)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	_, live := feedIDStats(packs, c.Feeds)
	if live[reused.id] != reused.TotalArt {
		t.Errorf("live entries for reused id: %d, want %d", live[reused.id], reused.TotalArt)
	}
}

// TestSyncMetaCatchUpWithLiveChain pins the warn-only recovery path: a
// consolidation whose SyncMeta never ran is healed by a later delta cycle's
// SyncMeta — coverage lands at tailCovered, the tail publishes under the
// CURRENT tail generation name, and the head projection (already past the
// seam via extendHead) is not regressed.
func TestSyncMetaCatchUpWithLiveChain(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.MaxDeltas = 8
	globals.MaxDeltaBytes = 1 << 20
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}

	globals.MaxDeltas = 0
	c.FetchedAt = 1_700_000_000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "base 1", Content: "x", Published: 1},
		{Feed: ch, Title: "base 2", Content: "x", Published: 2},
	}); err != nil {
		t.Fatal(err)
	}
	// SyncMeta deliberately NOT called — the simulated warn-only failure.

	globals.MaxDeltas = 8
	c.FetchedAt += 300
	w, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: "delta 1", Content: "x", Published: 3}})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SyncMeta(ctx, w); err != nil {
		t.Fatalf("catch-up SyncMeta: %v", err)
	}
	if c.MetaTail != 2 || c.MetaPacks != 0 {
		t.Errorf("coverage: mp=%d mt=%d, want 0/2 (tailCovered)", c.MetaPacks, c.MetaTail)
	}
	if _, err := os.Stat(filepath.Join(dir, genKey("meta", tailGen(c)))); err != nil {
		t.Errorf("meta tail not at the current tail generation: %v", err)
	}
	if end := c.HeadBase + len(c.Head); end != c.TotalArticles {
		t.Errorf("head regressed to %d, want %d", end, c.TotalArticles)
	}
}
