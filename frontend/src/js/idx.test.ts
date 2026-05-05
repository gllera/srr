import { describe, it, expect } from "vitest"
import { IDX_PACK_SIZE, makeIdxPack } from "./idx"

const HEADER_BYTES = 259 * 4

interface Entry {
   subId: number
   deltaPackId: 0 | 1
   deltaFetchedAt: number
}

interface PackOpts {
   fetchedAtBase?: number
   packIdBase?: number
   packOffBase?: number
   subCounts?: Record<number, number>
   entries: Entry[]
}

function buildBuf(o: PackOpts): ArrayBuffer {
   const buf = new ArrayBuffer(HEADER_BYTES + o.entries.length * 2)
   const view = new DataView(buf)
   view.setUint32(0, o.fetchedAtBase ?? 0, true)
   view.setUint32(4, o.packIdBase ?? 0, true)
   view.setUint32(8, o.packOffBase ?? 0, true)
   for (const [k, v] of Object.entries(o.subCounts ?? {})) {
      view.setUint32(12 + Number(k) * 4, v, true)
   }
   const bytes = new Uint8Array(buf)
   for (let i = 0; i < o.entries.length; i++) {
      const e = o.entries[i]
      bytes[HEADER_BYTES + i * 2] = e.subId
      bytes[HEADER_BYTES + i * 2 + 1] = (e.deltaPackId << 7) | (e.deltaFetchedAt & 0x7f)
   }
   return buf
}

const e = (subId: number, deltaPackId: 0 | 1 = 0, deltaFetchedAt = 0): Entry => ({
   subId,
   deltaPackId,
   deltaFetchedAt,
})

describe("IDX_PACK_SIZE", () => {
   it("is 50000", () => {
      expect(IDX_PACK_SIZE).toBe(50000)
   })
})

describe("makeIdxPack.parse", () => {
   it("decodes subIds in order", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(3)] })
      const pack = makeIdxPack(buf, 0, 3).parse()
      expect(Array.from(pack.subIds)).toEqual([1, 2, 3])
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

   it("populates ownSubCounts from entries", () => {
      const buf = buildBuf({ entries: [e(1), e(2), e(1), e(1), e(3)] })
      const pack = makeIdxPack(buf, 0, 5).parse()
      expect(pack.ownSubCounts[1]).toBe(3)
      expect(pack.ownSubCounts[2]).toBe(1)
      expect(pack.ownSubCounts[3]).toBe(1)
      expect(pack.ownSubCounts[0]).toBe(0)
      expect(pack.ownSubCounts[42]).toBe(0)
   })

   it("copies subCounts header verbatim", () => {
      const buf = buildBuf({
         subCounts: { 1: 100, 2: 50, 255: 7 },
         entries: [],
      })
      const pack = makeIdxPack(buf, 0, 0).parse()
      expect(pack.subCounts[0]).toBe(0)
      expect(pack.subCounts[1]).toBe(100)
      expect(pack.subCounts[2]).toBe(50)
      expect(pack.subCounts[255]).toBe(7)
   })

   it("is idempotent across repeated calls", () => {
      const buf = buildBuf({ entries: [e(1), e(2)] })
      const pack = makeIdxPack(buf, 0, 2)
      const a = pack.parse()
      const b = pack.parse()
      expect(a).toBe(b)
      expect(Array.from(a.subIds)).toEqual([1, 2])
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
})

describe("makeIdxPack.findLeft", () => {
   const buildPack = () => makeIdxPack(buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] }), 0, 5)

   it("returns the rightmost match scanning leftward from chronFrom", () => {
      const pack = buildPack()
      const subs = new Map([[1, 0]])
      expect(pack.findLeft(4, 0, subs)).toBe(4)
      expect(pack.findLeft(3, 0, subs)).toBe(2)
      expect(pack.findLeft(1, 0, subs)).toBe(0)
   })

   it("respects floor (chronFloor)", () => {
      const pack = buildPack()
      const subs = new Map([[1, 0]])
      expect(pack.findLeft(4, 3, subs)).toBe(4)
      expect(pack.findLeft(3, 3, subs)).toBe(-1)
   })

   it("respects sub addIdx (entries before addIdx don't match)", () => {
      const pack = buildPack()
      const subs = new Map([[1, 3]])
      expect(pack.findLeft(4, 0, subs)).toBe(4)
      expect(pack.findLeft(2, 0, subs)).toBe(-1)
   })

   it("returns -1 when no sub matches", () => {
      const pack = buildPack()
      expect(pack.findLeft(4, 0, new Map([[99, 0]]))).toBe(-1)
   })

   it("returns -1 when chronFrom < baseChron", () => {
      const buf = buildBuf({ entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1)
      expect(pack.findLeft(IDX_PACK_SIZE - 1, 0, new Map([[1, 0]]))).toBe(-1)
   })
})

describe("makeIdxPack.findRight", () => {
   const buildPack = () => makeIdxPack(buildBuf({ entries: [e(1), e(2), e(1), e(3), e(1)] }), 0, 5)

   it("returns the leftmost match scanning rightward from chronFrom", () => {
      const pack = buildPack()
      const subs = new Map([[1, 0]])
      expect(pack.findRight(0, 4, subs)).toBe(0)
      expect(pack.findRight(1, 4, subs)).toBe(2)
      expect(pack.findRight(3, 4, subs)).toBe(4)
   })

   it("respects upper bound chronTo", () => {
      const pack = buildPack()
      expect(pack.findRight(3, 3, new Map([[1, 0]]))).toBe(-1)
      expect(pack.findRight(0, 1, new Map([[1, 0]]))).toBe(0)
   })

   it("respects sub addIdx", () => {
      const pack = buildPack()
      expect(pack.findRight(0, 4, new Map([[1, 3]]))).toBe(4)
      expect(pack.findRight(0, 2, new Map([[1, 3]]))).toBe(-1)
   })

   it("returns -1 when no sub matches", () => {
      const pack = buildPack()
      expect(pack.findRight(0, 4, new Map([[99, 0]]))).toBe(-1)
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

   it("uses subCounts header for entries in earlier packs", () => {
      const buf = buildBuf({
         subCounts: { 1: 200 },
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
