package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

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
	_, err := parseIdxPack(make([]byte, idxHeaderPrefix-1), 0, 1)
	if err == nil || !strings.Contains(err.Error(), "short header") {
		t.Fatalf("want short-header error, got %v", err)
	}
}

func TestParseIdxPackRejectsShortBody(t *testing.T) {
	// Header claims numSlots=1; only 3 of the promised 10 entries are present.
	raw := buildIdxRaw(0, 0, []uint32{0}, []uint16{1, 2, 3}, nil)
	_, err := parseIdxPack(raw, 0, 10)
	if err == nil || !strings.Contains(err.Error(), "short body") {
		t.Fatalf("want short-body error, got %v", err)
	}
}

func TestParseIdxPackRejectsRaggedFooter(t *testing.T) {
	raw := buildIdxRaw(0, 0, []uint32{0}, []uint16{1, 2}, nil)
	raw = append(raw, 0x00) // one stray byte → footer is not a whole u16
	_, err := parseIdxPack(raw, 0, 2)
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
	pack, err := parseIdxPack(raw, 0, 3)
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
