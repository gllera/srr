package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var ctx = context.Background()

func setupTestDB(t *testing.T) (*DB, *DBCore, string) {
	t.Helper()
	dir := t.TempDir()
	globals = &Globals{
		PackSize: 1, // 1 KB, small to test pack splitting
		Store:    dir,
	}

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
		subID      int
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
			name = fmt.Sprintf("idx/%v.gz", c.DataToggle)
		}
		metaBytes := decompressGz(t, filepath.Join(dir, name))
		for off := 0; off+2 <= len(metaBytes); off += 2 {
			if metaBytes[off+1]>>7 != 0 {
				packID++
				packOffset = 0
			} else {
				packOffset++
			}
			refs = append(refs, idxRef{int(metaBytes[off]), packID, packOffset})
		}
	}

	dataCache := map[int][]ArticleData{}
	var articles []*Item
	for _, ref := range refs {
		if _, ok := dataCache[ref.packID]; !ok {
			var dataBytes []byte
			for _, name := range []string{
				fmt.Sprintf("data/%d.gz", ref.packID),
				fmt.Sprintf("data/%v.gz", c.DataToggle),
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
			dscanner := bufio.NewScanner(bytes.NewReader(dataBytes))
			for dscanner.Scan() {
				line := dscanner.Bytes()
				if len(line) == 0 {
					continue
				}
				var ad ArticleData
				if err := json.Unmarshal(line, &ad); err != nil {
					t.Fatalf("unmarshal article: %v", err)
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
			Sub:       &Subscription{id: ref.subID},
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
	sub1 := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub1.id: sub1}

	articles := []*Item{
		{Sub: sub1, Title: "A1", Content: "C1", Link: "http://example.com/1", Published: 1000},
		{Sub: sub1, Title: "A2", Content: "C2", Link: "http://example.com/2", Published: 2000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
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

func TestPutArticlesEmpty(t *testing.T) {
	db, _, _ := setupTestDB(t)

	if err := db.PutArticles(ctx, nil); err != nil {
		t.Fatalf("PutArticles(nil): %v", err)
	}
	if err := db.PutArticles(ctx, []*Item{}); err != nil {
		t.Fatalf("PutArticles([]): %v", err)
	}
}

func TestPutArticlesMultipleSubs(t *testing.T) {
	db, c, dir := setupTestDB(t)
	sub1, sub2 := &Subscription{id: 1}, &Subscription{id: 2}
	c.Subscriptions = map[int]*Subscription{sub1.id: sub1, sub2.id: sub2}

	articles := []*Item{
		{Sub: sub1, Title: "Sub1-A", Published: 1000},
		{Sub: sub2, Title: "Sub2-A", Published: 2000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	result := readAllArticles(t, dir, c)

	subIds := map[int]bool{}
	for _, a := range result {
		subIds[a.Sub.id] = true
	}
	if !subIds[1] || !subIds[2] {
		t.Errorf("expected articles from both subs, got subIds: %v", subIds)
	}
}

func TestPutArticlesPackSplitting(t *testing.T) {
	db, c, dir := setupTestDB(t)
	// Very small pack size to force content splitting
	globals.PackSize = 0 // 0 KB -> split after every flush

	sub1 := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub1.id: sub1}

	articles := []*Item{
		{Sub: sub1, Title: "A1", Content: "Content 1", Published: 1000},
		{Sub: sub1, Title: "A2", Content: "Content 2", Published: 2000},
		{Sub: sub1, Title: "A3", Content: "Content 3", Published: 3000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
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

	sub1, sub2 := &Subscription{id: 1}, &Subscription{id: 2}
	c.Subscriptions = map[int]*Subscription{sub1.id: sub1, sub2.id: sub2}

	articles := []*Item{
		{Sub: sub1, Title: "A1", Content: "Content 1", Published: 1000},
		{Sub: sub2, Title: "A2", Content: "Content 2", Published: 2000},
		{Sub: sub1, Title: "A3", Content: "Content 3", Published: 3000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if c.TotalArticles != 3 {
		t.Errorf("TotalArticles = %d, want 3", c.TotalArticles)
	}
}

func TestCommitAndReadDB(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.Subscriptions = map[int]*Subscription{
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

	if len(core.Subscriptions) != 1 {
		t.Fatalf("Subscriptions len = %d, want 1", len(core.Subscriptions))
	}
	if core.Subscriptions[1].Title != "Test Feed" {
		t.Errorf("Sub title = %q, want %q", core.Subscriptions[1].Title, "Test Feed")
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

	if err := db.AtomicPut(ctx, "state.json", strings.NewReader(`{"ok":true}`)); err != nil {
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

func TestAddRemoveSubscription(t *testing.T) {
	db, _, _ := setupTestDB(t)

	s1 := &Subscription{Title: "Feed 1", URL: "http://example.com/1"}
	s2 := &Subscription{Title: "Feed 2", URL: "http://example.com/2"}
	if err := db.AddSubscription(s1); err != nil {
		t.Fatalf("AddSubscription(s1): %v", err)
	}
	if err := db.AddSubscription(s2); err != nil {
		t.Fatalf("AddSubscription(s2): %v", err)
	}

	if s1.id != 0 || s2.id != 1 {
		t.Errorf("IDs = (%d, %d), want (0, 1)", s1.id, s2.id)
	}
	if len(db.Subscriptions()) != 2 {
		t.Fatalf("len(Subscriptions) = %d, want 2", len(db.Subscriptions()))
	}

	db.RemoveSubscription(0)
	if len(db.Subscriptions()) != 1 {
		t.Fatalf("len(Subscriptions) after remove = %d, want 1", len(db.Subscriptions()))
	}
	if db.Subscriptions()[1].id != 1 {
		t.Errorf("remaining sub ID = %d, want 1", db.Subscriptions()[1].id)
	}

	// Adding after removal should reuse freed ID
	s3 := &Subscription{Title: "Feed 3", URL: "http://example.com/3"}
	if err := db.AddSubscription(s3); err != nil {
		t.Fatalf("AddSubscription(s3): %v", err)
	}
	if s3.id != 0 {
		t.Errorf("reused ID = %d, want 0", s3.id)
	}
}

func TestRemoveNonExistentSubscription(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.AddSubscription(&Subscription{Title: "Feed", URL: "http://example.com"}); err != nil {
		t.Fatalf("AddSubscription: %v", err)
	}

	// Should not panic or error
	db.RemoveSubscription(999)
	if len(db.Subscriptions()) != 1 {
		t.Errorf("len(Subscriptions) = %d, want 1", len(db.Subscriptions()))
	}
}

func TestCommitAndReopen(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}

	if err := db.AddSubscription(&Subscription{Title: "Persist Feed", URL: "http://example.com/feed"}); err != nil {
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

	if len(db2.Subscriptions()) != 1 {
		t.Fatalf("Subscriptions after reopen: %d, want 1", len(db2.Subscriptions()))
	}
	if db2.Subscriptions()[0].Title != "Persist Feed" {
		t.Errorf("Title = %q, want %q", db2.Subscriptions()[0].Title, "Persist Feed")
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

func TestAddSubscriptionSetsAddIdx(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.TotalArticles = 100

	s := &Subscription{Title: "Feed", URL: "http://example.com"}
	if err := db.AddSubscription(s); err != nil {
		t.Fatalf("AddSubscription: %v", err)
	}

	if s.AddIdx != 100 {
		t.Errorf("AddIdx = %d, want 100", s.AddIdx)
	}
	if s.id != 0 {
		t.Errorf("ID = %d, want 0", s.id)
	}
}

func TestPutArticlesToggle(t *testing.T) {
	db, c, _ := setupTestDB(t)
	sub := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub.id: sub}

	initialToggle := c.DataToggle
	articles := []*Item{
		{Sub: sub, Title: "A1", Content: "C1", Published: 1000},
	}
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if c.DataToggle != !initialToggle {
		t.Errorf("DataToggle should have toggled from %v to %v", initialToggle, !initialToggle)
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

	if len(db.Subscriptions()) != 0 {
		t.Errorf("Subscriptions = %d, want 0", len(db.Subscriptions()))
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

	sub := &Subscription{id: 1}
	db.core.Subscriptions = map[int]*Subscription{sub.id: sub}
	db.core.FetchedAt = 1700000000

	articles := make([]*Item, idxPackSize)
	for i := range articles {
		articles[i] = &Item{Sub: sub, Title: fmt.Sprintf("A%d", i), Content: "c", Published: int64(i)}
	}
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if db.core.TotalArticles != idxPackSize {
		t.Fatalf("TotalArticles = %d, want %d", db.core.TotalArticles, idxPackSize)
	}

	if _, err := os.Stat(filepath.Join(dir, "idx/0.gz")); !os.IsNotExist(err) {
		t.Error("idx/0.gz should not exist yet at exactly 1000 articles")
	}

	if err := db.PutArticles(ctx, []*Item{
		{Sub: sub, Title: "A1001", Content: "c", Published: 1001},
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
	sub := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub.id: sub}

	articles := []*Item{
		{Sub: sub, Title: "", Content: "body", Link: "", Published: 0},
	}
	if err := db.PutArticles(ctx, articles); err != nil {
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

func TestDBNullSubscriptionsInJSON(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	core := `{"data_tog":false,"fetched_at":0,"total_art":0,"next_pid":0,"pack_off":0,"subscriptions":null}` + "\n"
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

	for range db.Subscriptions() {
	}
	if len(db.Subscriptions()) != 0 {
		t.Errorf("Subscriptions len = %d, want 0", len(db.Subscriptions()))
	}
}

func TestPutArticlesDataPackSplitResetsPackOffset(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.PackSize = 0 // split after every article

	sub := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub.id: sub}
	c.FetchedAt = 1700000000

	articles := []*Item{
		{Sub: sub, Title: "A1", Content: "Content1", Published: 1000},
		{Sub: sub, Title: "A2", Content: "Content2", Published: 2000},
	}
	if err := db.PutArticles(ctx, articles); err != nil {
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
	sub := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub.id: sub}
	c.FetchedAt = 1700000000

	if err := db.PutArticles(ctx, []*Item{
		{Sub: sub, Title: "A1", Content: "C1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles(1): %v", err)
	}

	savedPO := c.PackOffset
	savedNPID := c.NextPackID
	savedTotal := c.TotalArticles

	if err := db.PutArticles(ctx, []*Item{
		{Sub: sub, Title: "A2", Content: "C2", Published: 2000},
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

func TestPutArticlesFirstFetchedAt(t *testing.T) {
	db, c, _ := setupTestDB(t)
	sub := &Subscription{id: 1}
	c.Subscriptions = map[int]*Subscription{sub.id: sub}
	c.FetchedAt = 1700000000

	if err := db.PutArticles(ctx, []*Item{
		{Sub: sub, Title: "A1", Content: "C1", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if c.FirstFetchedAt != 1700000000 {
		t.Errorf("FirstFetchedAt = %d, want 1700000000", c.FirstFetchedAt)
	}
}
