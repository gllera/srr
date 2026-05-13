import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const data = vi.hoisted(() => ({
   IDX_PACK_SIZE: 50000 as const,
   db: {
      total_art: 0,
      channels: {} as Record<number, IChannel>,
   } as unknown as IDB,
   loadArticle: vi.fn<(chronIdx: number) => Promise<IArticle>>(),
   groupChannelsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IChannel[] })),
   findChronForTimestamp: vi.fn(() => 0),
   getChannelId: vi.fn<(chronIdx: number) => number>(),
   countLeft: vi.fn((chronIdx: number, channels: Map<number, number>) => {
      let count = 0
      for (let i = 0; i < chronIdx; i++) {
         const chanId = data.getChannelId(i)
         const addIdx = channels.get(chanId)
         if (addIdx !== undefined && i >= addIdx) count++
      }
      return count
   }),
   findLeft: vi.fn((from: number, channels: Map<number, number>) => {
      for (let i = from; i >= 0; i--) {
         const chanId = data.getChannelId(i)
         const addIdx = channels.get(chanId)
         if (addIdx !== undefined && i >= addIdx) return i
      }
      return -1
   }),
   findRight: vi.fn((from: number, channels: Map<number, number>) => {
      const end = data.db.total_art
      for (let i = from; i < end; i++) {
         const chanId = data.getChannelId(i)
         const addIdx = channels.get(chanId)
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

function makeChannel(overrides: Partial<IChannel> = {}): IChannel {
   return { id: 1, title: "Test", feeds: [{ url: "http://test.com" }], total_art: 1, ...overrides } as IChannel
}

function setupIndex(entries: Array<{ chanId: number; fetchedAt?: number }>) {
   data.db.total_art = entries.length
   const cIds = new Uint32Array(entries.map((e) => e.chanId))
   const fAts = new Uint32Array(entries.map((e) => e.fetchedAt ?? 0))
   data.loadArticle.mockImplementation(async (idx: number) => makeArticle({ s: cIds[idx], a: fAts[idx] }))
   data.getChannelId.mockImplementation((idx: number) => cIds[idx])
   const counts = new Map<number, number>()
   for (const e of entries) counts.set(e.chanId, (counts.get(e.chanId) ?? 0) + 1)
   for (const [id, count] of counts)
      if (!data.db.channels[id]) data.db.channels[id] = makeChannel({ id, total_art: count })
   nav.filter.clear()
}

beforeEach(() => {
   data.db.total_art = 0
   data.db.channels = {}
   data.loadArticle.mockReset()
   data.getChannelId.mockReset()
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
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash(String(input))
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("parses basic hash (#1)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("1")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("handles single article feed", async () => {
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash("0")
      expect(result.article.s).toBe(1)
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("snaps to later match when filter has no earlier match", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 2 }, { chanId: 1 }])
      const result = await nav.fromHash("0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      expect(result.article.s).toBe(1)
   })

   it("does not snap when current article matches filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("parses filter hash (#1!42)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 42 }])
      const result = await nav.fromHash("1!42")
      expect(result.filtered).toBe(true)
   })

   it("parses tag filter", async () => {
      data.db.channels = { "1": makeChannel({ id: 1, tag: "news" }), "2": makeChannel({ id: 2, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.channels)) s.id = Number(k)
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      const result = await nav.fromHash("1!news")
      expect(result.filtered).toBe(true)
      expect(result.article.s).toBe(2)
   })

   it.each(["", "abc"])("handles non-numeric hash %j by clamping", async (hash) => {
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash(hash)
      expect(result.article.s).toBe(1)
   })

   it("bare ! treated as no filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("1!")
      expect(result.article.s).toBe(2)
      expect(result.filtered).toBe(false)
   })

   it("parses multi-sub filter from hash", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("1!1+3")
      expect(result.filtered).toBe(true)
   })

   it("ignores unresolved tag tokens from hash", async () => {
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash("0!1+abc+3")
      expect(result.filtered).toBe(true)
   })

   it("hash with empty tokens between plus signs", async () => {
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash("0!1++3")
      expect(result.filtered).toBe(true)
   })

   it("tag with no matching subs clears filter", async () => {
      data.db.channels = {}
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash("0!nonexistent")
      expect(result.filtered).toBe(false)
   })

   it("hash preserves tag token instead of expanding to sub IDs", async () => {
      data.db.channels = { "1": makeChannel({ id: 1, tag: "tech" }), "2": makeChannel({ id: 2, tag: "tech" }) }
      for (const [k, s] of Object.entries(data.db.channels)) s.id = Number(k)
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0!tech")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!tech")
   })

   it("mixed tag and sub ID tokens in hash", async () => {
      data.db.channels = { "1": makeChannel({ id: 1, tag: "tech" }), "2": makeChannel({ id: 2 }) }
      for (const [k, s] of Object.entries(data.db.channels)) s.id = Number(k)
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("1!tech+2")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#1!tech+2")
   })

   it("fromHash goes to last matching article when current does not match filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("uses replaceState (not pushState) when snapping to a different position", async () => {
      // hashchange fires after the browser commits the URL; if the snap pushes
      // a new entry, pressing Back returns to the un-snapped URL and snaps
      // again, trapping the user in a loop. The snap must replace.
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("1!1")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#2!1")
      expect(history.pushState).not.toHaveBeenCalled()
   })

   it("resolves token '0' as sub ID 0", async () => {
      data.db.channels = { "0": makeChannel({ id: 0, title: "Zero" }) }
      setupIndex([{ chanId: 0 }])
      const result = await nav.fromHash("0!0")
      expect(result.filtered).toBe(true)
   })

   it("multi-sub filter hash serializes sub IDs", async () => {
      setupIndex([{ chanId: 3 }])
      await nav.fromHash("0!1+3")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!1+3")
   })
})

describe("left", () => {
   it("decrements pos in normal mode", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("2")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#0")
   })

   it("throws when already at start", async () => {
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("in filter mode, finds previous matching entry", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }, { chanId: 1 }])
      await nav.fromHash("3!1")
      const result = await nav.left()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("1!1")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("finds last matching entry searching backward", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("3!1")
      await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
   })

   it("returns first matching entry when it is at index 0", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("3!1")
      const r1 = await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(r1.has_left).toBe(false)
   })

   it("multi-sub filter matches any sub in filter set going left", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }, { chanId: 1 }])
      await nav.fromHash("3!1+3")
      const r1 = await nav.left()
      expect(r1.article.s).toBe(3)
      const r2 = await nav.left()
      expect(r2.article.s).toBe(1)
   })
})

describe("right", () => {
   it("increments pos in normal mode", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("0")
      const r1 = await nav.right()
      expect(r1.article.s).toBe(2)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(3)
   })

   it("throws when already at end", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("2")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("in filter mode, finds next matching entry", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }, { chanId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("multi-sub filter matches any sub in filter set going right", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }, { chanId: 1 }])
      await nav.fromHash("0!1+3")
      const r1 = await nav.right()
      expect(r1.article.s).toBe(3)
      const r2 = await nav.right()
      expect(r2.article.s).toBe(1)
   })

   it("updates hash after right navigation", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      await nav.right()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })
})

describe("last", () => {
   it("finds last matching entry for a sub", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 2 }])
      data.db.channels[1] = makeChannel({ id: 1, total_art: 2 })
      await nav.fromHash("0")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#2!1")
   })

   it("goes to last article when sub has no articles", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      data.db.channels[5] = makeChannel({ id: 5, total_art: 0 })
      await nav.fromHash("0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("goes to last article when sub not found in subscriptions", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      nav.filter.set(["999"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("uses current filter when called without subId in filter mode", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      data.db.channels[1] = makeChannel({ id: 1, total_art: 1 })
      await nav.fromHash("0!1")
      const result = await nav.last()
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("clears filter when called without subId and no filter active", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("returns no-match article when sub not found in any entry", async () => {
      setupIndex([{ chanId: 3 }, { chanId: 4 }])
      data.db.channels[5] = makeChannel({ id: 5, total_art: 1 })
      await nav.fromHash("0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(result.filtered).toBe(true)
      expect(result.article.t).toBe("(no matching articles)")
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("filter.set with empty string auto-clears", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      nav.filter.set([""])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("filter.set with NaN auto-clears", async () => {
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0")
      nav.filter.set(["abc"])
      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("scans backward to find last matching entry", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 2 }, { chanId: 2 }])
      data.db.channels[1] = makeChannel({ id: 1, total_art: 1 })
      await nav.fromHash("3")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("preserves multi-sub filter set when called with no arg", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      data.db.channels[1] = makeChannel({ id: 1, total_art: 1 })
      data.db.channels[3] = makeChannel({ id: 3, total_art: 1 })
      await nav.fromHash("0!1+3")
      const result = await nav.last()
      expect(result.article.s).toBe(3)
      expect(result.filtered).toBe(true)
   })
})

describe("countRight", () => {
   it("is always a number (never null)", async () => {
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash("0")
      expect(typeof result.countRight).toBe("number")
   })

   it("correct count in unfiltered mode (total - 1 - pos)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      const result = await nav.fromHash("0")
      expect(result.countRight).toBe(2)
   })

   it("returns 0 at last index unfiltered", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("1")
      expect(result.countRight).toBe(0)
   })

   it("decreases as pos approaches end", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      const mid = await nav.fromHash("1")
      expect(mid.countRight).toBe(1)
   })

   it("correct count in filtered mode", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 1 }])
      const result = await nav.fromHash("0!1")
      expect(result.countRight).toBe(2)
   })

   it("filtered: returns 0 at the last match", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(result.countRight).toBe(0)
   })

   it("filtered: counts matches after pos", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.countRight).toBe(2)
   })

   it("filtered: returns 0 when current is the only match", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 2 }, { chanId: 1 }])
      const result = await nav.fromHash("2!1")
      expect(result.countRight).toBe(0)
   })

   it("multi-sub filter counts articles matching any sub in set", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }, { chanId: 1 }, { chanId: 3 }])
      const result = await nav.fromHash("0!1+3")
      expect(result.countRight).toBe(3)
   })

   it("counter ignores sub.total_art when it exceeds real idx entries", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }])
      data.db.channels[1].total_art = 5
      const result = await nav.fromHash("1!1")
      expect(result.countRight).toBe(0)
      expect(result.has_right).toBe(false)
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("counter excludes unknown sub_id entries in unfiltered mode", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 99 }])
      delete data.db.channels[99]
      const result = await nav.fromHash("0")
      expect(result.countRight).toBe(0)
      expect(result.has_right).toBe(false)
   })
})

describe("showFeed", () => {
   it("has_left/has_right correct in normal mode", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])

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
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 2 }, { chanId: 1 }])

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
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(result.has_right).toBe(false)
   })

   it("has_left false in filtered mode with no earlier same-sub entries", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.has_left).toBe(false)
   })

   it("channel is looked up from channels", async () => {
      const ch = makeChannel({ id: 1, title: "MyChannel", feeds: [{ url: "http://ch.com" }] })
      data.db.channels[1] = ch
      setupIndex([{ chanId: 1 }])
      const result = await nav.fromHash("0")
      expect(result.channel).toBe(ch)
   })

   it("channel is undefined when not in channels", async () => {
      setupIndex([{ chanId: 99 }])
      delete data.db.channels[99]
      const result = await nav.fromHash("0")
      expect(result.channel).toBeUndefined()
   })
})

describe("getFilterEntries", () => {
   it("returns only empty string when no active subs", () => {
      data.groupChannelsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual([""])
   })

   it("returns tags sorted then untagged sub IDs", () => {
      const sub3 = makeChannel({ id: 3, title: "B-Sub", total_art: 2 })
      data.groupChannelsByTag.mockReturnValue({
         tagged: new Map([
            ["alpha", [makeChannel({ id: 2, tag: "alpha" })]],
            ["beta", [makeChannel({ id: 1, tag: "beta" })]],
         ]),
         sortedTags: ["alpha", "beta"],
         untagged: [sub3],
      })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "alpha", "beta", "3"])
   })

   it("returns single tag entry for multiple subs with same tag", () => {
      data.groupChannelsByTag.mockReturnValue({
         tagged: new Map([["tech", [makeChannel({ id: 1, tag: "tech" }), makeChannel({ id: 2, tag: "tech" })]]]),
         sortedTags: ["tech"],
         untagged: [],
      })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "tech"])
   })
})

describe("last with token", () => {
   it("with empty string clears filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      nav.filter.set(["1"])
      await nav.fromHash("0")
      const result = await nav.last("")
      expect(result.filtered).toBe(false)
      expect(result.article.s).toBe(2)
   })

   it("with token sets filter and jumps to last match", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("1")
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(result.filtered).toBe(true)
   })

   it("jumps to last matching article for given token", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      const result = await nav.last("1")
      expect(result.article.s).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("applies tag filter via token", async () => {
      data.db.channels = { "5": makeChannel({ id: 5, tag: "news" }), "6": makeChannel({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.channels)) s.id = Number(k)
      setupIndex([{ chanId: 5 }, { chanId: 6 }])
      await nav.fromHash("0")
      const result = await nav.last("news")
      expect(result.filtered).toBe(true)
   })
})

describe("switchFilter", () => {
   it("with empty token clears filter and jumps to last", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      nav.filter.set(["1"])
      await nav.fromHash("0")
      const result = await nav.switchFilter("")
      expect(result.filtered).toBe(false)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("jumps to first matching article when sub has not been seen", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("0")
      const result = await nav.switchFilter("1")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("jumps to first matching article when tag has not been seen", async () => {
      data.db.channels[5] = makeChannel({ id: 5, tag: "news" })
      data.db.channels[6] = makeChannel({ id: 6, tag: "news" })
      setupIndex([{ chanId: 5 }, { chanId: 6 }, { chanId: 5 }])
      await nav.fromHash("0")
      const result = await nav.switchFilter("news")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("resumes at last seen position when sub was previously viewed", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("2") // chronIdx 2 (sub 1) → seen sub:1=2
      await nav.switchFilter("2") // sub 2 lands on chronIdx 1 (does not touch sub:1)
      const result = await nav.switchFilter("1")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("resumes at last seen position when tag was previously viewed", async () => {
      data.db.channels[5] = makeChannel({ id: 5, tag: "news" })
      data.db.channels[6] = makeChannel({ id: 6 })
      setupIndex([{ chanId: 5 }, { chanId: 6 }, { chanId: 5 }])
      await nav.fromHash("0") // chronIdx 0 (sub 5, tag news) → seen tag:news=0
      await nav.switchFilter("6") // sub 6 (no tag) lands on chronIdx 1
      const result = await nav.switchFilter("news")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("falls back to first when stored position no longer matches filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      // Stale seen entry: chronIdx 1 is sub 2, doesn't match sub:1 filter.
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 1 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("falls back to first when stored position is beyond total_art", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 99 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("records both sub and tag seen positions on view", async () => {
      data.db.channels[5] = makeChannel({ id: 5, tag: "news" })
      setupIndex([{ chanId: 5 }, { chanId: 5 }])
      await nav.fromHash("1") // view chronIdx 1
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["chan:5"]).toBe(1)
      expect(seen["tag:news"]).toBe(1)
   })

   it("does not record tag seen for untagged sub", async () => {
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0")
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["chan:1"]).toBe(0)
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })
})

describe("pruneSeen", () => {
   it("removes entries for deleted subs and tags", () => {
      data.db.channels = { 1: makeChannel({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 5, "chan:99": 10, "tag:news": 3, "tag:gone": 7 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "chan:1": 5, "tag:news": 3 })
   })

   it("keeps tag entry when at least one sub still has the tag", () => {
      data.db.channels = {
         1: makeChannel({ id: 1, tag: "news" }),
         2: makeChannel({ id: 2 }),
      }
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 0, "tag:news": 0 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "chan:1": 0, "tag:news": 0 })
   })

   it("does not write when nothing is stale", () => {
      data.db.channels = { 1: makeChannel({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 0, "tag:news": 0 }))
      const setSpy = vi.spyOn(Storage.prototype, "setItem")
      nav.pruneSeen()
      expect(setSpy).not.toHaveBeenCalled()
      setSpy.mockRestore()
   })
})

describe("filter mutations", () => {
   it("set() resolves tag and sets filter", async () => {
      data.db.channels = { "5": makeChannel({ id: 5, tag: "news" }), "6": makeChannel({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.channels)) s.id = Number(k)
      setupIndex([{ chanId: 5 }, { chanId: 6 }])
      const result = await nav.fromHash("1!news")
      expect(result.filtered).toBe(true)
   })

   it("clear() clears filter", async () => {
      setupIndex([{ chanId: 1 }])
      const r1 = await nav.fromHash("0!1")
      expect(r1.filtered).toBe(true)
      const r2 = await nav.fromHash("0")
      expect(r2.filtered).toBe(false)
   })
})

describe("jumpToEnd via last()", () => {
   it("navigates to last article", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("returns last article when already at end", async () => {
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("jumps to last article and snaps to filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(1)
   })
})

describe("cycleFilter", () => {
   it("cycles forward from no filter to first tag", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      data.db.channels[1] = makeChannel({ id: 1, tag: "news" })
      data.db.channels[2] = makeChannel({ id: 2 })
      data.groupChannelsByTag.mockReturnValue({
         tagged: new Map([["news", [data.db.channels[1]]]]),
         sortedTags: ["news"],
         untagged: [data.db.channels[2]],
      })
      await nav.fromHash("0")
      const result = await nav.cycleFilter(1)
      expect(result.filtered).toBe(true)
   })

   it("cycles backward wrapping to last entry", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      data.db.channels[1] = makeChannel({ id: 1 })
      data.db.channels[2] = makeChannel({ id: 2 })
      data.groupChannelsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.channels[1], data.db.channels[2]],
      })
      await nav.fromHash("0")
      // entries = ["", "1", "2"], current = "" (idx 0), dir = -1 → wraps to idx 2 ("2")
      const result = await nav.cycleFilter(-1)
      expect(result.filtered).toBe(true)
   })

   it("clears filter when cycling back to all", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      data.db.channels[1] = makeChannel({ id: 1 })
      data.db.channels[2] = makeChannel({ id: 2 })
      data.groupChannelsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.channels[1], data.db.channels[2]],
      })
      await nav.fromHash("1!2")
      // entries = ["", "1", "2"], current = "2" (idx 2), dir = 1 → wraps to idx 0 ("")
      const result = await nav.cycleFilter(1)
      expect(result.filtered).toBe(false)
   })
})

describe("first", () => {
   it("navigates to first article", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("1")
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.s).toBe(1)
   })

   it("navigates to first filtered article", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("2!1")
      await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("starts findRight from min add_idx (skips packs before any filter sub existed)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 2 }, { chanId: 2 }])
      data.db.channels[2].add_idx = 2
      await nav.fromHash("3!2")
      data.findRight.mockClear()
      await nav.first()
      expect(data.findRight).toHaveBeenCalledWith(2, expect.any(Map))
   })
})

describe("goTo", () => {
   it("navigates directly to target when no filter active", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("0")
      const result = await nav.goTo(2)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(3)
   })

   it("navigates directly when target matches filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("0")
      const result = await nav.goTo(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
   })

   it("snaps forward when target does not match active filter", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 1 }, { chanId: 1 }])
      await nav.fromHash("2!1")
      const result = await nav.goTo(0)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(1)
   })

   it("falls back to last when no match at or after target", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1")
      const result = await nav.goTo(2)
      expect(result.article.s).toBe(1)
   })

   it("falls back to last for out-of-range target", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      const result = await nav.goTo(99)
      expect(result.article.s).toBe(2)
   })

   it("commits resolved chronIdx to URL hash when no filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 3 }])
      await nav.fromHash("0")
      await nav.goTo(2)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#2")
   })

   it("commits target chronIdx to URL hash when active filter matches", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.goTo(2)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.s).toBe(1)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#2!1")
   })

   it("commits snapped chronIdx (not input) to URL hash when filter forces a snap", async () => {
      setupIndex([{ chanId: 2 }, { chanId: 1 }, { chanId: 1 }])
      await nav.fromHash("2!1")
      await nav.goTo(0)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#1!1")
   })

   it("lands on findChronForTimestamp result chronIdx", async () => {
      setupIndex([
         { chanId: 1, fetchedAt: 10 },
         { chanId: 2, fetchedAt: 20 },
         { chanId: 3, fetchedAt: 30 },
      ])
      data.findChronForTimestamp.mockReturnValueOnce(1)
      await nav.fromHash("0")
      const target = data.findChronForTimestamp(25)
      const result = await nav.goTo(target)
      expect(target).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#1")
   })
})

describe("prefetch abort", () => {
   const RealImage = window.Image
   const RealRIC = window.requestIdleCallback
   let images: HTMLImageElement[]
   let pendingIdle: Array<() => Promise<void>>

   beforeEach(() => {
      images = []
      pendingIdle = []
      window.Image = function () {
         const img = new RealImage()
         images.push(img)
         return img
      } as unknown as typeof Image
      window.requestIdleCallback = ((cb: () => unknown) => {
         pendingIdle.push(cb as () => Promise<void>)
         return 0
      }) as unknown as typeof window.requestIdleCallback
   })

   afterEach(() => {
      window.Image = RealImage
      window.requestIdleCallback = RealRIC
   })

   async function flushIdle() {
      while (pendingIdle.length) {
         const cb = pendingIdle.shift()!
         await cb()
      }
   }

   it("creates Image objects with proxied src for the neighbor article", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      data.loadArticle.mockImplementation(async (idx: number) =>
         makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      expect(images).toHaveLength(1)
      expect(images[0].src).toContain(encodeURIComponent("http://example.com/2.jpg"))
   })

   it("sets src='' on previously prefetched images when the next navigation lands", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      data.loadArticle.mockImplementation(async (idx: number) =>
         makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      const prefetched = images[0]
      expect(prefetched.getAttribute("src")).not.toBe("")

      await nav.left()
      expect(prefetched.getAttribute("src")).toBe("")
   })

   it("bails the stale idle callback so no Image is created after an abort", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      data.loadArticle.mockImplementation(async (idx: number) =>
         makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
      )
      await nav.fromHash("0")
      await nav.right()
      await nav.left()
      await flushIdle()
      expect(images).toHaveLength(0)
   })

   it("aborts the prior prefetch when goTo navigates away (no left/right re-schedule)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      data.loadArticle.mockImplementation(async (idx: number) =>
         makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      const prefetched = images[0]
      expect(prefetched.getAttribute("src")).not.toBe("")

      await nav.goTo(3)
      expect(prefetched.getAttribute("src")).toBe("")
   })
})
