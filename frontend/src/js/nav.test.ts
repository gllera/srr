import { describe, it, expect, vi, beforeEach } from "vitest"

const data = vi.hoisted(() => ({
   IDX_PACK_SIZE: 50000 as const,
   db: {
      total_art: 0,
      subscriptions: [] as ISub[],
      subs_mapped: new Map<number, ISub>(),
   } as unknown as IDB,
   subIds: new Uint32Array(0),
   fetchedAts: new Uint32Array(0),
   loadArticle: vi.fn<(chronIdx: number) => Promise<IArticle>>(),
   getArticleSync: vi.fn<(chronIdx: number) => IArticle | undefined>(),
   activeSubs: vi.fn(() => [] as ISub[]),
   abortPending: vi.fn(),
   findChronForTimestamp: vi.fn(() => 0),
   numFinalizedIdx: vi.fn(() => 0),
}))

vi.mock("./data", () => data)

import * as nav from "./nav"

function makeArticle(overrides: Partial<IArticle> = {}): IArticle {
   return { s: 1, a: 0, p: 0, t: "", l: "", c: "", ...overrides }
}

function makeSub(overrides: Partial<ISub> = {}): ISub {
   return { id: 1, title: "Test", url: "http://test.com", ...overrides } as ISub
}

function setupIndex(entries: Array<{ subId: number; fetchedAt?: number }>) {
   data.db.total_art = entries.length
   data.subIds = new Uint32Array(entries.map((e) => e.subId))
   data.fetchedAts = new Uint32Array(entries.map((e) => e.fetchedAt ?? 0))
   data.loadArticle.mockImplementation(async (idx: number) =>
      makeArticle({ s: data.subIds[idx], a: data.fetchedAts[idx] }),
   )
   data.getArticleSync.mockImplementation((idx: number) =>
      makeArticle({ s: data.subIds[idx], a: data.fetchedAts[idx] }),
   )
}

beforeEach(() => {
   data.db.total_art = 0
   data.db.subscriptions = []
   data.db.subs_mapped = new Map()
   data.subIds = new Uint32Array(0)
   data.fetchedAts = new Uint32Array(0)
   data.loadArticle.mockReset()
   data.getArticleSync.mockReset()
   nav.setFilterSubs(undefined)
   nav.setFloorChron(0)
   vi.spyOn(history, "pushState").mockImplementation(() => {})
   vi.spyOn(history, "replaceState").mockImplementation(() => {})
})

describe("load", () => {
   it("throws when total_art is 0", async () => {
      data.db.total_art = 0
      await expect(nav.load(0)).rejects.toThrow("no articles")
   })

   it("clamps out-of-bounds chronIdx to last article", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 1 }])
      const result = await nav.load(999)
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("loads the correct position", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.load(1)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("handles negative chronIdx by clamping to last", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.load(-5)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("uses pushState by default", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0")
   })

   it("uses replaceState when replace=true", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0, true)
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0")
   })

   it("handles single article feed", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.load(0)
      expect(result.article.s).toBe(1)
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("snaps to nearest filtered match when current does not match filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }])
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(3)
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenCalledWith(2)
   })

   it("snaps to later match when no earlier match exists", async () => {
      setupIndex([{ subId: 2 }, { subId: 2 }, { subId: 1 }])
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(0)
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("does not snap when current article matches filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(0)
      expect(data.loadArticle).toHaveBeenCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("does not snap when no filter is active", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.load(1)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("clamps NaN to last article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.load(NaN)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("clamps Infinity to last article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.load(Infinity)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("loads position 0 correctly", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.load(0)
      expect(data.loadArticle).toHaveBeenCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("respects floor when snapping left in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 1 }])
      nav.setFilterSubs(new Set([1]))
      nav.setFloorChron(1)
      const result = await nav.load(2)
      // Should skip index 0 (below floor) and find index 3 to the right
      expect(data.loadArticle).toHaveBeenCalledWith(3)
      expect(result.article.s).toBe(1)
   })
})

describe("left", () => {
   it("decrements pos in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(2)
      const r1 = await nav.left()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
   })

   it("stays at 0 when already at start", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      const result = await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("in filter mode, finds previous matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("3!1")
      const result = await nav.left()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("in filter mode, stays put when no match exists", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      await nav.fromHash("1!1")
      const result = await nav.left()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
   })

   it("respects floor constraint in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      nav.setFloorChron(1)
      await nav.load(1)
      const result = await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("respects floor constraint in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      nav.setFloorChron(2)
      await nav.fromHash("3~2!1")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(r1.has_left).toBe(false)
   })

   it("finds last matching entry searching backward", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("3!1")
      await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
   })

   it("returns first matching entry when it is at index 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("3!1")
      const r1 = await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(r1.has_left).toBe(false)
   })

   it("multi-sub filter matches any sub in filter set going left", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("3!1+3")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(3)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
   })
})

describe("right", () => {
   it("increments pos in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(0)
      const r1 = await nav.right()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(3)
   })

   it("stays at last when already at end", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(2)
      const result = await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("in filter mode, finds next matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
   })

   it("in filter mode, stays put when no match exists", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("filter mode skips non-matching entries", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      expect(result.article.s).toBe(1)
   })

   it("multi-sub filter matches any sub in filter set going right", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0!1+3")
      const r1 = await nav.right()
      expect(r1.article.s).toBe(3)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(1)
   })

   it("updates hash after right navigation", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(0)
      await nav.right()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })
})

describe("last", () => {
   it("finds last matching entry for a sub", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1, total_art: 2 }))
      await nav.load(0)
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("goes to last article when sub has no articles", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subs_mapped.set(5, makeSub({ id: 5, total_art: 0 }))
      await nav.load(0)
      const result = await nav.last("5")
      expect(result.filtered).toBe(false)
   })

   it("goes to last article when sub not found in subs_mapped", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(0)
      const result = await nav.last("999")
      expect(result.filtered).toBe(false)
   })

   it("uses current filter when called without subId in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1, total_art: 1 }))
      await nav.fromHash("0!1")
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("clears filter when called without subId and no filter active", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(0)
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("falls back to latest unfiltered when sub not found in any entry", async () => {
      setupIndex([{ subId: 3 }, { subId: 4 }])
      data.db.subs_mapped.set(5, makeSub({ id: 5, total_art: 1 }))
      await nav.load(0)
      const result = await nav.last("5")
      expect(result.filtered).toBe(false)
   })

   it("last with empty string subId clears filter and goes to latest", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(0)
      const result = await nav.last("")
      expect(result.filtered).toBe(false)
   })

   it("last with NaN subId goes to latest unfiltered", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      const result = await nav.last("abc")
      expect(result.filtered).toBe(false)
   })

   it("scans backward to find last matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 2 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1, total_art: 1 }))
      await nav.load(3)
      const result = await nav.last("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("preserves multi-sub filter set when called with no arg", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1, total_art: 1 }))
      data.db.subs_mapped.set(3, makeSub({ id: 3, total_art: 1 }))
      await nav.fromHash("0!1+3")
      const result = await nav.last()
      expect(result.article.s).toBe(3)
      expect(result.filtered).toBe(true)
   })
})

describe("toggleFilter", () => {
   it("toggles between all and current sub's filter", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      let result = await nav.toggleFilter()
      expect(result.filtered).toBe(true)
      result = await nav.toggleFilter()
      expect(result.filtered).toBe(false)
   })

   it("returns to all from filtered state", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.load(2)
      await nav.toggleFilter()
      const result = await nav.toggleFilter()
      expect(result.filtered).toBe(false)
      expect(result.article.s).toBe(1)
   })

   it("updates hash with filter marker when toggled on", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      await nav.toggleFilter()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!1")
   })

   it("updates hash without filter marker when toggled off", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      await nav.toggleFilter()
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.toggleFilter()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0")
   })

   it("toggle on then off stays on same article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.load(2)
      await nav.toggleFilter()
      const result = await nav.toggleFilter()
      expect(result.filtered).toBe(false)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("returns correct sub after toggle", async () => {
      const sub = makeSub({ id: 1, title: "MySub" })
      data.db.subs_mapped.set(1, sub)
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      const result = await nav.toggleFilter()
      expect(result.article.s).toBe(1)
      expect(result.sub).toBe(sub)
   })

   it("toggleFilter produces numeric token in hash", async () => {
      setupIndex([{ subId: 7 }])
      await nav.load(0)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.toggleFilter()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!7")
   })
})

describe("fromHash", () => {
   it("parses basic hash (#123)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("parses floor hash (#123~50)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1~50")
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(50)
   })

   it("parses filter hash (#123!42)", async () => {
      setupIndex([{ subId: 1 }, { subId: 42 }])
      const result = await nav.fromHash("1!42")
      expect(result.filtered).toBe(true)
   })

   it("parses combined hash (#123~50!42)", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0~2!1")
      expect(result.floor).toBe(true)
      expect(result.filtered).toBe(true)
      expect(nav.floorChron).toBe(2)
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0~2!1")
   })

   it("parses tag filter (#123!tag:news)", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "news" }), makeSub({ id: 2, tag: "news" })]
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("1!news")
      expect(result.filtered).toBe(true)
      expect(result.article.s).toBe(2)
   })

   it("handles empty hash", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("")
      expect(result.article.s).toBe(1)
   })

   it("handles non-numeric hash values", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("abc")
      expect(result.article.s).toBe(1)
   })

   it("bare ! treated as no filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1!")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("parses multi-sub filter from hash", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1!1+3")
      expect(result.filtered).toBe(true)
   })

   it("ignores unresolved tag tokens from hash", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0!1+abc+3")
      expect(result.filtered).toBe(true)
   })

   it("uses replaceState for hash updates", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0")
      expect(history.replaceState).toHaveBeenCalled()
   })

   it.each(["0~-5", "0~abc"])("parses invalid floor %s as 0", async (hash) => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash(hash)
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("floor 0 from hash means no floor", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0~0")
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("hash with ! before ~ ignores tilde in filter portion", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0!1~5")
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("hash with only tilde", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("~")
      expect(result.floor).toBe(false)
   })

   it("hash with empty tokens between plus signs", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0!1++3")
      expect(result.filtered).toBe(true)
   })

   it("tag with no matching subs clears filter", async () => {
      data.db.subscriptions = []
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0!nonexistent")
      expect(result.filtered).toBe(false)
   })

   it("hash preserves tag token instead of expanding to sub IDs", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2, tag: "tech" })]
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0!tech")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!tech")
   })

   it("mixed tag and sub ID tokens in hash", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2 })]
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("1!tech+2")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#1!tech+2")
   })

   it("fromHash snaps to matching article when current does not match filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("resolves token '0' as sub ID 0", async () => {
      data.db.subscriptions = [makeSub({ id: 0, title: "Zero" })]
      data.db.subs_mapped.set(0, data.db.subscriptions[0])
      setupIndex([{ subId: 0 }])
      const result = await nav.fromHash("0!0")
      expect(result.filtered).toBe(true)
   })

   it("clears floor when no ~ segment", async () => {
      nav.setFloorChron(2)
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0")
      expect(result.floor).toBe(false)
   })
})

describe("floor", () => {
   it("setFloorHere sets floor to current pos", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      const result = nav.setFloorHere()
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(1)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1~1")
   })

   it("clearFloor resets floor to 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFloorChron(1)
      await nav.load(1)
      const result = nav.clearFloor()
      expect(result.floor).toBe(false)
      expect(result.has_left).toBe(true)
      expect(nav.floorChron).toBe(0)
   })

   it("setFloorAt sets arbitrary floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      const result = await nav.setFloorAt(1)
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(1)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1~1")
   })

   it("setFloorAt with 0 means no floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      const result = await nav.setFloorAt(0)
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("left() respects floor in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      nav.setFloorChron(1)
      await nav.load(2)
      const r1 = await nav.left()
      expect(r1.article.s).toBe(2)
      expect(r1.has_left).toBe(false)
      // Should not go below floor
      const r2 = await nav.left()
      expect(r2.article.s).toBe(2)
   })

   it("left() respects floor in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      nav.setFloorChron(2)
      await nav.fromHash("3~2!1")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(r1.has_left).toBe(false)
   })

   it("has_left is false when at floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFloorChron(1)
      const result = await nav.load(1)
      expect(result.has_left).toBe(false)
      expect(result.floor).toBe(true)
   })

   it("has_left true above floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      nav.setFloorChron(0)
      const result = await nav.load(2)
      expect(result.has_left).toBe(true)
   })

   it("load does not block navigation below floor (soft floor)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFloorChron(5)
      const result = await nav.load(0)
      expect(result.article.s).toBe(1)
   })

   it("floorChron export reflects setFloorChron changes", () => {
      expect(nav.floorChron).toBe(0)
      nav.setFloorChron(5)
      expect(nav.floorChron).toBe(5)
      nav.setFloorChron(0)
      expect(nav.floorChron).toBe(0)
   })

   it("fromHash parses floor from hash", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1~2")
      expect(result.floor).toBe(true)
   })

   it("clearFloor resets floorChron to 0 after setFloorHere", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      nav.setFloorHere()
      expect(nav.floorChron).toBe(1)
      nav.clearFloor()
      expect(nav.floorChron).toBe(0)
   })

   it("floor blocks filter left from crossing floor boundary", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      nav.setFloorChron(2)
      await nav.fromHash("2~2!1")
      const result = await nav.left()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })
})

describe("countLeft", () => {
   it("is always a number (never null)", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.load(0)
      expect(typeof result.countLeft).toBe("number")
   })

   it("correct count in unfiltered mode (pos - floorChron)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.load(2)
      expect(result.countLeft).toBe(2)
   })

   it("returns 0 at chronIdx 0 unfiltered", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.load(0)
      expect(result.countLeft).toBe(0)
   })

   it("subtracts floor in unfiltered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(1)
      nav.setFloorHere()
      const result = await nav.load(2)
      expect(result.countLeft).toBe(1)
   })

   it("correct count in filtered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1 }))
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(3)
      expect(result.countLeft).toBe(2)
   })

   it("filtered: returns 0 at the first match", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1 }))
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(1)
      expect(result.countLeft).toBe(0)
   })

   it("filtered with floor: counts from floor", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }, { subId: 1 }, { subId: 1 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1 }))
      nav.setFilterSubs(new Set([1]))
      nav.setFloorChron(1)
      const result = await nav.load(3)
      expect(result.countLeft).toBe(2)
   })

   it("filtered: returns 0 when current is the only match", async () => {
      setupIndex([{ subId: 2 }, { subId: 2 }, { subId: 1 }])
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(2)
      expect(result.countLeft).toBe(0)
   })

   it("unfiltered with floor at same position: returns 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFloorChron(1)
      const result = await nav.load(1)
      expect(result.countLeft).toBe(0)
   })

   it("multi-sub filter counts articles matching any sub in set", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }, { subId: 3 }])
      nav.setFilterSubs(new Set([1, 3]))
      const result = await nav.load(4)
      expect(result.countLeft).toBe(3)
   })
})

describe("showFeed", () => {
   it("has_left/has_right correct in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])

      const first = await nav.load(0)
      expect(first.has_left).toBe(false)
      expect(first.has_right).toBe(true)

      const mid = await nav.load(1)
      expect(mid.has_left).toBe(true)
      expect(mid.has_right).toBe(true)

      const last = await nav.load(2)
      expect(last.has_left).toBe(true)
      expect(last.has_right).toBe(false)
   })

   it("has_left/has_right correct in filtered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }, { subId: 1 }])
      nav.setFilterSubs(new Set([1]))

      const first = await nav.load(0)
      expect(first.has_left).toBe(false)
      expect(first.has_right).toBe(true)

      const mid = await nav.load(2)
      expect(mid.has_left).toBe(true)
      expect(mid.has_right).toBe(true)

      const last = await nav.load(4)
      expect(last.has_left).toBe(true)
      expect(last.has_right).toBe(false)
   })

   it("has_right false in filtered mode with no later same-sub entries", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(result.has_right).toBe(false)
   })

   it("has_left false in filtered mode with no earlier same-sub entries", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.has_left).toBe(false)
   })

   it("sub is looked up from subs_mapped", async () => {
      const sub = makeSub({ id: 1, title: "MySub", url: "http://sub.com" })
      data.db.subs_mapped.set(1, sub)
      setupIndex([{ subId: 1 }])
      const result = await nav.load(0)
      expect(result.sub).toBe(sub)
   })

   it("sub is undefined when not in subs_mapped", async () => {
      setupIndex([{ subId: 99 }])
      const result = await nav.load(0)
      expect(result.sub).toBeUndefined()
   })

   it("floor is true when floorChron > 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFloorChron(1)
      const result = await nav.load(1)
      expect(result.floor).toBe(true)
   })

   it("floor is false when floorChron is 0", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.load(0)
      expect(result.floor).toBe(false)
   })

   it("filtered flag reflects filter state", async () => {
      setupIndex([{ subId: 1 }])
      const unfiltered = await nav.load(0)
      expect(unfiltered.filtered).toBe(false)

      nav.setFilterSubs(new Set([1]))
      const filtered = await nav.load(0)
      expect(filtered.filtered).toBe(true)
   })

   it("single article has no left and no right", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.load(0)
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })
})

describe("getFilterEntries", () => {
   it("returns only empty string when no active subs", () => {
      data.activeSubs.mockReturnValue([])
      const entries = nav.getFilterEntries()
      expect(entries).toEqual([""])
   })

   it("returns tags sorted then untagged sub IDs", () => {
      const sub1 = makeSub({ id: 1, title: "Z-Sub", total_art: 5, tag: "beta" })
      const sub2 = makeSub({ id: 2, title: "A-Sub", total_art: 3, tag: "alpha" })
      const sub3 = makeSub({ id: 3, title: "B-Sub", total_art: 2 })
      data.activeSubs.mockReturnValue([sub2, sub3, sub1])
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "tag:alpha", "tag:beta", "3"])
   })

   it("deduplicates tags from multiple subs", () => {
      const sub1 = makeSub({ id: 1, title: "A", total_art: 1, tag: "tech" })
      const sub2 = makeSub({ id: 2, title: "B", total_art: 1, tag: "tech" })
      data.activeSubs.mockReturnValue([sub1, sub2])
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "tag:tech"])
   })
})

describe("getCurrentFilterKey", () => {
   it("returns empty string when no filter", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      expect(nav.getCurrentFilterKey()).toBe("")
   })

   it("returns sub ID for numeric filter", () => {
      nav.setFilterTokens(["5"])
      expect(nav.getCurrentFilterKey()).toBe("5")
   })

   it("returns tag:name for tag filter", () => {
      const sub1 = makeSub({ id: 1, title: "Sub1", tag: "news" })
      data.db.subs_mapped = new Map([[1, sub1]])
      data.db.subscriptions = [sub1]
      nav.setFilterTokens(["news"])
      expect(nav.getCurrentFilterKey()).toBe("tag:news")
   })

   it("returns tag for multi-ID filter matching a tag group", () => {
      const sub1 = makeSub({ id: 1, title: "Sub1", tag: "tech" })
      const sub2 = makeSub({ id: 2, title: "Sub2", tag: "tech" })
      data.db.subs_mapped = new Map([
         [1, sub1],
         [2, sub2],
      ])
      data.db.subscriptions = [sub1, sub2]
      nav.setFilterSubs(new Set([1, 2]))
      expect(nav.getCurrentFilterKey()).toBe("tag:tech")
   })

   it("returns empty string for multi-ID filter not matching any tag", () => {
      const sub1 = makeSub({ id: 1, title: "Sub1" })
      const sub2 = makeSub({ id: 2, title: "Sub2" })
      data.db.subs_mapped = new Map([
         [1, sub1],
         [2, sub2],
      ])
      data.db.subscriptions = [sub1, sub2]
      nav.setFilterSubs(new Set([1, 2]))
      expect(nav.getCurrentFilterKey()).toBe("")
   })
})

describe("applyFilter", () => {
   it("with undefined clears filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFilterSubs(new Set([1]))
      await nav.load(0)
      const result = await nav.applyFilter(undefined)
      expect(result.filtered).toBe(false)
      expect(result.article.s).toBe(1)
   })

   it("with tokens sets filter and snaps if needed", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.load(1) // on sub 2
      const result = await nav.applyFilter(["1"])
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("stays on current article when it matches new filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(0) // on sub 1
      const result = await nav.applyFilter(["1"])
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("applies tag filter via tokens", async () => {
      data.db.subscriptions = [makeSub({ id: 5, tag: "news" }), makeSub({ id: 6, tag: "news" })]
      setupIndex([{ subId: 5 }, { subId: 6 }])
      await nav.load(0)
      const result = await nav.applyFilter(["news"])
      expect(result.filtered).toBe(true)
   })
})

describe("cycleFilter", () => {
   it("setFilterTokens resolves tag and sets filter", async () => {
      data.db.subscriptions = [makeSub({ id: 5, tag: "news" }), makeSub({ id: 6, tag: "news" })]
      setupIndex([{ subId: 5 }, { subId: 6 }])
      nav.setFilterTokens(["news"])
      const result = await nav.load(1)
      expect(result.filtered).toBe(true)
   })

   it("setFilterSubs with undefined clears filter", async () => {
      setupIndex([{ subId: 1 }])
      nav.setFilterSubs(new Set([1]))
      const r1 = await nav.load(0)
      expect(r1.filtered).toBe(true)
      nav.setFilterSubs(undefined)
      const r2 = await nav.load(0)
      expect(r2.filtered).toBe(false)
   })

   it("setFilterTokens with undefined clears filter", async () => {
      setupIndex([{ subId: 1 }])
      nav.setFilterTokens(["1"])
      const r1 = await nav.load(0)
      expect(r1.filtered).toBe(true)
      nav.setFilterTokens(undefined)
      const r2 = await nav.load(0)
      expect(r2.filtered).toBe(false)
   })
})

describe("hash updates", () => {
   it("load uses pushState with correct format", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })

   it("left uses pushState", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.left()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0")
   })

   it("right uses pushState", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(0)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.right()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })

   it("toggleFilter uses pushState", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.toggleFilter()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!1")
   })

   it("fromHash uses replaceState", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0")
   })

   it("hash format includes floor when set", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0~2")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0~2")
   })

   it("hash format includes filter tokens", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0!1")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!1")
   })

   it("hash format includes both floor and filter", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0~2!1")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0~2!1")
   })

   it("hash includes chronIdx after navigation", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(2)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.left()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })

   it("multi-sub filter hash serializes sorted sub IDs", async () => {
      setupIndex([{ subId: 3 }])
      nav.setFilterSubs(new Set([3, 1]))
      await nav.load(0)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!1+3")
   })

   it("last() preserves tag token in hash", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech", total_art: 1 })]
      data.db.subs_mapped.set(1, data.db.subscriptions[0])
      setupIndex([{ subId: 1 }])
      nav.setFilterTokens(["tech"])
      await nav.last()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!tech")
   })

   it("setFloorHere updates hash with floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      nav.setFloorHere()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1~1")
   })

   it("clearFloor updates hash without floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.setFloorChron(1)
      await nav.load(1)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      nav.clearFloor()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })

   it("setFloorAt updates hash", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.setFloorAt(1)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1~1")
   })

   it("last updates hash", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subs_mapped.set(1, makeSub({ id: 1, total_art: 1 }))
      await nav.load(0)
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      await nav.last("1")
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!1")
   })
})

describe("jumpToEnd", () => {
   it("navigates to last article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(0)
      const result = await nav.jumpToEnd()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("returns last article when already at end", async () => {
      setupIndex([{ subId: 1 }])
      await nav.load(0)
      const result = await nav.jumpToEnd()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("jumps to last article and snaps to filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }])
      nav.setFilterSubs(new Set([1]))
      await nav.load(0)
      const result = await nav.jumpToEnd()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(1)
   })
})

describe("first", () => {
   it("returns current article when floor is 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.load(1)
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("navigates to floor chronIdx when floor is set", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.load(2)
      nav.setFloorChron(1)
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("navigates to floor chronIdx in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      nav.setFilterSubs(new Set([1]))
      nav.setFloorChron(2)
      await nav.load(3)
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("returns current article when floor is 0 in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      nav.setFilterSubs(new Set([1]))
      await nav.load(2)
      await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })
})

describe("tag tokens", () => {
   it("fromHash resolves tag token to sub IDs", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2, tag: "tech" }), makeSub({ id: 3 })]
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("1!tech")
      expect(result.filtered).toBe(true)
      expect(result.article.s).toBe(2)
   })

   it("last() preserves tag token in hash", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech", total_art: 1 })]
      data.db.subs_mapped.set(1, data.db.subscriptions[0])
      setupIndex([{ subId: 1 }])
      nav.setFilterTokens(["tech"])
      const result = await nav.last()
      expect(result.filtered).toBe(true)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0!tech")
   })
})
