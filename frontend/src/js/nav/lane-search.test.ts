import { beforeEach, describe, expect, it, vi } from "vitest"

const data = vi.hoisted(() => ({
   db: { total_art: 6, feeds: {} as Record<number, IFeed> } as unknown as IDB,
   feedTitle: vi.fn((id: number) => `F${id}`),
   activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
}))
vi.mock("../data", () => data)

const searchMod = vi.hoisted(() => ({ loadHits: vi.fn() }))
vi.mock("../search", () => searchMod)

import type { LaneEnv } from "./lane"
import { resetSearchStream, SearchLane, searchCard, searchTruncated } from "./lane-search"

// The ACTIVE lane nav would hold: the supersession guard compares against it.
let active: SearchLane | null = null
const env: LaneEnv = { unreadOnly: () => true, searchKey: () => active?.searchKey ?? "" }
const make = (tokens: string[]) =>
   (active = new SearchLane(
      tokens,
      tokens.findIndex((t) => t.startsWith("q:")),
      env,
   ))
const card4 = { f: 2, w: 40, t: "four" }

beforeEach(() => {
   resetSearchStream()
   active = null
   searchMod.loadHits.mockReset()
   searchMod.loadHits.mockResolvedValue({ chrons: [1, 4, 5], truncated: false, cards: new Map([[4, card4]]) })
   data.db.feeds = {
      1: { id: 1, title: "F1", url: "u", tag: "news", total_art: 3, add_idx: 0 } as IFeed,
      2: { id: 2, title: "F2", url: "u", tag: "news", total_art: 3, add_idx: 2 } as IFeed,
   }
})

describe("SearchLane — shape", () => {
   it("an unscoped query is feed-agnostic and keyed by its token", () => {
      const l = make(["q:rust"])
      expect([l.kind, l.key, l.query, l.peek, l.dividers, l.chronOrdered]).toEqual([
         "search",
         "q:rust",
         "rust",
         true,
         false,
         true,
      ])
      expect(l.scope).toEqual([])
      expect(l.members.size).toBe(0)
   })

   it("a scoped query resolves its scope at NATURAL bounds, even under unread-only", () => {
      const l = make(["news", "q:rust"])
      expect([l.key, l.query, l.scope]).toEqual(["", "rust", ["news"]])
      l.applyUnseen({ "feed:1": 5 })
      expect([...l.members]).toEqual([
         [1, 0],
         [2, 2],
      ])
   })
})

describe("SearchLane — the snapshot", () => {
   it("loads once, then matches and walks the hit set", async () => {
      const l = make(["q:rust"])
      expect(l.matches(0, 4)).toBe(false) // nothing before prepare
      await l.prepare()
      await l.prepare()
      expect(searchMod.loadHits).toHaveBeenCalledTimes(1)
      expect(searchMod.loadHits).toHaveBeenCalledWith("rust", 500, undefined)
      expect(l.matches(99, 4)).toBe(true)
      expect([await l.atOrBelow(3), await l.atOrAbove(2)]).toEqual([1, 4])
      expect([await l.older(4), await l.newer(4)]).toEqual([1, 5])
      expect([await l.oldest(), await l.newest(), await l.anchor()]).toEqual([1, 5, -1])
      expect(searchCard(4)).toEqual(card4)
      expect(searchTruncated()).toBe(false)
   })

   it("hands a scoped scan nav's own membership map", async () => {
      const l = make(["news", "q:rust"])
      await l.prepare()
      expect(searchMod.loadHits).toHaveBeenCalledWith("rust", 500, { key: '["news"]', feeds: l.members })
   })

   it("an empty query never scans", async () => {
      const l = make(["q:"])
      await l.prepare()
      expect(searchMod.loadHits).not.toHaveBeenCalled()
      expect(await l.newest()).toBe(-1)
   })

   it("survives a re-apply of the same key; a new key drops it", async () => {
      await make(["q:rust"]).prepare()
      const again = make(["q:rust"])
      expect(again.matches(0, 4)).toBe(true)
      await again.prepare()
      expect(searchMod.loadHits).toHaveBeenCalledTimes(1)
      expect(make(["q:go"]).matches(0, 4)).toBe(false)
   })

   it("discards a late result for a query that is no longer active", async () => {
      let release!: () => void
      searchMod.loadHits.mockImplementationOnce(
         () => new Promise((r) => (release = () => r({ chrons: [2], truncated: false }))),
      )
      const slow = make(["q:slow"])
      const pending = slow.prepare()
      const fast = make(["q:fast"])
      await fast.prepare()
      release()
      await pending
      expect(fast.matches(0, 2)).toBe(false)
      expect(fast.matches(0, 4)).toBe(true)
   })

   it("survives an A→B→A sequence: a same-key late result still commits, a different key is discarded", async () => {
      let releaseA1!: () => void
      let releaseB!: () => void
      searchMod.loadHits.mockImplementationOnce(
         () => new Promise((r) => (releaseA1 = () => r({ chrons: [7], truncated: false }))),
      )
      searchMod.loadHits.mockImplementationOnce(
         () => new Promise((r) => (releaseB = () => r({ chrons: [8], truncated: false }))),
      )
      const a1 = make(["q:rust"])
      const pendingA1 = a1.prepare()
      const b = make(["q:go"])
      const pendingB = b.prepare()
      // Back to "rust" — this instance is the ACTIVE lane and resolves quickly off
      // the default mock (the third loadHits call, queue exhausted).
      const a2 = make(["q:rust"])
      await a2.prepare()
      expect(a2.matches(0, 4)).toBe(true)

      // B's late result carries a DIFFERENT key than the active lane's — discarded.
      releaseB()
      await pendingB
      expect(a2.matches(0, 8)).toBe(false)
      expect(a2.matches(0, 4)).toBe(true)

      // A1's late result carries the SAME key string as the active lane's (the
      // guard is string equality against env.searchKey(), not instance identity)
      // — it commits and overwrites a2's snapshot.
      releaseA1()
      await pendingA1
      expect(a2.matches(0, 7)).toBe(true)
      expect(a2.matches(0, 4)).toBe(false)
   })

   it("counts hits strictly after the floor, and lands a switch on the newest", async () => {
      const l = make(["q:rust"])
      expect([await l.ahead(-1), await l.ahead(1), await l.ahead(5)]).toEqual([3, 2, 0])
      expect(await l.entry()).toEqual({ land: 5 })
   })

   it("a refresh reloads the snapshot and reconciles the scope", async () => {
      searchMod.loadHits.mockResolvedValueOnce({ chrons: [1], truncated: false })
      searchMod.loadHits.mockResolvedValueOnce({ chrons: [1, 3], truncated: false })
      const l = make(["news", "q:rust"])
      await l.prepare()
      expect(l.matches(0, 3)).toBe(false)
      data.db.feeds[2].add_idx = 3
      await l.refreshed()
      expect(l.matches(0, 3)).toBe(true)
      expect(l.members.get(2)).toBe(3)
      expect(searchMod.loadHits).toHaveBeenCalledTimes(2)
   })
})
