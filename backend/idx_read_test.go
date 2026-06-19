package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

// buildCoreGz encodes a DBCore as a gzip-compressed JSON blob, suitable for
// use as a fake db.gz keyGetter in loadCore tests.
func buildCoreGz(t *testing.T, core DBCore) []byte {
	t.Helper()
	raw, err := json.Marshal(core)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(raw); err != nil {
		t.Fatalf("gz.Write: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gz.Close: %v", err)
	}
	return buf.Bytes()
}

// fakeFetcher returns a keyGetter that serves a fixed db.gz blob and reports
// "not found" for any other key, so loadCore tests never reach loadIdxPacks.
func fakeFetcher(dbGz []byte) keyGetter {
	return func(key string) ([]byte, error) {
		if key != dbFileKey {
			return nil, nil
		}
		data, err := gunzip(bytes.NewReader(dbGz))
		if err != nil {
			return nil, err
		}
		return data, nil
	}
}

// B8: a db.gz with total_art < 0 must be rejected by loadCore with a clear
// error — without panicking. Before the fix, loadCore returns nil error and
// the corrupt core reaches loadIdxPacks → parseIdxPack with a negative
// packSize → makeslice panic. After the fix, loadCore itself returns an error.
func TestLoadCoreRejectsNegativeTotalArticles(t *testing.T) {
	core := DBCore{TotalArticles: -5, NextPackID: 1, Seq: 1}
	gz := buildCoreGz(t, core)
	_, err := loadCore(fakeFetcher(gz))
	if err == nil {
		t.Fatal("expected error for negative total_art, got nil")
	}
	if !strings.Contains(err.Error(), "total_art") {
		t.Errorf("error %q does not mention total_art", err.Error())
	}
}

// B11: a db.gz with a feed id >= feedIDCeiling must be rejected by loadCore
// with a clear error — without allocating a ~4 GB ownFeedCounts slice.
// Before the fix, loadCore returns nil error; the hostile id passes through
// feedSlots → parseIdxPack, which allocates make([]uint32, id+1). After the
// fix, loadCore rejects the id before any pack loading.
func TestLoadCoreRejectsOversizedFeedID(t *testing.T) {
	oversized := feedIDCeiling + 1 // e.g. 65537 — beyond the u16 ceiling
	core := DBCore{
		TotalArticles: 1,
		NextPackID:    1,
		Seq:           1,
		Feeds:         map[int]*Feed{oversized: {URL: "https://example.com/x"}},
	}
	gz := buildCoreGz(t, core)
	_, err := loadCore(fakeFetcher(gz))
	if err == nil {
		t.Fatal("expected error for feed id >= feedIDCeiling, got nil")
	}
	if !strings.Contains(err.Error(), "feed id") {
		t.Errorf("error %q does not mention feed id", err.Error())
	}
}

// buildIdxRaw assembles the raw (uncompressed) bytes of one idx pack:
// variable-length header ‖ 2-byte feed_id:u16 LE entries ‖ u16 LE boundary
// footer. It mirrors what writeIdxHeader/writeIdx/writeIdxFooter emit, so the
// reader-guard tests can hand-craft truncated/ragged packs the writer never
// produces.
func buildIdxRaw(packIDBase, packOffBase uint32, feedCounts []uint32, entries []uint16, boundaries []int) []byte {
	numSlots := len(feedCounts)
	out := make([]byte, idxHeaderPrefix+numSlots*4)
	binary.LittleEndian.PutUint32(out[0:], packIDBase)
	binary.LittleEndian.PutUint32(out[4:], packOffBase)
	binary.LittleEndian.PutUint32(out[idxStateSize:], uint32(numSlots))
	for i, c := range feedCounts {
		binary.LittleEndian.PutUint32(out[idxHeaderPrefix+i*4:], c)
	}
	body := make([]byte, len(entries)*idxEntrySize)
	for i, e := range entries {
		binary.LittleEndian.PutUint16(body[i*idxEntrySize:], e)
	}
	footer := make([]byte, len(boundaries)*idxBoundarySize)
	for i, b := range boundaries {
		binary.LittleEndian.PutUint16(footer[i*idxBoundarySize:], uint16(b))
	}
	out = append(out, body...)
	out = append(out, footer...)
	return out
}

// writeIdxFooter (db_pack.go) and parseIdxFooter (idx_read.go) are inverses;
// the append path relies on it, but neither has a direct round-trip test, so a
// symmetric encode/decode bug (wrong width, endianness) could slip past.
func TestIdxFooterRoundTrip(t *testing.T) {
	cases := [][]int{
		{},
		{0},
		{0, 1, 2},
		{5, 10, 49999},
	}
	for _, want := range cases {
		p := newPack()
		if err := writeIdxFooter(p, want); err != nil {
			t.Fatalf("writeIdxFooter(%v): %v", want, err)
		}
		if err := p.gz.Close(); err != nil {
			t.Fatalf("gz close: %v", err)
		}
		raw, err := gunzip(bytes.NewReader(p.buf.Bytes()))
		if err != nil {
			t.Fatalf("gunzip: %v", err)
		}
		got := parseIdxFooter(raw)
		if len(got) != len(want) {
			t.Fatalf("round-trip %v: len got %d want %d", want, len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("round-trip %v: got[%d]=%d want %d", want, i, got[i], want[i])
			}
		}
	}
}

// The three parseIdxPack reject guards mirror idx.ts makeIdxPack(); the TS side
// tests them (idx.test.ts) but the Go side did not, so the two readers could
// drift on what counts as a corrupt pack.
func TestParseIdxPackRejectsShortHeader(t *testing.T) {
	_, err := parseIdxPack(make([]byte, idxHeaderPrefix-1), 0, 1, 1)
	if err == nil || !strings.Contains(err.Error(), "short header") {
		t.Fatalf("want short-header error, got %v", err)
	}
}

func TestParseIdxPackRejectsShortBody(t *testing.T) {
	// Header claims numSlots=1; only 3 of the promised 10 entries are present.
	raw := buildIdxRaw(0, 0, []uint32{0}, []uint16{1, 2, 3}, nil)
	_, err := parseIdxPack(raw, 0, 10, 4)
	if err == nil || !strings.Contains(err.Error(), "short body") {
		t.Fatalf("want short-body error, got %v", err)
	}
}

func TestParseIdxPackRejectsRaggedFooter(t *testing.T) {
	raw := buildIdxRaw(0, 0, []uint32{0}, []uint16{1, 2}, nil)
	raw = append(raw, 0x00) // one stray byte → footer is not a whole u16
	_, err := parseIdxPack(raw, 0, 2, 3)
	if err == nil || !strings.Contains(err.Error(), "footer not whole u16 boundaries") {
		t.Fatalf("want ragged-footer error, got %v", err)
	}
}

// Boundary at local index 0 with packOff_base == 0 (the first entry of a fresh
// store): the i=0 footer boundary must bump packId against the empty-bounds
// sentinel, yielding bounds[0] = {packID_base+1, baseChron}. Covered only
// end-to-end before; this pins the distinct path in isolation.
func TestParseIdxPackBoundaryAtIndexZero(t *testing.T) {
	raw := buildIdxRaw(2, 0, []uint32{0, 0, 0}, []uint16{2, 2, 2}, []int{0, 2})
	pack, err := parseIdxPack(raw, 0, 3, 3)
	if err != nil {
		t.Fatalf("parseIdxPack: %v", err)
	}
	want := []idxBound{{packID: 3, startChron: 0}, {packID: 4, startChron: 2}}
	if len(pack.bounds) != len(want) {
		t.Fatalf("bounds = %+v, want %+v", pack.bounds, want)
	}
	for i := range want {
		if pack.bounds[i] != want[i] {
			t.Errorf("bounds[%d] = %+v, want %+v", i, pack.bounds[i], want[i])
		}
	}
	if pid, off := pack.getPackRef(0); pid != 3 || off != 0 {
		t.Errorf("getPackRef(0) = (%d,%d), want (3,0)", pid, off)
	}
	if pid, off := pack.getPackRef(2); pid != 4 || off != 0 {
		t.Errorf("getPackRef(2) = (%d,%d), want (4,0)", pid, off)
	}
}

// Regression: a feed added AFTER an idx pack's header was frozen (the header is
// written once, at the pack's first entry) has feed_id >= that pack's numSlots,
// yet its articles can land in the same pack. ownFeedCounts must be sized to
// the store high-water (feedSlots), not the pack's own numSlots — the frontend
// (idx.ts makeIdxPack) sizes by the threaded `slots`, so the Go mirror must
// too, or ownFeedCount under-reports that feed and both filtered navigation
// (idx.ts hasCandidate) and the inspector's feedCounts-continuity check
// silently undercount it. Found via the >50k synthetic-store generator
// (genbig_test.go); reproduced here inside a single latest pack so the path is
// pinned without crossing the 50,000-entry boundary.
func TestOwnFeedCountForFeedAddedMidPack(t *testing.T) {
	db, c, _ := setupTestDB(t)

	f0 := &Feed{Title: "f0", URL: "https://example.com/0"}
	if err := db.AddFeed(f0); err != nil {
		t.Fatalf("AddFeed f0: %v", err)
	}
	// Batch 1: only feed 0 exists, so the latest idx pack's header freezes at
	// numSlots=1.
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: f0, Title: "a0", Content: "c0", Link: "l0", Published: 1000},
	}); err != nil {
		t.Fatalf("PutArticles batch 1: %v", err)
	}

	// Feed 1 is added only now; its article appends to the SAME latest pack,
	// whose frozen header still says numSlots=1 (id 1 >= numSlots).
	f1 := &Feed{Title: "f1", URL: "https://example.com/1"}
	if err := db.AddFeed(f1); err != nil {
		t.Fatalf("AddFeed f1: %v", err)
	}
	if _, err := db.PutArticles(ctx, []*Item{
		{Feed: f1, Title: "a1", Content: "c1", Link: "l1", Published: 1001},
	}); err != nil {
		t.Fatalf("PutArticles batch 2: %v", err)
	}

	raw, err := db.loadPack(ctx, latestKey(c, "idx"))
	if err != nil {
		t.Fatalf("loadPack: %v", err)
	}
	pack, err := parseIdxPack(raw, 0, c.TotalArticles, feedSlots(c))
	if err != nil {
		t.Fatalf("parseIdxPack: %v", err)
	}
	if pack.numSlots != 1 {
		t.Fatalf("header numSlots = %d, want 1 (frozen at pack start)", pack.numSlots)
	}
	// The bug returned 0 here: feed 1's entry was skipped because id 1 fell
	// beyond the pack's numSlots=1.
	if got := pack.ownFeedCount(1); got != 1 {
		t.Errorf("ownFeedCount(1) = %d, want 1 (feed added after header froze)", got)
	}
	if got := pack.ownFeedCount(0); got != 1 {
		t.Errorf("ownFeedCount(0) = %d, want 1", got)
	}
}
