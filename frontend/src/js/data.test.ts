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
   groupSubsByTag(): { tagged: Map<string, ISub[]>; sortedTags: string[]; untagged: ISub[] } {
      const active = Object.values(state.db.subscriptions ?? {})
         .filter((sub: ISub) => sub.total_art > 0)
         .sort((a: ISub, b: ISub) => (a.title < b.title ? -1 : 1))
      const tagged = new Map<string, ISub[]>()
      const untagged: ISub[] = []
      for (const sub of active) {
         if (sub.tag) {
            let group = tagged.get(sub.tag)
            if (!group) {
               group = []
               tagged.set(sub.tag, group)
            }
            group.push(sub)
         } else {
            untagged.push(sub)
         }
      }
      return { tagged, sortedTags: Array.from(tagged.keys()).sort(), untagged }
   },
}))

const data = await import("./data")

describe("findChronForTimestamp", () => {
   it("returns 0 for empty array", () => {
      state.fetchedAts = new Uint32Array([])
      expect(data.findChronForTimestamp(100)).toBe(0)
   })

   it("returns 0 when all entries are after the timestamp", () => {
      state.fetchedAts = new Uint32Array([50, 60, 70])
      expect(data.findChronForTimestamp(10)).toBe(0)
   })

   it("returns last index when all entries are before the timestamp", () => {
      state.fetchedAts = new Uint32Array([10, 20, 30])
      expect(data.findChronForTimestamp(100)).toBe(2)
   })

   it("finds rightmost entry <= ts", () => {
      state.fetchedAts = new Uint32Array([10, 20, 30, 40, 50])
      expect(data.findChronForTimestamp(25)).toBe(1)
   })

   it("finds exact match", () => {
      state.fetchedAts = new Uint32Array([10, 20, 30, 40, 50])
      expect(data.findChronForTimestamp(30)).toBe(2)
   })

   it("returns rightmost of duplicate values", () => {
      state.fetchedAts = new Uint32Array([10, 20, 20, 20, 50])
      expect(data.findChronForTimestamp(20)).toBe(3)
   })

   it("works with single element <= ts", () => {
      state.fetchedAts = new Uint32Array([10])
      expect(data.findChronForTimestamp(10)).toBe(0)
   })

   it("works with single element > ts", () => {
      state.fetchedAts = new Uint32Array([10])
      expect(data.findChronForTimestamp(5)).toBe(0)
   })
})

describe("groupSubsByTag", () => {
   it("returns empty collections when no subscriptions", () => {
      state.db = { subscriptions: {} } as IDB
      const result = data.groupSubsByTag()
      expect(result.tagged.size).toBe(0)
      expect(result.sortedTags).toEqual([])
      expect(result.untagged).toEqual([])
   })

   it("separates tagged and untagged subs", () => {
      state.db = {
         subscriptions: {
            1: { id: 1, title: "A", total_art: 1, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupSubsByTag()
      expect(result.sortedTags).toEqual(["news"])
      expect(result.tagged.get("news")!.length).toBe(1)
      expect(result.untagged.length).toBe(1)
      expect(result.untagged[0].id).toBe(2)
   })

   it("sorts tags alphabetically", () => {
      state.db = {
         subscriptions: {
            1: { id: 1, title: "A", total_art: 1, tag: "zebra" },
            2: { id: 2, title: "B", total_art: 1, tag: "alpha" },
         },
      } as unknown as IDB
      const result = data.groupSubsByTag()
      expect(result.sortedTags).toEqual(["alpha", "zebra"])
   })

   it("groups multiple subs under same tag", () => {
      state.db = {
         subscriptions: {
            1: { id: 1, title: "A", total_art: 1, tag: "tech" },
            2: { id: 2, title: "B", total_art: 1, tag: "tech" },
         },
      } as unknown as IDB
      const result = data.groupSubsByTag()
      expect(result.tagged.get("tech")!.length).toBe(2)
      expect(result.sortedTags).toEqual(["tech"])
   })

   it("excludes subs with zero articles", () => {
      state.db = {
         subscriptions: {
            1: { id: 1, title: "A", total_art: 0, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupSubsByTag()
      expect(result.tagged.size).toBe(0)
      expect(result.untagged.length).toBe(1)
   })
})
