import { describe, it, expect, vi, beforeEach } from "vitest"

// data.ts has top-level side effects (fetch at module load), so we mock the
// module and re-export the real pure functions with writable state.
const state = vi.hoisted(() => ({
   db: {} as IDB,
}))

vi.mock("./data", () => ({
   IDX_PACK_SIZE: 50000,
   get db() {
      return state.db
   },
   set db(v: IDB) {
      state.db = v
   },
   lastFetchedAt(): number {
      return state.db.fetched_at ?? 0
   },
   numFinalizedIdx(): number {
      return state.db.total_art > 0 ? Math.floor((state.db.total_art - 1) / 50000) : 0
   },
   idxSummaryDegraded(): boolean {
      const nf =
         (state.db as IDB & { total_art: number }).total_art > 0
            ? Math.floor(((state.db as IDB & { total_art: number }).total_art - 1) / 50000)
            : 0
      const hdrs = (state.db as IDB & { hdrs?: number }).hdrs ?? 0
      return nf > 0 && hdrs > 0 && hdrs < nf
   },
   groupFeedsByTag(includeEmpty = false): { tagged: Map<string, IFeed[]>; sortedTags: string[]; untagged: IFeed[] } {
      const subs = Object.values(state.db.feeds ?? {})
         .filter((sub: IFeed) => includeEmpty || sub.total_art > 0)
         .sort((a: IFeed, b: IFeed) => (a.title < b.title ? -1 : 1))
      const tagged = new Map<string, IFeed[]>()
      const untagged: IFeed[] = []
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

describe("groupFeedsByTag", () => {
   it("returns empty collections when no feeds", () => {
      state.db = { feeds: {} } as IDB
      const result = data.groupFeedsByTag()
      expect(result.tagged.size).toBe(0)
      expect(result.sortedTags).toEqual([])
      expect(result.untagged).toEqual([])
   })

   it("separates tagged and untagged subs", () => {
      state.db = {
         feeds: {
            1: { id: 1, title: "A", total_art: 1, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupFeedsByTag()
      expect(result.sortedTags).toEqual(["news"])
      expect(result.tagged.get("news")!.length).toBe(1)
      expect(result.untagged.length).toBe(1)
      expect(result.untagged[0].id).toBe(2)
   })

   it("sorts tags alphabetically", () => {
      state.db = {
         feeds: {
            1: { id: 1, title: "A", total_art: 1, tag: "zebra" },
            2: { id: 2, title: "B", total_art: 1, tag: "alpha" },
         },
      } as unknown as IDB
      const result = data.groupFeedsByTag()
      expect(result.sortedTags).toEqual(["alpha", "zebra"])
   })

   it("groups multiple subs under same tag", () => {
      state.db = {
         feeds: {
            1: { id: 1, title: "A", total_art: 1, tag: "tech" },
            2: { id: 2, title: "B", total_art: 1, tag: "tech" },
         },
      } as unknown as IDB
      const result = data.groupFeedsByTag()
      expect(result.tagged.get("tech")!.length).toBe(2)
      expect(result.sortedTags).toEqual(["tech"])
   })

   it("excludes subs with zero articles", () => {
      state.db = {
         feeds: {
            1: { id: 1, title: "A", total_art: 0, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupFeedsByTag()
      expect(result.tagged.size).toBe(0)
      expect(result.untagged.length).toBe(1)
   })

   it("includes subs with zero articles when includeEmpty is set", () => {
      state.db = {
         feeds: {
            1: { id: 1, title: "A", total_art: 0, tag: "news" },
            2: { id: 2, title: "B", total_art: 1 },
         },
      } as unknown as IDB
      const result = data.groupFeedsByTag(true)
      expect(result.sortedTags).toEqual(["news"])
      expect(result.tagged.get("news")!.length).toBe(1)
      expect(result.untagged.length).toBe(1)
   })
})

describe("lastFetchedAt", () => {
   beforeEach(() => {
      state.db = { feeds: {}, total_art: 0, fetched_at: 0 } as unknown as IDB
   })

   it("returns fetched_at from db", () => {
      state.db = { feeds: {}, total_art: 0, fetched_at: 1700000000 } as unknown as IDB
      expect(data.lastFetchedAt()).toBe(1700000000)
   })

   it("returns 0 when fetched_at is 0", () => {
      state.db = { feeds: {}, total_art: 0, fetched_at: 0 } as unknown as IDB
      expect(data.lastFetchedAt()).toBe(0)
   })
})

describe("idxSummaryDegraded", () => {
   it("returns false when no finalized idx packs (empty store)", () => {
      state.db = { feeds: {}, total_art: 0, fetched_at: 0 } as unknown as IDB
      expect(data.idxSummaryDegraded()).toBe(false)
   })

   it("returns false when total_art < IDX_PACK_SIZE (only latest pack, no finalized)", () => {
      state.db = { feeds: {}, total_art: 1000, fetched_at: 0 } as unknown as IDB
      expect(data.idxSummaryDegraded()).toBe(false)
   })

   it("returns false when hdrs matches numFinalizedIdx", () => {
      // total_art = 50001 => numFinalizedIdx = 1; hdrs = 1 => not degraded
      state.db = { feeds: {}, total_art: 50001, fetched_at: 0, hdrs: 1 } as unknown as IDB
      expect(data.idxSummaryDegraded()).toBe(false)
   })

   it("returns false when finalized idx > 0 and hdrs is absent (pre-summary store, not advancing)", () => {
      // total_art = 50001 => numFinalizedIdx = 1; hdrs absent (legacy/old backend)
      // is steady-state, NOT an active rebuild — no permanent "optimizing" banner.
      state.db = { feeds: {}, total_art: 50001, fetched_at: 0 } as unknown as IDB
      expect(data.idxSummaryDegraded()).toBe(false)
   })

   it("returns true when hdrs is partway built (actively-advancing rebuild)", () => {
      // total_art = 100001 => numFinalizedIdx = 2; hdrs = 1 (0 < hdrs < nf) => degraded
      state.db = { feeds: {}, total_art: 100001, fetched_at: 0, hdrs: 1 } as unknown as IDB
      expect(data.idxSummaryDegraded()).toBe(true)
   })
})
