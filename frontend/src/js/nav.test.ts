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
   findLeft: vi.fn((from: number, subs: Map<number, number>) => {
      for (let i = from; i >= 0; i--) {
         const subId = data.getSubId(i)
         const addIdx = subs.get(subId)
         if (addIdx !== undefined && i >= addIdx) return i
      }
      return -1
   }),
   findRight: vi.fn((from: number, subs: Map<number, number>) => {
      const end = data.db.total_art
      for (let i = from; i < end; i++) {
         const subId = data.getSubId(i)
         const addIdx = subs.get(subId)
         if (addIdx !== undefined && i >= addIdx) return i
      }
      return -1
   }),
}))

vi.mock("./data", () => data)

import * as nav from "./nav"

function makeArticle(overrides: Partial<IArticle> = {}): IArticle {
   return { s: 1, a: 0, p: 0, t: "", l: "", c: "", ...overrides }
}

function makeSub(overrides: Partial<ISub> = {}): ISub {
   return { id: 1, title: "Test", src: [{ url: "http://test.com" }], total_art: 1, ...overrides } as ISub
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
   data.findLeft.mockClear()
   data.findRight.mockClear()
   nav.filter.clear()
   localStorage.removeItem("srr-seen")
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
      const result = await nav.fromHash(String(input))
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("parses basic hash (#1)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("handles single article feed", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0")
      expect(result.article.s).toBe(1)
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("snaps to later match when filter has no earlier match", async () => {
      setupIndex([{ subId: 2 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("does not snap when current article matches filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("parses filter hash (#1!42)", async () => {
      setupIndex([{ subId: 1 }, { subId: 42 }])
      const result = await nav.fromHash("1!42")
      expect(result.filtered).toBe(true)
   })

   it("parses tag filter", async () => {
      data.db.subscriptions = { "1": makeSub({ id: 1, tag: "news" }), "2": makeSub({ id: 2, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("1!news")
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

   it("hash with empty tokens between plus signs", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0!1++3")
      expect(result.filtered).toBe(true)
   })

   it("tag with no matching subs clears filter", async () => {
      data.db.subscriptions = {}
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0!nonexistent")
      expect(result.filtered).toBe(false)
   })

   it("hash preserves tag token instead of expanding to sub IDs", async () => {
      data.db.subscriptions = { "1": makeSub({ id: 1, tag: "tech" }), "2": makeSub({ id: 2, tag: "tech" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0!tech")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!tech")
   })

   it("mixed tag and sub ID tokens in hash", async () => {
      data.db.subscriptions = { "1": makeSub({ id: 1, tag: "tech" }), "2": makeSub({ id: 2 }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("1!tech+2")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#1!tech+2")
   })

   it("fromHash goes to last matching article when current does not match filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("resolves token '0' as sub ID 0", async () => {
      data.db.subscriptions = { "0": makeSub({ id: 0, title: "Zero" }) }
      setupIndex([{ subId: 0 }])
      const result = await nav.fromHash("0!0")
      expect(result.filtered).toBe(true)
   })

   it("multi-sub filter hash serializes sub IDs", async () => {
      setupIndex([{ subId: 3 }])
      await nav.fromHash("0!1+3")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!1+3")
   })
})

describe("left", () => {
   it("decrements pos in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("2")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#0")
   })

   it("throws when already at start", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("in filter mode, finds previous matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("3!1")
      const result = await nav.left()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }])
      await nav.fromHash("1!1")
      await expect(nav.left()).rejects.toThrow("no left match")
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
      await nav.fromHash("0")
      const r1 = await nav.right()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(3)
   })

   it("throws when already at end", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("2")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("in filter mode, finds next matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0!1")
      await expect(nav.right()).rejects.toThrow("no right match")
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
      await nav.fromHash("0")
      await nav.right()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })
})

describe("last", () => {
   it("finds last matching entry for a sub", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 2 })
      await nav.fromHash("0")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#2!1")
   })

   it("goes to last article when sub has no articles", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[5] = makeSub({ id: 5, total_art: 0 })
      await nav.fromHash("0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("goes to last article when sub not found in subscriptions", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0")
      nav.filter.set(["999"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("uses current filter when called without subId in filter mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 1 })
      await nav.fromHash("0!1")
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("clears filter when called without subId and no filter active", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("returns no-match article when sub not found in any entry", async () => {
      setupIndex([{ subId: 3 }, { subId: 4 }])
      data.db.subscriptions[5] = makeSub({ id: 5, total_art: 1 })
      await nav.fromHash("0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(result.filtered).toBe(true)
      expect(result.article.t).toBe("(no matching articles)")
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("filter.set with empty string auto-clears", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0")
      nav.filter.set([""])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("filter.set with NaN auto-clears", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0")
      nav.filter.set(["abc"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("scans backward to find last matching entry", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 2 }, { subId: 2 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 1 })
      await nav.fromHash("3")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("preserves multi-sub filter set when called with no arg", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      data.db.subscriptions[1] = makeSub({ id: 1, total_art: 1 })
      data.db.subscriptions[3] = makeSub({ id: 3, total_art: 1 })
      await nav.fromHash("0!1+3")
      const result = await nav.last()
      expect(result.article.s).toBe(3)
      expect(result.filtered).toBe(true)
   })
})

describe("countRight", () => {
   it("is always a number (never null)", async () => {
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0")
      expect(typeof result.countRight).toBe("number")
   })

   it("correct count in unfiltered mode (total - 1 - pos)", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const result = await nav.fromHash("0")
      expect(result.countRight).toBe(2)
   })

   it("returns 0 at last index unfiltered", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("1")
      expect(result.countRight).toBe(0)
   })

   it("decreases as pos approaches end", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      const mid = await nav.fromHash("1")
      expect(mid.countRight).toBe(1)
   })

   it("correct count in filtered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 1 }])
      const result = await nav.fromHash("0!1")
      expect(result.countRight).toBe(2)
   })

   it("filtered: returns 0 at the last match", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(result.countRight).toBe(0)
   })

   it("filtered: counts matches after pos", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }, { subId: 1 }, { subId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.countRight).toBe(2)
   })

   it("filtered: returns 0 when current is the only match", async () => {
      setupIndex([{ subId: 2 }, { subId: 2 }, { subId: 1 }])
      const result = await nav.fromHash("2!1")
      expect(result.countRight).toBe(0)
   })

   it("multi-sub filter counts articles matching any sub in set", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }, { subId: 1 }, { subId: 3 }])
      const result = await nav.fromHash("0!1+3")
      expect(result.countRight).toBe(3)
   })
})

describe("showFeed", () => {
   it("has_left/has_right correct in normal mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])

      const first = await nav.fromHash("0")
      expect(first.has_left).toBe(false)
      expect(first.has_right).toBe(true)

      const mid = await nav.fromHash("1")
      expect(mid.has_left).toBe(true)
      expect(mid.has_right).toBe(true)

      const last = await nav.fromHash("2")
      expect(last.has_left).toBe(true)
      expect(last.has_right).toBe(false)
   })

   it("has_left/has_right correct in filtered mode", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }, { subId: 1 }])

      const first = await nav.fromHash("0!1")
      expect(first.has_left).toBe(false)
      expect(first.has_right).toBe(true)

      const mid = await nav.fromHash("2!1")
      expect(mid.has_left).toBe(true)
      expect(mid.has_right).toBe(true)

      const last = await nav.fromHash("4!1")
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

   it("sub is looked up from subscriptions", async () => {
      const sub = makeSub({ id: 1, title: "MySub", src: [{ url: "http://sub.com" }] })
      data.db.subscriptions[1] = sub
      setupIndex([{ subId: 1 }])
      const result = await nav.fromHash("0")
      expect(result.sub).toBe(sub)
   })

   it("sub is undefined when not in subscriptions", async () => {
      setupIndex([{ subId: 99 }])
      delete data.db.subscriptions[99]
      const result = await nav.fromHash("0")
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
      await nav.fromHash("0")
      const result = await nav.last("")
      expect(result.filtered).toBe(false)
      expect(result.article.s).toBe(2)
   })

   it("with token sets filter and jumps to last match", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("1")
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("jumps to last matching article for given token", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0")
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("applies tag filter via token", async () => {
      data.db.subscriptions = { "5": makeSub({ id: 5, tag: "news" }), "6": makeSub({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 5 }, { subId: 6 }])
      await nav.fromHash("0")
      const result = await nav.last("news")
      expect(result.filtered).toBe(true)
   })
})

describe("switchFilter", () => {
   it("with empty token clears filter and jumps to last", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      nav.filter.set(["1"])
      await nav.fromHash("0")
      const result = await nav.switchFilter("")
      expect(result.filtered).toBe(false)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("jumps to first matching article when sub has not been seen", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("0")
      const result = await nav.switchFilter("1")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("jumps to first matching article when tag has not been seen", async () => {
      data.db.subscriptions[5] = makeSub({ id: 5, tag: "news" })
      data.db.subscriptions[6] = makeSub({ id: 6, tag: "news" })
      setupIndex([{ subId: 5 }, { subId: 6 }, { subId: 5 }])
      await nav.fromHash("0")
      const result = await nav.switchFilter("news")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("resumes at last seen position when sub was previously viewed", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }, { subId: 2 }])
      await nav.fromHash("2") // chronIdx 2 (sub 1) → seen sub:1=2
      await nav.switchFilter("2") // sub 2 lands on chronIdx 1 (does not touch sub:1)
      const result = await nav.switchFilter("1")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("resumes at last seen position when tag was previously viewed", async () => {
      data.db.subscriptions[5] = makeSub({ id: 5, tag: "news" })
      data.db.subscriptions[6] = makeSub({ id: 6 })
      setupIndex([{ subId: 5 }, { subId: 6 }, { subId: 5 }])
      await nav.fromHash("0") // chronIdx 0 (sub 5, tag news) → seen tag:news=0
      await nav.switchFilter("6") // sub 6 (no tag) lands on chronIdx 1
      const result = await nav.switchFilter("news")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("falls back to first when stored position no longer matches filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      // Stale seen entry: chronIdx 1 is sub 2, doesn't match sub:1 filter.
      localStorage.setItem("srr-seen", JSON.stringify({ "sub:1": 1 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("falls back to first when stored position is beyond total_art", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "sub:1": 99 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("records both sub and tag seen positions on view", async () => {
      data.db.subscriptions[5] = makeSub({ id: 5, tag: "news" })
      setupIndex([{ subId: 5 }, { subId: 5 }])
      await nav.fromHash("1") // view chronIdx 1
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["sub:5"]).toBe(1)
      expect(seen["tag:news"]).toBe(1)
   })

   it("does not record tag seen for untagged sub", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0")
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["sub:1"]).toBe(0)
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })
})

describe("pruneSeen", () => {
   it("removes entries for deleted subs and tags", () => {
      data.db.subscriptions = { 1: makeSub({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "sub:1": 5, "sub:99": 10, "tag:news": 3, "tag:gone": 7 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "sub:1": 5, "tag:news": 3 })
   })

   it("keeps tag entry when at least one sub still has the tag", () => {
      data.db.subscriptions = {
         1: makeSub({ id: 1, tag: "news" }),
         2: makeSub({ id: 2 }),
      }
      localStorage.setItem("srr-seen", JSON.stringify({ "sub:1": 0, "tag:news": 0 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "sub:1": 0, "tag:news": 0 })
   })

   it("does not write when nothing is stale", () => {
      data.db.subscriptions = { 1: makeSub({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "sub:1": 0, "tag:news": 0 }))
      const setSpy = vi.spyOn(Storage.prototype, "setItem")
      nav.pruneSeen()
      expect(setSpy).not.toHaveBeenCalled()
      setSpy.mockRestore()
   })
})

describe("filter mutations", () => {
   it("set() resolves tag and sets filter", async () => {
      data.db.subscriptions = { "5": makeSub({ id: 5, tag: "news" }), "6": makeSub({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.subscriptions)) s.id = Number(k)
      setupIndex([{ subId: 5 }, { subId: 6 }])
      const result = await nav.fromHash("1!news")
      expect(result.filtered).toBe(true)
   })

   it("clear() clears filter", async () => {
      setupIndex([{ subId: 1 }])
      const r1 = await nav.fromHash("0!1")
      expect(r1.filtered).toBe(true)
      const r2 = await nav.fromHash("0")
      expect(r2.filtered).toBe(false)
   })
})

describe("jumpToEnd via last()", () => {
   it("navigates to last article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("returns last article when already at end", async () => {
      setupIndex([{ subId: 1 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("jumps to last article and snaps to filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }])
      await nav.fromHash("0!1")
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
      await nav.fromHash("0")
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
      await nav.fromHash("0")
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
      await nav.fromHash("1!2")
      // entries = ["", "1", "2"], current = "2" (idx 2), dir = 1 → wraps to idx 0 ("")
      const result = await nav.cycleFilter(1)
      expect(result.filtered).toBe(false)
   })
})

describe("first", () => {
   it("navigates to first article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("1")
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("navigates to first filtered article", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 1 }])
      await nav.fromHash("2!1")
      await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("starts findRight from min add_idx (skips packs before any filter sub existed)", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }, { subId: 2 }])
      data.db.subscriptions[2].add_idx = 2
      data.findRight.mockClear()
      await nav.fromHash("3!2")
      await nav.first()
      const lastCall = data.findRight.mock.calls.at(-1)!
      expect(lastCall[0]).toBe(2)
   })
})

describe("goTo", () => {
   it("navigates directly to target when no filter active", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0")
      const result = await nav.goTo(2)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("navigates directly when target matches filter", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }, { subId: 3 }])
      await nav.fromHash("0")
      const result = await nav.goTo(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("snaps forward when target does not match active filter", async () => {
      setupIndex([{ subId: 2 }, { subId: 1 }, { subId: 1 }])
      await nav.fromHash("2!1")
      const result = await nav.goTo(0)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(1)
   })

   it("falls back to last when no match at or after target", async () => {
      setupIndex([{ subId: 1 }, { subId: 1 }, { subId: 2 }])
      await nav.fromHash("0!1")
      const result = await nav.goTo(2)
      expect(result.article.s).toBe(1)
   })

   it("falls back to last for out-of-range target", async () => {
      setupIndex([{ subId: 1 }, { subId: 2 }])
      await nav.fromHash("0")
      const result = await nav.goTo(99)
      expect(result.article.s).toBe(2)
   })
})
