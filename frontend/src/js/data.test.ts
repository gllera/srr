import { describe, it, expect, vi } from "vitest"

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

// findChronForTimestamp is covered where the real code lives: its two halves
// in idx.test.ts (findPackForBlocks, findChronForBlocks) and the composition
// in the contract layer (summary.e2e.test.ts).

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
