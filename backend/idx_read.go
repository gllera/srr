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
	chanIDs       []byte
	fetchedAts    []uint32 // per-entry cumulative fetched_at (8h blocks since first_fetched)
	bounds        []idxBound
	fetchedAtBase uint32
	packIDBase    uint32
	packOffBase   uint32
	chanCounts    [idxChanSlots]uint32 // from header (cumulative before this pack)
	ownChanCounts [idxChanSlots]uint32 // counted during parse (in this pack only)
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
		var key string
		if p < numFinalized {
			key = finalizedIdxKey(p)
		} else {
			key = latestKey(core, "idx")
		}
		size := idxPackSize
		if p == numFinalized {
			size = core.TotalArticles - p*idxPackSize
		}
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
	if len(buf) < idxHeaderSize {
		return nil, fmt.Errorf("short header: %d < %d", len(buf), idxHeaderSize)
	}
	expected := idxHeaderSize + packSize*2
	if len(buf) < expected {
		return nil, fmt.Errorf("short body: have %d, want %d (header+%d entries)", len(buf), expected, packSize)
	}

	pack := &idxPack{
		packIndex:     packIndex,
		packSize:      packSize,
		chanIDs:       make([]byte, packSize),
		fetchedAts:    make([]uint32, packSize),
		fetchedAtBase: binary.LittleEndian.Uint32(buf[0:]),
		packIDBase:    binary.LittleEndian.Uint32(buf[4:]),
		packOffBase:   binary.LittleEndian.Uint32(buf[8:]),
	}
	for s := range idxChanSlots {
		pack.chanCounts[s] = binary.LittleEndian.Uint32(buf[idxStateSize+s*4:])
	}

	packID := int(pack.packIDBase)
	packOff := int(pack.packOffBase)
	fetchedAt := pack.fetchedAtBase
	baseChron := packIndex * idxPackSize
	if packOff > 0 {
		pack.bounds = append(pack.bounds, idxBound{packID, baseChron - packOff})
	}
	for i := range packSize {
		off := idxHeaderSize + i*2
		packed := buf[off+1]
		if packed>>7 != 0 {
			packID++
		}
		fetchedAt += uint32(packed & deltaFetchedMax)
		sub := buf[off]
		pack.chanIDs[i] = sub
		pack.fetchedAts[i] = fetchedAt
		pack.ownChanCounts[sub]++
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
