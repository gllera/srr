import { describe, it, expect, vi, beforeEach } from "vitest"

const data = vi.hoisted(() => ({
   IDX_PACK_SIZE: 50000 as const,
   db: {
      total_art: 0,
      subscriptions: {} as Record<number, ISub>,
   } as unknown as IDB,
   loadArticle: vi.fn<(chronIdx: number) => Promise<IArticle>>(),
   getArticleSync: vi.fn<(chronIdx: number) => IArticle | undefined>(),
   groupSubsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as ISub[] })),
   abortPending: vi.fn(),
   findChronForTimestamp: vi.fn(() => 0),
   getSubId: vi.fn<(chronIdx: number) => number>(),
   countLeft: vi.fn((chronIdx: number, subs: Map<number, number>) => {
      let count = 0
      for (let i = 0; i < chronIdx; i++) {
         const subId = data.getSubId(i)
         const addIdx = subs.get(subId)
         if (addIdx !== undefined && i >= addIdx) count++
      }
      return count
   }),
}))

vi.mock("./data", () => data)

import * as nav from "./nav"

function makeArticle(overrides: Partial<IArticle> = {}): IArticle {
   return { s: 1, a: 0, p: 0, t: "", l: "", c: "", ...overrides }
}

function makeSub(overrides: Partial<ISub> = {}): ISub {
   return { id: 1, title: "Test", url: "http://test.com", total_art: 1, ...overrides } as ISub
}

function setupIndex(entries: Array<{ subId: number; fetchedAt?: number }>) {
   data.db.total_art = entries.length
   const sIds = new Uint32Array(entries.map((e) => e.subId))
   const fAts = new Uint32Array(entries.map((e) => e.fetchedAt ?? 0))
   data.loadArticle.mockImplementation(async (idx: number) => makeArticle({ s: sIds[idx], a: fAts[idx] }))
   data.getArticleSync.mockImplementation((idx: number) => makeArticle({ s: sIds[idx], a: fAts[idx] }))
   data.getSubId.mockImplementation((idx: number) => sIds[idx])
   const counts = new Map<number, number>()
   for (const e of entries) counts.set(e.subId, (counts.get(e.subId) ?? 0) + 1)
   for (const [id, count] of counts)
      if (!data.db.subscriptions[id]) data.db.subscriptions[id] = makeSub({ id, total_art: count })
   nav.filter.clear()
}

beforeEach(() => {
   data.db.total_art = 0
   data.db.subscriptions = {}
   data.loadArticle.mockReset()
   data.getArticleSync.mockReset()
   data.getSubId.mockReset()
   nav.filter.clear()
   vi.spyOn(history, "pushState").mockImplementation(() => {})
   vi.spyOn(history, "replaceState").mockImplementation(() => {})
})

describe("fromHash", () => {
   it("rejects when total_art is 0", async () => {
      data.db.total_art = 0
      await expect(nav.fromHash("0")).rejects.toThrow("no articles")
   })

   it.each([999, -5, NaN, Infinity])("clamps %s to last article", async (input) => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0," + input)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("parses basic hash (#123)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0,1")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("handles single article feed", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0")
      expect(result.article.s).toBe(1)
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("snaps to later match when filter has no earlier match", async () => {
      setupIndex([{ subId: 2 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("0,0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("does not snap when current article matches filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0,0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("respects floor when snapping in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("1,2!1")
      // Should skip index 0 (below floor) and find index 3 to the right
      expect(data.loadArticle).toHaveBeenCalledWith(3)
      expect(result.article.s).toBe(1)
   })

   it("parses floor hash (#123~50)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("50,1")
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(50)
   })

   it("parses filter hash (#123!42)", async () => {
      setupIndex([{ subId: 1 }, { subId: 42 }])
      const result = await nav.fromHash("0,1!42")
      expect(result.filtered).toBe(true)
   })

   it("parses combined hash (#123~50!42)", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("2,0!1")
      expect(result.floor).toBe(true)
      expect(result.filtered).toBe(true)
      expect(nav.floorChron).toBe(2)
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#2,0!1")
   })

   it("parses tag filter (#123!tag:news)", async () => {
      data.db.subscriptions = { "1": makeSub({ id: 1, tag: "news" }), "2": makeSub({ id: 2, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("0,1!news")
      expect(result.filtered).toBe(true)
      expect(result.article.s).toBe(2)
   })

   it.each(["", "abc"])("handles non-numeric hash %j by clamping", async (hash) => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash(hash)
      expect(result.article.s).toBe(1)
   })

   it("bare ! treated as no filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0,1!")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("parses multi-sub filter from hash", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0,1!1+3")
      expect(result.filtered).toBe(true)
   })

   it("ignores unresolved tag tokens from hash", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0!1+abc+3")
      expect(result.filtered).toBe(true)
   })

   it.each(["-5,0", "abc,0"])("parses invalid floor %s as 0", async (hash) => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash(hash)
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("floor 0 from hash means no floor", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0")
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("hash with ! before , ignores comma in filter portion", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0!1,5")
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("hash with only comma", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash(",")
      expect(result.floor).toBe(false)
   })

   it("hash with empty tokens between plus signs", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0!1++3")
      expect(result.filtered).toBe(true)
   })

   it("tag with no matching subs clears filter", async () => {
      data.db.subscriptions = {}
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0!nonexistent")
      expect(result.filtered).toBe(false)
   })

   it("hash preserves tag token instead of expanding to sub IDs", async () => {
      data.db.subscriptions = { "1": makeSub({ id: 1, tag: "tech" }), "2": makeSub({ id: 2, tag: "tech" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0,0!tech")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0,0!tech")
   })

   it("mixed tag and sub ID tokens in hash", async () => {
      data.db.subscriptions = { "1": makeSub({ id: 1, tag: "tech" }), "2": makeSub({ id: 2 }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,1!tech+2")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0,1!tech+2")
   })

   it("fromHash goes to last matching article when current does not match filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("0,1!1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("resolves token '0' as sub ID 0", async () => {
      data.db.subscriptions = { "0": makeSub({ id: 0, title: "Zero" }) }
      setupIndex([{ subId: 0 }])
      const result = await nav.fromHash("0,0!0")
      expect(result.filtered).toBe(true)
   })

   it("clears floor from previous navigation", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("2,0")
      const result = await nav.fromHash("0,0")
      expect(result.floor).toBe(false)
   })

   it("multi-sub filter hash serializes sorted sub IDs", async () => {
      setupIndex([{ subId: 3 }])
      await nav.fromHash("0,0!1+3")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0,0!1+3")
   })
})

describe("left", () => {
   it("decrements pos in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0,2")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#0,0")
   })

   it("throws when already at start", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0,0")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("in filter mode, finds previous matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0,3!1")
      const result = await nav.left()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      await nav.fromHash("0,1!1")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("finds last matching entry searching backward", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("0,3!1")
      await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
   })

   it("returns first matching entry when it is at index 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("0,3!1")
      const r1 = await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(r1.has_left).toBe(false)
   })

   it("multi-sub filter matches any sub in filter set going left", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0,3!1+3")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(3)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
   })
})

describe("right", () => {
   it("increments pos in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0,0")
      const r1 = await nav.right()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(3)
   })

   it("throws when already at end", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0,2")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("in filter mode, finds next matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0,0!1")
      const result = await nav.right()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0!1")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("multi-sub filter matches any sub in filter set going right", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0,0!1+3")
      const r1 = await nav.right()
      expect(r1.article.s).toBe(3)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(1)
   })

   it("updates hash after right navigation", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0")
      await nav.right()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0,1")
   })
})

describe("last", () => {
   it("finds last matching entry for a sub", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 2 })
      await nav.fromHash("0,0")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0,2!1")
   })

   it("goes to last article when sub has no articles", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[5] = makeSub({ id: 5, total_art: 0 })
      await nav.fromHash("0,0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("goes to last article when sub not found in subscriptions", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0")
      nav.filter.set(["999"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("uses current filter when called without subId in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 1 })
      await nav.fromHash("0,0!1")
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("clears filter when called without subId and no filter active", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0")
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("returns no-match article when sub not found in any entry", async () => {
      setupIndex([{ subId: 3 }, { subId: 4 }])
      data.db.subscriptions[5] = makeSub({ id: 5, total_art: 1 })
      await nav.fromHash("0,0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(result.filtered).toBe(true)
      expect(result.article.t).toBe("(no matching articles)")
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("filter.set with empty string auto-clears", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0")
      nav.filter.set([""])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("filter.set with NaN auto-clears", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0,0")
      nav.filter.set(["abc"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("scans backward to find last matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 1 })
      await nav.fromHash("0,3")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("preserves multi-sub filter set when called with no arg", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 1 })
      data.db.subscriptions[3] = makeSub({ id: 3, total_art: 1 })
      await nav.fromHash("0,0!1+3")
      const result = await nav.last()
      expect(result.article.s).toBe(3)
      expect(result.filtered).toBe(true)
   })
})

describe("floor", () => {
   it("setFloorHere sets floor to current pos", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,1")
      const result = nav.setFloorHere()
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(1)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1,1")
   })

   it("clearFloor resets floor to 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("1,1")
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      const result = nav.clearFloor()
      expect(result.floor).toBe(false)
      expect(result.has_left).toBe(true)
      expect(nav.floorChron).toBe(0)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#0,1")
   })

   it("setFloorAt sets arbitrary floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,1")
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      const result = await nav.setFloorAt(1)
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(1)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1,1")
   })

   it("setFloorAt with 0 means no floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,1")
      ;(history.pushState as ReturnType<typeof vi.fn>).mockClear()
      const result = await nav.setFloorAt(0)
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("left() respects floor in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("1,2")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(2)
      expect(r1.has_left).toBe(false)
      // Should not go below floor
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("left() respects floor in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      await nav.fromHash("2,3!1")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(r1.has_left).toBe(false)
   })

   it("has_left is false when at floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1,1")
      expect(result.has_left).toBe(false)
      expect(result.floor).toBe(true)
   })

   it("has_left true above floor", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("0,2")
      expect(result.has_left).toBe(true)
   })

   it("navigation below floor is not blocked (soft floor)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("5,0")
      expect(result.article.s).toBe(1)
   })

   it("fromHash parses floor from hash", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("2,1")
      expect(result.floor).toBe(true)
   })

   it("clearFloor resets floorChron to 0 after setFloorHere", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,1")
      nav.setFloorHere()
      expect(nav.floorChron).toBe(1)
      nav.clearFloor()
      expect(nav.floorChron).toBe(0)
   })

   it("floor blocks filter left from crossing floor boundary", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("2,2!1")
      await expect(nav.left()).rejects.toThrow("no left match")
   })
})

describe("countLeft", () => {
   it("is always a number (never null)", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0")
      expect(typeof result.countLeft).toBe("number")
   })

   it("correct count in unfiltered mode (pos - floorChron)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("0,2")
      expect(result.countLeft).toBe(2)
   })

   it("returns 0 at chronIdx 0 unfiltered", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0,0")
      expect(result.countLeft).toBe(0)
   })

   it("subtracts floor in unfiltered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0,1")
      nav.setFloorHere()
      const result = await nav.fromHash("1,2")
      expect(result.countLeft).toBe(1)
   })

   it("correct count in filtered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      data.db.subscriptions[1] = makeSub({ id: 1 })
      const result = await nav.fromHash("0,3!1")
      expect(result.countLeft).toBe(2)
   })

   it("filtered: returns 0 at the first match", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      data.db.subscriptions[1] = makeSub({ id: 1 })
      const result = await nav.fromHash("0,1!1")
      expect(result.countLeft).toBe(0)
   })

   it("filtered with floor: counts from floor", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }, { subId: 1 }, { subId: 1 }])
      data.db.subscriptions[1] = makeSub({ id: 1 })
      const result = await nav.fromHash("1,3!1")
      expect(result.countLeft).toBe(2)
   })

   it("filtered: returns 0 when current is the only match", async () => {
      setupIndex([{ subId: 2 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("0,2!1")
      expect(result.countLeft).toBe(0)
   })

   it("unfiltered with floor at same position: returns 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1,1")
      expect(result.countLeft).toBe(0)
   })

   it("multi-sub filter counts articles matching any sub in set", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }, { subId: 3 }])
      const result = await nav.fromHash("0,4!1+3")
      expect(result.countLeft).toBe(3)
   })
})

describe("showFeed", () => {
   it("has_left/has_right correct in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])

      const first = await nav.fromHash("0,0")
      expect(first.has_left).toBe(false)
      expect(first.has_right).toBe(true)

      const mid = await nav.fromHash("0,1")
      expect(mid.has_left).toBe(true)
      expect(mid.has_right).toBe(true)

      const last = await nav.fromHash("0,2")
      expect(last.has_left).toBe(true)
      expect(last.has_right).toBe(false)
   })

   it("has_left/has_right correct in filtered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }, { subId: 1 }])

      const first = await nav.fromHash("0,0!1")
      expect(first.has_left).toBe(false)
      expect(first.has_right).toBe(true)

      const mid = await nav.fromHash("0,2!1")
      expect(mid.has_left).toBe(true)
      expect(mid.has_right).toBe(true)

      const last = await nav.fromHash("0,4!1")
      expect(last.has_left).toBe(true)
      expect(last.has_right).toBe(false)
   })

   it("has_right false in filtered mode with no later same-sub entries", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0,0!1")
      expect(result.has_right).toBe(false)
   })

   it("has_left false in filtered mode with no earlier same-sub entries", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("0,1!1")
      expect(result.has_left).toBe(false)
   })

   it("sub is looked up from subscriptions", async () => {
      const sub = makeSub({ id: 1, title: "MySub", url: "http://sub.com" })
      data.db.subscriptions[1] = sub
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0,0")
      expect(result.sub).toBe(sub)
   })

   it("sub is undefined when not in subscriptions", async () => {
      setupIndex([{ subId: 99 }])
      delete data.db.subscriptions[99]
      const result = await nav.fromHash("0,0")
      expect(result.sub).toBeUndefined()
   })
})

describe("getFilterEntries", () => {
   it("returns only empty string when no active subs", () => {
      data.groupSubsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual([""])
   })

   it("returns tags sorted then untagged sub IDs", () => {
      const sub3 = makeSub({ id: 3, title: "B-Sub", total_art: 2 })
      data.groupSubsByTag.mockReturnValue({
         tagged: new Map([
            ["alpha", [makeSub({ id: 2, tag: "alpha" })]],
            ["beta", [makeSub({ id: 1, tag: "beta" })]],
         ]),
         sortedTags: ["alpha", "beta"],
         untagged: [sub3],
      })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "alpha", "beta", "3"])
   })

   it("returns single tag entry for multiple subs with same tag", () => {
      data.groupSubsByTag.mockReturnValue({
         tagged: new Map([["tech", [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2, tag: "tech" })]]]),
         sortedTags: ["tech"],
         untagged: [],
      })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "tech"])
   })
})

describe("last with token", () => {
   it("with empty string clears filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.filter.set(["1"])
      await nav.fromHash("0,0")
      const result = await nav.last("")
      expect(result.filtered).toBe(false)
      expect(result.article.s).toBe(2)
   })

   it("with token sets filter and jumps to last match", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("0,1")
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("jumps to last matching article for given token", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0")
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("applies tag filter via token", async () => {
      data.db.subscriptions = { "5": makeSub({ id: 5, tag: "news" }), "6": makeSub({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 5 }, { subId: 6 }])
      await nav.fromHash("0,0")
      const result = await nav.last("news")
      expect(result.filtered).toBe(true)
   })
})

describe("filter mutations", () => {
   it("set() resolves tag and sets filter", async () => {
      data.db.subscriptions = { "5": makeSub({ id: 5, tag: "news" }), "6": makeSub({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 5 }, { subId: 6 }])
      const result = await nav.fromHash("0,1!news")
      expect(result.filtered).toBe(true)
   })

   it("clear() clears filter", async () => {
      setupIndex([{ subId: 1 }])
      const r1 = await nav.fromHash("0,0!1")
      expect(r1.filtered).toBe(true)
      const r2 = await nav.fromHash("0,0")
      expect(r2.filtered).toBe(false)
   })
})

describe("jumpToEnd via last()", () => {
   it("navigates to last article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0,0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("returns last article when already at end", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0,0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("jumps to last article and snaps to filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,0!1")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(1)
   })
})

describe("cycleFilter", () => {
   it("cycles forward from no filter to first tag", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, tag: "news" })
      data.db.subscriptions[2] = makeSub({ id: 2 })
      data.groupSubsByTag.mockReturnValue({
         tagged: new Map([["news", [data.db.subscriptions[1]]]]),
         sortedTags: ["news"],
         untagged: [data.db.subscriptions[2]],
      })
      await nav.fromHash("0,0")
      const result = await nav.cycleFilter(1)
      expect(result.filtered).toBe(true)
   })

   it("cycles backward wrapping to last entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1 })
      data.db.subscriptions[2] = makeSub({ id: 2 })
      data.groupSubsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.subscriptions[1], data.db.subscriptions[2]],
      })
      await nav.fromHash("0,0")
      // entries = ["", "1", "2"], current = "" (idx 0), dir = -1 → wraps to idx 2 ("2")
      const result = await nav.cycleFilter(-1)
      expect(result.filtered).toBe(true)
   })

   it("clears filter when cycling back to all", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1 })
      data.db.subscriptions[2] = makeSub({ id: 2 })
      data.groupSubsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.subscriptions[1], data.db.subscriptions[2]],
      })
      await nav.fromHash("0,1!2")
      // entries = ["", "1", "2"], current = "2" (idx 2), dir = 1 → wraps to idx 0 ("")
      const result = await nav.cycleFilter(1)
      expect(result.filtered).toBe(false)
   })
})

describe("first", () => {
   it("navigates to first article when floor is 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0,1")
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("navigates to floor chronIdx when floor is set", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("1,2")
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("navigates to floor chronIdx in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      await nav.fromHash("2,3!1")
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("navigates to first filtered article when floor is 0", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("0,2!1")
      await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })
})
