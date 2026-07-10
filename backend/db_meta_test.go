package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
// metaPackSize+1 articles written in two batches.
func setupMetaBoundaryDB(t *testing.T) (*DB, string) {
	t.Helper()
	db, c, dir := setupTestDB(t)
	globals.PackSize = 1024 // data packs never split

	ch := &Feed{id: 1, URL: "https://example.com/1"}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	articles := make([]*Item, metaPackSize)
	for i := range articles {
		articles[i] = &Item{Feed: ch, Title: fmt.Sprintf("A%d", i), Content: "c", Published: int64(i)}
	}
	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "Last", Content: "c", Published: int64(metaPackSize)},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	return db, dir
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
	if c.MetaPacks != 0 || c.MetaTail != 2 {
		t.Fatalf("coverage = (%d, %d), want (0, 2)", c.MetaPacks, c.MetaTail)
	}

	entries := readMetaEntries(t, dir, "meta/L2.gz", false)
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
	if c.MetaPacks != 1 || c.MetaTail != 1 {
		t.Fatalf("coverage = (%d, %d), want (1, 1)", c.MetaPacks, c.MetaTail)
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

	latest := readMetaEntries(t, dir, "meta/L2.gz", false)
	if len(latest) != 1 || latest[0].Title != "Last" {
		t.Fatalf("latest = %+v, want the single post-boundary article", latest)
	}

	sum := decompressGz(t, filepath.Join(dir, "meta/s1.gz"))
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
	entries := readMetaEntries(t, dir, "meta/L2.gz", false)
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
	for _, key := range []string{genKey("idx", 1), genKey("data", 1)} {
		if err := os.Remove(filepath.Join(dir, key)); err != nil {
			t.Fatalf("Remove %s: %v", key, err)
		}
	}

	if err := db.SyncMeta(ctx, written); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if c.MetaPacks != 0 || c.MetaTail != 2 {
		t.Fatalf("coverage = (%d, %d), want (0, 2)", c.MetaPacks, c.MetaTail)
	}
	entries := readMetaEntries(t, dir, "meta/L1.gz", false)
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
	os.Remove(filepath.Join(dir, "meta/L2.gz")) // the read-back candidate

	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatalf("SyncMeta (rebuild): %v", err)
	}
	if c.MetaTail != 3 {
		t.Fatalf("MetaTail = %d, want 3", c.MetaTail)
	}
	entries := readMetaEntries(t, dir, "meta/L3.gz", false)
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
	if c.MetaPacks != 1 || c.MetaTail != 1 {
		t.Fatalf("baseline coverage = (%d, %d), want (1, 1)", c.MetaPacks, c.MetaTail)
	}

	// Simulate the post-saveSummary-failure state: the finalized shard and the
	// shifted tail are durable, but coverage never advanced past 0. MetaTail (1)
	// still equals the on-disk tail's entry count, so a count-only trust fires.
	c.MetaPacks = 0

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
	if c.MetaPacks != 0 || c.MetaTail != 2 {
		t.Fatalf("coverage = (%d, %d), want rebuilt (0, 2)", c.MetaPacks, c.MetaTail)
	}
	entries := readMetaEntries(t, dir, "meta/L2.gz", false)
	if len(entries) != 2 {
		t.Fatalf("latest entries = %d, want 2", len(entries))
	}
}

func TestGCMetaSummariesGraceWindow(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := os.MkdirAll(filepath.Join(dir, "meta"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for g := 1; g <= 5; g++ {
		if err := os.WriteFile(filepath.Join(dir, metaSummaryKey(g)), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	c.MetaPacks = 5

	if err := db.GCMetaSummaries(ctx, 2); err != nil {
		t.Fatalf("GCMetaSummaries: %v", err)
	}
	for g := 1; g <= 2; g++ {
		assertKey(t, dir, metaSummaryKey(g), false)
	}
	for g := 3; g <= 5; g++ {
		assertKey(t, dir, metaSummaryKey(g), true)
	}
}

// GCLatest sweeps the meta series' L<g> names alongside idx/data.
func TestGCLatestSweepsMeta(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := os.MkdirAll(filepath.Join(dir, "meta"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for g := 1; g <= 5; g++ {
		if err := os.WriteFile(filepath.Join(dir, genKey("meta", g)), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	c.Seq = 5

	if err := db.GCLatest(ctx, 2); err != nil {
		t.Fatalf("GCLatest: %v", err)
	}
	for g := 1; g <= 2; g++ {
		assertKey(t, dir, genKey("meta", g), false)
	}
	for g := 3; g <= 5; g++ {
		assertKey(t, dir, genKey("meta", g), true)
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
	db.core.MetaPacks = 2
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err == nil {
		t.Fatal("inspect --validate passed with mp > finalized meta shard count")
	}
}

// mp/mt are omitempty: absent from db.gz at 0 (readers treat absent as 0).
func TestCommitMetaFieldsOmitemptyWhenZero(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw := string(decompressGz(t, filepath.Join(dir, "db.gz")))
	for _, key := range []string{`"mp"`, `"mt"`} {
		if strings.Contains(raw, key) {
			t.Errorf("fresh db.gz should omit %s: %s", key, raw)
		}
	}

	c.MetaPacks, c.MetaTail = 2, 7
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw = string(decompressGz(t, filepath.Join(dir, "db.gz")))
	for _, want := range []string{`"mp":2`, `"mt":7`} {
		if !strings.Contains(raw, want) {
			t.Errorf("db.gz missing %s: %s", want, raw)
		}
	}
}
