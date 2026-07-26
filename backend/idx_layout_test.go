package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// The generated idx codec (idx_layout.gen.go, emitted from idx_layout.go) is
// now the ONLY implementation of the binary layout on the Go side, and the TS
// reader runs the same declaration's other output. These tests are the two
// things a generator cannot prove about itself: that the offsets it derived
// still equal the format atoms the reader imports (db.go / format.gen.ts), and
// that the bytes it emits are the bytes an independent hand-written spec says.

// TestIdxLayoutGeometryMatchesFormatAtoms ties the generated arithmetic to the
// constants gen-ts exports to the frontend. They come from one declaration
// today — the layout table's widths ARE those constants — but that is exactly
// the kind of link a future edit can quietly cut, and cutting it would move
// every idx offset the reader computes.
func TestIdxLayoutGeometryMatchesFormatAtoms(t *testing.T) {
	if got := idxHeaderEnd(0); got != idxHeaderPrefix {
		t.Errorf("idxHeaderEnd(0) = %d, want idxHeaderPrefix = %d", got, idxHeaderPrefix)
	}
	// One cumulative count per slot, 4 bytes each — the stride idx.ts's summary
	// walk and readIdxHeader both advance by.
	if got := idxHeaderEnd(7) - idxHeaderEnd(0); got != 7*4 {
		t.Errorf("7 header counts span %d bytes, want %d", got, 7*4)
	}
	if got := idxEntriesEnd(3, 11) - idxHeaderEnd(3); got != 11*idxEntrySize {
		t.Errorf("11 entries span %d bytes, want %d", got, 11*idxEntrySize)
	}
	// numSlots is the third state u32: the reader peeks it after exactly
	// idxStateSize bytes, before it can know how long the header is.
	prefix := make([]byte, idxHeaderPrefix)
	binary.LittleEndian.PutUint32(prefix[idxStateSize:], 42)
	got, err := idxNumSlots(prefix)
	if err != nil || got != 42 {
		t.Errorf("idxNumSlots = (%d, %v), want (42, nil) — the numSlots field moved off idxStateSize", got, err)
	}
	if _, err := idxNumSlots(prefix[:idxHeaderPrefix-1]); err == nil {
		t.Error("idxNumSlots accepted a buffer shorter than the fixed prefix")
	}
	// A footer element is one u16 boundary; idxValidate's ragged check keys on
	// exactly that width.
	if err := idxValidate(idxEntriesEnd(1, 2)+idxBoundarySize, 1, 2); err != nil {
		t.Errorf("a whole trailing boundary was rejected: %v", err)
	}
	if err := idxValidate(idxEntriesEnd(1, 2)+idxBoundarySize-1, 1, 2); err == nil {
		t.Error("a partial trailing boundary was accepted")
	}
}

// TestIdxLayoutEncodeMatchesHandBuiltPack pins the generated ENCODERS against
// buildIdxRaw — the hand-written pack builder the reader-guard tests use, which
// spells the layout out byte by byte from the format atoms and shares no code
// with the generator. If the two agree, the generator is emitting the format
// the contract documents rather than a self-consistent one of its own.
func TestIdxLayoutEncodeMatchesHandBuiltPack(t *testing.T) {
	cases := []struct {
		name       string
		packID     uint32
		packOff    uint32
		counts     []uint32
		entries    []uint16
		boundaries []int
	}{
		{"empty store", 0, 0, nil, nil, nil},
		{"one feed", 3, 7, []uint32{2, 1}, []uint16{0, 1, 0, 0}, []int{2}},
		{"high feed ids", 11, 0, []uint32{0, 0, 5}, []uint16{2, 65535, 2}, []int{0, 2}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			want := buildIdxRaw(c.packID, c.packOff, c.counts, c.entries, c.boundaries)

			got := idxAppendHeader(nil, c.packID, c.packOff, c.counts)
			for _, id := range c.entries {
				got = idxAppendEntry(got, id)
			}
			got = idxAppendFooter(got, c.boundaries)
			if !bytes.Equal(got, want) {
				t.Fatalf("generated encoder emitted %v, the hand-written layout says %v", got, want)
			}

			raw, err := idxDecode(got, len(c.entries))
			if err != nil {
				t.Fatalf("the generated decoder rejected the generated encoder's bytes: %v", err)
			}
			if raw.PackIDBase != c.packID || raw.PackOffBase != c.packOff || raw.NumSlots != len(c.counts) {
				t.Errorf("header round-tripped as (%d,%d,%d), want (%d,%d,%d)",
					raw.PackIDBase, raw.PackOffBase, raw.NumSlots, c.packID, c.packOff, len(c.counts))
			}
			for i, n := range c.counts {
				if raw.FeedCounts[i] != n {
					t.Errorf("feedCounts[%d] = %d, want %d", i, raw.FeedCounts[i], n)
				}
			}
			for i, id := range c.entries {
				if raw.FeedIDs[i] != id {
					t.Errorf("feedIDs[%d] = %d, want %d", i, raw.FeedIDs[i], id)
				}
			}
			if len(raw.Boundaries) != len(c.boundaries) {
				t.Fatalf("boundaries round-tripped as %v, want %v", raw.Boundaries, c.boundaries)
			}
			for i, b := range c.boundaries {
				if raw.Boundaries[i] != b {
					t.Errorf("boundaries[%d] = %d, want %d", i, raw.Boundaries[i], b)
				}
			}
		})
	}
}

// TestPlanLayoutRejectsUnrepresentableShapes pins the generator's own guard
// rail: a declaration it cannot express must fail at generate time, never emit
// a parser that silently reads the wrong bytes.
func TestPlanLayoutRejectsUnrepresentableShapes(t *testing.T) {
	base := func() binLayout { return idxLayout }

	t.Run("scalar after a variable field", func(t *testing.T) {
		l := base()
		l.Header = append(append([]binField{}, l.Header...),
			binField{Name: "Trailer", TS: "trailer", Width: 4, Endian: binLE, Count: countOne})
		if _, err := planLayout(l); err == nil {
			t.Error("accepted a scalar declared after a variable-length header field")
		}
	})
	t.Run("count field naming a non-scalar", func(t *testing.T) {
		l := base()
		hdr := append([]binField{}, l.Header...)
		hdr[3].From = "Nope"
		l.Header = hdr
		if _, err := planLayout(l); err == nil {
			t.Error("accepted a count source that is not an earlier scalar")
		}
	})
	t.Run("unsupported element width", func(t *testing.T) {
		l := base()
		l.Entry.Width = 3
		if _, err := planLayout(l); err == nil {
			t.Error("accepted a 3-byte element width")
		}
	})
	t.Run("footer that is not countRest", func(t *testing.T) {
		l := base()
		l.Footer.Count = countArg
		if _, err := planLayout(l); err == nil {
			t.Error("accepted a footer whose length is not implicit")
		}
	})
	if _, err := planLayout(base()); err != nil {
		t.Fatalf("the shipped declaration no longer plans: %v", err)
	}
}
