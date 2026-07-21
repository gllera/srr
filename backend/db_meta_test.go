package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"srr/store"
)

// foldSearchText is a writer↔reader contract (mirrored by search.ts fold());
// these vectors pin the Go side, and the e2e contract layer asserts the TS
// side produces identical bytes.
func TestFoldSearchText(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{"Hello, World!", "hello world"},
		{"  --foo__bar  42  ", "foo bar 42"},
		{"don't", "don t"},
		{"Café Éclair", "cafe eclair"},
		{"éclair", "eclair"},     // pre-decomposed combining mark
		{"İstanbul", "istanbul"}, // NFD defuses the JS full-case divergence
		{"STRAẞE", "straße"},     // U+1E9E lowers to ß on both sides
		{"ΓΛΩΣΣΑΣ", "γλωσσασ"},   // Σ lowers context-free…
		{"γλώσσας", "γλωσσασ"},   // …and literal final sigma maps ς→σ
		{"日本語のニュース", "日本語のニュース"},
		{"...a...", "a"},
		{"ﬁle", "ﬁle"},         // NFD (not NFKD) leaves the ﬁ ligature intact
		{"foo😀bar", "foo bar"}, // emoji is neither letter nor number → separator
		{"́abc", "abc"},        // an orphan combining mark (Mn) is stripped
		{"٤٢", "٤٢"},           // Arabic-Indic digits are numbers, kept as a word
	} {
		if got := foldSearchText(tc.in); got != tc.want {
			t.Errorf("foldSearchText(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestEachSearchGram(t *testing.T) {
	var got []string
	eachSearchGram("hello ab cde", func(g string) { got = append(got, g) })
	want := []string{"hel", "ell", "llo", "cde"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("grams = %v, want %v", got, want)
	}

	got = nil
	eachSearchGram("日本語の", func(g string) { got = append(got, g) }) // rune windows, not bytes
	want = []string{"日本語", "本語の"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("grams = %v, want %v", got, want)
	}
}

// Cross-language parity pin: frontend/src/js/search.test.ts asserts its
// bloomBits against these same literals, so a drift on either side of the
// probe math (FNV-1a-64, double hashing, masking) fails one of the suites.
func TestBloomBitsVectors(t *testing.T) {
	for _, tc := range []struct {
		gram string
		want [searchBloomK]uint32
	}{
		{"abc", [searchBloomK]uint32{22347, 31076, 7037, 15766, 24495, 456, 9185}},
		{"ukr", [searchBloomK]uint32{1353, 5218, 9083, 12948, 16813, 20678, 24543}},
		{"日本語", [searchBloomK]uint32{28551, 21052, 13553, 6054, 31323, 23824, 16325}},
		{"niñ", [searchBloomK]uint32{9728, 25531, 8566, 24369, 7404, 23207, 6242}},
		{"42a", [searchBloomK]uint32{1574, 28479, 22616, 16753, 10890, 5027, 31932}},
	} {
		if got := bloomBits(tc.gram); got != tc.want {
			t.Errorf("bloomBits(%q) = %v, want %v", tc.gram, got, tc.want)
		}
	}
}

func TestBloomAddHas(t *testing.T) {
	bloom := make([]byte, searchBloomBytes)
	if bloomHas(bloom, "abc") {
		t.Error("empty bloom claims membership")
	}
	bloomAdd(bloom, "abc")
	if !bloomHas(bloom, "abc") {
		t.Error("added gram not found")
	}
	if bloomHas(bloom, "xyz") {
		t.Error("false positive on a near-empty bloom")
	}
}

func readMetaEntries(t *testing.T, dir, key string, skipBloom bool) []MetaEntry {
	t.Helper()
	raw := decompressGz(t, filepath.Join(dir, key))
	if skipBloom {
		if len(raw) < searchBloomBytes {
			t.Fatalf("%s: %d bytes, shorter than the bloom header", key, len(raw))
		}
		raw = raw[searchBloomBytes:]
	}
	out, err := parseMetaEntries(raw)
	if err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return out
}

// setupMetaBoundaryDB builds a store whose first meta shard just finalized:
// metaPackSize+1 articles written in two batches (setupSplitBoundaryDB in
// db_summary_test.go, at the meta split size).
func setupMetaBoundaryDB(t *testing.T) (*DB, string) {
	t.Helper()
	return setupSplitBoundaryDB(t, metaPackSize)
}

func TestSyncMetaFresh(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 3, URL: "https://example.com/3"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000
	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if c.metaPacks() != 0 || c.MetaTail != 2 {
		t.Fatalf("coverage = (%d, %d), want (0, 2)", c.metaPacks(), c.MetaTail)
	}

	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(entries) != 2 {
		t.Fatalf("latest entries = %d, want 2", len(entries))
	}
	want := []MetaEntry{
		{FeedID: 3, When: 1000, Title: "A1"},
		{FeedID: 3, When: 2000, Title: "A2"},
	}
	for i, e := range entries {
		if e != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, e, want[i])
		}
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "meta/s*.gz"))
	if len(matches) != 0 {
		t.Errorf("no shards finalized, yet summary exists: %v", matches)
	}
}

func TestSyncMetaAtBoundary(t *testing.T) {
	db, dir := setupMetaBoundaryDB(t)
	c := &db.core

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if c.metaPacks() != 1 || c.MetaTail != 1 {
		t.Fatalf("coverage = (%d, %d), want (1, 1)", c.metaPacks(), c.MetaTail)
	}

	shard := decompressGz(t, filepath.Join(dir, "meta/0.gz"))
	bloom := shard[:searchBloomBytes]
	for _, gram := range []string{"a49", "999"} { // grams of folded "A4999"
		if !bloomHas(bloom, gram) {
			t.Errorf("shard bloom missing gram %q", gram)
		}
	}
	entries := readMetaEntries(t, dir, "meta/0.gz", true)
	if len(entries) != metaPackSize {
		t.Fatalf("shard entries = %d, want %d", len(entries), metaPackSize)
	}
	if entries[0].Title != "A0" || entries[metaPackSize-1].Title != fmt.Sprintf("A%d", metaPackSize-1) {
		t.Errorf("shard boundary titles = %q / %q", entries[0].Title, entries[metaPackSize-1].Title)
	}
	// Article 0 has Published 0 → When falls back to FetchedAt.
	if entries[0].When != 1700000000 {
		t.Errorf("entry 0 When = %d, want fetched_at fallback 1700000000", entries[0].When)
	}

	latest := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(latest) != 1 || latest[0].Title != "Last" {
		t.Fatalf("latest = %+v, want the single post-boundary article", latest)
	}

	sum := decompressGz(t, filepath.Join(dir, c.Names.ssumKey()))
	if !bytes.Equal(sum, bloom) {
		t.Error("summary bytes != meta/0.gz bloom header")
	}
}

func TestSyncMetaNoopWhenCurrent(t *testing.T) {
	db, dir := setupMetaBoundaryDB(t)

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	for _, key := range []string{"meta/0.gz", "meta/L2.gz", "meta/s1.gz"} {
		os.Remove(filepath.Join(dir, key))
	}
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta (noop): %v", err)
	}
	for _, key := range []string{"meta/0.gz", "meta/L2.gz", "meta/s1.gz"} {
		assertKey(t, dir, key, false)
	}
}

// Steady state: each sync extends the previous generation's tail read-back
// instead of rebuilding it.
func TestSyncMetaIncremental(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta #1: %v", err)
	}
	putOneArticle(t, db, ch, 2)
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta #2: %v", err)
	}

	if c.MetaTail != 2 {
		t.Fatalf("MetaTail = %d, want 2", c.MetaTail)
	}
	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(entries) != 2 || entries[0].Title != "A1" || entries[1].Title != "A2" {
		t.Fatalf("latest = %+v, want A1+A2", entries)
	}
}

// The common fetch cycle: the missing range is exactly what PutArticles just
// returned, so SyncMeta builds its entries from memory. Removing the packs
// the walk would need proves no read-back happens.
func TestSyncMetaBatchFastPath(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 3, URL: "https://example.com/3"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	written, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A1", Content: "C", Published: 1000},
		{Feed: ch, Title: "A2", Content: "C"},
	})
	if err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	for _, key := range []string{tailK(c, idxSeries), tailK(c, dataSeries)} {
		if err := os.Remove(filepath.Join(dir, key)); err != nil {
			t.Fatalf("Remove %s: %v", key, err)
		}
	}

	if err := db.SyncMeta(ctx, written); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if c.metaPacks() != 0 || c.MetaTail != 2 {
		t.Fatalf("coverage = (%d, %d), want (0, 2)", c.metaPacks(), c.MetaTail)
	}
	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	want := []MetaEntry{
		{FeedID: 3, When: 1000, Title: "A1"},
		{FeedID: 3, When: 1700000000, Title: "A2"}, // dateless → fetched_at
	}
	if len(entries) != 2 || entries[0] != want[0] || entries[1] != want[1] {
		t.Fatalf("latest = %+v, want %+v", entries, want)
	}
}

// A missing previous tail (consecutive failed syncs, manual deletion) falls
// back to rebuilding the tail from the data packs.
func TestSyncMetaRebuildsMissingTail(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	putOneArticle(t, db, ch, 3)
	os.Remove(filepath.Join(dir, tailK(c, metaSeries))) // the read-back candidate
	metaTailMemo.reset()                                // force the GET path — this test covers the missing-tail rebuild

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta (rebuild): %v", err)
	}
	if c.MetaTail != 3 {
		t.Fatalf("MetaTail = %d, want 3", c.MetaTail)
	}
	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(entries) != 3 || entries[2].Title != "A3" {
		t.Fatalf("latest = %+v, want A1..A3", entries)
	}
}

// Inconsistent coverage fields (hand-edited db.gz) reset to a full rebuild
// instead of trusting them.
// TestSyncMetaStaleLowCoverageDoesNotOverwriteFinalizedShard reproduces the
// meta-shard overwrite corruption: a prior cycle finalized meta/0.gz and wrote a
// shifted latest tail but failed (warn-only) before recording coverage, so
// MetaPacks is left stale-low (0) while MetaTail happens to still equal the
// on-disk tail's entry count. A later cycle whose read-back tail length matches
// that stale MetaTail must NOT trust it at chron base MetaPacks*metaPackSize and
// re-finalize the immutable meta/0.gz with a wrong chron range.
func TestSyncMetaStaleLowCoverageDoesNotOverwriteFinalizedShard(t *testing.T) {
	db, dir := setupMetaBoundaryDB(t)
	c := &db.core

	// Correct baseline: meta/0.gz = [A0..A4999], latest tail meta/L2 = [Last].
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta baseline: %v", err)
	}
	if c.metaPacks() != 1 || c.MetaTail != 1 {
		t.Fatalf("baseline coverage = (%d, %d), want (1, 1)", c.metaPacks(), c.MetaTail)
	}

	// Simulate the post-saveSummary-failure state: the finalized shard and the
	// shifted tail are durable, but coverage never advanced past 0. MetaTail (1)
	// still equals the on-disk tail's entry count, so a count-only trust fires.
	c.Names.truncate(metaSeries, 0)

	// A later cycle adds one article; its read-back tail (meta/L2, 1 entry)
	// matches the stale MetaTail.
	ch := c.Feeds[1]
	written, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "New", Content: "c", Published: int64(metaPackSize + 1)},
	})
	if err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.SyncMeta(ctx, written); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}

	// The immutable finalized shard must still hold its original chron range.
	entries := readMetaEntries(t, dir, "meta/0.gz", true)
	if len(entries) != metaPackSize {
		t.Fatalf("shard entries = %d, want %d", len(entries), metaPackSize)
	}
	if entries[0].Title != "A0" || entries[metaPackSize-1].Title != fmt.Sprintf("A%d", metaPackSize-1) {
		t.Fatalf("meta/0.gz overwritten with wrong chron range: [0]=%q [last]=%q, want A0 / A%d",
			entries[0].Title, entries[metaPackSize-1].Title, metaPackSize-1)
	}
}

func TestSyncMetaInconsistentCoverageRebuilds(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	c.MetaTail = 7 // covered (7) > total_art (2)

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if c.metaPacks() != 0 || c.MetaTail != 2 {
		t.Fatalf("coverage = (%d, %d), want rebuilt (0, 2)", c.metaPacks(), c.MetaTail)
	}
	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(entries) != 2 {
		t.Fatalf("latest entries = %d, want 2", len(entries))
	}
}

// metaTPutFailBackend fails every Put/AtomicPut while promoting reads, so a test
// can inject a store-write failure partway through a sync that still needs to
// read packs.
type metaTPutFailBackend struct {
	store.Backend
}

var errMetaTPutFail = errors.New("injected meta put failure")

func (metaTPutFailBackend) Put(context.Context, string, io.Reader, bool) error {
	return errMetaTPutFail
}

// Pack saves route through AtomicPut (the fsync path), so the injection has to
// cover it too or a save failure never reaches the code under test.
func (metaTPutFailBackend) AtomicPut(context.Context, string, io.Reader, store.ObjectMeta) error {
	return errMetaTPutFail
}

// SyncMeta is warn-only, but it must set the mp/mt coverage fields ONLY after
// every save succeeds — a mid-sync save failure must leave coverage untouched so
// the next cycle recomputes the same window. Inject a Put failure at the shard
// finalize of a boundary-crossing store and assert the error surfaces and
// coverage stays 0.
func TestSyncMetaSaveFailureLeavesCoverageUnchanged(t *testing.T) {
	db, _ := setupMetaBoundaryDB(t)
	c := &db.core
	// Reads (the walk) keep working through the promoted backend; the first meta
	// save — finalizing shard 0 at the metaPackSize boundary — fails.
	db.Backend = metaTPutFailBackend{Backend: db.Backend}

	if err := db.SyncMeta(ctx, nil); err == nil {
		t.Fatal("SyncMeta should surface the injected Put failure")
	}
	if c.metaPacks() != 0 || c.MetaTail != 0 {
		t.Fatalf("coverage advanced despite save failure: mp=%d mt=%d, want 0/0", c.metaPacks(), c.MetaTail)
	}
}

// SyncMeta trusts a read-back tail only when its line count matches MetaTail.
// This exercises the count-MISMATCH branch (an existing but wrong-length tail),
// distinct from the missing-tail read-ERROR branch (TestSyncMetaRebuildsMissingTail):
// the mismatched tail is discarded and the tail rebuilt from the data packs.
func TestSyncMetaTailCountMismatchRebuilds(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta #1: %v", err)
	}
	if c.MetaTail != 2 {
		t.Fatalf("MetaTail = %d, want 2", c.MetaTail)
	}

	// A third article lands; the read-back candidate is meta/L2 (Seq is now 3).
	putOneArticle(t, db, ch, 3)

	// Overwrite that tail with a single line so its count (1) disagrees with the
	// stale MetaTail (2), tripping the count-mismatch rebuild.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write([]byte(`{"f":1,"w":1,"t":"stale"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, tailK(c, metaSeries)), buf.Bytes(), 0o644); err != nil {
		t.Fatalf("corrupt tail: %v", err)
	}
	metaTailMemo.reset() // force the GET path — this test covers the count-mismatch rebuild

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta (rebuild): %v", err)
	}
	if c.MetaTail != 3 {
		t.Fatalf("MetaTail = %d, want 3 (rebuilt)", c.MetaTail)
	}
	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(entries) != 3 || entries[0].Title != "A1" || entries[2].Title != "A3" {
		t.Fatalf("latest = %+v, want A1..A3 (tail rebuilt from data packs)", entries)
	}
}

// walkArticles guards against a data pack shorter than the idx promises (the
// "(reading 'f')" crash class): a resolved offset beyond the data pack must be a
// clean error, not an index panic.
func TestWalkArticlesRejectsTruncatedDataPack(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A1", Content: "c1", Published: 1000},
		{Feed: ch, Title: "A2", Content: "c2", Published: 2000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	// Rewrite the latest data pack to hold only 1 entry while idx still promises
	// 2, so chron 1 resolves to an offset past the data pack.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	line, err := jsonEncode(&ArticleData{FeedID: 1, FetchedAt: 1700000000, Published: 1000, Title: "A1", Content: "c1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gz.Write(line); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, tailK(c, dataSeries)), buf.Bytes(), 0o644); err != nil {
		t.Fatalf("corrupt data pack: %v", err)
	}

	err = db.walkArticles(ctx, 0, c.TotalArticles, func(*ArticleData) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "beyond data pack") {
		t.Fatalf("walkArticles err = %v, want the 'beyond data pack' corruption guard", err)
	}
}

// Full inspect --validate sweep over a meta-boundary-crossing store with the
// meta series published — the writer-side contract check for meta/.
func TestInspectValidateMeta(t *testing.T) {
	db, _ := setupMetaBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
		t.Fatalf("inspect --validate: %v", err)
	}
}

// mp claiming more coverage than the store has finalized meta shards is an
// integrity issue, not a warning.
func TestInspectValidateMetaOverclaim(t *testing.T) {
	db, _ := setupMetaBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	db.core.Names.SSum.Covers = 2
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err == nil {
		t.Fatal("inspect --validate passed with mp > finalized meta shard count")
	}
}

// TestSyncMetaTailMemoHit pins the memo fast path: the cycle after a
// successful sync must extend the tail WITHOUT re-reading meta/L<Seq-1> from
// the store. Observable: the on-disk tail is deleted, so a memo miss would
// take the GET path and log the "read-back failed" warn before rebuilding —
// the memo path logs nothing and still produces identical entries.
func TestSyncMetaTailMemoHit(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta #1: %v", err)
	}
	if lines, ok := metaTailMemo.memoized(tailK(c, metaSeries), c.MetaTail); !ok || len(lines) != 2 {
		t.Fatalf("memo after sync = (%d lines, %v), want (2, true)", len(lines), ok)
	}

	putOneArticle(t, db, ch, 3)
	os.Remove(filepath.Join(dir, tailK(c, metaSeries))) // memo must make this GET unnecessary

	var logbuf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logbuf, nil)))
	defer slog.SetDefault(old)

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta #2: %v", err)
	}
	if strings.Contains(logbuf.String(), "read-back") {
		t.Fatalf("memo missed — tail read-back hit the store:\n%s", logbuf.String())
	}
	if c.MetaTail != 3 {
		t.Fatalf("MetaTail = %d, want 3", c.MetaTail)
	}
	entries := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if len(entries) != 3 || entries[0].Title != "A1" || entries[2].Title != "A3" {
		t.Fatalf("latest = %+v, want A1..A3", entries)
	}
}

// TestMetaTailMemoCopyIsolation pins the copy contract: the caller truncates
// and appends to the slice memoized() hands out (the shard-flush path), which
// must never scribble the memo's own backing array; and mismatched seq/count
// or a reset must miss.
func TestMetaTailMemoCopyIsolation(t *testing.T) {
	m := &metaTailCache{}
	m.store("meta/5.gz", [][]byte{[]byte("a\n"), []byte("b\n")})

	got, ok := m.memoized("meta/5.gz", 2)
	if !ok || len(got) != 2 {
		t.Fatalf("memoized(5,2) = (%d, %v), want (2, true)", len(got), ok)
	}
	got = got[:0]
	got = append(got, []byte("scribble\n"), []byte("scribble\n"))
	_ = got

	again, ok := m.memoized("meta/5.gz", 2)
	if !ok || string(again[0]) != "a\n" || string(again[1]) != "b\n" {
		t.Fatalf("memo scribbled by caller mutation: %q", again)
	}

	if _, ok := m.memoized("meta/4.gz", 2); ok {
		t.Fatal("memoized(wrong key) must miss")
	}
	if _, ok := m.memoized("meta/5.gz", 1); ok {
		t.Fatal("memoized(wrong count) must miss")
	}
	m.reset()
	if _, ok := m.memoized("meta/5.gz", 2); ok {
		t.Fatal("memoized after reset must miss")
	}
}

// TestSyncMetaHeadProjection pins the newest-glance head: after every sync,
// db.Head holds the newest min(headMax, MetaTail) cards in chron order —
// Head[i] is the card at chron TotalArticles-len(Head)+i — parsed from the
// very lines the tail pack holds. A shard finalization shrinks the tail, and
// Head with it.
func TestSyncMetaHeadProjection(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	for i := 1; i <= headMax+5; i++ {
		putOneArticle(t, db, ch, i)
	}
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if len(c.Head) != headMax {
		t.Fatalf("len(Head) = %d, want capped at %d", len(c.Head), headMax)
	}
	// Head[i] must be the card at chron HeadBase+i, and the base must be
	// written explicitly (a later warn-only sync failure must not shift it).
	base := c.HeadBase
	if base != c.TotalArticles-len(c.Head) {
		t.Fatalf("HeadBase = %d, want %d", base, c.TotalArticles-len(c.Head))
	}
	for i, e := range c.Head {
		want := fmt.Sprintf("A%d", base+i+1) // A<n> titles are 1-based
		if e.Title != want || e.FeedID != ch.id {
			t.Fatalf("Head[%d] = %+v, want title %q", i, e, want)
		}
	}

	// The head must agree with the published tail's newest lines.
	tail := readMetaEntries(t, dir, tailK(c, metaSeries), false)
	if tail[len(tail)-1] != c.Head[len(c.Head)-1] {
		t.Fatalf("Head newest %+v != tail newest %+v", c.Head[len(c.Head)-1], tail[len(tail)-1])
	}
}

// TestSyncMetaHeadShrinksAtBoundary: right after a shard finalization the
// tail is shorter than headMax and Head mirrors it (readers fall back to
// packs below its base).
func TestSyncMetaHeadShrinksAtBoundary(t *testing.T) {
	db, _ := setupMetaBoundaryDB(t)
	c := &db.core
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if len(c.Head) != 1 || c.Head[0].Title != "Last" {
		t.Fatalf("Head = %+v, want the single post-boundary card", c.Head)
	}
	if c.HeadBase != metaPackSize {
		t.Fatalf("HeadBase = %d, want %d (the tail starts at the finalized boundary)", c.HeadBase, metaPackSize)
	}
}
