import { describe, it, expect } from "vitest"
import { IDX_BOUNDARY_SIZE, IDX_ENTRY_SIZE, IDX_HEADER_PREFIX, IDX_STATE_SIZE } from "./format.gen"
import { IDX_PACK_SIZE, makeFeedsLookup, makeIdxPack, parseIdxHeaders } from "./idx"

// The scan methods take the prebuilt reverse lookup data.ts hoists once per nav
// call; tests build it from the same feeds Map at SLOTS width.
const lk = (feeds: Map<number, number>): Int32Array => makeFeedsLookup(feeds, SLOTS)

interface Entry {
   feedId: number
   // deltaPackId marks this entry as a data-pack boundary: buildBuf collects the
   // local indices of such entries into the u16 LE footer (the wire form).
   deltaPackId: 0 | 1
}

interface PackOpts {
   packIdBase?: number
   packOffBase?: number
   feedCounts?: Record<number, number>
   // numSlots override; defaults to (high-water feedCount id) + 1.
   numSlots?: number
   entries: Entry[]
}

// SLOTS is the per-pack feed lookup size passed to makeIdxPack: the store
// high-water + 1 in production. Tests use a fixed generous value.
const SLOTS = 256

// numSlots a built header carries: explicit override, else dense up to the
// highest feedCount key (+1), else 0.
function headerSlots(o: Pick<PackOpts, "feedCounts" | "numSlots">): number {
   if (o.numSlots !== undefined) return o.numSlots
   const keys = Object.keys(o.feedCounts ?? {}).map(Number)
   return keys.length > 0 ? Math.max(...keys) + 1 : 0
}

// buildBuf assembles a v2 idx pack: header (prefix [packIdBase, packOffBase,
// numSlots] + feedCounts) ‖ 2-byte feed_id entries ‖ u16 LE boundary footer
// (the local indices of entries flagged deltaPackId=1).
function buildBuf(o: PackOpts): ArrayBuffer {
   const numSlots = headerSlots(o)
   const headerSize = IDX_HEADER_PREFIX + numSlots * 4
   const boundaries: number[] = []
   o.entries.forEach((e, i) => {
      if (e.deltaPackId) boundaries.push(i)
   })
   const buf = new ArrayBuffer(headerSize + o.entries.length * IDX_ENTRY_SIZE + boundaries.length * IDX_BOUNDARY_SIZE)
   const view = new DataView(buf)
   view.setUint32(0, o.packIdBase ?? 0, true)
   view.setUint32(4, o.packOffBase ?? 0, true)
   view.setUint32(IDX_STATE_SIZE, numSlots, true)
   for (const [k, v] of Object.entries(o.feedCounts ?? {})) {
      view.setUint32(IDX_HEADER_PREFIX + Number(k) * 4, v, true)
   }
   const bytes = new Uint8Array(buf)
   for (let i = 0; i < o.entries.length; i++) {
      const off = headerSize + i * IDX_ENTRY_SIZE
      bytes[off] = o.entries[i].feedId & 0xff
      bytes[off + 1] = (o.entries[i].feedId >> 8) & 0xff
   }
   let foff = headerSize + o.entries.length * IDX_ENTRY_SIZE
   for (const b of boundaries) {
      view.setUint16(foff, b, true)
      foff += IDX_BOUNDARY_SIZE
   }
   return buf
}

const e = (feedId: number, deltaPackId: 0 | 1 = 0): Entry => ({ feedId, deltaPackId })

describe("IDX_PACK_SIZE", () => {
   it("is 50000", () => {
      expect(IDX_PACK_SIZE).toBe(50000)
   })
})

describe("makeIdxPack.parse", () => {
   it("decodes feedIds in order", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(3)] })
      const pack = makeIdxPack(buf, 0, 3, SLOTS).parse()
      expect(Array.from(pack.feedIds)).toEqual([1, 2, 3])
   })

   it("decodes u16 feed_ids beyond the old 255 ceiling", () => {
      // The widen: a feed_id is a little-endian uint16, so ids 256..65535 must
      // round-trip and count into ownFeedCounts at their full value (the
      // lookup arrays are sized to the store high-water, here 65536).
      const wide = 65536
      const buf = buildBuf({ numSlots: 1000, entries: [e(300), e(65535), e(300)] })
      const pack = makeIdxPack(buf, 0, 3, wide).parse()
      expect(Array.from(pack.feedIds)).toEqual([300, 65535, 300])
      expect(pack.ownFeedCounts[300]).toBe(2)
      expect(pack.ownFeedCounts[65535]).toBe(1)
   })

   it("populates ownFeedCounts from entries", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(1), e(1), e(3)] })
      const pack = makeIdxPack(buf, 0, 5, SLOTS).parse()
      expect(pack.ownFeedCounts[1]).toBe(3)
      expect(pack.ownFeedCounts[2]).toBe(1)
      expect(pack.ownFeedCounts[3]).toBe(1)
      expect(pack.ownFeedCounts[0]).toBe(0)
      expect(pack.ownFeedCounts[42]).toBe(0)
   })

   it("copies feedCounts header verbatim", () => {
      const buf = buildBuf({
         feedCounts: { 1: 100, 2: 50, 255: 7 },
         entries: [],
      })
      const pack = makeIdxPack(buf, 0, 0, SLOTS).parse()
      expect(pack.header.feedCounts[0]).toBe(0)
      expect(pack.header.feedCounts[1]).toBe(100)
      expect(pack.header.feedCounts[2]).toBe(50)
      expect(pack.header.feedCounts[255]).toBe(7)
   })

   it("exposes the full header before parse() is called", () => {
      const buf = buildBuf({
         packIdBase: 7,
         packOffBase: 3,
         feedCounts: { 5: 11 },
         entries: [e(1, 1)],
      })
      const pack = makeIdxPack(buf, 0, 1, SLOTS)
      expect(pack.header.packIdBase).toBe(7)
      expect(pack.header.packOffBase).toBe(3)
      expect(pack.header.feedCounts[5]).toBe(11)
      // Entry-derived state must still be untouched (parse not forced).
      expect(pack.feedIds.length).toBe(0)
      expect(pack.bounds.length).toBe(0)
   })

   it("is idempotent across repeated calls", () => {
      const buf = buildBuf({ entries: [e(1), e(2)] })
      const pack = makeIdxPack(buf, 0, 2, SLOTS)
      const a = pack.parse()
      const b = pack.parse()
      expect(a).toBe(b)
      expect(Array.from(a.feedIds)).toEqual([1, 2])
   })

   it("uses packIndex to compute baseChron in bounds", () => {
      const buf = buildBuf({ entries: [e(1)] })
      const pack = makeIdxPack(buf, 2, 1, SLOTS).parse()
      expect(pack.bounds[0]).toEqual({ packId: 0, startChron: 2 * IDX_PACK_SIZE })
   })

   it("emits an initial bound with negative startChron when packOffBase > 0", () => {
      const buf = buildBuf({
         packIdBase: 5,
         packOffBase: 10,
         entries: [e(1)],
      })
      const pack = makeIdxPack(buf, 0, 1, SLOTS).parse()
      expect(pack.bounds[0]).toEqual({ packId: 5, startChron: -10 })
   })

   it("advances packId on a footer boundary and adds a new bound", () => {
      const buf = buildBuf({
         packIdBase: 5,
         packOffBase: 0,
         entries: [e(1), e(2, 1), e(3)],
      })
      const pack = makeIdxPack(buf, 0, 3, SLOTS).parse()
      expect(pack.bounds.length).toBe(2)
      expect(pack.bounds[0]).toEqual({ packId: 5, startChron: 0 })
      expect(pack.bounds[1]).toEqual({ packId: 6, startChron: 1 })
   })

   it("rejects a buffer shorter than header + packSize*IDX_ENTRY_SIZE", () => {
      const buf = buildBuf({ entries: [e(1), e(2)] })
      expect(() => makeIdxPack(buf, 0, 7, SLOTS)).toThrow(/short body/)
   })

   it("rejects a footer whose trailing bytes are not whole u16 boundaries", () => {
      // Mirror of the Go side's parseIdxPack guard (idx_read_test.go
      // TestParseIdxPackRejectsRaggedFooter): one stray byte past header+entries
      // can't be a complete u16 boundary, so the pack is corrupt.
      const base = buildBuf({ entries: [e(1), e(2)] })
      const ragged = new Uint8Array(base.byteLength + 1)
      ragged.set(new Uint8Array(base))
      expect(() => makeIdxPack(ragged.buffer, 0, 2, SLOTS)).toThrow(/footer not whole u16 boundaries/)
   })

   it("ignores trailing entries past packSize (a stale SW cache may hold a longer body)", () => {
      // The body carries 5 entries but db.gz says this pack holds 3 — parsing
      // must stop at packSize so the ghost rows don't skew feedIds/bounds/counts.
      const buf = buildBuf({ entries: [e(1), e(2), e(3), e(4), e(5)] })
      const pack = makeIdxPack(buf, 0, 3, SLOTS).parse()
      expect(Array.from(pack.feedIds)).toEqual([1, 2, 3])
   })
})

describe("makeIdxPack.findLeft", () => {
   const buildPack = () => makeIdxPack(buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] }), 0, 5, SLOTS)

   it("returns the rightmost match scanning leftward from chronFrom", () => {
      const pack = buildPack()
      const feeds = new Map([[1, 0]])
      expect(pack.findLeft(4, feeds, lk(feeds))).toBe(4)
      expect(pack.findLeft(3, feeds, lk(feeds))).toBe(2)
      expect(pack.findLeft(1, feeds, lk(feeds))).toBe(0)
   })

   it("respects sub addIdx (entries before addIdx don't match)", () => {
      const pack = buildPack()
      const feeds = new Map([[1, 3]])
      expect(pack.findLeft(4, feeds, lk(feeds))).toBe(4)
      expect(pack.findLeft(2, feeds, lk(feeds))).toBe(-1)
   })

   it("returns -1 when no sub matches", () => {
      const pack = buildPack()
      const feeds = new Map([[99, 0]])
      expect(pack.findLeft(4, feeds, lk(feeds))).toBe(-1)
   })

   it("returns -1 when chronFrom < baseChron", () => {
      const buf = buildBuf({ entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      expect(pack.findLeft(IDX_PACK_SIZE - 1, feeds, lk(feeds))).toBe(-1)
   })
})

describe("makeIdxPack.findRight", () => {
   const buildPack = () => makeIdxPack(buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] }), 0, 5, SLOTS)

   it("returns the leftmost match scanning rightward from chronFrom", () => {
      const pack = buildPack()
      const feeds = new Map([[1, 0]])
      expect(pack.findRight(0, feeds, lk(feeds))).toBe(0)
      expect(pack.findRight(1, feeds, lk(feeds))).toBe(2)
      expect(pack.findRight(3, feeds, lk(feeds))).toBe(4)
   })

   it("respects sub addIdx", () => {
      const pack = buildPack()
      const feeds = new Map([[1, 3]])
      expect(pack.findRight(0, feeds, lk(feeds))).toBe(4)
   })

   it("returns -1 when no sub matches addIdx within pack", () => {
      const buf = buildBuf({ entries: [e(1), e(1), e(1)] })
      const pack = makeIdxPack(buf, 0, 3, SLOTS)
      const feeds = new Map([[1, 5]])
      expect(pack.findRight(0, feeds, lk(feeds))).toBe(-1)
   })

   it("returns -1 when no sub matches", () => {
      const pack = buildPack()
      const feeds = new Map([[99, 0]])
      expect(pack.findRight(0, feeds, lk(feeds))).toBe(-1)
   })
})

describe("makeIdxPack.countLeft", () => {
   it("counts matching entries strictly left of chronIdx", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] })
      const pack = makeIdxPack(buf, 0, 5, SLOTS)
      const feeds = new Map([[1, 0]])
      expect(pack.countLeft(0, feeds, lk(feeds))).toBe(0)
      expect(pack.countLeft(4, feeds, lk(feeds))).toBe(2)
      expect(pack.countLeft(5, feeds, lk(feeds))).toBe(3)
   })

   it("respects sub addIdx", () => {
      const buf = buildBuf({ entries: [e(1), e(1), e(1)] })
      const pack = makeIdxPack(buf, 0, 3, SLOTS)
      const feeds = new Map([[1, 1]])
      expect(pack.countLeft(3, feeds, lk(feeds))).toBe(2)
   })

   it("uses feedCounts header for entries in earlier packs", () => {
      const buf = buildBuf({
         feedCounts: { 1: 200 },
         entries: [e(1)],
      })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      // baseChron = 1 * IDX_PACK_SIZE; addIdx (0) < baseChron, so prior count = 200
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds))).toBe(200)
      expect(pack.countLeft(IDX_PACK_SIZE + 1, feeds, lk(feeds))).toBe(201)
   })

   it("clamps limit at packSize so chronIdx past the pack still works", () => {
      const buf = buildBuf({ entries: [e(1), e(1), e(1)] })
      const pack = makeIdxPack(buf, 0, 3, SLOTS)
      const feeds = new Map([[1, 0]])
      expect(pack.countLeft(99999, feeds, lk(feeds))).toBe(3)
   })

   it("subtracts per-feed expired from the header shortcut", () => {
      const buf = buildBuf({ feedCounts: { 1: 200 }, entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      const xp = new Uint32Array(SLOTS)
      xp[1] = 40
      // 200 all-time in earlier packs − 40 expired = 160 visible, +1 own entry
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds), xp)).toBe(160)
      expect(pack.countLeft(IDX_PACK_SIZE + 1, feeds, lk(feeds), xp)).toBe(161)
   })

   it("clamps a corrected prior count at 0", () => {
      const buf = buildBuf({ feedCounts: { 1: 10 }, entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      const xp = new Uint32Array(SLOTS)
      xp[1] = 999 // defensive: corrupt xp must not go negative
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds), xp)).toBe(0)
   })

   it("without an expired lookup keeps today's counts", () => {
      const buf = buildBuf({ feedCounts: { 1: 200 }, entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds))).toBe(200)
   })
})

// idx/h<N>.gz is the verbatim concatenation of finalized-pack headers, each
// variable-length (its own numSlots). Concatenate the entry-less buildBuf
// outputs so the strides match what parseIdxHeaders walks.
function buildSummary(headers: Omit<PackOpts, "entries">[]): ArrayBuffer {
   const parts = headers.map((h) => new Uint8Array(buildBuf({ ...h, entries: [] })))
   const total = parts.reduce((n, p) => n + p.byteLength, 0)
   const out = new Uint8Array(total)
   let off = 0
   for (const p of parts) {
      out.set(p, off)
      off += p.byteLength
   }
   return out.buffer
}

describe("parseIdxHeaders", () => {
   it("decodes each variable-length chunk by its own numSlots", () => {
      const buf = buildSummary([
         { packIdBase: 1, packOffBase: 0 },
         { packIdBase: 4, packOffBase: 2, feedCounts: { 1: 50000 } },
      ])
      const hs = parseIdxHeaders(buf, 2)
      expect(hs.length).toBe(2)
      expect(hs[0].packIdBase).toBe(1)
      expect(hs[0].numSlots).toBe(0)
      expect(hs[1].packIdBase).toBe(4)
      expect(hs[1].packOffBase).toBe(2)
      expect(hs[1].numSlots).toBe(2)
      expect(hs[1].feedCounts[1]).toBe(50000)
      expect(hs[1].feedCounts[0]).toBe(0)
   })

   it("rejects a size mismatch", () => {
      // One header in the buffer but count=2 → the walk runs off the end.
      const buf = buildSummary([{}])
      expect(() => parseIdxHeaders(buf, 2)).toThrow(/summary/)
      // A buffer shorter than even one header's prefix.
      expect(() => parseIdxHeaders(buf.slice(0, 10), 1)).toThrow(/summary/)
      // Trailing bytes past the last header (count too low for the buffer).
      const padded = new Uint8Array(buf.byteLength + 8)
      padded.set(new Uint8Array(buf))
      expect(() => parseIdxHeaders(padded.buffer, 1)).toThrow(/summary/)
   })
})
