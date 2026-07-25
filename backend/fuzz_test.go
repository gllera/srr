package main

import (
	"bytes"
	"encoding/binary"
	"slices"
	"testing"
)

// Fuzz targets for the two byte-level parsers that read UNTRUSTED store bytes
// (TST4). "Untrusted" is not an exaggeration for either: a public store is
// world-writable in the sense that nothing but the origin's ACL stands between
// an attacker and the bytes, an edge cache can hand back a truncated body, and a
// crash can leave a half-written object under a name a manifest already lists.
// Both parsers therefore have exactly one job on bad input — report an error —
// and exactly one forbidden behavior: panic, or return a structure whose fields
// disagree with the bytes it just accepted.
//
// The seed corpora are the corruption cases the table tests already pin
// (idx_read_test.go, seen_test.go), so the fuzzer starts from the shapes a human
// already thought of and mutates outward from there. Run a smoke pass with
// `make fuzz-be`; CI runs a longer one nightly.

// fuzzIdxSeeds returns the well-formed idx pack the seeds mutate from, plus the
// parse arguments that match it.
func fuzzIdxSeeds() (raw []byte, packSize, slots int) {
	raw = buildIdxRaw(3, 7, []uint32{2, 1}, []uint16{0, 1, 0, 0}, []int{2})
	return raw, 4, 2
}

func FuzzParseIdxPack(f *testing.F) {
	good, packSize, slots := fuzzIdxSeeds()
	f.Add(good, packSize, slots)
	f.Add(good[:idxHeaderPrefix-1], packSize, slots)       // short header
	f.Add(good[:len(good)-1], packSize, slots)             // ragged footer
	f.Add(good[:idxHeaderPrefix+slots*4], packSize, slots) // header only: short body
	f.Add(good, packSize, 0)                               // slot count disagrees with the header
	f.Add([]byte{}, 0, 0)

	f.Fuzz(func(t *testing.T, buf []byte, packSize, slots int) {
		// The reader is only ever handed sizes derived from chron arithmetic, so
		// keep the fuzzer inside that domain rather than burning runs proving
		// that a negative pack size is rejected.
		if packSize < 0 || packSize > idxPackSize || slots < 0 || slots > feedIDCeiling {
			t.Skip()
		}
		p, err := parseIdxPack(buf, 0, packSize, slots)
		if err != nil {
			return
		}
		// Accepted: every field must be consistent with the bytes. A parser that
		// accepts garbage and hands back a plausible-looking pack is worse than
		// one that panics — the reader would then address the WRONG article.
		if p.packSize != packSize {
			t.Fatalf("accepted a pack claiming %d entries, want %d", p.packSize, packSize)
		}
		for i := range packSize {
			if id := int(p.feedIDs[i]); id < 0 || id >= feedIDCeiling {
				t.Fatalf("entry %d has feed id %d, outside [0, %d)", i, id, feedIDCeiling)
			}
		}
		// Bounds are the chron→(dataPack, offset) map. The FIRST one may start
		// below the pack's own base — by exactly packOff_base, the fill of the
		// data pack this idx pack opened inside — which is what makes the
		// subtraction in getPackRef yield the right offset. What must hold is
		// that they ascend and that every chron in the pack resolves to a
		// non-negative offset in an ascending data pack.
		for i, b := range p.bounds {
			if i > 0 && (b.startChron <= p.bounds[i-1].startChron || b.packID <= p.bounds[i-1].packID) {
				t.Fatalf("bounds are not ascending at %d: (%d,%d) after (%d,%d)",
					i, b.packID, b.startChron, p.bounds[i-1].packID, p.bounds[i-1].startChron)
			}
		}
		for chron := range packSize {
			if _, off := p.getPackRef(chron); off < 0 {
				t.Fatalf("chron %d resolves to a negative data-pack offset %d", chron, off)
			}
		}
	})
}

// FuzzIdxWriteParse is the round-trip half: whatever the WRITER emits, the
// reader must read back exactly. It is the property `make verify` cannot state
// as a table — the two sides are byte-for-byte mirrors (db_pack.go writeIdx* vs
// idx_read.go parseIdxPack), and a symmetric bug in both would pass every
// hand-written case while silently misaddressing a real store.
func FuzzIdxWriteParse(f *testing.F) {
	f.Add([]byte{0, 1, 0, 2}, []byte{2})
	f.Add([]byte{}, []byte{})
	f.Add([]byte{5}, []byte{0})

	f.Fuzz(func(t *testing.T, feedBytes, boundBytes []byte) {
		// One feed id per byte of feedBytes, one boundary per byte of
		// boundBytes, both kept small so a run explores SHAPES rather than sizes.
		if len(feedBytes) > 512 || len(boundBytes) > 64 {
			t.Skip()
		}
		feeds := make([]uint16, len(feedBytes))
		maxID := 0
		for i, b := range feedBytes {
			feeds[i] = uint16(b)
			maxID = max(maxID, int(b))
		}
		// Boundaries must be ascending, in range and unique — the writer only
		// ever emits them that way (it appends one as the data packId advances),
		// so feeding it anything else would fuzz a shape no store can hold.
		seen := map[int]bool{}
		var bounds []int
		for _, b := range boundBytes {
			at := int(b) % (len(feeds) + 1)
			if !seen[at] {
				seen[at] = true
				bounds = append(bounds, at)
			}
		}
		slices.Sort(bounds)

		counts := make([]uint32, maxID+1)
		for _, id := range feeds {
			counts[id]++
		}
		raw := buildIdxRaw(11, 23, counts, feeds, bounds)

		p, err := parseIdxPack(raw, 0, len(feeds), len(counts))
		if err != nil {
			t.Fatalf("the reader rejected bytes the writer's own layout produced: %v", err)
		}
		for i, want := range feeds {
			if got := p.feedIDs[i]; got != want {
				t.Fatalf("entry %d round-tripped as feed %d, want %d", i, got, want)
			}
		}
		// The footer round-trips through the writer's own encoder too.
		var buf bytes.Buffer
		for _, at := range bounds {
			_ = binary.Write(&buf, binary.LittleEndian, uint16(at))
		}
		if got := parseIdxFooter(buf.Bytes()); len(got) != len(bounds) {
			t.Fatalf("footer round-trip lost boundaries: %d, want %d", len(got), len(bounds))
		}
	})
}

// FuzzParseSeen guards the dedup sidecar's binary decoder. A corrupt seen.gz
// must degrade to an empty pool (loadSeen's contract — never an article loss),
// which is only safe while parseSeen reliably says "no" instead of panicking on
// a length prefix it read out of attacker-influenced bytes.
func FuzzParseSeen(f *testing.F) {
	valid := newSeenPool()
	valid.stamp(1, 0x1234, 50)
	valid.stamp(2, 0xfeed, 51)
	valid.feed[1] = feedState{etag: `"e"`, lastMod: "lm"}
	good := valid.marshal()

	f.Add(good)
	f.Add([]byte{})
	f.Add([]byte("SEEN"))
	f.Add(append([]byte("XXXX"), good[4:]...))
	f.Add(append([]byte("SEEN"), append([]byte{99}, good[5:]...)...))
	f.Add(good[:len(good)-1])
	f.Add(append(append([]byte(nil), good...), 0))

	f.Fuzz(func(t *testing.T, data []byte) {
		p, err := parseSeen(data)
		if err != nil {
			return
		}
		if p == nil {
			t.Fatal("parseSeen returned (nil, nil)")
		}
		// Accepted bytes must re-encode and re-parse: the pool is written back
		// every dirty cycle, so anything parseSeen accepts, marshal must be able
		// to state again without losing or corrupting an entry.
		again, err := parseSeen(p.marshal())
		if err != nil {
			t.Fatalf("re-parsing a pool this parser accepted failed: %v", err)
		}
		if len(again.m) != len(p.m) || len(again.feed) != len(p.feed) {
			t.Fatalf("round-trip changed the pool: %d/%d entries, want %d/%d",
				len(again.m), len(again.feed), len(p.m), len(p.feed))
		}
	})
}
