package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// compactAssetKey is a valid assets/<2hex>/<16hex><ext> key referenced by an
// early (soon-expired) article, so compaction has an asset to reclaim.
const compactAssetKey = "assets/ab/0123456789abcdef.jpg"

// buildExpiredStore builds a multi-data-pack store (PackSize=1KB, incompressible
// content) with two interleaved feeds — feed0 on even chrons, feed1 on odd —
// ages feed0's first cycle out via a real ExpireArticles pass (so AddIdx/Expired
// and the live-count invariant are exactly what production writes), and leaves
// the baseline committed and --validate clean. feed0's chron-0 content
// references compactAssetKey. Returns the open db and the store dir.
func buildExpiredStore(t *testing.T) (*DB, string) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{
		PackSize:      1, // roll data packs aggressively
		Store:         dir,
		Workers:       2,
		MaxFeedSize:   defaultMaxFeedSize,
		CacheDir:      t.TempDir(),
		MaxDeltas:     0, // consolidate every cycle: everything lands in packs
		MaxDeltaBytes: 1 << 20,
		KeepManifests: keepManifests,
	}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	metaTailMemo.reset()
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	t.Cleanup(func() { db.Close(ctx) })

	feed0 := &Feed{Title: "feed0", URL: "https://example.com/0", ExpireDays: 10}
	feed1 := &Feed{Title: "feed1", URL: "https://example.com/1"} // keep forever
	for _, f := range []*Feed{feed0, feed1} {
		if err := db.AddFeed(f); err != nil {
			t.Fatalf("AddFeed: %v", err)
		}
	}

	rng := lcg(7)
	cycle := func(fetchedAt int64, n int, firstAsset bool) {
		batch := make([]*Item, 0, n)
		for i := range n {
			f := feed0
			if i%2 == 1 {
				f = feed1
			}
			// Incompressible ~4 KB content so the gzip writer flushes and data
			// packs roll (PackSize=1 KB), giving several packs — some straddling
			// the expiry boundary (rewritten) and some entirely live (untouched).
			content := rng.content(4000)
			if firstAsset && i == 0 {
				content = `<img src="` + compactAssetKey + `">` + content
			}
			batch = append(batch, &Item{
				Feed: f, Title: fmt.Sprintf("t%d", len(batch)), Content: content,
				Link: "https://example.com/a", Published: fetchedAt + int64(i),
			})
		}
		putExpireBatch(t, db, fetchedAt, batch)
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatalf("SyncIdxSummary: %v", err)
		}
		if err := db.SyncMeta(ctx, nil); err != nil {
			t.Fatalf("SyncMeta: %v", err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("Commit: %v", err)
		}
	}
	cycle(old20d, 40, true) // chrons 0..39 (feed0 even, expirable); chron 0 refs the asset
	cycle(fresh1d, 20, false)

	// The asset ExpireArticles will delete — present before the pass.
	mustWriteAsset(t, dir, compactAssetKey)
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit after expire: %v", err)
	}
	if feed0.Expired == 0 || feed0.AddIdx == 0 {
		t.Fatalf("nothing expired: AddIdx=%d Expired=%d", feed0.AddIdx, feed0.Expired)
	}
	return db, dir
}

// dataLine returns the verbatim JSONL line and parsed record at chronIdx.
func dataLine(t *testing.T, db *DB, dir string, chron int) (string, ArticleData) {
	t.Helper()
	packs, _, err := loadIdxPacks(func(k string) ([]byte, error) { return db.readGz(ctx, k) }, &db.core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	p := packIdxFor(chron, len(packs))
	pid, off := packs[p].getPackRef(chron)
	raw := decompressGz(t, filepath.Join(dir, posK(&db.core, dataSeries, pid)))
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	arts, err := parseDataPack(raw)
	if err != nil {
		t.Fatalf("parseDataPack: %v", err)
	}
	return lines[off], arts[off]
}

func mustValidate(t *testing.T, wantChronOK bool) string {
	t.Helper()
	var buf bytes.Buffer
	if err := (&InspectCmd{Chron: -1, Validate: true, out: &buf}).Run(); err != nil {
		t.Fatalf("inspect --validate failed:\n%s\nerr: %v", buf.String(), err)
	}
	if wantChronOK && !strings.Contains(buf.String(), "[chron-permanence] chron addresses stable") {
		t.Fatalf("chron-permanence check did not run/pass:\n%s", buf.String())
	}
	return buf.String()
}

func TestCompactTombstonesExpiredAndKeepsChrons(t *testing.T) {
	db, dir := buildExpiredStore(t)
	mustValidate(t, true) // baseline is clean

	// Re-create the asset ExpireArticles deleted, so THIS is the object compaction
	// itself must reclaim (isolating compaction's own delete).
	assetPath := mustWriteAsset(t, dir, compactAssetKey)
	if assetGone(t, assetPath) {
		t.Fatal("asset should exist before compaction")
	}

	c := &db.core
	total, nextPID := c.TotalArticles, c.NextPackID
	f0, f1 := c.Feeds[0], c.Feeds[1]
	f0State := [3]int{f0.TotalArt, f0.AddIdx, f0.Expired}
	f1State := [3]int{f1.TotalArt, f1.AddIdx, f1.Expired}

	preStems := slices.Clone(c.Names.series(dataSeries).Stems)
	_, liveBefore := dataLine(t, db, dir, 1) // chron 1 = feed1, live
	if liveBefore.Content == "" {
		t.Fatal("chron 1 should have content before compaction")
	}

	if err := db.Compact(ctx, false); err != nil {
		t.Fatalf("Compact: %v", err)
	}

	// (1) Nothing that addresses a chron moved.
	if c.TotalArticles != total || c.NextPackID != nextPID {
		t.Fatalf("total_art/next_pid moved: %d/%d -> %d/%d", total, nextPID, c.TotalArticles, c.NextPackID)
	}
	if got := [3]int{c.Feeds[0].TotalArt, c.Feeds[0].AddIdx, c.Feeds[0].Expired}; got != f0State {
		t.Fatalf("feed0 counters moved: %v -> %v", f0State, got)
	}
	if got := [3]int{c.Feeds[1].TotalArt, c.Feeds[1].AddIdx, c.Feeds[1].Expired}; got != f1State {
		t.Fatalf("feed1 counters moved: %v -> %v", f1State, got)
	}

	// (2) The expired chron-0 article is a tombstone: f/a/p kept, no c/t/l/g.
	line0, art0 := dataLine(t, db, dir, 0)
	if art0.FeedID != 0 || art0.FetchedAt != old20d {
		t.Fatalf("tombstone lost f/a: %+v", art0)
	}
	if art0.Content != "" || art0.Title != "" || art0.Link != "" || art0.Lang != "" {
		t.Fatalf("tombstone kept a dropped field: %+v", art0)
	}
	for _, k := range []string{`"c"`, `"t"`, `"l"`, `"g"`} {
		if strings.Contains(line0, k) {
			t.Fatalf("tombstone data line still carries %s: %s", k, line0)
		}
	}
	if !strings.Contains(line0, `"a":`) {
		t.Fatalf("tombstone dropped fetched_at: %s", line0)
	}

	// (3) A live article is byte-preserved.
	_, liveAfter := dataLine(t, db, dir, 1)
	if liveAfter.Content != liveBefore.Content || liveAfter.Title != liveBefore.Title {
		t.Fatalf("live chron 1 changed: %q -> %q", liveBefore.Content, liveAfter.Content)
	}

	// (4) The expired article's asset was reclaimed by compaction.
	if !assetGone(t, assetPath) {
		t.Fatal("compaction did not delete the expired article's asset")
	}

	// (5) Fresh names beside the old: rewritten packs got new stems, some packs
	// were left at their old stem, and the OLD stems are still on disk (grace
	// window — a stale tab can still read them).
	postStems := c.Names.series(dataSeries).Stems
	changed, unchanged := 0, 0
	for i := range preStems {
		if preStems[i] != postStems[i] {
			changed++
			old := filepath.Join(dir, fmt.Sprintf("%s/%d.gz", dataSeries, preStems[i]))
			if assetGone(t, old) {
				t.Fatalf("old data stem %d was deleted immediately; the grace window must keep it", preStems[i])
			}
		} else {
			unchanged++
		}
	}
	if changed == 0 || unchanged == 0 {
		t.Fatalf("expected some data packs rewritten and some left alone (changed=%d unchanged=%d)", changed, unchanged)
	}

	// (6) The whole store is still consistent, including chron-permanence.
	mustValidate(t, true)
}

// TestCompactPreservesLiveDeltaChain compacts a store that still has a live
// delta chain: compaction touches only the consolidated region [0, tailCovered)
// and must leave na, the delta stems, and the seam untouched.
func TestCompactPreservesLiveDeltaChain(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{
		PackSize: 1, Store: dir, Workers: 2, MaxFeedSize: defaultMaxFeedSize,
		CacheDir: t.TempDir(), MaxDeltas: 0, MaxDeltaBytes: 1 << 20, KeepManifests: keepManifests,
	}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	metaTailMemo.reset()
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	t.Cleanup(func() { db.Close(ctx) })

	feed0 := &Feed{Title: "f0", URL: "https://example.com/0", ExpireDays: 10}
	feed1 := &Feed{Title: "f1", URL: "https://example.com/1"}
	for _, f := range []*Feed{feed0, feed1} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	rng := lcg(3)
	put := func(fetchedAt int64, items []*Item) {
		putExpireBatch(t, db, fetchedAt, items)
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatal(err)
		}
		if err := db.SyncMeta(ctx, nil); err != nil {
			t.Fatal(err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	// Consolidated region: 40 interleaved articles (feed0 even, expirable).
	old := make([]*Item, 40)
	for i := range old {
		f := feed0
		if i%2 == 1 {
			f = feed1
		}
		old[i] = &Item{Feed: f, Title: fmt.Sprintf("o%d", i), Content: rng.content(4000), Published: old20d + int64(i)}
	}
	put(old20d, old)

	// Two live delta cycles (feed1 only — feed0's expirable prefix stays wholly
	// consolidated).
	globals.MaxDeltas = 5
	for c := range 2 {
		put(fresh1d+int64(c), []*Item{
			{Feed: feed1, Title: fmt.Sprintf("d%d", c), Content: "recent", Published: fresh1d + int64(c)},
			{Feed: feed1, Title: fmt.Sprintf("d%db", c), Content: "recent", Published: fresh1d + int64(c) + 100},
		})
	}
	if db.core.numDeltas() == 0 {
		t.Fatal("expected a live delta chain")
	}

	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if feed0.Expired == 0 {
		t.Fatal("nothing expired in the consolidated region")
	}
	mustValidate(t, true)

	naBefore := db.core.DeltaArticles
	deltasBefore := slices.Clone(db.core.Names.Deltas.Stems)
	if err := db.Compact(ctx, false); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if db.core.DeltaArticles != naBefore {
		t.Fatalf("na moved: %d -> %d", naBefore, db.core.DeltaArticles)
	}
	if !slices.Equal(db.core.Names.Deltas.Stems, deltasBefore) {
		t.Fatalf("delta stems changed: %v -> %v", deltasBefore, db.core.Names.Deltas.Stems)
	}
	mustValidate(t, true)
}

// TestCompactMetaShardAndSummary crosses a 5,000-entry meta shard so compaction
// exercises the finalized-shard rewrite (bloom rebuilt over survivors) and the
// bloom-summary republish, not just the tail.
func TestCompactMetaShardAndSummary(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{
		PackSize: 64, Store: dir, Workers: 2, MaxFeedSize: defaultMaxFeedSize,
		CacheDir: t.TempDir(), MaxDeltas: 0, MaxDeltaBytes: 1 << 20, KeepManifests: keepManifests,
	}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	metaTailMemo.reset()
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	t.Cleanup(func() { db.Close(ctx) })

	feed := &Feed{Title: "feed", URL: "https://example.com/f", ExpireDays: 10}
	if err := db.AddFeed(feed); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}

	rng := lcg(11)
	mk := func(fetchedAt int64, n int) {
		batch := make([]*Item, n)
		for i := range n {
			batch[i] = &Item{Feed: feed, Title: fmt.Sprintf("shard title %d %s", i, rng.content(6)), Content: rng.content(40), Published: fetchedAt + int64(i)}
		}
		putExpireBatch(t, db, fetchedAt, batch)
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatal(err)
		}
		if err := db.SyncMeta(ctx, nil); err != nil {
			t.Fatal(err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	mk(old20d, 5200) // > metaPackSize: one finalized meta shard + tail; these expire
	mk(fresh1d, 200) // live

	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if db.core.metaPacks() == 0 {
		t.Fatal("test needs at least one finalized meta shard")
	}
	mustValidate(t, true)

	preSSum := db.core.Names.SSum.key()
	if err := db.Compact(ctx, false); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	// The finalized shard's bloom changed (titles dropped), so the summary was
	// republished under a fresh stem.
	if db.core.Names.SSum.key() == preSSum {
		t.Fatalf("bloom summary was not republished after a finalized shard rewrite (%s)", preSSum)
	}
	// checkMeta re-derives every shard's bloom from its surviving titles and
	// checks summary==shard blooms; a clean validate proves the rebuild.
	mustValidate(t, true)
}

// TestCompactDryRun proves --dry-run writes nothing.
func TestCompactDryRun(t *testing.T) {
	db, dir := buildExpiredStore(t)
	before := storeSnapshot(t, dir)
	m := db.core.ManifestNum
	if err := db.Compact(ctx, true); err != nil {
		t.Fatalf("Compact dry-run: %v", err)
	}
	if db.core.ManifestNum != m {
		t.Fatalf("dry-run advanced the manifest %d -> %d", m, db.core.ManifestNum)
	}
	if after := storeSnapshot(t, dir); !slices.Equal(before, after) {
		t.Fatal("dry-run mutated the store")
	}
}

// TestCompactGraceWindowReclaimsOldStems proves the superseded pack objects
// survive within K manifests and are swept once older than the window.
func TestCompactGraceWindowReclaimsOldStems(t *testing.T) {
	db, dir := buildExpiredStore(t)
	globals.KeepManifests = 1 // tiny grace window

	preStems := slices.Clone(db.core.Names.series(dataSeries).Stems)
	if err := db.Compact(ctx, false); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	// A superseded stem: one that changed.
	var oldStem = -1
	post := db.core.Names.series(dataSeries).Stems
	for i := range preStems {
		if preStems[i] != post[i] {
			oldStem = preStems[i]
			break
		}
	}
	if oldStem < 0 {
		t.Fatal("no data pack was rewritten")
	}
	oldKey := filepath.Join(dir, fmt.Sprintf("%s/%d.gz", dataSeries, oldStem))
	if assetGone(t, oldKey) {
		t.Fatal("old stem swept while still inside the grace window")
	}

	// Advance one generation the way production does — GC then Commit, so the
	// sweep's gcm advance rides the same root flip. With K=1 the compaction
	// generation's superseded objects now fall outside the window and are
	// reclaimed; the store stays consistent.
	if err := db.GC(ctx, globals.KeepManifests); err != nil {
		t.Fatalf("GC: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if !assetGone(t, oldKey) {
		t.Fatalf("old stem %d not reclaimed after it left the grace window", oldStem)
	}
	mustValidate(t, true)
}

// TestChronPermanenceDetectsRenumber proves the M8 check has teeth: a prior
// manifest whose total_art EXCEEDS the current one is a renumbering, and the
// check must flag it.
func TestChronPermanenceDetectsRenumber(t *testing.T) {
	db, _ := buildExpiredStore(t)
	c := &db.core
	if c.ManifestNum < 2 {
		t.Skip("need at least two generations")
	}

	// A fetch shim that serves the real store but injects a bogus prior manifest
	// claiming MORE articles than the store now has — i.e. a chron was dropped.
	real := func(k string) ([]byte, error) { return db.readGz(ctx, k) }
	bogusGen := c.ManifestNum - 1
	shim := func(k string) ([]byte, error) {
		if k == manifestKey(bogusGen) {
			var man Manifest
			buf, err := real(k)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(buf, &man); err != nil {
				return nil, err
			}
			man.TotalArticles = c.TotalArticles + 100 // pretend the older gen had MORE
			return jsonEncode(man)
		}
		return real(k)
	}
	insp := &InspectCmd{out: &bytes.Buffer{}}
	if n := insp.checkChronPermanence(shim, c); n == 0 {
		t.Fatalf("chron-permanence did not flag a renumbering:\n%s", insp.out.(*bytes.Buffer).String())
	}
	if !strings.Contains(insp.out.(*bytes.Buffer).String(), "total_art fell") {
		t.Fatalf("wrong diagnosis:\n%s", insp.out.(*bytes.Buffer).String())
	}
}

// storeSnapshot lists every object path under dir with its size, sorted — a
// cheap "did anything change" fingerprint for the dry-run test.
func storeSnapshot(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			out = append(out, fmt.Sprintf("%s:%d", p, info.Size()))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(out)
	return out
}
