package main

import (
	"testing"
)

func TestDataKeyForFinalized(t *testing.T) {
	core := &DBCore{NextPackID: 5, DataToggle: true}
	cases := []struct {
		packID int
		want   string
	}{
		{0, "data/0.gz"},
		{4, "data/4.gz"},
		// packID == NextPackID is the latest pack (toggle name).
		{5, "data/true.gz"},
		{99, "data/true.gz"},
	}
	for _, c := range cases {
		if got := dataKeyFor(core, c.packID); got != c.want {
			t.Errorf("dataKeyFor(NextPackID=%d, packID=%d) = %q, want %q", core.NextPackID, c.packID, got, c.want)
		}
	}
}

func TestDataKeyForLatestRespectsToggle(t *testing.T) {
	cases := []struct {
		toggle bool
		want   string
	}{
		{true, "data/true.gz"},
		{false, "data/false.gz"},
	}
	for _, c := range cases {
		core := &DBCore{NextPackID: 0, DataToggle: c.toggle}
		if got := dataKeyFor(core, 0); got != c.want {
			t.Errorf("dataKeyFor(toggle=%v) = %q, want %q", c.toggle, got, c.want)
		}
	}
}

func TestParseDataPackEmpty(t *testing.T) {
	entries, err := parseDataPack(nil)
	if err != nil {
		t.Fatalf("parseDataPack(nil): %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("got %d entries, want 0", len(entries))
	}
}

func TestParseDataPackJSONL(t *testing.T) {
	body := []byte(`{"s":1,"a":100,"p":50,"t":"hello","l":"http://x","c":"body1"}` + "\n" +
		`{"s":2,"a":200,"c":"body2"}` + "\n")
	entries, err := parseDataPack(body)
	if err != nil {
		t.Fatalf("parseDataPack: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[0].ChannelID != 1 || entries[0].FetchedAt != 100 || entries[0].Published != 50 ||
		entries[0].Title != "hello" || entries[0].Link != "http://x" || entries[0].Content != "body1" {
		t.Errorf("entries[0] = %+v", entries[0])
	}
	if entries[1].ChannelID != 2 || entries[1].FetchedAt != 200 || entries[1].Content != "body2" ||
		entries[1].Published != 0 || entries[1].Title != "" || entries[1].Link != "" {
		t.Errorf("entries[1] = %+v", entries[1])
	}
}

func TestParseDataPackInvalidJSON(t *testing.T) {
	if _, err := parseDataPack([]byte(`{not json`)); err == nil {
		t.Error("expected error for malformed JSONL")
	}
}

func TestExpectedLatestIdxSize(t *testing.T) {
	cases := []struct {
		total int
		want  int
	}{
		{0, 0},
		{1, idxHeaderSize + 2},
		{idxPackSize - 1, idxHeaderSize + (idxPackSize-1)*2},
		// At exactly idxPackSize the latest pack still holds all entries
		// (the split fires only when the next entry arrives).
		{idxPackSize, idxHeaderSize + idxPackSize*2},
		{idxPackSize + 1, idxHeaderSize + 1*2},
		{2*idxPackSize + 7, idxHeaderSize + 7*2},
	}
	for _, c := range cases {
		if got := expectedLatestIdxSize(c.total); got != c.want {
			t.Errorf("expectedLatestIdxSize(%d) = %d, want %d", c.total, got, c.want)
		}
	}
}
