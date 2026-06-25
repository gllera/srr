package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"srrb/store"
)

var ctx = context.Background()

func setupTestDB(t *testing.T) (*DB, *DBCore, string) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{
		PackSize: 1, // 1 KB, small to test pack splitting
		Store:    dir,
	}

	// Skip zopfli recompression of finalized packs: the 50k-boundary tests
	// would pay ~10s per finalized search shard for bytes whose validity
	// gzipBest's own tests already pin. Identity keeps the published bytes
	// exactly what the assertions read back.
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	t.Cleanup(func() {
		db.Close(ctx)
	})

	return db, &db.core, dir
}

func readAllClose(t *testing.T, rc io.ReadCloser) string {
	t.Helper()
	if rc == nil {
		return ""
	}
	defer rc.Close()
	d, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return string(d)
}

func decompressGz(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer reader.Close()

	content, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return content
}

// readAllArticles reads all articles across all idx/ and data/ packs.
func readAllArticles(t *testing.T, dir string, c *DBCore) []*Item {
	t.Helper()

	type idxRef struct {
		feedID     int
		packID     int
		packOffset int
	}

	numFinalized := 0
	if c.TotalArticles > 0 {
		numFinalized = (c.TotalArticles - 1) / idxPackSize
	}

	packID := 0
	packOffset := 0
	var refs []idxRef

	for p := 0; p <= numFinalized; p++ {
		var name string
		if p < numFinalized {
			name = fmt.Sprintf("idx/%d.gz", p)
		} else {
			name = latestKey(c, "idx")
		}
		metaBytes := decompressGz(t, filepath.Join(dir, name))
		// idx pack = header (prefix + numSlots×4 counts) ‖ 2-byte entries ‖
		// u16-LE boundary footer (local indices where the data packId advances).
		numSlots := int(binary.LittleEndian.Uint32(metaBytes[idxStateSize:]))
		headerSize := idxHeaderPrefix + numSlots*4
		entryCount := idxPackSize
		if p == numFinalized {
			entryCount = c.TotalArticles - numFinalized*idxPackSize
		}
		entriesEnd := headerSize + entryCount*idxEntrySize
		boundaries := map[int]bool{}
		for off := entriesEnd; off+idxBoundarySize <= len(metaBytes); off += idxBoundarySize {
			boundaries[int(binary.LittleEndian.Uint16(metaBytes[off:]))] = true
		}
		for i := range entryCount {
			off := headerSize + i*idxEntrySize
			feedID := int(metaBytes[off]) | int(metaBytes[off+1])<<8
			if boundaries[i] {
				packID++
				packOffset = 0
			} else {
				packOffset++
			}
			refs = append(refs, idxRef{feedID, packID, packOffset})
		}
	}

	dataCache := map[int][]ArticleData{}
	var articles []*Item
	for _, ref := range refs {
		if _, ok := dataCache[ref.packID]; !ok {
			var dataBytes []byte
			for _, name := range []string{
				fmt.Sprintf("data/%d.gz", ref.packID),
				latestKey(c, "data"),
			} {
				path := filepath.Join(dir, name)
				if _, err := os.Stat(path); err == nil {
					dataBytes = decompressGz(t, path)
					break
				}
			}
			if dataBytes == nil {
				t.Fatalf("data pack %d not found", ref.packID)
			}
			var ads []ArticleData
			dec := json.NewDecoder(bytes.NewReader(dataBytes))
			for dec.More() {
				var ad ArticleData
				if err := dec.Decode(&ad); err != nil {
					t.Fatalf("decode article: %v", err)
				}
				ads = append(ads, ad)
			}
			dataCache[ref.packID] = ads
		}

		ad := ArticleData{}
		if ads, ok := dataCache[ref.packID]; ok && ref.packOffset < len(ads) {
			ad = ads[ref.packOffset]
		}

		articles = append(articles, &Item{
			Feed:      &Feed{id: ref.feedID},
			Title:     ad.Title,
			Content:   ad.Content,
			Link:      ad.Link,
			Published: ad.Published,
		})
	}
	return articles
}

func TestPutArticlesBasic(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch1 := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch1.id: ch1}

	articles := []*Item{
		{Feed: ch1, Title: "A1", Content: "C1", Link: "http://example.com/1", Published: 1000},
		{Feed: ch1, Title: "A2", Content: "C2", Link: "http://example.com/2", Published: 2000},
	}

	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	result := readAllArticles(t, dir, c)
	if len(result) < 1 {
		t.Fatal("expected at least 1 article in latest pack")
	}
	if result[0].Content != "C1" {
		t.Errorf("Content[0] = %q, want %q", result[0].Content, "C1")
	}
	if result[1].Content != "C2" {
		t.Errorf("Content[1] = %q, want %q", result[1].Content, "C2")
	}
}

// A second batch must STRIP the latest idx pack's non-empty boundary footer
// (keeping header+entries), recover its boundary list, then re-emit it with the
// new batch's boundaries. PackSize=0 rolls a fresh data pack per article, so
// batch 1 leaves a non-empty footer; a bug in the strip math (db_pack.go
// entriesEnd) would corrupt the boundary list and mis-resolve chronIdx -> the
// wrong article, while `make verify` stays green. This is the core mechanism
// the 2-byte-entry + footer format introduced, and was previously covered only
// in isolation (idx_read_test.go) or by single-batch / no-split tests.
func TestPutArticlesCrossBatchFooter(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.PackSize = 0 // each article in its own data pack -> a boundary per entry

	ch1, ch2 := &Feed{id: 1, URL: "http://a"}, &Feed{id: 2, URL: "http://b"}
	c.Feeds = map[int]*Feed{ch1.id: ch1, ch2.id: ch2}

	batch1 := []*Item{
		{Feed: ch1, Title: "A", Content: "cA", Link: "http://a/1", Published: 1000},
		{Feed: ch2, Title: "B", Content: "cB", Link: "http://b/1", Published: 2000},
		{Feed: ch1, Title: "C", Content: "cC", Link: "http://a/2", Published: 3000},
	}
	if _, err := db.PutArticles(ctx, batch1); err != nil {
		t.Fatalf("PutArticles batch1: %v", err)
	}

	// Precondition: batch 1 must leave a NON-EMPTY footer, else the cross-batch
	// strip/re-emit path under test is never exercised.
	raw1, err := db.loadPack(ctx, latestKey(c, "idx"))
	if err != nil {
		t.Fatalf("loadPack idx after batch1: %v", err)
	}
	numSlots := int(binary.LittleEndian.Uint32(raw1[idxStateSize:]))
	entriesEnd := idxHeaderPrefix + numSlots*4 + latestIdxEntryCount(c.TotalArticles)*idxEntrySize
	if n := len(parseIdxFooter(raw1[entriesEnd:])); n == 0 {
		t.Fatalf("batch1 left an empty footer; test would not exercise the strip path")
	}

	batch2 := []*Item{
		{Feed: ch2, Title: "D", Content: "cD", Link: "http://b/2", Published: 4000},
		{Feed: ch1, Title: "E", Content: "cE", Link: "http://a/3", Published: 5000},
	}
	if _, err := db.PutArticles(ctx, batch2); err != nil {
		t.Fatalf("PutArticles batch2: %v", err)
	}

	// The footer-derived bounds must resolve every chronIdx to the right article
	// in order — proving the old footer was stripped and re-emitted, not
	// double-counted or dropped.
	got := readAllArticles(t, dir, c)
	want := []struct {
		feedID  int
		content string
	}{{1, "cA"}, {2, "cB"}, {1, "cC"}, {2, "cD"}, {1, "cE"}}
	if len(got) != len(want) {
		t.Fatalf("readAllArticles len = %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Feed.id != w.feedID || got[i].Content != w.content {
			t.Errorf("article %d = (feed %d, %q), want (feed %d, %q)",
				i, got[i].Feed.id, got[i].Content, w.feedID, w.content)
		}
	}

	// Strongest cross-check: validate footer-derived bounds against the data
	// packs over the committed store (reopens via NewDB).
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
		t.Fatalf("inspect --validate: %v", err)
	}
}

func TestPutArticlesEmpty(t *testing.T) {
	db, c, _ := setupTestDB(t)

	if _, err := db.PutArticles(ctx, nil); err != nil {
		t.Fatalf("PutArticles(nil): %v", err)
	}
	if _, err := db.PutArticles(ctx, []*Item{}); err != nil {
		t.Fatalf("PutArticles([]): %v", err)
	}
	// An empty batch must not publish a new latest-pack generation.
	if c.Seq != 0 {
		t.Errorf("Seq after empty batches = %d, want 0", c.Seq)
	}
}

func TestPutArticlesMultipleFeeds(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch1, ch2 := &Feed{id: 1}, &Feed{id: 2}
	c.Feeds = map[int]*Feed{ch1.id: ch1, ch2.id: ch2}

	articles := []*Item{
		{Feed: ch1, Title: "Sub1-A", Published: 1000},
		{Feed: ch2, Title: "Sub2-A", Published: 2000},
	}

	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	result := readAllArticles(t, dir, c)

	feedIds := map[int]bool{}
	for _, a := range result {
		feedIds[a.Feed.id] = true
	}
	if !feedIds[1] || !feedIds[2] {
		t.Errorf("expected articles from both feeds, got feedIds: %v", feedIds)
	}
}

func TestPutArticlesPackSplitting(t *testing.T) {
	db, c, dir := setupTestDB(t)
	// Very small pack size to force content splitting
	globals.PackSize = 0 // 0 KB -> split after every flush

	ch1 := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch1.id: ch1}

	articles := []*Item{
		{Feed: ch1, Title: "A1", Content: "Content 1", Published: 1000},
		{Feed: ch1, Title: "A2", Content: "Content 2", Published: 2000},
		{Feed: ch1, Title: "A3", Content: "Content 3", Published: 3000},
	}

	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	// With PackSize=0, content packs should split
	if c.NextPackID <= 1 {
		t.Errorf("expected pack splitting, NPacks = %d", c.NextPackID)
	}

	// Verify numbered content pack exists (NPacks starts at 1)
	pack1 := filepath.Join(dir, "data/1.gz")
	if _, err := os.Stat(pack1); os.IsNotExist(err) {
		t.Error("expected data/1.gz to exist")
	}
}

func TestPackMetadata(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.PackSize = 0 // force content split after every article

	ch1, ch2 := &Feed{id: 1}, &Feed{id: 2}
	c.Feeds = map[int]*Feed{ch1.id: ch1, ch2.id: ch2}

	articles := []*Item{
		{Feed: ch1, Title: "A1", Content: "Content 1", Published: 1000},
		{Feed: ch2, Title: "A2", Content: "Content 2", Published: 2000},
		{Feed: ch1, Title: "A3", Content: "Content 3", Published: 3000},
	}

	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if c.TotalArticles != 3 {
		t.Errorf("TotalArticles = %d, want 3", c.TotalArticles)
	}
}

func TestCommitAndReadDB(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, Title: "Test Feed", URL: "http://example.com/feed"},
	}

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("CommitDB: %v", err)
	}

	// Read it back
	data := decompressGz(t, filepath.Join(dir, "db.gz"))

	var core DBCore
	if err := json.Unmarshal(data, &core); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if len(core.Feeds) != 1 {
		t.Fatalf("Subscriptions len = %d, want 1", len(core.Feeds))
	}
	if core.Feeds[1].Title != "Test Feed" {
		t.Errorf("Sub title = %q, want %q", core.Feeds[1].Title, "Test Feed")
	}
}

func TestDBLocalCRUD(t *testing.T) {
	db, _, _ := setupTestDB(t)

	// Put + Get
	if err := db.Put(ctx, "test.txt", strings.NewReader("hello"), false); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rc, err := db.Get(ctx, "test.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "hello" {
		t.Errorf("Get = %q, want %q", got, "hello")
	}

	// Put with ignoreExisting=false should fail (file exists)
	if err := db.Put(ctx, "test.txt", strings.NewReader("world"), false); err == nil {
		t.Error("expected error for duplicate put with ignoreExisting=false")
	}

	// Put with ignoreExisting=true should overwrite
	if err := db.Put(ctx, "test.txt", strings.NewReader("world"), true); err != nil {
		t.Fatalf("Put(overwrite): %v", err)
	}
	rc, _ = db.Get(ctx, "test.txt", false)
	if got := readAllClose(t, rc); got != "world" {
		t.Errorf("Get after overwrite = %q, want %q", got, "world")
	}

	// Get missing file with ignoreMissing=true
	rc, err = db.Get(ctx, "missing.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get(missing, ignore): rc=%v, err=%v", rc, err)
	}

	// Get missing file with ignoreMissing=false
	_, err = db.Get(ctx, "missing.txt", false)
	if err == nil {
		t.Error("expected error for missing file with ignoreMissing=false")
	}

	// Rm
	if err := db.Rm(ctx, "test.txt"); err != nil {
		t.Fatalf("Rm: %v", err)
	}
	rc, _ = db.Get(ctx, "test.txt", true)
	if rc != nil {
		rc.Close()
		t.Error("file still exists after Rm")
	}
}

func TestJSONEncodeRoundTrip(t *testing.T) {
	type item struct {
		Name string `json:"name"`
		HTML string `json:"html"`
	}

	input := item{Name: "test", HTML: "<b>bold</b>"}
	data, err := jsonEncode(input)
	if err != nil {
		t.Fatalf("jsonEncode: %v", err)
	}

	var output item
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if output != input {
		t.Errorf("got %+v, want %+v", output, input)
	}
}

func TestJSONEncodeNoHTMLEscape(t *testing.T) {
	data, err := jsonEncode(map[string]string{"html": "<b>test</b>"})
	if err != nil {
		t.Fatalf("jsonEncode: %v", err)
	}

	s := string(data)
	if strings.Contains(s, `\u003c`) || strings.Contains(s, `\u003e`) {
		t.Errorf("HTML was escaped: %s", s)
	}
}

func TestAtomicPut(t *testing.T) {
	db, _, dir := setupTestDB(t)

	if err := db.AtomicPut(ctx, "state.json", strings.NewReader(`{"ok":true}`), store.ObjectMeta{}); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != `{"ok":true}` {
		t.Errorf("content = %q", data)
	}

	// Temp file should not remain
	if _, err := os.Stat(filepath.Join(dir, "state.json.tmp")); !os.IsNotExist(err) {
		t.Error("temp file still exists after AtomicPut")
	}
}

func TestDBLocking(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	db, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB(locked): %v", err)
	}

	// Lock file should exist
	if _, err := os.Stat(filepath.Join(dir, ".locked")); os.IsNotExist(err) {
		t.Error("lock file not created")
	}

	// Second locked open should fail (file already exists with ignoreExisting=false via Force=false)
	_, err = NewDB(ctx, true)
	if err == nil {
		t.Error("expected error for second locked open")
	}

	db.Close(ctx)

	// Lock file should be removed after close
	if _, err := os.Stat(filepath.Join(dir, ".locked")); !os.IsNotExist(err) {
		t.Error("lock file not removed after close")
	}
}

func TestDBLockingForce(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir, Force: true}

	db1, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB(locked): %v", err)
	}
	defer db1.Close(ctx)

	// With Force=true, second locked open should succeed (overwrites lock)
	db2, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB(locked, force): %v", err)
	}
	db2.Close(ctx)
}

func TestAddRemoveFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)

	s1 := &Feed{Title: "Feed 1", URL: "http://example.com/1"}
	s2 := &Feed{Title: "Feed 2", URL: "http://example.com/2"}
	if err := db.AddFeed(s1); err != nil {
		t.Fatalf("AddSubscription(s1): %v", err)
	}
	if err := db.AddFeed(s2); err != nil {
		t.Fatalf("AddSubscription(s2): %v", err)
	}

	if s1.id != 0 || s2.id != 1 {
		t.Errorf("IDs = (%d, %d), want (0, 1)", s1.id, s2.id)
	}
	if len(db.Feeds()) != 2 {
		t.Fatalf("len(Subscriptions) = %d, want 2", len(db.Feeds()))
	}

	db.RemoveFeed(0)
	if len(db.Feeds()) != 1 {
		t.Fatalf("len(Subscriptions) after remove = %d, want 1", len(db.Feeds()))
	}
	if db.Feeds()[1].id != 1 {
		t.Errorf("remaining sub ID = %d, want 1", db.Feeds()[1].id)
	}

	// Adding after removal should reuse freed ID
	s3 := &Feed{Title: "Feed 3", URL: "http://example.com/3"}
	if err := db.AddFeed(s3); err != nil {
		t.Fatalf("AddSubscription(s3): %v", err)
	}
	if s3.id != 0 {
		t.Errorf("reused ID = %d, want 0", s3.id)
	}
}

func TestRemoveNonExistentFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "Feed", URL: "http://example.com"}); err != nil {
		t.Fatalf("AddSubscription: %v", err)
	}

	// Should not panic or error
	db.RemoveFeed(999)
	if len(db.Feeds()) != 1 {
		t.Errorf("len(Subscriptions) = %d, want 1", len(db.Feeds()))
	}
}

func TestCommitAndReopen(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}

	if err := db.AddFeed(&Feed{Title: "Persist Feed", URL: "http://example.com/feed"}); err != nil {
		t.Fatalf("AddSubscription: %v", err)
	}
	db.core.FetchedAt = 1234567890
	db.core.TotalArticles = 42

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	db.Close(ctx)

	// Reopen and verify
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB reopen: %v", err)
	}
	defer db2.Close(ctx)

	if len(db2.Feeds()) != 1 {
		t.Fatalf("Subscriptions after reopen: %d, want 1", len(db2.Feeds()))
	}
	if db2.Feeds()[0].Title != "Persist Feed" {
		t.Errorf("Title = %q, want %q", db2.Feeds()[0].Title, "Persist Feed")
	}
	if db2.core.FetchedAt != 1234567890 {
		t.Errorf("FetchedAt = %d, want 1234567890", db2.core.FetchedAt)
	}
	if db2.core.TotalArticles != 42 {
		t.Errorf("TotalArticles = %d, want 42", db2.core.TotalArticles)
	}
}

func TestLoadPackCorruptedGzip(t *testing.T) {
	db, _, dir := setupTestDB(t)

	// Write corrupted gzip data
	os.MkdirAll(filepath.Join(dir, "data"), 0755)
	os.WriteFile(filepath.Join(dir, "data/corrupt.gz"), []byte("not gzip data"), 0644)

	_, err := db.loadPack(ctx, "data/corrupt.gz")
	if err == nil {
		t.Error("expected error for corrupted gzip data")
	}
}

func TestPutArticlesRejectsStaleLatestIdx(t *testing.T) {
	db, c, _ := setupTestDB(t)
	ch1 := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch1.id: ch1}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch1, Title: "A1", Published: 1000},
		{Feed: ch1, Title: "A2", Published: 2000},
	}); err != nil {
		t.Fatalf("PutArticles seed: %v", err)
	}

	c.TotalArticles = 5

	_, err := db.PutArticles(ctx, []*Item{{Feed: ch1, Title: "A3", Published: 3000}})
	if err == nil {
		t.Fatal("expected PutArticles to refuse a stale latest idx pack")
	}
	if !strings.Contains(err.Error(), "expects") {
		t.Errorf("error %q should mention the expected size mismatch", err.Error())
	}
}

func TestAddFeedSetsAddIdx(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.TotalArticles = 100

	s := &Feed{Title: "Feed", URL: "http://example.com"}
	if err := db.AddFeed(s); err != nil {
		t.Fatalf("AddSubscription: %v", err)
	}

	if s.AddIdx != 100 {
		t.Errorf("AddIdx = %d, want 100", s.AddIdx)
	}
	if s.id != 0 {
		t.Errorf("ID = %d, want 0", s.id)
	}
}

func TestPutArticlesSeqIncrements(t *testing.T) {
	db, c, _ := setupTestDB(t)
	ch := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch.id: ch}

	if c.Seq != 0 {
		t.Fatalf("fresh store Seq = %d, want 0", c.Seq)
	}

	// First article batch publishes generation 1, the next one generation 2.
	for want := 1; want <= 2; want++ {
		articles := []*Item{
			{Feed: ch, Title: "A", Content: "C", Published: int64(1000 * want)},
		}
		if _, err := db.PutArticles(ctx, articles); err != nil {
			t.Fatalf("PutArticles #%d: %v", want, err)
		}
		if c.Seq != want {
			t.Errorf("Seq after batch %d = %d, want %d", want, c.Seq, want)
		}
	}
}

// putOneArticle runs one article-producing PutArticles batch (one latest-pack
// generation per call).
func putOneArticle(t *testing.T, db *DB, ch *Feed, n int) {
	t.Helper()
	articles := []*Item{
		{Feed: ch, Title: fmt.Sprintf("A%d", n), Content: "C", Published: int64(n * 1000)},
	}
	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles #%d: %v", n, err)
	}
}

// assertKey asserts presence/absence of one store file.
func assertKey(t *testing.T, dir, key string, present bool) {
	t.Helper()
	_, err := os.Stat(filepath.Join(dir, key))
	if present && err != nil {
		t.Errorf("%s missing: %v", key, err)
	}
	if !present && err == nil {
		t.Errorf("%s should have been GC'd", key)
	}
}

// assertGen asserts presence/absence of both series' files for a generation.
func assertGen(t *testing.T, dir string, g int, present bool) {
	t.Helper()
	for _, prefix := range []string{"idx", "data"} {
		assertKey(t, dir, genKey(prefix, g), present)
	}
}

func TestGCLatestGraceWindow(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch.id: ch}

	// Five fetch cycles, each running GC like cmd_fetch does.
	for i := 1; i <= 5; i++ {
		putOneArticle(t, db, ch, i)
		if err := db.GCLatest(ctx, 2); err != nil {
			t.Fatalf("GCLatest #%d: %v", i, err)
		}
	}

	// Seq is 5, keep=2: generations 3..5 stay, 1..2 are gone.
	for g := 1; g <= 2; g++ {
		assertGen(t, dir, g, false)
	}
	for g := 3; g <= 5; g++ {
		assertGen(t, dir, g, true)
	}
}

func TestGCLatestSweepsCrashGaps(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch.id: ch}

	// Five batches with no GC in between (as if every prior run died after
	// Commit): a single sweep must still clear the whole expired backlog.
	for i := 1; i <= 5; i++ {
		putOneArticle(t, db, ch, i)
	}
	if err := db.GCLatest(ctx, 2); err != nil {
		t.Fatalf("GCLatest: %v", err)
	}
	for g := 1; g <= 2; g++ {
		assertGen(t, dir, g, false)
	}
	for g := 3; g <= 5; g++ {
		assertGen(t, dir, g, true)
	}

	// A second sweep on the same state is a no-op (Rm silent-on-missing).
	if err := db.GCLatest(ctx, 2); err != nil {
		t.Fatalf("GCLatest (idempotent): %v", err)
	}
}

func TestGCLatestEmptyStoreNoop(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.GCLatest(ctx, 2); err != nil {
		t.Fatalf("GCLatest on empty store: %v", err)
	}
}

func TestDBOpenCorruptedJSON(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	// Write invalid db.gz
	os.WriteFile(filepath.Join(dir, "db.gz"), []byte("not gzip"), 0644)

	_, err := NewDB(ctx, false)
	if err == nil {
		t.Error("expected error for corrupted db.gz")
	}
}

func TestDBOpenEmptyDir(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	// Fresh DB with no db.gz should work
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)

	if len(db.Feeds()) != 0 {
		t.Errorf("Subscriptions = %d, want 0", len(db.Feeds()))
	}
}

// A db.gz from before the feed→feed merge stored the source URL under a
// feeds[] array, which the current schema ignores — leaving the feed's
// top-level url empty. NewDB must reject that loudly rather than silently
// fetch nothing.
func TestNewDBRejectsUrllessFeed(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	// Legacy shape: feed carries feeds[] but no top-level url.
	legacy := `{"feeds":{"1":{"title":"Old","feeds":[{"url":"http://example.com/feed"}],"total_art":0,"add_idx":0}}}`
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write([]byte(legacy)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	gz.Close()
	if err := os.WriteFile(filepath.Join(dir, "db.gz"), buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write db.gz: %v", err)
	}

	_, err := NewDB(ctx, false)
	if err == nil {
		t.Fatal("expected error for url-less (pre-merge) feed")
	}
	if !strings.Contains(err.Error(), "no url") || !strings.Contains(err.Error(), "feed→feed merge") {
		t.Errorf("error = %v, want the feed→feed migration guard message", err)
	}
}

func TestPutArticlesIdxPackSplitAtBoundary(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1024, Store: dir} // large enough that data doesn't split

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)

	ch := &Feed{id: 1}
	db.core.Feeds = map[int]*Feed{ch.id: ch}
	db.core.FetchedAt = 1700000000

	articles := make([]*Item, idxPackSize)
	for i := range articles {
		articles[i] = &Item{Feed: ch, Title: fmt.Sprintf("A%d", i), Content: "c", Published: int64(i)}
	}
	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if db.core.TotalArticles != idxPackSize {
		t.Fatalf("TotalArticles = %d, want %d", db.core.TotalArticles, idxPackSize)
	}

	if _, err := os.Stat(filepath.Join(dir, "idx/0.gz")); !os.IsNotExist(err) {
		t.Errorf("idx/0.gz should not exist yet at exactly %d articles", idxPackSize)
	}

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A1001", Content: "c", Published: 1001},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if db.core.TotalArticles != idxPackSize+1 {
		t.Fatalf("TotalArticles = %d, want %d", db.core.TotalArticles, idxPackSize+1)
	}

	idxPath := filepath.Join(dir, "idx/0.gz")
	if _, err := os.Stat(idxPath); os.IsNotExist(err) {
		t.Fatal("idx/0.gz should exist after 1001 articles")
	}

	allArticles := readAllArticles(t, dir, &db.core)
	if len(allArticles) != idxPackSize+1 {
		t.Fatalf("total articles = %d, want %d", len(allArticles), idxPackSize+1)
	}
	if allArticles[idxPackSize].Title != "A1001" {
		t.Errorf("latest article title = %q, want %q", allArticles[idxPackSize].Title, "A1001")
	}
}

func TestPutArticlesEmptyTitleAndLink(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch.id: ch}

	articles := []*Item{
		{Feed: ch, Title: "", Content: "body", Link: "", Published: 0},
	}
	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	result := readAllArticles(t, dir, c)
	if len(result) != 1 {
		t.Fatalf("expected 1 article, got %d", len(result))
	}
	if result[0].Title != "" {
		t.Errorf("Title = %q, want empty", result[0].Title)
	}
	if result[0].Link != "" {
		t.Errorf("Link = %q, want empty", result[0].Link)
	}
	if result[0].Published != 0 {
		t.Errorf("Published = %d, want 0", result[0].Published)
	}
	if result[0].Content != "body" {
		t.Errorf("Content = %q, want %q", result[0].Content, "body")
	}
}

// TestCommitSeqGolden pins the db.gz emission contract the frontend
// normalizes against (data.ts `raw.seq ??= 0`): "seq" is present once a
// generation exists, omitted (omitempty) for an empty store, and the
// retired "data_tog" key is never emitted.
func TestCommitSeqGolden(t *testing.T) {
	db, c, dir := setupTestDB(t)

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw := string(decompressGz(t, filepath.Join(dir, "db.gz")))
	if strings.Contains(raw, `"seq"`) {
		t.Errorf("empty-store db.gz should omit %q: %s", "seq", raw)
	}

	c.Seq = 3
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	raw = string(decompressGz(t, filepath.Join(dir, "db.gz")))
	if !strings.Contains(raw, `"seq":3`) {
		t.Errorf("db.gz missing %q: %s", `"seq":3`, raw)
	}
	if strings.Contains(raw, "data_tog") {
		t.Errorf("db.gz still emits retired %q: %s", "data_tog", raw)
	}
}

func TestDBNullFeedsInJSON(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	core := `{"fetched_at":0,"total_art":0,"next_pid":0,"pack_off":0,"feeds":null}` + "\n"
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write([]byte(core))
	gz.Close()
	os.WriteFile(filepath.Join(dir, "db.gz"), buf.Bytes(), 0644)

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)

	for range db.Feeds() {
	}
	if len(db.Feeds()) != 0 {
		t.Errorf("Subscriptions len = %d, want 0", len(db.Feeds()))
	}
}

func TestPutArticlesDataPackSplitResetsPackOffset(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.PackSize = 0 // split after every article

	ch := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	articles := []*Item{
		{Feed: ch, Title: "A1", Content: "Content1", Published: 1000},
		{Feed: ch, Title: "A2", Content: "Content2", Published: 2000},
	}
	if _, err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if c.NextPackID < 2 {
		t.Errorf("NextPackID = %d, want >= 2", c.NextPackID)
	}
	if c.PackOffset != 1 {
		t.Errorf("PackOffset = %d, want 1 (one entry in latest data pack)", c.PackOffset)
	}
}

func TestPutArticlesResumption(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{id: 1}
	c.Feeds = map[int]*Feed{ch.id: ch}
	c.FetchedAt = 1700000000

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A1", Content: "C1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles(1): %v", err)
	}

	savedPO := c.PackOffset
	savedNPID := c.NextPackID
	savedTotal := c.TotalArticles

	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: ch, Title: "A2", Content: "C2", Published: 2000},
	}); err != nil {
		t.Fatalf("PutArticles(2): %v", err)
	}

	if c.TotalArticles != savedTotal+1 {
		t.Errorf("TotalArticles = %d, want %d", c.TotalArticles, savedTotal+1)
	}
	if c.PackOffset != savedPO+1 {
		t.Errorf("PackOffset = %d, want %d (resumed)", c.PackOffset, savedPO+1)
	}
	if c.NextPackID != savedNPID {
		t.Errorf("NextPackID = %d, want %d (no split)", c.NextPackID, savedNPID)
	}

	result := readAllArticles(t, dir, c)
	if len(result) != 2 {
		t.Fatalf("got %d articles, want 2", len(result))
	}
	if result[0].Title != "A1" || result[1].Title != "A2" {
		t.Errorf("articles = [%q, %q], want [A1, A2]", result[0].Title, result[1].Title)
	}
}

func TestDBOpenCorruptedGzipValidInner(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write([]byte("{invalid json"))
	gz.Close()
	os.WriteFile(filepath.Join(dir, "db.gz"), buf.Bytes(), 0644)

	_, err := NewDB(ctx, false)
	if err == nil {
		t.Error("expected error for valid gzip wrapping invalid JSON")
	}
}

func TestReadGzReturnsDecompressedBytes(t *testing.T) {
	db, _, dir := setupTestDB(t)

	// Write a gzip blob via the backend so we exercise the same path
	// readGz uses to read it back.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write([]byte("hello readGz"))
	gz.Close()
	if err := os.WriteFile(filepath.Join(dir, "blob.gz"), buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}

	got, err := db.readGz(ctx, "blob.gz")
	if err != nil {
		t.Fatalf("readGz: %v", err)
	}
	if string(got) != "hello readGz" {
		t.Errorf("readGz = %q, want %q", got, "hello readGz")
	}
}

func TestReadGzMissingErrors(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if _, err := db.readGz(ctx, "missing.gz"); err == nil {
		t.Error("expected error for missing key")
	}
}

func TestReadGzCorruptedReturnsError(t *testing.T) {
	db, _, dir := setupTestDB(t)
	if err := os.WriteFile(filepath.Join(dir, "bad.gz"), []byte("not gzip"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := db.readGz(ctx, "bad.gz"); err == nil {
		t.Error("expected decompress error")
	}
}
