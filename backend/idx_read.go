package main

import (
	"encoding/binary"
	"fmt"
	"sort"
)

// Read-side mirror of the binary idx pack format (the writer lives in
// db_pack.go). parseIdxPack is the byte-for-byte Go mirror of
// frontend/src/js/idx.ts makeIdxPack().parse(); getPackRef mirrors
// frontend/src/js/data.ts getPackRef(). Every read-side command
// (inspect/check/report, art ls) goes through this one parser, so the
// format has exactly one Go reader to keep in sync with the frontend.

// keyGetter abstracts "fetch + gunzip a store key" so the same read path
// works over a local store handle and a live HTTP CDN.
type keyGetter func(key string) ([]byte, error)

type idxBound struct {
	packID     int
	startChron int
}

type idxPack struct {
	packIndex     int
	packSize      int
	feedIDs       []uint16
	bounds        []idxBound
	packIDBase    uint32
	packOffBase   uint32
	numSlots      int
	feedCounts    []uint32 // cumulative before this pack (len numSlots)
	ownFeedCounts []uint32 // counted during parse (len numSlots)
}

// feedCount returns the cumulative count for id, 0 when id is beyond this
// pack's slots (a feed added after the pack was written).
func (p *idxPack) feedCount(id int) uint32 {
	if id < 0 || id >= p.numSlots {
		return 0
	}
	return p.feedCounts[id]
}

func (p *idxPack) ownFeedCount(id int) uint32 {
	if id < 0 || id >= p.numSlots {
		return 0
	}
	return p.ownFeedCounts[id]
}

// loadIdxPacks fetches and parses every idx pack named by core: the
// finalized numeric names plus the L<seq> latest generation. Returns nil
// for an empty store.
func loadIdxPacks(fetch keyGetter, core *DBCore) ([]*idxPack, error) {
	if core.TotalArticles == 0 {
		return nil, nil
	}
	numFinalized := numFinalizedIdx(core.TotalArticles)
	out := make([]*idxPack, numFinalized+1)
	for p := 0; p <= numFinalized; p++ {
		key, size := idxKeyAndSize(core, p)
		buf, err := fetch(key)
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", key, err)
		}
		pack, err := parseIdxPack(buf, p, size)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		out[p] = pack
	}
	return out, nil
}

// parseIdxPack is the byte-for-byte mirror of
// frontend/src/js/idx.ts makeIdxPack().parse().
func parseIdxPack(buf []byte, packIndex, packSize int) (*idxPack, error) {
	if len(buf) < idxHeaderPrefix {
		return nil, fmt.Errorf("short header: %d < %d", len(buf), idxHeaderPrefix)
	}
	numSlots := int(binary.LittleEndian.Uint32(buf[idxStateSize:]))
	headerSize := idxHeaderPrefix + numSlots*4
	entriesEnd := headerSize + packSize*idxEntrySize
	if len(buf) < entriesEnd {
		return nil, fmt.Errorf("short body: have %d, want >= %d (header+%d entries)", len(buf), entriesEnd, packSize)
	}
	if (len(buf)-entriesEnd)%idxBoundarySize != 0 {
		return nil, fmt.Errorf("idx footer not whole u16 boundaries: %d trailing bytes", len(buf)-entriesEnd)
	}

	pack := &idxPack{
		packIndex:     packIndex,
		packSize:      packSize,
		feedIDs:       make([]uint16, packSize),
		packIDBase:    binary.LittleEndian.Uint32(buf[0:]),
		packOffBase:   binary.LittleEndian.Uint32(buf[4:]),
		numSlots:      numSlots,
		feedCounts:    make([]uint32, numSlots),
		ownFeedCounts: make([]uint32, numSlots),
	}
	for s := range numSlots {
		pack.feedCounts[s] = binary.LittleEndian.Uint32(buf[idxHeaderPrefix+s*4:])
	}

	// Bounds come from the header bases + the boundary footer (the u16 LE local
	// indices at which the data packId advances), reconstructed with the same
	// push condition the old per-entry delta_pack_id decode used.
	boundaries := parseIdxFooter(buf[entriesEnd:])
	packID := int(pack.packIDBase)
	packOff := int(pack.packOffBase)
	baseChron := packIndex * idxPackSize
	if packOff > 0 {
		pack.bounds = append(pack.bounds, idxBound{packID, baseChron - packOff})
	}
	bi := 0
	for i := range packSize {
		off := headerSize + i*idxEntrySize
		sub := uint16(buf[off]) | uint16(buf[off+1])<<8
		pack.feedIDs[i] = sub
		if int(sub) < numSlots {
			pack.ownFeedCounts[sub]++
		}
		if bi < len(boundaries) && boundaries[bi] == i {
			packID++
			bi++
		}
		if len(pack.bounds) == 0 || pack.bounds[len(pack.bounds)-1].packID != packID {
			pack.bounds = append(pack.bounds, idxBound{packID, baseChron + i})
		}
	}
	return pack, nil
}

// getPackRef mirrors frontend/src/js/data.ts getPackRef().
func (p *idxPack) getPackRef(chron int) (packID, offset int) {
	idx := sort.Search(len(p.bounds), func(i int) bool {
		return p.bounds[i].startChron > chron
	}) - 1
	b := p.bounds[idx]
	return b.packID, chron - b.startChron
}

// packIdxFor mirrors frontend/src/js/data.ts packIdx(): the index of the
// idx pack holding chron, clamped to the last pack.
func packIdxFor(chron, n int) int {
	p := chron / idxPackSize
	if p >= n {
		return n - 1
	}
	return p
}
