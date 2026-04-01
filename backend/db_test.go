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
	"strconv"
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

// readArticles reads articles from idx/ and data/ packs in a test directory.
// metaPath is the path to an idx/ gzip file (TSV format).
// It parses TSV rows, loads referenced data/ packs, and reconstructs Items.
func readArticles(t *testing.T, dir string, metaPath string) []*Item {
	t.Helper()
	metaBytes := decompressGz(t, metaPath)

	// Cache for content packs: packID -> []string
	contentCache := map[int][]string{}

	var articles []*Item
	scanner := bufio.NewScanner(bytes.NewReader(metaBytes))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 7 {
			t.Fatalf("expected 7 TSV fields, got %d: %q", len(fields), scanner.Text())
		}

		// fields[0] is fetched-time, skip
		contentPackID, _ := strconv.Atoi(fields[1])
		contentIdx, _ := strconv.Atoi(fields[2])
		subID, _ := strconv.Atoi(fields[3])
		published, _ := strconv.ParseInt(fields[4], 10, 64)
		title := fields[5]
		link := fields[6]

		// Load content pack if not cached
		if _, ok := contentCache[contentPackID]; !ok {
			// Try numbered pack first, then latest packs
			var contentBytes []byte
			for _, name := range []string{
				fmt.Sprintf("data/%d.gz", contentPackID),
				"data/true.gz",
				"data/false.gz",
			} {
				path := filepath.Join(dir, name)
				if _, err := os.Stat(path); err == nil {
					contentBytes = decompressGz(t, path)
					break
				}
			}
			if contentBytes == nil {
				t.Fatalf("content pack %d not found", contentPackID)
			}
			// Split by null separator; last element is empty due to trailing \0
			parts := strings.Split(string(contentBytes), "\x00")
			if len(parts) > 0 && parts[len(parts)-1] == "" {
				parts = parts[:len(parts)-1]
			}
			contentCache[contentPackID] = parts
		}

		content := ""
		if parts, ok := contentCache[contentPackID]; ok && contentIdx < len(parts) {
			content = parts[contentIdx]
		}

		articles = append(articles, &Item{
			Sub:       &Subscription{ID: subID},
			Title:     title,
			Content:   content,
			Link:      link,
			Published: published,
		})
	}
	return articles
}

// readAllArticles reads all articles from the latest idx/ pack.
func readAllArticles(t *testing.T, dir string, latest bool) []*Item {
	t.Helper()
	metaPath := filepath.Join(dir, fmt.Sprintf("idx/%v.gz", latest))
	return readArticles(t, dir, metaPath)
}

func TestPutArticlesBasic(t *testing.T) {
	db, c, dir := setupTestDB(t)
	sub1 := &Subscription{ID: 1}
	c.Subscriptions = []*Subscription{sub1}

	articles := []*Item{
		{Sub: sub1, Title: "A1", Content: "C1", Link: "http://example.com/1", Published: 1000},
		{Sub: sub1, Title: "A2", Content: "C2", Link: "http://example.com/2", Published: 2000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	result := readAllArticles(t, dir, c.DataToggle)
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
	sub1, sub2 := &Subscription{ID: 1}, &Subscription{ID: 2}
	c.Subscriptions = []*Subscription{sub1, sub2}

	articles := []*Item{
		{Sub: sub1, Title: "Sub1-A", Published: 1000},
		{Sub: sub2, Title: "Sub2-A", Published: 2000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	result := readAllArticles(t, dir, c.DataToggle)

	subIds := map[int]bool{}
	for _, a := range result {
		subIds[a.Sub.ID] = true
	}
	if !subIds[1] || !subIds[2] {
		t.Errorf("expected articles from both subs, got subIds: %v", subIds)
	}
}

func TestPutArticlesPackSplitting(t *testing.T) {
	db, c, dir := setupTestDB(t)
	// Very small pack size to force content splitting
	globals.PackSize = 0 // 0 KB -> split after every flush

	sub1 := &Subscription{ID: 1}
	c.Subscriptions = []*Subscription{sub1}

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

func readTsLines(t *testing.T, path string) [][]string {
	t.Helper()
	var lines [][]string
	scanner := bufio.NewScanner(bytes.NewReader(decompressGz(t, path)))
	for scanner.Scan() {
		lines = append(lines, strings.Split(scanner.Text(), "\t"))
	}
	return lines
}

func TestPackMetadata(t *testing.T) {
	db, c, dir := setupTestDB(t)
	globals.PackSize = 0 // force content split after every article

	sub1, sub2 := &Subscription{ID: 1}, &Subscription{ID: 2}
	c.Subscriptions = []*Subscription{sub1, sub2}

	articles := []*Item{
		{Sub: sub1, Title: "A1", Content: "Content 1", Published: 1000},
		{Sub: sub2, Title: "A2", Content: "Content 2", Published: 2000},
		{Sub: sub1, Title: "A3", Content: "Content 3", Published: 3000},
	}

	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	// UpdateTS after PutArticles: subs are dirty, snapshot is written
	if err := db.UpdateTS(ctx); err != nil {
		t.Fatalf("UpdateTS: %v", err)
	}

	// UpdateTS writes to ts/{!Latest}.gz
	tsPath := filepath.Join(dir, fmt.Sprintf("ts/%v.gz", c.TSToggle))
	lines := readTsLines(t, tsPath)
	if len(lines) == 0 {
		t.Fatal("expected at least one ts entry")
	}

	last := lines[len(lines)-1]
	// Delta line: deltaTS \t subID \t delta [\t subID \t delta]*
	if len(last) < 5 {
		t.Fatalf("expected at least 5 TSV fields, got %d: %v", len(last), last)
	}
	sub1Delta, _ := strconv.Atoi(last[2])
	sub2Delta, _ := strconv.Atoi(last[4])
	if sub1Delta+sub2Delta != 3 {
		t.Errorf("total delta articles = %d, want 3", sub1Delta+sub2Delta)
	}

	// Verify cumulative counts
	if c.TotalArticles != 3 {
		t.Errorf("NArticles = %d, want 3", c.TotalArticles)
	}
	if c.Subscriptions[0].TotalArticles != 2 {
		t.Errorf("Sub[1].TotalArticles = %d, want 2", c.Subscriptions[0].TotalArticles)
	}
	if c.Subscriptions[1].TotalArticles != 1 {
		t.Errorf("Sub[2].TotalArticles = %d, want 1", c.Subscriptions[1].TotalArticles)
	}
}

func TestCommitAndReadDB(t *testing.T) {
	db, c, dir := setupTestDB(t)
	c.Subscriptions = []*Subscription{
		{ID: 1, Title: "Test Feed", URL: "http://example.com/feed"},
	}
	c.SubSeq = 2

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("CommitDB: %v", err)
	}

	// Read it back
	data := decompressGz(t, filepath.Join(dir, "db.gz"))

	var core DBCore
	if err := json.Unmarshal(data, &core); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if core.SubSeq != 2 {
		t.Errorf("SubSeq = %d, want 2", core.SubSeq)
	}
	if len(core.Subscriptions) != 1 {
		t.Fatalf("Subscriptions len = %d, want 1", len(core.Subscriptions))
	}
	if core.Subscriptions[0].Title != "Test Feed" {
		t.Errorf("Sub title = %q, want %q", core.Subscriptions[0].Title, "Test Feed")
	}
}

func TestDBLocalCRUD(t *testing.T) {
	db, _, _ := setupTestDB(t)

	// Put + Get
	if err := db.Put(ctx, "test.txt", []byte("hello"), false); err != nil {
		t.Fatalf("Put: %v", err)
	}
	data, err := db.Get(ctx, "test.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("Get = %q, want %q", data, "hello")
	}

	// Put with ignoreExisting=false should fail (file exists)
	if err := db.Put(ctx, "test.txt", []byte("world"), false); err == nil {
		t.Error("expected error for duplicate put with ignoreExisting=false")
	}

	// Put with ignoreExisting=true should overwrite
	if err := db.Put(ctx, "test.txt", []byte("world"), true); err != nil {
		t.Fatalf("Put(overwrite): %v", err)
	}
	data, _ = db.Get(ctx, "test.txt", false)
	if string(data) != "world" {
		t.Errorf("Get after overwrite = %q, want %q", data, "world")
	}

	// Get missing file with ignoreMissing=true
	data, err = db.Get(ctx, "missing.txt", true)
	if err != nil || data != nil {
		t.Errorf("Get(missing, ignore): data=%v, err=%v", data, err)
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
	data, _ = db.Get(ctx, "test.txt", true)
	if data != nil {
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

	if err := db.AtomicPut(ctx, "state.json", []byte(`{"ok":true}`)); err != nil {
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
	db, c, _ := setupTestDB(t)

	s1 := &Subscription{Title: "Feed 1", URL: "http://example.com/1"}
	s2 := &Subscription{Title: "Feed 2", URL: "http://example.com/2"}
	db.AddSubscription(s1)
	db.AddSubscription(s2)

	if s1.ID != 1 || s2.ID != 2 {
		t.Errorf("IDs = (%d, %d), want (1, 2)", s1.ID, s2.ID)
	}
	if c.SubSeq != 2 {
		t.Errorf("SubSeq = %d, want 2", c.SubSeq)
	}
	if len(db.Subscriptions()) != 2 {
		t.Fatalf("len(Subscriptions) = %d, want 2", len(db.Subscriptions()))
	}

	db.RemoveSubscription(1)
	if len(db.Subscriptions()) != 1 {
		t.Fatalf("len(Subscriptions) after remove = %d, want 1", len(db.Subscriptions()))
	}
	if db.Subscriptions()[0].ID != 2 {
		t.Errorf("remaining sub ID = %d, want 2", db.Subscriptions()[0].ID)
	}

	// SubSeq should not decrease on removal
	if c.SubSeq != 2 {
		t.Errorf("SubSeq after remove = %d, want 2", c.SubSeq)
	}
}

func TestRemoveNonExistentSubscription(t *testing.T) {
	db, _, _ := setupTestDB(t)
	db.AddSubscription(&Subscription{Title: "Feed", URL: "http://example.com"})

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

	db.AddSubscription(&Subscription{Title: "Persist Feed", URL: "http://example.com/feed"})
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

func TestUpdateTSNoDirtySubs(t *testing.T) {
	db, c, dir := setupTestDB(t)
	sub := &Subscription{ID: 1, TotalArticles: 5}
	sub.oTotalArticles = 5 // not dirty
	c.Subscriptions = []*Subscription{sub}
	c.FetchedAt = 100
	c.oFetchedAt = 100 // same week

	if err := db.UpdateTS(ctx); err != nil {
		t.Fatalf("UpdateTS: %v", err)
	}

	// No ts files should be created when no dirty subs and same week
	for _, name := range []string{"ts/true.gz", "ts/false.gz"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Errorf("%s should not exist", name)
		}
	}
}

func TestUpdateTSFirstFetchedAt(t *testing.T) {
	db, c, _ := setupTestDB(t)
	sub := &Subscription{ID: 1}
	c.Subscriptions = []*Subscription{sub}

	articles := []*Item{
		{Sub: sub, Title: "A1", Content: "C1", Published: 1000},
	}
	c.FetchedAt = 1700000000
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if err := db.UpdateTS(ctx); err != nil {
		t.Fatalf("UpdateTS: %v", err)
	}

	if c.FirstFetchedAt != 1700000000 {
		t.Errorf("FirstFetchedAt = %d, want 1700000000", c.FirstFetchedAt)
	}
}

func TestUpdateTSWeekBoundary(t *testing.T) {
	db, c, dir := setupTestDB(t)
	sub := &Subscription{ID: 1}
	c.Subscriptions = []*Subscription{sub}

	// First fetch: week 2800 (epoch seconds ~1693440000)
	c.FetchedAt = 2800 * 604800
	c.oFetchedAt = 2800 * 604800
	articles := []*Item{
		{Sub: sub, Title: "A1", Content: "C1", Published: 1000},
	}
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.UpdateTS(ctx); err != nil {
		t.Fatalf("UpdateTS: %v", err)
	}

	// Simulate next fetch in a different week
	sub.oTotalArticles = sub.TotalArticles
	c.oFetchedAt = c.FetchedAt
	c.oTotalArticles = c.TotalArticles
	c.FetchedAt = 2801 * 604800 // next week

	articles = []*Item{
		{Sub: sub, Title: "A2", Content: "C2", Published: 2000},
	}
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.UpdateTS(ctx); err != nil {
		t.Fatalf("UpdateTS: %v", err)
	}

	// The previous week pack should be finalized
	prevWeekPath := filepath.Join(dir, "ts/2800.gz")
	if _, err := os.Stat(prevWeekPath); os.IsNotExist(err) {
		t.Error("expected finalized ts/2800.gz to exist")
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

func TestPutArticlesSubTotalArticlesIncrement(t *testing.T) {
	db, c, _ := setupTestDB(t)
	sub1 := &Subscription{ID: 1}
	sub2 := &Subscription{ID: 2}
	c.Subscriptions = []*Subscription{sub1, sub2}
	c.FetchedAt = 1700000000

	articles := []*Item{
		{Sub: sub1, Title: "A1", Content: "C1", Published: 1000},
		{Sub: sub1, Title: "A2", Content: "C2", Published: 2000},
		{Sub: sub2, Title: "B1", Content: "D1", Published: 3000},
	}
	if err := db.PutArticles(ctx, articles); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}

	if sub1.TotalArticles != 2 {
		t.Errorf("sub1.TotalArticles = %d, want 2", sub1.TotalArticles)
	}
	if sub2.TotalArticles != 1 {
		t.Errorf("sub2.TotalArticles = %d, want 1", sub2.TotalArticles)
	}
	if sub1.LastAddedAt != c.FetchedAt {
		t.Errorf("sub1.LastAddedAt = %d, want %d", sub1.LastAddedAt, c.FetchedAt)
	}
	if sub2.LastAddedAt != c.FetchedAt {
		t.Errorf("sub2.LastAddedAt = %d, want %d", sub2.LastAddedAt, c.FetchedAt)
	}
}

func TestPutArticlesToggle(t *testing.T) {
	db, c, _ := setupTestDB(t)
	sub := &Subscription{ID: 1}
	c.Subscriptions = []*Subscription{sub}

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
	if db.core.SubSeq != 0 {
		t.Errorf("SubSeq = %d, want 0", db.core.SubSeq)
	}
}
