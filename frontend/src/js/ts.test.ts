import { describe, it, expect, vi, beforeEach } from "vitest"

const SECS_PER_WEEK = 604800

// Define db separately so numFinalizedIdx can close over it (not rely on `this`)
const data = vi.hoisted(() => {
   const db = {
      total_art: 5000,
      data_tog: true,
      ts_tog: true,
      fetched_at: 604800 * 200 + 1000,
      first_fetched: 604800 * 50,
      sub_seq: 0,
      next_pid: 5,
      pack_off: 0,
      subscriptions: [] as ISub[],
      subs_mapped: new Map<number, ISub>(),
   } as unknown as IDB
   return {
      db,
      makeLRU() {
         const map = new Map()
         return {
            get(id: number) {
               const entry = map.get(id)
               if (entry) {
                  map.delete(id)
                  map.set(id, entry)
               }
               return entry
            },
            put(id: number, val: unknown) {
               map.delete(id)
               map.set(id, val)
            },
         }
      },
      PACK_SIZE: 1000 as const,
      numFinalizedIdx(): number {
         return db.total_art > 0 ? Math.floor((db.total_art - 1) / 1000) : 0
      },
      streamSplit: vi.fn(),
   }
})

vi.mock("./data", () => data)

import { findChronForTimestamp, findCandidateIdxPacks } from "./ts"

function makeTsLine(offset: number, total: number, subIds: number[] = [], lastAdded?: Map<number, number>) {
   const subs = new Map<number, number>()
   for (const id of subIds) subs.set(id, 1)
   return { offset, total, subs, lastAdded }
}

// Use a unique week counter to avoid LRU cache collisions between tests
let nextWeek = 96

beforeEach(() => {
   data.db.total_art = 5000
   data.db.fetched_at = SECS_PER_WEEK * 200 + 1000
   data.db.first_fetched = SECS_PER_WEEK * 50
   data.db.subs_mapped = new Map()
   data.streamSplit.mockReset()
   nextWeek++
})

describe("findChronForTimestamp", () => {
   it("returns total from the best matching line", async () => {
      const week = nextWeek
      data.streamSplit.mockResolvedValue([
         makeTsLine(0, 1000, [1]),
         makeTsLine(200, 2000, [1]),
         makeTsLine(400, 3000, [1]),
      ])
      const result = await findChronForTimestamp(week * SECS_PER_WEEK + 300)
      // offset 300 → best match is line with offset 200, total 2000
      expect(result).toBe(2000)
   })

   it("returns first line total when offset is 0", async () => {
      const week = nextWeek
      data.streamSplit.mockResolvedValue([makeTsLine(0, 500, [1]), makeTsLine(100, 1500, [1])])
      const result = await findChronForTimestamp(week * SECS_PER_WEEK + 0)
      expect(result).toBe(500)
   })

   it("returns null when week is out of range", async () => {
      const result = await findChronForTimestamp(50 * SECS_PER_WEEK + 100)
      expect(result).toBeNull()
   })

   it("returns null when streamSplit fails", async () => {
      const week = nextWeek
      data.streamSplit.mockRejectedValue(new Error("fetch failed"))
      const result = await findChronForTimestamp(week * SECS_PER_WEEK + 100)
      expect(result).toBeNull()
   })
})

describe("findCandidateIdxPacks", () => {
   it("returns null when starting week has no data", async () => {
      const fetchedAt = 50 * SECS_PER_WEEK + 100
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([1]), -1)
      expect(result).toBeNull()
   })

   it("returns empty array when no subs match any line", async () => {
      const week = nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 300
      data.streamSplit.mockResolvedValue([makeTsLine(0, 1000, [2], new Map()), makeTsLine(200, 2000, [2])])
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([99]), -1)
      expect(result).toEqual([])
   })

   it("collects packs going backward", async () => {
      const week = nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 500
      data.streamSplit.mockResolvedValue([
         makeTsLine(0, 1000, [1], new Map()),
         makeTsLine(200, 2000, [1]),
         makeTsLine(600, 3000, [1]),
      ])
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([1]), -1)
      expect(result).not.toBeNull()
      expect(result!.length).toBeGreaterThan(0)
   })

   it("collects packs going forward", async () => {
      const week = nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 100
      // Use totals that map to packs above currentPack (0)
      data.streamSplit.mockResolvedValue([
         makeTsLine(0, 1000, [1], new Map()),
         makeTsLine(200, 2000, [1]),
         makeTsLine(600, 3000, [1]),
      ])
      // currentPack=0, so packs 1 and 2 (from totals 1000-2999) should be candidates
      const result = await findCandidateIdxPacks(fetchedAt, 0, new Set([1]), 1)
      expect(result).not.toBeNull()
      expect(result!.length).toBeGreaterThan(0)
   })

   it("skips currentPack in results", async () => {
      const week = nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 300
      data.streamSplit.mockResolvedValue([makeTsLine(0, 1000, [1], new Map()), makeTsLine(200, 2000, [1])])
      const result = await findCandidateIdxPacks(fetchedAt, 1, new Set([1]), -1)
      expect(result).not.toBeNull()
      expect(result).not.toContain(1)
   })

   it("uses lastAdded to jump to earlier weeks backward", async () => {
      const week = nextWeek
      const prevWeek = week - 5
      const fetchedAt = week * SECS_PER_WEEK + 300
      // First week: has sub 1, lastAdded points to prevWeek
      const lastAdded = new Map([[1, prevWeek * SECS_PER_WEEK + 100]])
      data.streamSplit
         .mockResolvedValueOnce([makeTsLine(0, 3000, [1], lastAdded), makeTsLine(200, 4000, [1])])
         // prevWeek pack: has sub 1 at different totals
         .mockResolvedValueOnce([makeTsLine(0, 1000, [1], new Map()), makeTsLine(200, 2000, [1])])
      data.db.first_fetched = (prevWeek - 1) * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([1]), -1)
      expect(result).not.toBeNull()
      expect(result!.length).toBeGreaterThan(0)
   })

   it("forward scan collects packs from later weeks", async () => {
      const week = nextWeek
      const fwdWeek = week + 3
      const fetchedAt = week * SECS_PER_WEEK + 100
      const sub1 = { id: 1, title: "S", url: "", last_added: fwdWeek * SECS_PER_WEEK + 50 } as ISub
      data.db.subs_mapped = new Map([[1, sub1]])
      // Start week: sub 1 at offset 0
      data.streamSplit
         .mockResolvedValueOnce([makeTsLine(0, 1000, [1], new Map())])
         // fwdWeek: has sub 1 with higher totals
         .mockResolvedValueOnce([makeTsLine(0, 5000, [1], new Map()), makeTsLine(200, 6000, [1])])
      data.db.first_fetched = (week - 1) * SECS_PER_WEEK
      data.db.fetched_at = (fwdWeek + 1) * SECS_PER_WEEK
      const result = await findCandidateIdxPacks(fetchedAt, 0, new Set([1]), 1)
      expect(result).not.toBeNull()
      expect(result!.length).toBeGreaterThan(0)
   })

   it("backward scan handles terminal case with hasSub at line 0", async () => {
      const week = nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 100
      // Single line with sub 1, total=500, no previous week available
      data.streamSplit.mockResolvedValueOnce([makeTsLine(0, 500, [1], new Map())])
      data.db.first_fetched = week * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      // currentPack=4, dir=-1: addPacks(0, 499) → packs 0..0, clamped to min(0, nf=4)=0
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([1]), -1)
      expect(result).not.toBeNull()
      expect(result!.length).toBeGreaterThan(0)
   })

   it("deduplicates pack numbers via seen set", async () => {
      const week = nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 500
      // Multiple lines mapping to same pack range
      data.streamSplit.mockResolvedValue([
         makeTsLine(0, 0, [1], new Map()),
         makeTsLine(100, 500, [1]),
         makeTsLine(200, 999, [1]),
         makeTsLine(400, 1500, [1]),
      ])
      data.db.first_fetched = (week - 1) * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([1]), -1)
      expect(result).not.toBeNull()
      // No duplicates
      expect(new Set(result).size).toBe(result!.length)
   })
})

describe("findChronForTimestamp edge cases", () => {
   it("returns last line total when offset exceeds all lines", async () => {
      // Use a week far from any other test to avoid LRU cache collisions
      const week = 500 + nextWeek
      data.streamSplit.mockResolvedValueOnce([makeTsLine(0, 100, [1]), makeTsLine(200, 500, [1])])
      data.db.first_fetched = (week - 1) * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findChronForTimestamp(week * SECS_PER_WEEK + 99999)
      expect(result).toBe(500)
   })

   it("returns total from single-line pack", async () => {
      const week = 600 + nextWeek
      data.streamSplit.mockResolvedValueOnce([makeTsLine(0, 42, [1])])
      data.db.first_fetched = (week - 1) * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findChronForTimestamp(week * SECS_PER_WEEK + 300)
      expect(result).toBe(42)
   })

   it("returns null when week is before first_fetched", async () => {
      data.db.first_fetched = 200 * SECS_PER_WEEK
      const result = await findChronForTimestamp(100 * SECS_PER_WEEK + 50)
      expect(result).toBeNull()
   })

   it("returns null when week is after fetched_at", async () => {
      data.db.fetched_at = 200 * SECS_PER_WEEK
      const result = await findChronForTimestamp(300 * SECS_PER_WEEK + 50)
      expect(result).toBeNull()
   })

   it("selects line at exact offset boundary", async () => {
      const week = 700 + nextWeek
      data.streamSplit.mockResolvedValueOnce([
         makeTsLine(0, 100, [1]),
         makeTsLine(200, 300, [1]),
         makeTsLine(400, 500, [1]),
      ])
      data.db.first_fetched = (week - 1) * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findChronForTimestamp(week * SECS_PER_WEEK + 200)
      expect(result).toBe(300)
   })
})

describe("findCandidateIdxPacks edge cases", () => {
   it("returns empty when sub never appears in ts data", async () => {
      const week = 800 + nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 300
      data.streamSplit.mockResolvedValueOnce([makeTsLine(0, 1000, [2], new Map()), makeTsLine(200, 2000, [2])])
      data.db.first_fetched = week * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([99]), -1)
      expect(result).toEqual([])
   })

   it("backward scan returns candidates in order from nearest to furthest", async () => {
      const week = 900 + nextWeek
      const fetchedAt = week * SECS_PER_WEEK + 500
      data.streamSplit.mockResolvedValueOnce([
         makeTsLine(0, 0, [1], new Map()),
         makeTsLine(100, 1000, [1]),
         makeTsLine(200, 2000, [1]),
         makeTsLine(400, 3000, [1]),
      ])
      data.db.first_fetched = (week - 1) * SECS_PER_WEEK
      data.db.fetched_at = (week + 1) * SECS_PER_WEEK
      const result = await findCandidateIdxPacks(fetchedAt, 4, new Set([1]), -1)
      expect(result).not.toBeNull()
      for (let i = 1; i < result!.length; i++) {
         expect(result![i]).toBeLessThanOrEqual(result![i - 1])
      }
   })
})
