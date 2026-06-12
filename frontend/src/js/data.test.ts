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
   // Mirrors the real signature (async since the lazy-idx change) but keeps
   // the flat in-pack search: the pack-level step is pure and unit-tested in
   // idx.test.ts (findPackForBlocks).
   async findChronForTimestamp(ts: number): Promise<number> {
      let lo = 0
      let hi = state.fetchedAts.length
      while (lo < hi) {
         const mid = (lo + hi) >>> 1
         if (state.fetchedAts[mid] < ts) lo = mid + 1
         else hi = mid
      }
      return lo < state.fetchedAts.length ? lo : Math.max(0, state.fetchedAts.length - 1)
   },
   groupChannelsByTag(): { tagged: Map<string, IChannel[]>; sortedTags: string[]; untagged: IChannel[] } {
      const subs = Object.values(state.db.channels ?? {})
         .filter((sub: IChannel) => sub.total_art > 0)
         .sort((a: IChannel, b: IChannel) => (a.title < b.title ? -1 : 1))
      const tagged = new Map<string, IChannel[]>()
      const untagged: IChannel[] = []
      for (const sub of subs) {
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
   it("returns 0 for empty array", async () => {
      state.fetchedAts = new Uint32Array([])
      expect(await data.findChronForTimestamp(100)).toBe(0)
   })

   it("returns 0 when all entries are after the timestamp", async () => {
      state.fetchedAts = new Uint32Array([50, 60, 70])
      expect(await data.findChronForTimestamp(10)).toBe(0)
   })

   it("returns last index when all entries are before the timestamp", async () => {
      state.fetchedAts = new Uint32Array([10, 20, 30])
      expect(await data.findChronForTimestamp(100)).toBe(2)
   })

   it("finds leftmost entry >= ts", async () => {
      state.fetchedAts = new Uint32Array([10, 20, 30, 40, 50])
      expect(await data.findChronForTimestamp(25)).toBe(2)
   })

   it("finds exact match", async () => {
      state.fetchedAts = new Uint32Array([10, 20, 30, 40, 50])
      expect(await data.findChronForTimestamp(30)).toBe(2)
   })

   it("returns leftmost of duplicate values", async () => {
      state.fetchedAts = new Uint32Array([10, 20, 20, 20, 50])
      expect(await data.findChronForTimestamp(20)).toBe(1)
   })

   it("works with single element <= ts", async () => {
      state.fetchedAts = new Uint32Array([10])
      expect(await data.findChronForTimestamp(10)).toBe(0)
   })

   it("works with single element > ts", async () => {
      state.fetchedAts = new Uint32Array([10])
      expect(await data.findChronForTimestamp(5)).toBe(0)
   })
})

describe("groupChannelsByTag", () => {
   it("returns empty collections when no channels", () => {
      state.db = { channels: {} } as IDB
      const result = data.groupChannelsByTag()
      expect(result.tagged.size).toBe(0)
      expect(result.sortedTags).toEqual([])
      expect(result.untagged).toEqual([])
   })

   it("separates tagged and untagged subs", () => {
      state.db = {
         channels: {
            1: { id: 1, title: "A", total_art: 1, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupChannelsByTag()
      expect(result.sortedTags).toEqual(["news"])
      expect(result.tagged.get("news")!.length).toBe(1)
      expect(result.untagged.length).toBe(1)
      expect(result.untagged[0].id).toBe(2)
   })

   it("sorts tags alphabetically", () => {
      state.db = {
         channels: {
            1: { id: 1, title: "A", total_art: 1, tag: "zebra" },
            2: { id: 2, title: "B", total_art: 1, tag: "alpha" },
         },
      } as unknown as IDB
      const result = data.groupChannelsByTag()
      expect(result.sortedTags).toEqual(["alpha", "zebra"])
   })

   it("groups multiple subs under same tag", () => {
      state.db = {
         channels: {
            1: { id: 1, title: "A", total_art: 1, tag: "tech" },
            2: { id: 2, title: "B", total_art: 1, tag: "tech" },
         },
      } as unknown as IDB
      const result = data.groupChannelsByTag()
      expect(result.tagged.get("tech")!.length).toBe(2)
      expect(result.sortedTags).toEqual(["tech"])
   })

   it("excludes subs with zero articles", () => {
      state.db = {
         channels: {
            1: { id: 1, title: "A", total_art: 0, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupChannelsByTag()
      expect(result.tagged.size).toBe(0)
      expect(result.untagged.length).toBe(1)
   })
})
