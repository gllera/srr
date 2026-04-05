import { describe, it, expect, vi } from "vitest"

// data.ts has top-level side effects (fetch at module load), so we mock the
// module and re-export the real pure functions with writable state.
const state = vi.hoisted(() => ({
   db: {} as IDB,
   fetchedAts: new Uint32Array(0),
}))

vi.mock("./data", () => ({
   IDX_PACK_SIZE: 50000,
   get db() {
      return state.db
   },
   set db(v: IDB) {
      state.db = v
   },
   get fetchedAts() {
      return state.fetchedAts
   },
   set fetchedAts(v: Uint32Array) {
      state.fetchedAts = v
   },
   numFinalizedIdx(): number {
      return state.db.total_art > 0 ? Math.floor((state.db.total_art - 1) / 50000) : 0
   },
   findChronForTimestamp(ts: number): number {
      let lo = 0
      let hi = state.fetchedAts.length
      while (lo < hi) {
         const mid = (lo + hi) >>> 1
         if (state.fetchedAts[mid] <= ts) lo = mid + 1
         else hi = mid
      }
      return lo > 0 ? lo - 1 : 0
   },
}))

const data = await import("./data")

describe("numFinalizedIdx", () => {
   it("returns 0 when total_art is 0", () => {
      data.db = { total_art: 0 } as IDB
      expect(data.numFinalizedIdx()).toBe(0)
   })

   it("returns 0 when total_art is 1", () => {
      data.db = { total_art: 1 } as IDB
      expect(data.numFinalizedIdx()).toBe(0)
   })

   it("returns 0 when total_art equals IDX_PACK_SIZE", () => {
      data.db = { total_art: data.IDX_PACK_SIZE } as IDB
      expect(data.numFinalizedIdx()).toBe(0)
   })

   it("returns 1 when total_art is IDX_PACK_SIZE + 1", () => {
      data.db = { total_art: data.IDX_PACK_SIZE + 1 } as IDB
      expect(data.numFinalizedIdx()).toBe(1)
   })

   it("returns 2 when total_art is 2 * IDX_PACK_SIZE + 1", () => {
      data.db = { total_art: 2 * data.IDX_PACK_SIZE + 1 } as IDB
      expect(data.numFinalizedIdx()).toBe(2)
   })
})

describe("findChronForTimestamp", () => {
   it("returns 0 for empty array", () => {
      data.fetchedAts = new Uint32Array([])
      expect(data.findChronForTimestamp(100)).toBe(0)
   })

   it("returns 0 when all entries are after the timestamp", () => {
      data.fetchedAts = new Uint32Array([50, 60, 70])
      expect(data.findChronForTimestamp(10)).toBe(0)
   })

   it("returns last index when all entries are before the timestamp", () => {
      data.fetchedAts = new Uint32Array([10, 20, 30])
      expect(data.findChronForTimestamp(100)).toBe(2)
   })

   it("finds rightmost entry <= ts", () => {
      data.fetchedAts = new Uint32Array([10, 20, 30, 40, 50])
      expect(data.findChronForTimestamp(25)).toBe(1)
   })

   it("finds exact match", () => {
      data.fetchedAts = new Uint32Array([10, 20, 30, 40, 50])
      expect(data.findChronForTimestamp(30)).toBe(2)
   })

   it("returns rightmost of duplicate values", () => {
      data.fetchedAts = new Uint32Array([10, 20, 20, 20, 50])
      expect(data.findChronForTimestamp(20)).toBe(3)
   })

   it("works with single element <= ts", () => {
      data.fetchedAts = new Uint32Array([10])
      expect(data.findChronForTimestamp(10)).toBe(0)
   })

   it("works with single element > ts", () => {
      data.fetchedAts = new Uint32Array([10])
      expect(data.findChronForTimestamp(5)).toBe(0)
   })
})
