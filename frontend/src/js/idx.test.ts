import { describe, it, expect } from "vitest"
import { IDX_HEADER_SIZE } from "./format.gen"
import { findPackForBlocks, IDX_PACK_SIZE, makeIdxPack, parseIdxHeaders, type IdxHeader } from "./idx"

interface Entry {
   chanId: number
   deltaPackId: 0 | 1
   deltaFetchedAt: number
}

interface PackOpts {
   fetchedAtBase?: number
   packIdBase?: number
   packOffBase?: number
   chanCounts?: Record<number, number>
   entries: Entry[]
}

function buildBuf(o: PackOpts): ArrayBuffer {
   const buf = new ArrayBuffer(IDX_HEADER_SIZE + o.entries.length * 2)
   const view = new DataView(buf)
   view.setUint32(0, o.fetchedAtBase ?? 0, true)
   view.setUint32(4, o.packIdBase ?? 0, true)
   view.setUint32(8, o.packOffBase ?? 0, true)
   for (const [k, v] of Object.entries(o.chanCounts ?? {})) {
      view.setUint32(12 + Number(k) * 4, v, true)
   }
   const bytes = new Uint8Array(buf)
   for (let i = 0; i < o.entries.length; i++) {
      const e = o.entries[i]
      bytes[IDX_HEADER_SIZE + i * 2] = e.chanId
      bytes[IDX_HEADER_SIZE + i * 2 + 1] = (e.deltaPackId << 7) | (e.deltaFetchedAt & 0x7f)
   }
   return buf
}

const e = (chanId: number, deltaPackId: 0 | 1 = 0, deltaFetchedAt = 0): Entry => ({
   chanId,
   deltaPackId,
   deltaFetchedAt,
})

describe("IDX_PACK_SIZE", () => {
   it("is 50000", () => {
      expect(IDX_PACK_SIZE).toBe(50000)
   })
})

describe("makeIdxPack.parse", () => {
   it("decodes chanIds in order", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(3)] })
      const pack = makeIdxPack(buf, 0, 3).parse()
      expect(Array.from(pack.chanIds)).toEqual([1, 2, 3])
   })

   it("accumulates fetchedAt from header base plus deltas", () => {
      const buf = buildBuf({
         fetchedAtBase: 100,
         entries: [e(1, 0, 5), e(2, 0, 3), e(3, 0, 7)],
      })
      const pack = makeIdxPack(buf, 0, 3).parse()
      expect(Array.from(pack.fetchedAts)).toEqual([105, 108, 115])
   })

   it("preserves max 7-bit delta (127)", () => {
      const buf = buildBuf({
         fetchedAtBase: 0,
         entries: [e(1, 0, 127), e(2, 0, 127)],
      })
      const pack = makeIdxPack(buf, 0, 2).parse()
      expect(Array.from(pack.fetchedAts)).toEqual([127, 254])
   })

   it("accumulates fetchedAt across a large in-range base", () => {
      // fetchedAt is 8h-blocks since first_fetched, stored as Uint16. The
      // ceiling (65535 blocks ≈ 60y of calendar time from the first fetch)
      // is far beyond any real horizon, so a large base still round-trips.
      const buf = buildBuf({ fetchedAtBase: 60000, entries: [e(1, 0, 5)] })
      const pack = makeIdxPack(buf, 0, 1).parse()
      expect(pack.fetchedAts[0]).toBe(60005)
   })

   it("populates ownChanCounts from entries", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(1), e(1), e(3)] })
      const pack = makeIdxPack(buf, 0, 5).parse()
      expect(pack.ownChanCounts[1]).toBe(3)
      expect(pack.ownChanCounts[2]).toBe(1)
      expect(pack.ownChanCounts[3]).toBe(1)
      expect(pack.ownChanCounts[0]).toBe(0)
      expect(pack.ownChanCounts[42]).toBe(0)
   })

   it("copies chanCounts header verbatim", () => {
      const buf = buildBuf({
         chanCounts: { 1: 100, 2: 50, 255: 7 },
         entries: [],
      })
      const pack = makeIdxPack(buf, 0, 0).parse()
      expect(pack.header.chanCounts[0]).toBe(0)
      expect(pack.header.chanCounts[1]).toBe(100)
      expect(pack.header.chanCounts[2]).toBe(50)
      expect(pack.header.chanCounts[255]).toBe(7)
   })

   it("exposes the full header before parse() is called", () => {
      const buf = buildBuf({
         fetchedAtBase: 42,
         packIdBase: 7,
         packOffBase: 3,
         chanCounts: { 5: 11 },
         entries: [e(1, 1, 2)],
      })
      const pack = makeIdxPack(buf, 0, 1)
      expect(pack.header.fetchedAtBase).toBe(42)
      expect(pack.header.packIdBase).toBe(7)
      expect(pack.header.packOffBase).toBe(3)
      expect(pack.header.chanCounts[5]).toBe(11)
      // Entry-derived state must still be untouched (parse not forced).
      expect(pack.chanIds.length).toBe(0)
      expect(pack.bounds.length).toBe(0)
   })

   it("is idempotent across repeated calls", () => {
      const buf = buildBuf({ entries: [e(1), e(2)] })
      const pack = makeIdxPack(buf, 0, 2)
      const a = pack.parse()
      const b = pack.parse()
      expect(a).toBe(b)
      expect(Array.from(a.chanIds)).toEqual([1, 2])
   })

   it("uses packIndex to compute baseChron in bounds", () => {
      const buf = buildBuf({ entries: [e(1)] })
      const pack = makeIdxPack(buf, 2, 1).parse()
      expect(pack.bounds[0]).toEqual({ packId: 0, startChron: 2 * IDX_PACK_SIZE })
   })

   it("emits an initial bound with negative startChron when packOffBase > 0", () => {
      const buf = buildBuf({
         packIdBase: 5,
         packOffBase: 10,
         entries: [e(1)],
      })
      const pack = makeIdxPack(buf, 0, 1).parse()
      expect(pack.bounds[0]).toEqual({ packId: 5, startChron: -10 })
   })

   it("advances packId on the delta_pack_id bit and adds a new bound", () => {
      const buf = buildBuf({
         packIdBase: 5,
         packOffBase: 0,
         entries: [e(1, 0, 0), e(2, 1, 0), e(3, 0, 0)],
      })
      const pack = makeIdxPack(buf, 0, 3).parse()
      expect(pack.bounds.length).toBe(2)
      expect(pack.bounds[0]).toEqual({ packId: 5, startChron: 0 })
      expect(pack.bounds[1]).toEqual({ packId: 6, startChron: 1 })
   })

   it("rejects a buffer shorter than header + packSize*2", () => {
      const buf = buildBuf({ entries: [e(1), e(2)] })
      expect(() => makeIdxPack(buf, 0, 7)).toThrow(/short body/)
   })
})

describe("makeIdxPack.findLeft", () => {
   const buildPack = () => makeIdxPack(buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] }), 0, 5)

   it("returns the rightmost match scanning leftward from chronFrom", () => {
      const pack = buildPack()
      const channels = new Map([[1, 0]])
      expect(pack.findLeft(4, channels)).toBe(4)
      expect(pack.findLeft(3, channels)).toBe(2)
      expect(pack.findLeft(1, channels)).toBe(0)
   })

   it("respects sub addIdx (entries before addIdx don't match)", () => {
      const pack = buildPack()
      const channels = new Map([[1, 3]])
      expect(pack.findLeft(4, channels)).toBe(4)
      expect(pack.findLeft(2, channels)).toBe(-1)
   })

   it("returns -1 when no sub matches", () => {
      const pack = buildPack()
      expect(pack.findLeft(4, new Map([[99, 0]]))).toBe(-1)
   })

   it("returns -1 when chronFrom < baseChron", () => {
      const buf = buildBuf({ entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1)
      expect(pack.findLeft(IDX_PACK_SIZE - 1, new Map([[1, 0]]))).toBe(-1)
   })
})

describe("makeIdxPack.findRight", () => {
   const buildPack = () => makeIdxPack(buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] }), 0, 5)

   it("returns the leftmost match scanning rightward from chronFrom", () => {
      const pack = buildPack()
      const channels = new Map([[1, 0]])
      expect(pack.findRight(0, channels)).toBe(0)
      expect(pack.findRight(1, channels)).toBe(2)
      expect(pack.findRight(3, channels)).toBe(4)
   })

   it("respects sub addIdx", () => {
      const pack = buildPack()
      expect(pack.findRight(0, new Map([[1, 3]]))).toBe(4)
   })

   it("returns -1 when no sub matches addIdx within pack", () => {
      const buf = buildBuf({ entries: [e(1), e(1), e(1)] })
      const pack = makeIdxPack(buf, 0, 3)
      expect(pack.findRight(0, new Map([[1, 5]]))).toBe(-1)
   })

   it("returns -1 when no sub matches", () => {
      const pack = buildPack()
      expect(pack.findRight(0, new Map([[99, 0]]))).toBe(-1)
   })
})

describe("makeIdxPack.countLeft", () => {
   it("counts matching entries strictly left of chronIdx", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] })
      const pack = makeIdxPack(buf, 0, 5)
      expect(pack.countLeft(0, new Map([[1, 0]]))).toBe(0)
      expect(pack.countLeft(4, new Map([[1, 0]]))).toBe(2)
      expect(pack.countLeft(5, new Map([[1, 0]]))).toBe(3)
   })

   it("respects sub addIdx", () => {
      const buf = buildBuf({ entries: [e(1), e(1), e(1)] })
      const pack = makeIdxPack(buf, 0, 3)
      expect(pack.countLeft(3, new Map([[1, 1]]))).toBe(2)
   })

   it("uses chanCounts header for entries in earlier packs", () => {
      const buf = buildBuf({
         chanCounts: { 1: 200 },
         entries: [e(1)],
      })
      const pack = makeIdxPack(buf, 1, 1)
      // baseChron = 1 * IDX_PACK_SIZE; addIdx (0) < baseChron, so prior count = 200
      expect(pack.countLeft(IDX_PACK_SIZE, new Map([[1, 0]]))).toBe(200)
      expect(pack.countLeft(IDX_PACK_SIZE + 1, new Map([[1, 0]]))).toBe(201)
   })

   it("clamps limit at packSize so chronIdx past the pack still works", () => {
      const buf = buildBuf({ entries: [e(1), e(1), e(1)] })
      const pack = makeIdxPack(buf, 0, 3)
      expect(pack.countLeft(99999, new Map([[1, 0]]))).toBe(3)
   })
})

// idx/h<N>.gz is the verbatim concatenation of finalized-pack headers.
function buildSummary(headers: Omit<PackOpts, "entries">[]): ArrayBuffer {
   const out = new Uint8Array(headers.length * IDX_HEADER_SIZE)
   headers.forEach((h, k) => out.set(new Uint8Array(buildBuf({ ...h, entries: [] })), k * IDX_HEADER_SIZE))
   return out.buffer
}

describe("makeIdxPack.findChronForBlocks", () => {
   // fetchedAts: [10, 15, 15, 20] in pack 2 → chron base 2 * IDX_PACK_SIZE
   const buf = buildBuf({ fetchedAtBase: 10, entries: [e(1), e(1, 0, 5), e(1), e(1, 0, 5)] })
   const base = 2 * IDX_PACK_SIZE

   it("returns the global chron of the leftmost entry with fetchedAt >= tsBlocks", () => {
      const pack = makeIdxPack(buf, 2, 4)
      expect(pack.findChronForBlocks(0)).toBe(base)
      expect(pack.findChronForBlocks(11)).toBe(base + 1)
      expect(pack.findChronForBlocks(15)).toBe(base + 1)
      expect(pack.findChronForBlocks(16)).toBe(base + 3)
   })

   it("returns one past the pack's end when nothing qualifies", () => {
      expect(makeIdxPack(buf, 2, 4).findChronForBlocks(21)).toBe(base + 4)
   })
})

describe("parseIdxHeaders", () => {
   it("decodes each 1036-byte chunk", () => {
      const buf = buildSummary([
         { fetchedAtBase: 0, packIdBase: 1, packOffBase: 0 },
         { fetchedAtBase: 9, packIdBase: 4, packOffBase: 2, chanCounts: { 1: 50000 } },
      ])
      const hs = parseIdxHeaders(buf, 2)
      expect(hs.length).toBe(2)
      expect(hs[0].fetchedAtBase).toBe(0)
      expect(hs[0].packIdBase).toBe(1)
      expect(hs[1].fetchedAtBase).toBe(9)
      expect(hs[1].packIdBase).toBe(4)
      expect(hs[1].packOffBase).toBe(2)
      expect(hs[1].chanCounts[1]).toBe(50000)
      expect(hs[1].chanCounts[0]).toBe(0)
   })

   it("rejects a size mismatch", () => {
      const buf = buildSummary([{}])
      expect(() => parseIdxHeaders(buf, 2)).toThrow(/summary/)
      expect(() => parseIdxHeaders(buf.slice(0, 100), 1)).toThrow(/summary/)
   })
})

describe("findPackForBlocks", () => {
   const hdr = (fetchedAtBase: number): IdxHeader => ({
      fetchedAtBase,
      packIdBase: 0,
      packOffBase: 0,
      chanCounts: new Uint32Array(256),
   })
   // Pack k's last entry value = headers[k+1].fetchedAtBase; the final
   // header is the latest pack's (unbounded end). Packs 0..2 + latest.
   const headers = [hdr(0), hdr(10), hdr(10), hdr(30)]

   it("picks the first pack whose last entry >= tsBlocks", () => {
      expect(findPackForBlocks(headers, 0)).toBe(0)
      expect(findPackForBlocks(headers, 5)).toBe(0)
      // Boundary duplicate (pack 1 spans no time): earliest pack wins, like
      // the flat leftmost-entry search.
      expect(findPackForBlocks(headers, 10)).toBe(0)
      expect(findPackForBlocks(headers, 11)).toBe(2)
      expect(findPackForBlocks(headers, 30)).toBe(2)
   })

   it("clamps to the latest pack when no finalized pack qualifies", () => {
      expect(findPackForBlocks(headers, 31)).toBe(3)
      expect(findPackForBlocks([hdr(0)], 999)).toBe(0)
   })
})
