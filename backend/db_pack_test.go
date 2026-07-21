package main

import (
	"bytes"
	"compress/gzip"
	"strings"
	"testing"

	"github.com/foobaz/go-zopfli/zopfli"
)

func TestDataKeyForFinalized(t *testing.T) {
	core := &DBCore{WriterState: WriterState{NextPackID: 5, Seq: 7}}
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
		core := &DBCore{WriterState: WriterState{Seq: c.seq}}
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
	body := []byte(`{"f":1,"a":100,"p":50,"t":"hello","l":"http://x","c":"body1"}` + "\n" +
		`{"f":2,"a":200,"c":"body2"}` + "\n")
	entries, err := parseDataPack(body)
	if err != nil {
		t.Fatalf("parseDataPack: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[0].FeedID != 1 || entries[0].FetchedAt != 100 || entries[0].Published != 50 ||
		entries[0].Title != "hello" || entries[0].Link != "http://x" || entries[0].Content != "body1" {
		t.Errorf("entries[0] = %+v", entries[0])
	}
	if entries[1].FeedID != 2 || entries[1].FetchedAt != 200 || entries[1].Content != "body2" ||
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
	raw := bytes.Repeat([]byte(`{"f":1,"a":100,"t":"hello","c":"body"}`+"\n"), 500)
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

// The no-gain branch: gzipBest returns the input unchanged when zopfli can't
// beat the bytes already stored. zopfli out-compresses stdlib on every input
// (measured), so the only way to reach this branch is to feed a stream that is
// ALREADY zopfli-optimal — re-compressing it is idempotent, so best.Len() can
// never fall below the input and the original slice is returned verbatim.
func TestGzipBestNoGainReturnsInput(t *testing.T) {
	raw := []byte("srr no-gain probe")
	var zbuf bytes.Buffer
	opts := zopfli.DefaultOptions()
	if err := zopfli.GzipCompress(&opts, raw, &zbuf); err != nil {
		t.Fatalf("zopfli seed: %v", err)
	}
	in := zbuf.Bytes()

	out, err := gzipBest("data/0.gz", in)
	if err != nil {
		t.Fatalf("gzipBest: %v", err)
	}
	if !bytes.Equal(out, in) {
		t.Errorf("gzipBest re-shrank an already-zopfli stream (in=%d out=%d); want the input returned unchanged",
			len(in), len(out))
	}
	// Slice identity is the discriminating check. Zopfli is deterministic, so a
	// recompression of an already-zopfli stream is byte-identical to the input —
	// byte equality alone would still pass even if the no-gain branch (return gz)
	// were deleted and best.Bytes() returned instead. The no-gain branch returns
	// the exact input slice; the fall-through returns a fresh buffer.
	if len(out) == 0 || &out[0] != &in[0] {
		t.Error("gzipBest returned a recompressed buffer, not the input slice; the no-gain branch was not exercised")
	}
}

// checkLatestIdx (db_pack.go) rejects a latest idx pack that disagrees with
// db.gz. Its guard branches — empty-store-vs-nonempty-pack, short header,
// ragged footer — had no direct coverage (only parseIdxPack's read-side twins
// did); hand-built bytes via buildIdxRaw exercise each without a 50k-entry store.
func TestCheckLatestIdxGuards(t *testing.T) {
	// Happy path: a well-formed 2-entry latest pack returns the offset where the
	// boundary footer begins (header + entries).
	valid := buildIdxRaw(0, 0, []uint32{0}, []uint16{1, 2}, nil)
	end, err := checkLatestIdx("idx/L1.gz", valid, 2)
	if err != nil {
		t.Fatalf("valid pack: %v", err)
	}
	if want := idxHeaderPrefix + 1*4 + 2*idxEntrySize; end != want {
		t.Errorf("entriesEnd = %d, want %d", end, want)
	}

	// db.gz says empty store (want == 0) but a non-empty pack is on disk.
	if _, err := checkLatestIdx("idx/L1.gz", []byte{0x01}, 0); err == nil || !strings.Contains(err.Error(), "empty store") {
		t.Errorf("nonempty-pack/empty-store err = %v, want 'empty store'", err)
	}

	// want > 0 but fewer than idxHeaderPrefix header bytes present.
	if _, err := checkLatestIdx("idx/L1.gz", make([]byte, idxHeaderPrefix-1), 5); err == nil || !strings.Contains(err.Error(), "short idx header") {
		t.Errorf("short-header err = %v, want 'short idx header'", err)
	}

	// header + entries present, but the trailing footer isn't a whole u16 count.
	ragged := append(buildIdxRaw(0, 0, []uint32{0}, []uint16{1, 2}, nil), 0x00)
	if _, err := checkLatestIdx("idx/L1.gz", ragged, 2); err == nil || !strings.Contains(err.Error(), "whole number of u16 boundaries") {
		t.Errorf("ragged-footer err = %v, want 'whole number of u16 boundaries'", err)
	}

	// header present but the promised entries are truncated (short body).
	if _, err := checkLatestIdx("idx/L1.gz", valid, 10); err == nil || !strings.Contains(err.Error(), "expects at least") {
		t.Errorf("short-body err = %v, want 'expects at least'", err)
	}
}
