package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestArticleDataLangNotPacked pins the lang contract on the pack writer
// side: Item.articleData carries Lang through for same-cycle backend use,
// and jsonEncode — the one data-pack line encoder — never serializes it
// (json:"-"), so the data/ JSONL format is byte-identical with or without it.
func TestArticleDataLangNotPacked(t *testing.T) {
	it := &Item{Feed: &Feed{}, Title: "T", Content: "c", Lang: "en"}
	ad := it.articleData(42)
	if ad.Lang != "en" {
		t.Errorf("articleData Lang = %q, want \"en\"", ad.Lang)
	}
	line, err := jsonEncode(ad)
	if err != nil {
		t.Fatalf("jsonEncode: %v", err)
	}
	if strings.Contains(string(line), "lang") {
		t.Errorf("pack line = %s, want no lang field", line)
	}
	bare := ad
	bare.Lang = ""
	bareLine, err := jsonEncode(bare)
	if err != nil {
		t.Fatalf("jsonEncode: %v", err)
	}
	if string(line) != string(bareLine) {
		t.Errorf("pack line differs with Lang set:\n  with: %s\n  without: %s", line, bareLine)
	}
}

// The reader half of the same contract: a stamped article survives a real
// PutArticles → data pack → parseDataPack round trip with everything else
// intact and Lang empty, so nothing downstream can come to depend on a value
// the packs do not carry.
func TestPutArticlesDropsLangOnReadBack(t *testing.T) {
	db, c, dir := setupTestDB(t)
	f := &Feed{Title: "F", URL: "https://e.example/f"}
	if err := db.AddFeed(f); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: f, Title: "T", Content: "c", Link: "l", Published: 1000, Lang: "es"},
	}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, latestKey(c, "data")))
	if err != nil {
		t.Fatalf("read data pack: %v", err)
	}
	plain, err := gunzip(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	arts, err := parseDataPack(plain)
	if err != nil {
		t.Fatalf("parseDataPack: %v", err)
	}
	if len(arts) != 1 {
		t.Fatalf("got %d articles, want 1", len(arts))
	}
	if arts[0].Title != "T" || arts[0].Content != "c" {
		t.Errorf("read back %+v, want the article intact", arts[0])
	}
	if arts[0].Lang != "" {
		t.Errorf("read-back Lang = %q, want empty — the packs never carried it", arts[0].Lang)
	}
}
