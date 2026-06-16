package main

import (
	"bytes"
	"compress/gzip"
	"testing"
)

func TestDataKeyForFinalized(t *testing.T) {
	core := &DBCore{NextPackID: 5, Seq: 7}
	cases := []struct {
		packID int
		want   string
	}{
		{0, "data/0.gz"},
		{4, "data/4.gz"},
		// packID == NextPackID is the latest pack (current generation name).
		{5, "data/L7.gz"},
		{99, "data/L7.gz"},
	}
	for _, c := range cases {
		if got := dataKeyFor(core, c.packID); got != c.want {
			t.Errorf("dataKeyFor(NextPackID=%d, packID=%d) = %q, want %q", core.NextPackID, c.packID, got, c.want)
		}
	}
}

func TestGenKey(t *testing.T) {
	cases := []struct {
		prefix string
		gen    int
		want   string
	}{
		{"idx", 0, "idx/L0.gz"},
		{"idx", 1, "idx/L1.gz"},
		{"data", 17, "data/L17.gz"},
	}
	for _, c := range cases {
		if got := genKey(c.prefix, c.gen); got != c.want {
			t.Errorf("genKey(%q, %d) = %q, want %q", c.prefix, c.gen, got, c.want)
		}
	}
}

func TestLatestKeyFollowsSeq(t *testing.T) {
	cases := []struct {
		seq  int
		want string
	}{
		{1, "data/L1.gz"},
		{42, "data/L42.gz"},
	}
	for _, c := range cases {
		core := &DBCore{Seq: c.seq}
		if got := latestKey(core, "data"); got != c.want {
			t.Errorf("latestKey(seq=%d, data) = %q, want %q", c.seq, got, c.want)
		}
		wantIdx := "idx" + c.want[len("data"):]
		if got := latestKey(core, "idx"); got != wantIdx {
			t.Errorf("latestKey(seq=%d, idx) = %q, want %q", c.seq, got, wantIdx)
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

func TestLatestIdxEntryCount(t *testing.T) {
	cases := []struct {
		total int
		want  int
	}{
		{0, 0},
		{1, 1},
		{idxPackSize - 1, idxPackSize - 1},
		// At exactly idxPackSize the latest pack still holds all entries
		// (the split fires only when the next entry arrives).
		{idxPackSize, idxPackSize},
		{idxPackSize + 1, 1},
		{2*idxPackSize + 7, 7},
	}
	for _, c := range cases {
		if got := latestIdxEntryCount(c.total); got != c.want {
			t.Errorf("latestIdxEntryCount(%d) = %d, want %d", c.total, got, c.want)
		}
	}
}

func TestGzipBestSmallerAndRoundTrips(t *testing.T) {
	raw := bytes.Repeat([]byte(`{"s":1,"a":100,"t":"hello","c":"body"}`+"\n"), 500)
	var std bytes.Buffer
	gz := gzip.NewWriter(&std)
	if _, err := gz.Write(raw); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}

	best, err := gzipBest("data/0.gz", std.Bytes())
	if err != nil {
		t.Fatalf("gzipBest: %v", err)
	}
	if len(best) > std.Len() {
		t.Errorf("gzipBest output %d bytes, larger than stdlib's %d", len(best), std.Len())
	}
	back, err := gunzip(bytes.NewReader(best))
	if err != nil {
		t.Fatalf("gzipBest output is not stdlib-readable gzip: %v", err)
	}
	if !bytes.Equal(back, raw) {
		t.Errorf("gzipBest output decompressed to different bytes")
	}
}

func TestGzipBestErrorsOnBadInput(t *testing.T) {
	if out, err := gzipBest("data/0.gz", []byte("not a gzip stream")); err == nil {
		t.Errorf("gzipBest(non-gzip) = %d bytes, want error", len(out))
	}
}
