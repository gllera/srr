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
		{"éclair", "eclair"},    // pre-decomposed combining mark
		{"İstanbul", "istanbul"}, // NFD defuses the JS full-case divergence
		{"STRAẞE", "straße"},     // U+1E9E lowers to ß on both sides
		{"ΓΛΩΣΣΑΣ", "γλωσσασ"},   // Σ lowers context-free…
		{"γλώσσας", "γλωσσασ"},   // …and literal final sigma maps ς→σ
		{"日本語のニュース", "日本語のニュース"},
		{"...a...", "a"},
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
		{"abc", [searchBloomK]uint32{87883, 63844, 39805, 15766}},
		{"ukr", [searchBloomK]uint32{66889, 37986, 9083, 242324}},
		{"日本語", [searchBloomK]uint32{61319, 250428, 177393, 104358}},
		{"niñ", [searchBloomK]uint32{108032, 123835, 139638, 155441}},
		{"42a", [searchBloomK]uint32{230950, 126783, 22616, 180593}},
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

func readSearchEntries(t *testing.T, dir, key string, skipBloom bool) []SearchEntry {
	t.Helper()
	raw := decompressGz(t, filepath.Join(dir, key))
	if skipBloom {
		if len(raw) < searchBloomBytes {
			t.Fatalf("%s: %d bytes, shorter than the bloom header", key, len(raw))
		}
		raw = raw[searchBloomBytes:]
	}
	out, err := parseSearchEntries(raw)
	if err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return out
}

func TestSyncSearchFresh(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Channel{id: 3}
	c.Channels = map[int]*Channel{ch.id: ch}
	c.FetchedAt = 1700000000
	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)

	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	if c.SearchPacks != 0 || c.SearchTail != 2 {
		t.Fatalf("coverage = (%d, %d), want (0, 2)", c.SearchPacks, c.SearchTail)
	}

	entries := readSearchEntries(t, dir, "search/L2.gz", false)
	if len(entries) != 2 {
		t.Fatalf("latest entries = %d, want 2", len(entries))
	}
	want := []SearchEntry{
		{ChannelID: 3, When: 1000, Title: "A1"},
		{ChannelID: 3, When: 2000, Title: "A2"},
	}
	for i, e := range entries {
		if e != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, e, want[i])
		}
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "search/s*.gz"))
	if len(matches) != 0 {
		t.Errorf("no shards finalized, yet summary exists: %v", matches)
	}
}

func TestSyncSearchAtBoundary(t *testing.T) {
	db, dir := setupBoundaryDB(t)
	c := &db.core

	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	if c.SearchPacks != 1 || c.SearchTail != 1 {
		t.Fatalf("coverage = (%d, %d), want (1, 1)", c.SearchPacks, c.SearchTail)
	}

	shard := decompressGz(t, filepath.Join(dir, "search/0.gz"))
	bloom := shard[:searchBloomBytes]
	for _, gram := range []string{"a49", "999"} { // grams of folded "A49999"
		if !bloomHas(bloom, gram) {
			t.Errorf("shard bloom missing gram %q", gram)
		}
	}
	entries := readSearchEntries(t, dir, "search/0.gz", true)
	if len(entries) != idxPackSize {
		t.Fatalf("shard entries = %d, want %d", len(entries), idxPackSize)
	}
	if entries[0].Title != "A0" || entries[idxPackSize-1].Title != fmt.Sprintf("A%d", idxPackSize-1) {
		t.Errorf("shard boundary titles = %q / %q", entries[0].Title, entries[idxPackSize-1].Title)
	}
	// Article 0 has Published 0 → When falls back to FetchedAt.
	if entries[0].When != 1700000000 {
		t.Errorf("entry 0 When = %d, want fetched_at fallback 1700000000", entries[0].When)
	}

	latest := readSearchEntries(t, dir, "search/L2.gz", false)
	if len(latest) != 1 || latest[0].Title != "Last" {
		t.Fatalf("latest = %+v, want the single post-boundary article", latest)
	}

	sum := decompressGz(t, filepath.Join(dir, "search/s1.gz"))
	if !bytes.Equal(sum, bloom) {
		t.Error("summary bytes != search/0.gz bloom header")
	}
}

func TestSyncSearchNoopWhenCurrent(t *testing.T) {
	db, dir := setupBoundaryDB(t)

	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	for _, key := range []string{"search/0.gz", "search/L2.gz", "search/s1.gz"} {
		os.Remove(filepath.Join(dir, key))
	}
	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch (noop): %v", err)
	}
	for _, key := range []string{"search/0.gz", "search/L2.gz", "search/s1.gz"} {
		assertKey(t, dir, key, false)
	}
}

// Steady state: each sync extends the previous generation's tail read-back
// instead of rebuilding it.
func TestSyncSearchIncremental(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Channel{id: 1}
	c.Channels = map[int]*Channel{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch #1: %v", err)
	}
	putOneArticle(t, db, ch, 2)
	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch #2: %v", err)
	}

	if c.SearchTail != 2 {
		t.Fatalf("SearchTail = %d, want 2", c.SearchTail)
	}
	entries := readSearchEntries(t, dir, "search/L2.gz", false)
	if len(entries) != 2 || entries[0].Title != "A1" || entries[1].Title != "A2" {
		t.Fatalf("latest = %+v, want A1+A2", entries)
	}
}

// The common fetch cycle: the missing range is exactly what PutArticles just
// returned, so SyncSearch builds its entries from memory. Removing the packs
// the walk would need proves no read-back happens.
func TestSyncSearchBatchFastPath(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Channel{id: 3}
	c.Channels = map[int]*Channel{ch.id: ch}
	c.FetchedAt = 1700000000

	written, err := db.PutArticles(ctx, []*Item{
		{Channel: ch, Title: "A1", Content: "C", Published: 1000},
		{Channel: ch, Title: "A2", Content: "C"},
	})
	if err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	for _, key := range []string{genKey("idx", 1), genKey("data", 1)} {
		if err := os.Remove(filepath.Join(dir, key)); err != nil {
			t.Fatalf("Remove %s: %v", key, err)
		}
	}

	if err := db.SyncSearch(ctx, written); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	if c.SearchPacks != 0 || c.SearchTail != 2 {
		t.Fatalf("coverage = (%d, %d), want (0, 2)", c.SearchPacks, c.SearchTail)
	}
	entries := readSearchEntries(t, dir, "search/L1.gz", false)
	want := []SearchEntry{
		{ChannelID: 3, When: 1000, Title: "A1"},
		{ChannelID: 3, When: 1700000000, Title: "A2"}, // dateless → fetched_at
	}
	if len(entries) != 2 || entries[0] != want[0] || entries[1] != want[1] {
		t.Fatalf("latest = %+v, want %+v", entries, want)
	}
}

// A missing previous tail (consecutive failed syncs, manual deletion) falls
// back to rebuilding the tail from the data packs.
func TestSyncSearchRebuildsMissingTail(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Channel{id: 1}
	c.Channels = map[int]*Channel{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	putOneArticle(t, db, ch, 3)
	os.Remove(filepath.Join(dir, "search/L2.gz")) // the read-back candidate

	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch (rebuild): %v", err)
	}
	if c.SearchTail != 3 {
		t.Fatalf("SearchTail = %d, want 3", c.SearchTail)
	}
	entries := readSearchEntries(t, dir, "search/L3.gz", false)
	if len(entries) != 3 || entries[2].Title != "A3" {
		t.Fatalf("latest = %+v, want A1..A3", entries)
	}
}

// Inconsistent coverage fields (hand-edited db.gz) reset to a full rebuild
// instead of trusting them.
func TestSyncSearchInconsistentCoverageRebuilds(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Channel{id: 1}
	c.Channels = map[int]*Channel{ch.id: ch}
	c.FetchedAt = 1700000000

	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	c.SearchTail = 7 // covered (7) > total_art (2)

	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	if c.SearchPacks != 0 || c.SearchTail != 2 {
		t.Fatalf("coverage = (%d, %d), want rebuilt (0, 2)", c.SearchPacks, c.SearchTail)
	}
	entries := readSearchEntries(t, dir, "search/L2.gz", false)
	if len(entries) != 2 {
		t.Fatalf("latest entries = %d, want 2", len(entries))
	}
}

func TestGCSearchSummariesGraceWindow(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := os.MkdirAll(filepath.Join(dir, "search"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for g := 1; g <= 5; g++ {
		if err := os.WriteFile(filepath.Join(dir, searchSummaryKey(g)), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	c.SearchPacks = 5

	if err := db.GCSearchSummaries(ctx, 2); err != nil {
		t.Fatalf("GCSearchSummaries: %v", err)
	}
	for g := 1; g <= 2; g++ {
		assertKey(t, dir, searchSummaryKey(g), false)
	}
	for g := 3; g <= 5; g++ {
		assertKey(t, dir, searchSummaryKey(g), true)
	}
}

// GCLatest sweeps the search series' L<g> names alongside idx/data.
func TestGCLatestSweepsSearch(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := os.MkdirAll(filepath.Join(dir, "search"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for g := 1; g <= 5; g++ {
		if err := os.WriteFile(filepath.Join(dir, genKey("search", g)), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	c.Seq = 5

	if err := db.GCLatest(ctx, 2); err != nil {
		t.Fatalf("GCLatest: %v", err)
	}
	for g := 1; g <= 2; g++ {
		assertKey(t, dir, genKey("search", g), false)
	}
	for g := 3; g <= 5; g++ {
		assertKey(t, dir, genKey("search", g), true)
	}
}

// Full inspect --validate sweep over a boundary-crossing store with the
// search series published — the writer-side contract check for search/.
func TestInspectValidateSearch(t *testing.T) {
	db, _ := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
		t.Fatalf("inspect --validate: %v", err)
	}
}

// srch claiming more coverage than the store has finalized packs is an
// integrity issue, not a warning.
func TestInspectValidateSearchOverclaim(t *testing.T) {
	db, _ := setupBoundaryDB(t)

	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncSearch(ctx, nil); err != nil {
		t.Fatalf("SyncSearch: %v", err)
	}
	db.core.SearchPacks = 2
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err == nil {
		t.Fatal("inspect --validate passed with srch > finalized pack count")
	}
}

// srch/srcht are omitempty: absent from db.gz at 0 (readers treat absent as 0).
func TestCommitSearchFieldsOmitemptyWhenZero(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw := string(decompressGz(t, filepath.Join(dir, "db.gz")))
	for _, key := range []string{`"srch"`, `"srcht"`} {
		if strings.Contains(raw, key) {
			t.Errorf("fresh db.gz should omit %s: %s", key, raw)
		}
	}

	c.SearchPacks, c.SearchTail = 2, 7
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw = string(decompressGz(t, filepath.Join(dir, "db.gz")))
	for _, want := range []string{`"srch":2`, `"srcht":7`} {
		if !strings.Contains(raw, want) {
			t.Errorf("db.gz missing %s: %s", want, raw)
		}
	}
}
