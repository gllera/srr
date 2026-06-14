import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const data = vi.hoisted(() => ({
   IDX_PACK_SIZE: 50000 as const,
   db: {
      total_art: 0,
      channels: {} as Record<number, IChannel>,
   } as unknown as IDB,
   loadArticle: vi.fn<(chronIdx: number) => Promise<IArticle>>(),
   groupChannelsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IChannel[] })),
   findChronForTimestamp: vi.fn(async () => 0),
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
   countAll: vi.fn((channels: Map<number, number>) => data.countLeft(data.db.total_art, channels)),
   findLeft: vi.fn(async (from: number, channels: Map<number, number>) => {
      for (let i = from; i >= 0; i--) {
         const chanId = data.getChannelId(i)
         const addIdx = channels.get(chanId)
         if (addIdx !== undefined && i >= addIdx) return i
      }
      return -1
   }),
   findRight: vi.fn(async (from: number, channels: Map<number, number>) => {
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

// nav.ts imports ./search for its "q:<query>" filter mode; mock it so tests
// drive the hit set directly instead of fetching real shards.
const searchMod = vi.hoisted(() => ({
   available: vi.fn(() => true),
   shortQuery: vi.fn(() => false),
   search: vi.fn(),
}))
vi.mock("./search", () => searchMod)

import * as nav from "./nav"
import { setImgProxy } from "./fmt"

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
   localStorage.clear()
   vi.spyOn(history, "pushState").mockImplementation(() => {})
   vi.spyOn(history, "replaceState").mockImplementation(() => {})
   // jsdom has no requestIdleCallback; without a stub schedulePrefetch would
   // take its setTimeout fallback and fire mid-suite. A swallow-everything rIC
   // keeps prefetch inert except where the prefetch suite installs its own.
   window.requestIdleCallback = (() => 0) as unknown as typeof window.requestIdleCallback
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
      await nav.fromHash("0") // chronIdx 0 (sub 5, tag news) → seen chan:5=0
      await nav.switchFilter("6") // sub 6 (no tag) lands on chronIdx 1
      const result = await nav.switchFilter("news")
      expect(result.filtered).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("resumes a multi-channel tag at its oldest (min) member position", async () => {
      data.db.channels[5] = makeChannel({ id: 5, tag: "news" })
      data.db.channels[6] = makeChannel({ id: 6, tag: "news" })
      setupIndex([{ chanId: 5 }, { chanId: 6 }, { chanId: 5 }, { chanId: 6 }, { chanId: 5 }])
      await nav.fromHash("4") // view chron 4 (ch5) → chan:5 = 4
      await nav.fromHash("1") // view chron 1 (ch6) → chan:6 = 1
      const result = await nav.switchFilter("news")
      expect(result.filtered).toBe(true)
      // min(4, 1) = 1: open at the least-recently-read member so every unread
      // article in the tag sits to the right, none skipped on the left.
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
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

   it("records only the channel seen position; the tag derives from it", async () => {
      data.db.channels[5] = makeChannel({ id: 5, tag: "news" })
      setupIndex([{ chanId: 5 }, { chanId: 5 }])
      await nav.fromHash("1") // view chronIdx 1
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["chan:5"]).toBe(1)
      // No tag key is ever written — the tag's position is read back from its
      // member channels (here a single channel at chron 1).
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })

   it("never records a tag key", async () => {
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0")
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["chan:1"]).toBe(0)
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })
})

describe("pruneSeen", () => {
   it("removes entries for deleted subs and all legacy tag keys", () => {
      data.db.channels = { 1: makeChannel({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 5, "chan:99": 10, "tag:news": 3, "tag:gone": 7 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // tag: keys are legacy now (a tag derives its position from its channels),
      // so they are dropped even when the tag still exists.
      expect(seen).toEqual({ "chan:1": 5 })
   })

   it("strips a legacy tag key even when the tag still exists", () => {
      data.db.channels = {
         1: makeChannel({ id: 1, tag: "news" }),
         2: makeChannel({ id: 2 }),
      }
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 0, "tag:news": 0 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "chan:1": 0 })
   })

   it("does not write when nothing is stale", () => {
      data.db.channels = { 1: makeChannel({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "chan:1": 0 }))
      const setSpy = vi.spyOn(Storage.prototype, "setItem")
      nav.pruneSeen()
      expect(setSpy).not.toHaveBeenCalled()
      setSpy.mockRestore()
   })
})

describe("isRowUnread", () => {
   // Strictly-after the channel's seen high-water — the same rule chanUnread
   // counts by (countAll − countLeft(seen+1)). recordSeen stores the just-read
   // article's OWN chronIdx, so the row AT seen must read as READ, not unread, or
   // the list dot disagrees with the channel badge by one row.
   const seen = { "chan:5": 50 }

   it("treats the article at the seen high-water (chron === seen) as READ", () => {
      expect(nav.isRowUnread(50, 5, seen)).toBe(false)
   })

   it("treats older articles (chron < seen) as READ", () => {
      expect(nav.isRowUnread(49, 5, seen)).toBe(false)
   })

   it("treats newer articles (chron > seen) as UNREAD", () => {
      expect(nav.isRowUnread(51, 5, seen)).toBe(true)
   })

   it("treats a never-seen channel as fully unread", () => {
      expect(nav.isRowUnread(0, 7, seen)).toBe(true)
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
      data.findChronForTimestamp.mockResolvedValueOnce(1)
      await nav.fromHash("0")
      const target = await data.findChronForTimestamp(25)
      const result = await nav.goTo(target)
      expect(target).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.s).toBe(2)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#1")
   })
})

describe("getCurrentFilterKey", () => {
   it("returns empty string when no filter is active", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0")
      expect(nav.getCurrentFilterKey()).toBe("")
   })

   it("returns the single token of a single-token filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1")
      expect(nav.getCurrentFilterKey()).toBe("1")
   })

   it("returns the tag string of a single-tag filter", async () => {
      data.db.channels = { "1": makeChannel({ id: 1, tag: "tech" }) }
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0!tech")
      expect(nav.getCurrentFilterKey()).toBe("tech")
   })

   it("returns empty string for a multi-token filter (URL-only edge case)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1+2")
      expect(nav.getCurrentFilterKey()).toBe("")
   })
})

describe("isSingleFilter", () => {
   it("rejects empty token even when no filter is active", async () => {
      setupIndex([{ chanId: 1 }])
      await nav.fromHash("0")
      expect(nav.isSingleFilter("")).toBe(false)
   })

   it("returns true when the active single-token filter matches the queried token", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1")
      expect(nav.isSingleFilter("1")).toBe(true)
   })

   it("returns false when token differs from the active single-token filter", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1")
      expect(nav.isSingleFilter("2")).toBe(false)
   })

   it("returns false when the filter has multiple tokens", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0!1+2")
      expect(nav.isSingleFilter("1")).toBe(false)
   })
})

describe("unreadCount", () => {
   it("returns the full backlog for a channel never seen on this device", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      expect(await nav.unreadCount(data.db.channels[2])).toBe(1) // its 1 article, all unseen
   })

   it("counts the channel's articles strictly after its seen position", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("1") // views chron 1 (chan 1) → seen chan:1 = 1
      expect(await nav.unreadCount(data.db.channels[1])).toBe(1) // only chron 3 left
      expect(await nav.unreadCount(data.db.channels[2])).toBe(1) // never seen → its 1 article (chron 2)
   })

   it("reading everything via [ALL] clears the counts of passed channels", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("0")
      await nav.right()
      await nav.right() // unfiltered walk to the end bumps each article's own channel
      expect(await nav.unreadCount(data.db.channels[1])).toBe(0)
      expect(await nav.unreadCount(data.db.channels[2])).toBe(0)
   })

   it("respects add_idx so a reused id's predecessor articles never count", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      data.db.channels[1].add_idx = 1 // chron 0 belongs to the predecessor epoch
      await nav.fromHash("1") // seen chan:1 = 1
      expect(await nav.unreadCount(data.db.channels[1])).toBe(1) // only chron 2
   })

   it("clamps a stale seen position beyond total_art instead of going negative", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }])
      await nav.fromHash("1") // seen chan:1 = 1
      data.db.total_art = 1 // simulate a rebuilt, shorter store
      expect(await nav.unreadCount(data.db.channels[1])).toBe(0)
   })
})

describe("unread-only mode (tags)", () => {
   afterEach(() => nav.setUnreadOnly(false))

   function tagSetup(entries: Array<{ chanId: number }>) {
      setupIndex(entries)
      for (const id of new Set(entries.map((e) => e.chanId))) data.db.channels[id].tag = "news"
   }

   it("persists the toggle in localStorage", () => {
      expect(nav.isUnreadOnly()).toBe(false)
      nav.setUnreadOnly(true)
      expect(nav.isUnreadOnly()).toBe(true)
      expect(localStorage.getItem("srr-unread-only")).toBe("1")
      nav.setUnreadOnly(false)
      expect(localStorage.getItem("srr-unread-only")).toBeNull()
   })

   // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1; read ch1→2, ch2→1; unseen are 3,4.
   async function readSome() {
      tagSetup([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      await nav.fromHash("1") // chan:2 = 1
      await nav.fromHash("2") // chan:1 = 2
   }

   it("opening a tag resumes at its current position, not the next unseen", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1)
      nav.setUnreadOnly(true)
      const shown = await nav.switchFilter("news")
      // Resumes at the tag's saved position (min seen = chron 1, ch2) — the same
      // current position a channel or a non-unseen tag opens at — NOT the oldest
      // unseen. The raised bounds no longer bounce the open forward.
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(shown.article.s).toBe(2)
      expect(shown.has_left).toBe(false) // nothing unseen to the left of the resume
      const next = await nav.right() // Right steps to the first unseen
      expect(data.loadArticle).toHaveBeenLastCalledWith(3) // ch2, first unseen
      expect(next.article.s).toBe(2)
   })

   it("counts unseen remaining including the current one and stops at the last unseen", async () => {
      await readSome()
      nav.setUnreadOnly(true)
      await nav.switchFilter("news") // resumes at chron 1 (seen); both unseen to the right
      const onFirst = await nav.right() // chron 3 (oldest unseen)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      expect(onFirst.countRight).toBe(2) // both unseen remain (chron 3 you're on + chron 4)
      expect(onFirst.has_right).toBe(true)
      const onLast = await nav.right() // chron 4 (last unseen)
      expect(data.loadArticle).toHaveBeenLastCalledWith(4)
      expect(onLast.countRight).toBe(1) // only the one you're on remains
      expect(onLast.has_right).toBe(false) // nothing further to the right
   })

   it("navigating right skips interleaved seen articles, hitting only unseen", async () => {
      await readSome()
      nav.setUnreadOnly(true)
      await nav.switchFilter("news") // resumes at chron 1 (seen)
      await nav.right() // chron 3 (oldest unseen), skipping seen chron 2
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(4) // jumps 3→4, not onto a seen one
   })

   it("the dropdown tag badge stays equal to the toolbar counter through select then read", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1) → 2
      nav.setUnreadOnly(true)
      const group = [data.db.channels[1], data.db.channels[2]]

      // On select you resume at the seen position (chron 1): the current article
      // is seen (matchesPos 0), so neither the counter nor the badge counts it —
      // both read the full 2.
      const opened = await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(opened.countRight).toBe(2)
      let counts = await nav.unreadCounts(group)
      expect(counts.get(2)).toBe(1) // ch2 unseen {3}
      expect(counts.get(1)).toBe(1) // ch1 unseen {4}
      expect(nav.tagUnreadFromCounts(group, counts)).toBe(opened.countRight) // 2 == 2

      // Regression: step onto the first unseen (chron 3, ch2). recordSeen bumps
      // ch2's LIVE seen to 3 the instant you arrive, which would drop ch2's badge
      // to 0 and leave it one below the (snapshot-based) counter. chanUnread
      // counts the unread you're sitting on back, so the badge still equals the
      // counter.
      const onUnseen = await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      expect(onUnseen.countRight).toBe(2)
      counts = await nav.unreadCounts(group)
      expect(counts.get(2)).toBe(1) // ch2: live seen now 3 → {} unread, +1 for the one you're on
      expect(counts.get(1)).toBe(1) // ch1: its remaining unseen {4}, not inflated
      expect(nav.tagUnreadFromCounts(group, counts)).toBe(onUnseen.countRight) // 2 == 2, not 1
   })

   it("fromHash honors an explicit seen #pos instead of bouncing/drifting to the last unseen", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1)
      nav.setUnreadOnly(true)
      // Refreshing #2!news: chron 2 (ch1) is an already-SEEN article, below ch1's
      // raised bound (seen+1 = 3). filter.matches() would reject it and bounce to
      // last() (chron 4, the highest unseen); recordSeen would mark that seen, so a
      // second refresh would drift lower again. The hash position must be honored.
      const shown = await nav.fromHash("2!news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(shown.article.s).toBe(1)
      // Stable across a reload of the same hash — no downward drift.
      const again = await nav.fromHash("2!news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(again.article.s).toBe(1)
   })

   it("does not affect a single-channel filter (navigates all, including seen)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
      await nav.fromHash("1") // chan:1 = 1
      nav.setUnreadOnly(true)
      await nav.switchFilter("1") // resumes at seen position 1
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      const left = await nav.left() // can still reach the seen article at 0
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(left.article.s).toBe(1)
   })

   it("does not affect [ALL] (seen articles still counted)", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      await nav.fromHash("0") // chan:1 = 0 (chron 0 seen)
      nav.setUnreadOnly(true)
      const shown = await nav.last("") // [ALL], lands on chron 1
      expect(shown.has_left).toBe(true) // the seen chron 0 is still to the left
   })

   it("the counter shows total unseen at open and decrements by one per step (OPT-1 invariant)", async () => {
      await readSome() // ch1→2, ch2→1; unseen are chron 3 (ch2), 4 (ch1) → 2 total
      nav.setUnreadOnly(true)
      // Open at the resume position (chron 1, seen): both unseen are to the right,
      // none to the left, so the counter equals the tag's total unseen.
      const a = await nav.switchFilter("news") // chron 1 (resume, seen)
      expect(a.has_left).toBe(false)
      expect(a.countRight).toBe(2)
      // Walk onto the oldest unseen, then the last: the counter ticks 2 → 1, and
      // the invariant (counter + unseen already passed on the left) stays 2.
      const b = await nav.right() // chron 3 (oldest unseen)
      expect(b.countRight).toBe(2) // on the first of two unseen
      expect(b.has_left).toBe(false)
      const c = await nav.right() // chron 4 (last unseen)
      expect(c.countRight).toBe(1)
      expect(c.has_left).toBe(true)
   })

   it("R3-2: a cold-pack countLeft rejection in the unread tally does not fail the loaded nav", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1)
      nav.setUnreadOnly(true)
      const realCountLeft = data.countLeft.getMockImplementation()!
      // Throw on the per-member seen-pack lookup for ch1 (single-channel map at
      // its seen+1 = chron 3), as if that finalized idx pack were cold and the
      // fetch blipped (countLeft awaits the pack fetch, so a throw here is a
      // rejection). The multi-channel raised-bounds fallback (filter.channels,
      // size 2) and the resident-pack countAll still resolve, so unreadTally
      // rejects but the approximate fallback in showFeed never throws. The
      // wrapper stays SYNC like the base mock so countAll (which calls countLeft
      // internally) keeps returning a number, not a promise.
      data.countLeft.mockImplementation((chronIdx: number, channels: Map<number, number>) => {
         if (channels.size === 1 && channels.has(1) && chronIdx === 3) throw new Error("cold idx pack fetch failed")
         return realCountLeft(chronIdx, channels)
      })
      try {
         // switchFilter resolves the article (loadArticle(pos) succeeds), then
         // showFeed tallies unread — the rejection must be swallowed, not surfaced.
         const shown = await nav.switchFilter("news") // resumes at chron 1 (ch2, seen)
         expect(data.loadArticle).toHaveBeenLastCalledWith(1)
         expect(shown.article.s).toBe(2) // the loaded article is intact
         expect(shown.article.t).not.toBe("(no matching articles)")
         expect(Number.isFinite(shown.countRight)).toBe(true)
         expect(shown.countRight).toBeGreaterThanOrEqual(0)
         // The approximate raised-bounds fallback: at the resume position 0 left,
         // total 2, matchesPos 0 (a seen article) → right 2, counter 2.
         expect(shown.countRight).toBe(2)
      } finally {
         data.countLeft.mockImplementation(realCountLeft) // restore for later tests
      }
   })
})

describe("tagUnreadFromCounts", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("counts a never-seen member as fully unread; unseen-only resumes at the saved position", async () => {
      data.db.channels[1] = makeChannel({ id: 1, tag: "news" })
      data.db.channels[2] = makeChannel({ id: 2, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1. Read ch1→2; ch2 NEVER seen here.
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 2 }, { chanId: 1 }])
      data.db.channels[1].tag = "news"
      data.db.channels[2].tag = "news"
      await nav.fromHash("2") // chan:1 = 2 (ch2 untouched)
      const group = [data.db.channels[1], data.db.channels[2]]
      // ch1 unread after chron 2 = {4} = 1; ch2 fully unread = {1,3} = 2 → 3.
      // The badge is derived from the already-computed per-channel counts map.
      const counts = await nav.unreadCounts(group)
      const badge = nav.tagUnreadFromCounts(group, counts)
      expect(badge).toBe(3)
      // Unseen-only opens at the tag's saved position (chron 2, ch1), NOT the
      // oldest unseen. ch2 was never seen and has an older article at chron 1, so
      // it sits to the LEFT of the resume (reachable with Left) and the toolbar
      // counter (unseen to the right) is the badge minus that one left-side unseen.
      nav.setUnreadOnly(true)
      const shown = await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(shown.has_left).toBe(true)
      expect(shown.countRight).toBe(2) // badge (3) − 1 unseen to the left
   })

   it("equals the unseen-only counter for a mixed tag (seen, never-seen, fully-read members)", async () => {
      data.db.channels[1] = makeChannel({ id: 1, tag: "news" })
      data.db.channels[2] = makeChannel({ id: 2, tag: "news" })
      data.db.channels[3] = makeChannel({ id: 3, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch3 4=ch1 5=ch3.
      // ch1: partially read (seen→2, so {4} unread = 1).
      // ch2: NEVER seen → fully unread ({1} = 1).
      // ch3: fully read (seen→5, so {} unread = 0).
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 3 }, { chanId: 1 }, { chanId: 3 }])
      data.db.channels[1].tag = "news"
      data.db.channels[2].tag = "news"
      data.db.channels[3].tag = "news"
      await nav.fromHash("5") // chan:3 = 5 (ch3 fully read)
      await nav.fromHash("2") // chan:1 = 2 (ch1 partially read); ch2 untouched
      const group = [data.db.channels[1], data.db.channels[2], data.db.channels[3]]
      const counts = await nav.unreadCounts(group)
      const badge = nav.tagUnreadFromCounts(group, counts)
      // 1 (ch1) + 1 (ch2 full) + 0 (ch3) = 2.
      expect(badge).toBe(2)
      // Unseen-only resumes at the saved position (chron 2, ch1), not the oldest
      // unseen. ch2 (never seen) has an older article at chron 1, to the left of
      // the resume, so has_left and the counter is the badge minus that one.
      nav.setUnreadOnly(true)
      const shown = await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(shown.has_left).toBe(true)
      expect(shown.countRight).toBe(1) // badge (2) − 1 unseen to the left
   })

   it("returns 0 when every member is fully read (never-seen members excepted)", async () => {
      data.db.channels[1] = makeChannel({ id: 1, tag: "news" })
      setupIndex([{ chanId: 1 }, { chanId: 1 }])
      data.db.channels[1].tag = "news"
      await nav.fromHash("1") // chan:1 = 1 (fully read)
      const group = [data.db.channels[1]]
      expect(nav.tagUnreadFromCounts(group, await nav.unreadCounts(group))).toBe(0)
   })

   it("sums member counts (never-seen members as their full backlog) and equals the unseen-only counter", async () => {
      // A tag mixing seen / never-seen / fully-read members. chanUnread reports a
      // never-seen member as its full backlog, so the tag badge is a plain sum of
      // the per-channel counts and the row badges beneath the header add up to it.
      data.db.channels[1] = makeChannel({ id: 1, tag: "news" })
      data.db.channels[2] = makeChannel({ id: 2, tag: "news" })
      data.db.channels[3] = makeChannel({ id: 3, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch3 4=ch1 5=ch3 6=ch2.
      // ch1: partially read (seen→2 → {4} unread = 1).
      // ch2: NEVER seen → fully unread ({1,6} = 2).
      // ch3: NEVER seen → fully unread ({3,5} = 2).
      setupIndex([
         { chanId: 1 },
         { chanId: 2 },
         { chanId: 1 },
         { chanId: 3 },
         { chanId: 1 },
         { chanId: 3 },
         { chanId: 2 },
      ])
      for (const id of [1, 2, 3]) data.db.channels[id].tag = "news"
      await nav.fromHash("2") // chan:1 = 2; ch2/ch3 untouched (never-seen)
      const group = [data.db.channels[1], data.db.channels[2], data.db.channels[3]]
      const counts = await nav.unreadCounts(group)
      // counts: ch1 = 1 (read down to chron 2); ch2/ch3 = their full backlog (2 each).
      expect(counts.get(1)).toBe(1)
      expect(counts.get(2)).toBe(2)
      expect(counts.get(3)).toBe(2)
      const badge = nav.tagUnreadFromCounts(group, counts)
      expect(badge).toBe(5) // 1 (ch1) + 2 (ch2 full) + 2 (ch3 full)
      // Unseen-only resumes at the saved position (chron 2, ch1), not the oldest
      // unseen; ch2 (never seen) has an older article at chron 1 to the left, so
      // the counter is the badge minus that one left-side unseen.
      nav.setUnreadOnly(true)
      const shown = await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(shown.has_left).toBe(true)
      expect(shown.countRight).toBe(4) // badge (5) − 1 unseen to the left
   })
})

describe("unreadCounts", () => {
   it("returns the same values as N× unreadCount", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }, { chanId: 1 }, { chanId: 3 }])
      await nav.fromHash("0") // chan:1 = 0 seen; ch2/ch3 never seen
      const chs = [data.db.channels[1], data.db.channels[2], data.db.channels[3]]
      const batch = await nav.unreadCounts(chs)
      for (const ch of chs) expect(batch.get(ch.id)).toBe(await nav.unreadCount(ch))
      // Spot-check the semantics: ch1 has chron 2 unread; ch2/ch3 never seen →
      // their full backlog (one article each, chron 1 and 3).
      expect(batch.get(1)).toBe(1)
      expect(batch.get(2)).toBe(1)
      expect(batch.get(3)).toBe(1)
   })
})

describe("prefetch abort", () => {
   const RealImage = window.Image
   const RealRIC = window.requestIdleCallback
   const PROXY_PREFIX = "https://proxy.test/?u="
   let images: HTMLImageElement[]
   let pendingIdle: Array<() => Promise<void>>

   beforeEach(() => {
      // localStorage `srr-img-proxy` is unset (passthrough) by default; install
      // a prefix so the assertions about encoded srcs exercise the proxy path.
      setImgProxy(PROXY_PREFIX)
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

   it("falls back to setTimeout when requestIdleCallback is missing (WebKit)", async () => {
      window.requestIdleCallback = undefined as unknown as typeof window.requestIdleCallback
      vi.useFakeTimers()
      try {
         setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }])
         data.loadArticle.mockImplementation(async (idx: number) =>
            makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
         )
         await nav.fromHash("0")
         await nav.right()
         expect(images).toHaveLength(0)
         await vi.advanceTimersByTimeAsync(200)
         expect(images).toHaveLength(1)
         expect(images[0].src).toContain(encodeURIComponent("http://example.com/2.jpg"))
      } finally {
         vi.useRealTimers()
      }
   })
})

describe("saved articles", () => {
   it("toggleSaved / isSaved / savedCount round-trip via localStorage", () => {
      expect(nav.isSaved(3)).toBe(false)
      expect(nav.toggleSaved(3)).toBe(true)
      expect(nav.isSaved(3)).toBe(true)
      expect(nav.savedCount()).toBe(1)
      expect(JSON.parse(localStorage.getItem("srr-saved")!)).toEqual([3])
      expect(nav.toggleSaved(3)).toBe(false)
      expect(nav.isSaved(3)).toBe(false)
      expect(nav.savedCount()).toBe(0)
      expect(localStorage.getItem("srr-saved")).toBe("[]")
   })

   it("filter.set([SAVED_TOKEN]) enters a channel-agnostic saved mode", () => {
      setupIndex([{ chanId: 1 }, { chanId: 2 }])
      nav.filter.set([nav.SAVED_TOKEN])
      expect(nav.filter.saved).toBe(true)
      expect(nav.filter.active).toBe(true)
      expect(nav.filter.channels.size).toBe(0)
   })

   it("matches() is saved-set membership, ignoring the channel", () => {
      nav.toggleSaved(5)
      nav.filter.set([nav.SAVED_TOKEN])
      expect(nav.filter.matches(99, 5)).toBe(true) // any channel
      expect(nav.filter.matches(1, 4)).toBe(false) // not saved
   })

   it("clear() leaves saved mode", () => {
      nav.filter.set([nav.SAVED_TOKEN])
      nav.filter.clear()
      expect(nav.filter.saved).toBe(false)
   })

   it("traverses only saved articles, newest-first, with right-counts", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }, { chanId: 1 }, { chanId: 1 }]) // chrons 0..4
      nav.toggleSaved(1)
      nav.toggleSaved(3)
      nav.toggleSaved(4)
      // switchFilter resumes at the newest saved (4).
      const r4 = await nav.switchFilter(nav.SAVED_TOKEN)
      expect(data.loadArticle).toHaveBeenCalledWith(4)
      expect(r4.filtered).toBe(true)
      expect(r4.countRight).toBe(0)
      expect(r4.has_right).toBe(false)
      expect(r4.has_left).toBe(true)

      const r3 = await nav.left()
      expect(data.loadArticle).toHaveBeenCalledWith(3)
      expect(r3.countRight).toBe(1) // only 4 is to the right
      expect(r3.has_left).toBe(true)

      const r1 = await nav.left()
      expect(data.loadArticle).toHaveBeenCalledWith(1) // skips unsaved 2
      expect(r1.countRight).toBe(2) // 3 and 4
      expect(r1.has_left).toBe(false) // oldest saved
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("getFilterEntries surfaces the saved token only when something is saved", () => {
      setupIndex([{ chanId: 1 }])
      expect(nav.getFilterEntries()).not.toContain(nav.SAVED_TOKEN)
      nav.toggleSaved(0)
      expect(nav.getFilterEntries()).toContain(nav.SAVED_TOKEN)
   })

   it("switchFilter(SAVED) pushes a #pos!~saved hash", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }])
      nav.toggleSaved(1)
      await nav.switchFilter(nav.SAVED_TOKEN)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1!~saved")
   })

   it("fromHash validates the position against the saved set", async () => {
      setupIndex([{ chanId: 1 }, { chanId: 1 }, { chanId: 1 }]) // 0,1,2
      nav.toggleSaved(2)
      await nav.fromHash("2!~saved")
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      // A position not in the saved set bounces to the newest saved (2).
      data.loadArticle.mockClear()
      await nav.fromHash("1!~saved")
      expect(data.loadArticle).toHaveBeenCalledWith(2)
   })
})

describe("search filter mode (q:<query>)", () => {
   // The hit set is computed lazily (ensureSearchSet) on the first feedLeft/Right;
   // nav module state persists across tests (no resetModules), and filter.set only
   // refetches when the term changes, so each test uses a UNIQUE query term.
   const hit = (chron: number) => ({ chron, s: 1, w: 1000, t: "t" })
   async function* gen(hits: ReturnType<typeof hit>[]) {
      yield hits
   }
   const enter = (term: string) => nav.applyFilter([nav.SEARCH_PREFIX + term])

   beforeEach(() => {
      searchMod.search.mockReset()
      searchMod.available.mockReturnValue(true)
      searchMod.shortQuery.mockReturnValue(false)
   })

   it("walks the hit set newest-first via feedLeft / feedRight", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ chanId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9), hit(15)]))
      enter("alpha")
      expect(nav.isSearchFilter()).toBe(true)
      expect(await nav.feedLeft(19)).toBe(15)
      expect(await nav.feedLeft(14)).toBe(9)
      expect(await nav.feedLeft(8)).toBe(3)
      expect(await nav.feedLeft(2)).toBe(-1)
      expect(await nav.feedRight(0)).toBe(3)
      expect(await nav.feedRight(10)).toBe(15)
      expect(await nav.feedRight(16)).toBe(-1)
      // The hit-set generator is consulted once and cached for the walk.
      expect(searchMod.search).toHaveBeenCalledTimes(1)
   })

   it("matches() reflects the hit set", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ chanId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9)]))
      enter("bravo")
      await nav.feedLeft(19) // trigger the lazy load
      expect(nav.filter.matches(1, 3)).toBe(true)
      expect(nav.filter.matches(1, 4)).toBe(false)
   })

   it("last() opens the newest hit, first() the oldest, goTo snaps forward", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ chanId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9), hit(15)]))
      enter("charlie")
      await nav.last()
      expect(nav.currentChron()).toBe(15)
      await nav.first()
      expect(nav.currentChron()).toBe(3)
      await nav.goTo(5) // next hit at-or-after 5 is 9
      expect(nav.currentChron()).toBe(9)
   })

   it("showFeed reports left/right over the hit set", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ chanId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9), hit(15)]))
      enter("delta")
      const r = await nav.goTo(9)
      expect(r.has_left).toBe(true) // hit 3 is left of 9
      expect(r.has_right).toBe(true) // hit 15 is right of 9
      expect(r.countRight).toBe(1)
   })

   it("fromHash honors a #pos!q: deep link that is a hit, else snaps to newest", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ chanId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9), hit(15)]))
      await nav.fromHash("9!" + nav.SEARCH_PREFIX + "echo")
      expect(nav.currentChron()).toBe(9)
      await nav.fromHash("7!" + nav.SEARCH_PREFIX + "echo2")
      expect(nav.currentChron()).toBe(15) // 7 isn't a hit → newest
   })

   it("an empty query yields no hits and never fetches", async () => {
      setupIndex(Array.from({ length: 5 }, () => ({ chanId: 1 })))
      enter("")
      expect(nav.isSearchFilter()).toBe(true)
      expect(await nav.feedLeft(4)).toBe(-1)
      expect(searchMod.search).not.toHaveBeenCalled()
   })

   it("caps the set at SEARCH_CAP and flags truncation", async () => {
      setupIndex(Array.from({ length: 600 }, () => ({ chanId: 1 })))
      // Honor `limit` like the real search() does — it never yields more than the
      // caller asks for. So truncation is only observable if nav requests one past
      // the cap (SEARCH_CAP + 1); asking for exactly SEARCH_CAP makes it invisible.
      searchMod.search.mockImplementation((_q: string, limit: number) =>
         gen(Array.from({ length: Math.min(limit, 600) }, (_, i) => hit(i))),
      )
      enter("foxtrot")
      // The cap keeps the first SEARCH_CAP collected (chrons 0..499); the witness
      // hit (500) only flips the flag.
      expect(await nav.feedLeft(599)).toBe(499)
      expect(nav.searchTruncated()).toBe(true)
   })

   it("leaving search (another filter) clears the mode and escapes '+' in the hash", async () => {
      setupIndex(Array.from({ length: 5 }, () => ({ chanId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(2)]))
      enter("c++")
      expect(nav.isSearchFilter()).toBe(true)
      expect(nav.tokensSuffix()).toBe("!q%3Ac%2B%2B") // ":" and "+" escaped so the split survives
      nav.applyFilter([])
      expect(nav.isSearchFilter()).toBe(false)
   })

   it("a returning query reloads after its set was dropped by an in-flight newer query", async () => {
      // Regression: A → B → A while B's load is still in flight. filter.set drops
      // A's cached set when B arrives; without also forgetting searchLoadedFor, the
      // return to A short-circuits ensureSearchSet on the EMPTIED set and strands
      // the list on "no matches" for a query that has hits.
      setupIndex(Array.from({ length: 20 }, () => ({ chanId: 1 })))
      // 1. "golf" loads and commits.
      searchMod.search.mockImplementation(() => gen([hit(5), hit(11)]))
      enter("golf")
      expect(await nav.feedLeft(19)).toBe(11)
      // 2. "golfx": its load blocks (still in flight) — and dropping the set here is
      //    what would strand the return to "golf".
      let release!: () => void
      const blocked = new Promise<void>((r) => (release = r))
      searchMod.search.mockImplementation(async function* () {
         await blocked
         yield [hit(7)]
      })
      enter("golfx")
      const inflight = nav.feedLeft(19) // kicks off the blocked load, leaves it pending
      // 3. Back to "golf" before "golfx" resolves.
      searchMod.search.mockImplementation(() => gen([hit(5), hit(11)]))
      enter("golf")
      // 4. The walk must RECOMPUTE "golf" (not read the emptied set) → 11, not -1.
      expect(await nav.feedLeft(19)).toBe(11)
      release()
      await inflight.catch(() => {})
   })
})
