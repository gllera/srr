package main

import (
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
