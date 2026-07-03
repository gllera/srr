import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const data = vi.hoisted(() => ({
   IDX_PACK_SIZE: 50000 as const,
   db: {
      total_art: 0,
      feeds: {} as Record<number, IFeed>,
   } as unknown as IDB,
   loadArticle: vi.fn<(chronIdx: number) => Promise<IArticle>>(),
   groupFeedsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IFeed[] })),
   feedTitle: vi.fn((id: number) => data.db.feeds[id]?.title ?? "[DELETED]"),
   getFeedId: vi.fn<(chronIdx: number) => number>(),
   countLeft: vi.fn((chronIdx: number, feeds: Map<number, number>) => {
      let count = 0
      for (let i = 0; i < chronIdx; i++) {
         const feedId = data.getFeedId(i)
         const addIdx = feeds.get(feedId)
         if (addIdx !== undefined && i >= addIdx) count++
      }
      return count
   }),
   countAll: vi.fn((feeds: Map<number, number>) => data.countLeft(data.db.total_art, feeds)),
   findLeft: vi.fn(async (from: number, feeds: Map<number, number>) => {
      for (let i = from; i >= 0; i--) {
         const feedId = data.getFeedId(i)
         const addIdx = feeds.get(feedId)
         if (addIdx !== undefined && i >= addIdx) return i
      }
      return -1
   }),
   findRight: vi.fn(async (from: number, feeds: Map<number, number>) => {
      const end = data.db.total_art
      for (let i = from; i < end; i++) {
         const feedId = data.getFeedId(i)
         const addIdx = feeds.get(feedId)
         if (addIdx !== undefined && i >= addIdx) return i
      }
      return -1
   }),
}))

vi.mock("./data", () => data)

// nav.ts imports ./search for its "q:<query>" filter mode; mock it so tests
// drive the hit set directly instead of fetching real shards.
const searchMod = vi.hoisted(() => {
   const mod = {
      available: vi.fn(() => true),
      shortQuery: vi.fn(() => false),
      search: vi.fn(),
      // Faithful stand-in for search.ts loadHits: drive the generator, cap, dedup
      // and sort exactly as buildHits does (like the data mock mirrors findLeft).
      loadHits: vi.fn(async (query: string, cap: number) => {
         const seen = new Set<number>()
         const chrons: number[] = []
         let truncated = false
         if (query) {
            outer: for await (const batch of mod.search(query, cap + 1)) {
               for (const h of batch as { chron: number }[]) {
                  if (chrons.length >= cap) {
                     truncated = true
                     break outer
                  }
                  if (!seen.has(h.chron)) {
                     seen.add(h.chron)
                     chrons.push(h.chron)
                  }
               }
            }
         }
         chrons.sort((a, b) => a - b)
         return { chrons, truncated }
      }),
   }
   return mod
})
vi.mock("./search", () => searchMod)

import * as nav from "./nav"
import { setImgProxy } from "./fmt"

function makeArticle(overrides: Partial<IArticle> = {}): IArticle {
   return { f: 1, a: 0, p: 0, t: "", l: "", c: "", ...overrides }
}

function makeFeed(overrides: Partial<IFeed> = {}): IFeed {
   return { id: 1, title: "Test", url: "http://test.com", total_art: 1, ...overrides } as IFeed
}

function setupIndex(entries: Array<{ feedId: number; fetchedAt?: number }>) {
   data.db.total_art = entries.length
   const cIds = new Uint32Array(entries.map((e) => e.feedId))
   const fAts = new Uint32Array(entries.map((e) => e.fetchedAt ?? 0))
   data.loadArticle.mockImplementation(async (idx: number) => makeArticle({ f: cIds[idx], a: fAts[idx] }))
   data.getFeedId.mockImplementation((idx: number) => cIds[idx])
   const counts = new Map<number, number>()
   for (const e of entries) counts.set(e.feedId, (counts.get(e.feedId) ?? 0) + 1)
   for (const [id, count] of counts) if (!data.db.feeds[id]) data.db.feeds[id] = makeFeed({ id, total_art: count })
   nav.filter.clear()
}

beforeEach(() => {
   data.db.total_art = 0
   data.db.feeds = {}
   data.loadArticle.mockReset()
   data.getFeedId.mockReset()
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
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const result = await nav.fromHash(String(input))
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(result.article.f).toBe(2)
   })

   it("parses basic hash (#1)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const result = await nav.fromHash("1")
      expect(result.article.f).toBe(2)
      expect(nav.filter.active).toBe(false)
   })

   it("handles single article feed", async () => {
      setupIndex([{ feedId: 1 }])
      const result = await nav.fromHash("0")
      expect(result.article.f).toBe(1)
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("snaps to later match when filter has no earlier match", async () => {
      setupIndex([{ feedId: 2 }, { feedId: 2 }, { feedId: 1 }])
      const result = await nav.fromHash("0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(2)
      expect(result.article.f).toBe(1)
   })

   it("does not snap when current article matches filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(data.loadArticle).toHaveBeenCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("parses filter hash (#1!42)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 42 }])
      await nav.fromHash("1!42")
      expect(nav.filter.active).toBe(true)
   })

   it("parses tag filter", async () => {
      data.db.feeds = { "1": makeFeed({ id: 1, tag: "news" }), "2": makeFeed({ id: 2, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.feeds)) s.id = Number(k)
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      const result = await nav.fromHash("1!news")
      expect(nav.filter.active).toBe(true)
      expect(result.article.f).toBe(2)
   })

   it.each(["", "abc"])("handles non-numeric hash %j by clamping", async (hash) => {
      setupIndex([{ feedId: 1 }])
      const result = await nav.fromHash(hash)
      expect(result.article.f).toBe(1)
   })

   it("bare ! treated as no filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const result = await nav.fromHash("1!")
      expect(result.article.f).toBe(2)
      expect(nav.filter.active).toBe(false)
   })

   it("parses multi-sub filter from hash", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("1!1+3")
      expect(nav.filter.active).toBe(true)
   })

   it("ignores unresolved tag tokens from hash", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0!1+abc+3")
      expect(nav.filter.active).toBe(true)
   })

   it("hash with empty tokens between plus signs", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0!1++3")
      expect(nav.filter.active).toBe(true)
   })

   it("tag with no matching subs clears filter", async () => {
      data.db.feeds = {}
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0!nonexistent")
      expect(nav.filter.active).toBe(false)
   })

   it("hash preserves tag token instead of expanding to sub IDs", async () => {
      data.db.feeds = { "1": makeFeed({ id: 1, tag: "tech" }), "2": makeFeed({ id: 2, tag: "tech" }) }
      for (const [k, s] of Object.entries(data.db.feeds)) s.id = Number(k)
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0!tech")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!tech")
   })

   it("mixed tag and sub ID tokens in hash", async () => {
      data.db.feeds = { "1": makeFeed({ id: 1, tag: "tech" }), "2": makeFeed({ id: 2 }) }
      for (const [k, s] of Object.entries(data.db.feeds)) s.id = Number(k)
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("1!tech+2")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#1!tech+2")
   })

   it("fromHash goes to last matching article when current does not match filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.article.f).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("uses replaceState (not pushState) when snapping to a different position", async () => {
      // hashchange fires after the browser commits the URL; if the snap pushes
      // a new entry, pressing Back returns to the un-snapped URL and snaps
      // again, trapping the user in a loop. The snap must replace.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("1!1")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#2!1")
      expect(history.pushState).not.toHaveBeenCalled()
   })

   it("resolves token '0' as sub ID 0", async () => {
      data.db.feeds = { "0": makeFeed({ id: 0, title: "Zero" }) }
      setupIndex([{ feedId: 0 }])
      await nav.fromHash("0!0")
      expect(nav.filter.active).toBe(true)
   })

   it("multi-sub filter hash serializes sub IDs", async () => {
      setupIndex([{ feedId: 3 }])
      await nav.fromHash("0!1+3")
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "#0!1+3")
   })
})

describe("left", () => {
   it("decrements pos in normal mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("2")
      const r1 = await nav.left()
      expect(r1.article.f).toBe(2)
      const r2 = await nav.left()
      expect(r2.article.f).toBe(1)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#0")
   })

   it("throws when already at start", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("in filter mode, finds previous matching entry", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }, { feedId: 1 }])
      await nav.fromHash("3!1")
      const result = await nav.left()
      expect(result.article.f).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("1!1")
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("finds last matching entry searching backward", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("3!1")
      await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
   })

   it("returns first matching entry when it is at index 0", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("3!1")
      const r1 = await nav.left()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(r1.has_left).toBe(false)
   })

   it("multi-sub filter matches any sub in filter set going left", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }, { feedId: 1 }])
      await nav.fromHash("3!1+3")
      const r1 = await nav.left()
      expect(r1.article.f).toBe(3)
      const r2 = await nav.left()
      expect(r2.article.f).toBe(1)
   })
})

describe("right", () => {
   it("increments pos in normal mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("0")
      const r1 = await nav.right()
      expect(r1.article.f).toBe(2)
      const r2 = await nav.right()
      expect(r2.article.f).toBe(3)
   })

   it("throws when already at end", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("2")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("in filter mode, finds next matching entry", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }, { feedId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(result.article.f).toBe(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
   })

   it("in filter mode, throws when no match exists", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0!1")
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("multi-sub filter matches any sub in filter set going right", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }, { feedId: 1 }])
      await nav.fromHash("0!1+3")
      const r1 = await nav.right()
      expect(r1.article.f).toBe(3)
      const r2 = await nav.right()
      expect(r2.article.f).toBe(1)
   })

   it("updates hash after right navigation", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0")
      await nav.right()
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1")
   })
})

describe("last", () => {
   it("finds last matching entry for a sub", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      data.db.feeds[1] = makeFeed({ id: 1, total_art: 2 })
      await nav.fromHash("0")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(result.article.f).toBe(1)
      expect(nav.filter.active).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#2!1")
   })

   it("goes to last article when sub has no articles", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      data.db.feeds[5] = makeFeed({ id: 5, total_art: 0 })
      await nav.fromHash("0")
      nav.filter.set(["5"])
      await nav.last()
      expect(nav.filter.active).toBe(false)
   })

   it("goes to last article when sub not found in subscriptions", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0")
      nav.filter.set(["999"])
      await nav.last()
      expect(nav.filter.active).toBe(false)
   })

   it("uses current filter when called without subId in filter mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      data.db.feeds[1] = makeFeed({ id: 1, total_art: 1 })
      await nav.fromHash("0!1")
      const result = await nav.last()
      expect(result.article.f).toBe(1)
      expect(nav.filter.active).toBe(true)
   })

   it("clears filter when called without subId and no filter active", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0")
      await nav.last()
      expect(nav.filter.active).toBe(false)
   })

   it("returns no-match article when sub not found in any entry", async () => {
      setupIndex([{ feedId: 3 }, { feedId: 4 }])
      data.db.feeds[5] = makeFeed({ id: 5, total_art: 1 })
      await nav.fromHash("0")
      nav.filter.set(["5"])
      const result = await nav.last()
      expect(nav.filter.active).toBe(true)
      expect(result.article.t).toBe("(no matching articles)")
      expect(result.has_left).toBe(false)
      expect(result.has_right).toBe(false)
   })

   it("filter.set with empty string auto-clears", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0")
      nav.filter.set([""])
      await nav.last()
      expect(nav.filter.active).toBe(false)
   })

   it("filter.set with NaN auto-clears", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0")
      nav.filter.set(["abc"])
      await nav.last()
      expect(nav.filter.active).toBe(false)
   })

   it("scans backward to find last matching entry", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 2 }, { feedId: 2 }])
      data.db.feeds[1] = makeFeed({ id: 1, total_art: 1 })
      await nav.fromHash("3")
      nav.filter.set(["1"])
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("preserves multi-sub filter set when called with no arg", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      data.db.feeds[1] = makeFeed({ id: 1, total_art: 1 })
      data.db.feeds[3] = makeFeed({ id: 3, total_art: 1 })
      await nav.fromHash("0!1+3")
      const result = await nav.last()
      expect(result.article.f).toBe(3)
      expect(nav.filter.active).toBe(true)
   })
})

describe("has_right edges", () => {
   it("ignores sub.total_art when it exceeds real idx entries", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      data.db.feeds[1].total_art = 5
      const result = await nav.fromHash("1!1")
      expect(result.has_right).toBe(false)
      await expect(nav.right()).rejects.toThrow("no right match")
   })

   it("excludes unknown sub_id entries in unfiltered mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 99 }])
      delete data.db.feeds[99]
      const result = await nav.fromHash("0")
      expect(result.has_right).toBe(false)
   })
})

describe("showFeed", () => {
   it("has_left/has_right correct in normal mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])

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
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])

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
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const result = await nav.fromHash("0!1")
      expect(result.has_right).toBe(false)
   })

   it("has_left false in filtered mode with no earlier same-sub entries", async () => {
      setupIndex([{ feedId: 2 }, { feedId: 1 }])
      const result = await nav.fromHash("1!1")
      expect(result.has_left).toBe(false)
   })
})

// right_count — the reader's pending readout: articles still AHEAD of pos.
// Feed/tag/[ALL] modes count the filter's unread through the same
// unreadCounts/tagUnreadFromCounts pair the config surface badges use, minus
// the article on screen (countCurrent=false) — so the last article reads 0.
// Saved/search count their explicit sets strictly after pos.
describe("right_count", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("matches the unread total in normal mode, ticking down as you read forward", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      expect((await nav.fromHash("0")).right_count).toBe(2)
      expect((await nav.fromHash("1")).right_count).toBe(1)
      expect((await nav.fromHash("2")).right_count).toBe(0)
   })

   it("counts only the filtered feed's unread in filtered mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      expect((await nav.fromHash("0!1")).right_count).toBe(2) // chron 2, 4
      expect((await nav.fromHash("2!1")).right_count).toBe(1)
      expect((await nav.fromHash("4!1")).right_count).toBe(0)
   })

   it("counts what's ahead in unseen-only mode — the badges' numbers minus the article on screen", async () => {
      // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1; seen ch1→2, ch2→1; unseen are 3,4.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      for (const id of [1, 2]) data.db.feeds[id].tag = "news"
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:2": 1, "feed:1": 2 }))
      nav.setUnreadOnly(true)
      const group = [data.db.feeds[1], data.db.feeds[2]]
      // The pill's own sum: badge counting with the on-screen article excluded.
      const pillSum = async () => nav.tagUnreadFromCounts(group, await nav.unreadCounts(group, false))

      // Resumes at the seen position (chron 1, already read); both unseen sit ahead.
      const opened = await nav.switchFilter("news")
      expect(opened.right_count).toBe(2)
      expect(opened.right_count).toBe(await pillSum())

      // Stepping onto an unread article: the settings badge keeps counting it
      // (feedUnread's onCurrent) but the pill does not — one ahead, one on screen.
      const onFirst = await nav.right() // chron 3
      expect(onFirst.right_count).toBe(1)
      expect(onFirst.right_count).toBe(await pillSum())
      expect(nav.tagUnreadFromCounts(group, await nav.unreadCounts(group))).toBe(2) // pill + the one on screen

      // The LAST unread: nothing ahead, so the pill reads an explicit 0 — even
      // though its settings badge still shows the one on screen.
      const onLast = await nav.right() // chron 4
      expect(onLast.has_right).toBe(false)
      expect(onLast.right_count).toBe(0)
      expect(onLast.right_count).toBe(await pillSum())
   })

   it("counts the saved set to the right in ★ Saved mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      localStorage.setItem("srr-saved", JSON.stringify([0, 2, 3]))
      // Saved opens at the newest saved article — nothing further right.
      expect((await nav.switchFilter(nav.SAVED_TOKEN)).right_count).toBe(0)
      expect((await nav.left()).right_count).toBe(1) // on chron 2 → {3} remains
      expect((await nav.left()).right_count).toBe(2) // on chron 0 → {2, 3}
   })

   it("counts the hit set to the right in search mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      searchMod.search.mockImplementation(async function* () {
         yield [{ chron: 2 }, { chron: 0 }]
      })
      // Search opens at the newest hit (chron 2); the other hit is to the left.
      expect((await nav.switchFilter("q:foo")).right_count).toBe(0)
      expect((await nav.left()).right_count).toBe(1) // on chron 0 → {2} remains
   })

   it("degrades to -1 (digits hidden) when the count probe fails, without failing the render", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      data.countLeft.mockImplementationOnce(() => {
         throw new Error("cold pack blip")
      })
      const shown = await nav.fromHash("0")
      expect(shown.has_right).toBe(true) // the neighbor probe still succeeded
      expect(shown.right_count).toBe(-1)
   })

   it("is 0 on the last article in normal mode (read on landing, like its badge)", async () => {
      setupIndex([{ feedId: 1 }])
      const shown = await nav.fromHash("0")
      expect(shown.has_right).toBe(false)
      expect(shown.right_count).toBe(0)
   })
})

describe("getFilterEntries", () => {
   it("returns only empty string when no active subs", () => {
      data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual([""])
   })

   it("returns tags sorted then untagged sub IDs", () => {
      const sub3 = makeFeed({ id: 3, title: "B-Sub", total_art: 2 })
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([
            ["alpha", [makeFeed({ id: 2, tag: "alpha" })]],
            ["beta", [makeFeed({ id: 1, tag: "beta" })]],
         ]),
         sortedTags: ["alpha", "beta"],
         untagged: [sub3],
      })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "alpha", "beta", "3"])
   })

   it("returns single tag entry for multiple subs with same tag", () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["tech", [makeFeed({ id: 1, tag: "tech" }), makeFeed({ id: 2, tag: "tech" })]]]),
         sortedTags: ["tech"],
         untagged: [],
      })
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "tech"])
   })
})

describe("filterLabel", () => {
   it("maps [ALL] and the saved smart-folder to their words", () => {
      expect(nav.filterLabel("")).toBe("All")
      expect(nav.filterLabel(nav.SAVED_TOKEN)).toBe("★ Saved")
   })

   it("resolves a numeric feed-id key to that feed's title, never the raw id", () => {
      data.db.feeds = { "7": makeFeed({ id: 7, title: "The Wire" }) }
      expect(nav.filterLabel("7")).toBe("The Wire")
   })

   it("passes a tag-name key through unchanged (tags are already names)", () => {
      expect(nav.filterLabel("news")).toBe("news")
   })
})

describe("switchFilter", () => {
   it("with empty token clears filter and opens at the oldest article on a fresh device", async () => {
      // Nothing seen → everything is unread → [ALL] opens at the start of the
      // global backlog (chron 0), not the newest.
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const result = await nav.switchFilter("")
      expect(nav.filter.active).toBe(false)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("opens [ALL] at the oldest unseen article, not the newest", async () => {
      // feed 1 (chron 0,1) fully read; feed 2 (chron 2,3) untouched. The oldest
      // unseen overall is chron 2 — the same anchor the list uses (listAnchor),
      // NOT the newest (chron 3).
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      const result = await nav.switchFilter("")
      expect(nav.filter.active).toBe(false)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.f).toBe(2)
   })

   it("selecting [ALL] does not mark the unread backlog as seen", async () => {
      // Landing on the newest would let recordSeen raise every feed's frontier
      // to it and wipe all unread counts. Landing on the oldest unseen (chron 2)
      // marks only that article: chron 3 must stay unread.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      await nav.switchFilter("")
      const seen = JSON.parse(localStorage.getItem("srr-seen")!)
      expect(seen["feed:2"]).toBe(2) // exact resume on the shown article, not 3
   })

   it("falls back to the newest article for [ALL] when everything is seen", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0, "feed:2": 1 }))
      const result = await nav.switchFilter("")
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.f).toBe(2)
   })

   it("jumps to first matching article when sub has not been seen", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("0")
      const result = await nav.switchFilter("1")
      expect(nav.filter.active).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("jumps to first matching article when tag has not been seen", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      data.db.feeds[6] = makeFeed({ id: 6, tag: "news" })
      setupIndex([{ feedId: 5 }, { feedId: 6 }, { feedId: 5 }])
      await nav.fromHash("0")
      await nav.switchFilter("news")
      expect(nav.filter.active).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("resumes at last seen position when sub was previously viewed", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("2") // chronIdx 2 (sub 1) → seen sub:1=2
      await nav.switchFilter("2") // sub 2 lands on chronIdx 1 (does not touch sub:1)
      await nav.switchFilter("1")
      expect(nav.filter.active).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("resumes at last seen position when tag was previously viewed", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      data.db.feeds[6] = makeFeed({ id: 6 })
      setupIndex([{ feedId: 5 }, { feedId: 6 }, { feedId: 5 }])
      await nav.fromHash("0") // chronIdx 0 (sub 5, tag news) → seen feed:5=0
      await nav.switchFilter("6") // sub 6 (no tag) lands on chronIdx 1
      await nav.switchFilter("news")
      expect(nav.filter.active).toBe(true)
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("picking an empty feed shows the placeholder scoped to it, not [ALL]'s newest", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }]) // real articles for feeds 1 and 2
      data.db.feeds[9] = makeFeed({ id: 9, total_art: 0 }) // a pickable empty feed
      await nav.fromHash("0")
      const result = await nav.switchFilter("9")
      expect(result.placeholder).toBe(true) // not a teleport to feed 2's newest
      expect(nav.getCurrentFilterKey()).toBe("9") // filter scoped to the picked feed
      expect(nav.filter.feeds.size).toBe(0) // no navigable members
   })

   it("resumes a multi-feed tag at its oldest (min) member position", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      data.db.feeds[6] = makeFeed({ id: 6, tag: "news" })
      setupIndex([{ feedId: 5 }, { feedId: 6 }, { feedId: 5 }, { feedId: 6 }, { feedId: 5 }])
      await nav.fromHash("4") // view chron 4 (ch5) → feed:5 = 4
      await nav.fromHash("1") // view chron 1 (ch6) → feed:6 = 1
      await nav.switchFilter("news")
      expect(nav.filter.active).toBe(true)
      // min(4, 1) = 1: open at the least-recently-read member so every unread
      // article in the tag sits to the right, none skipped on the left.
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
   })

   it("falls back to first when stored position no longer matches filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      // Stale seen entry: chronIdx 1 is sub 2, doesn't match sub:1 filter.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("falls back to first when stored position is beyond total_art", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 99 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("records only the feed seen position; the tag derives from it", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      setupIndex([{ feedId: 5 }, { feedId: 5 }])
      await nav.fromHash("1") // view chronIdx 1
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:5"]).toBe(1)
      // No tag key is ever written — the tag's position is read back from its
      // member feeds (here a single feed at chron 1).
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })

   it("never records a tag key", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0")
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:1"]).toBe(0)
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })
})

describe("applyFilter", () => {
   it("keeps a known-but-empty feed scoped (reload of #!<id>)", () => {
      // Feed 9 has articles; feed 5 exists but has zero articles (known-but-empty).
      setupIndex([{ feedId: 9 }, { feedId: 9 }, { feedId: 9 }])
      data.db.feeds[5] = makeFeed({ id: 5, total_art: 0 })

      nav.applyFilter(["5"])
      expect(nav.filter.tokens).toEqual(["5"]) // not cleared to [ALL]
      expect(nav.filter.feeds.size).toBe(0) // no navigable members

      // A genuinely unknown token still falls back to [ALL].
      nav.applyFilter(["999"])
      expect(nav.filter.tokens).toEqual([])
   })
})

describe("pruneSeen", () => {
   it("removes entries for deleted subs and all legacy tag keys", () => {
      data.db.feeds = { 1: makeFeed({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 5, "feed:99": 10, "tag:news": 3, "tag:gone": 7 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // tag: keys are legacy now (a tag derives its position from its feeds),
      // so they are dropped even when the tag still exists.
      expect(seen).toEqual({ "feed:1": 5 })
   })

   it("strips a legacy tag key even when the tag still exists", () => {
      data.db.feeds = {
         1: makeFeed({ id: 1, tag: "news" }),
         2: makeFeed({ id: 2 }),
      }
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0, "tag:news": 0 }))
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "feed:1": 0 })
   })

   it("does not write when nothing is stale", () => {
      data.db.feeds = { 1: makeFeed({ id: 1, tag: "news" }) }
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0 }))
      const setSpy = vi.spyOn(Storage.prototype, "setItem")
      nav.pruneSeen()
      expect(setSpy).not.toHaveBeenCalled()
      setSpy.mockRestore()
   })
})

describe("isRowUnread", () => {
   // Strictly-after the feed's seen high-water — the same rule feedUnread
   // counts by (countAll − countLeft(seen+1)). recordSeen stores the just-read
   // article's OWN chronIdx, so the row AT seen must read as READ, not unread, or
   // the list dot disagrees with the feed badge by one row.
   const seen = { "feed:5": 50 }

   it("treats the article at the seen high-water (chron === seen) as READ", () => {
      expect(nav.isRowUnread(50, 5, seen)).toBe(false)
   })

   it("treats older articles (chron < seen) as READ", () => {
      expect(nav.isRowUnread(49, 5, seen)).toBe(false)
   })

   it("treats newer articles (chron > seen) as UNREAD", () => {
      expect(nav.isRowUnread(51, 5, seen)).toBe(true)
   })

   it("treats a never-seen feed as fully unread", () => {
      expect(nav.isRowUnread(0, 7, seen)).toBe(true)
   })
})

describe("recordSeen marks previous articles seen across the list", () => {
   it("marks OLDER articles in every other filter feed seen, leaving newer unread", async () => {
      // Three interleaved feeds in [ALL]: chron 0=ch1 1=ch2 2=ch3 3=ch1 4=ch2 5=ch3.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }, { feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("3") // open chron 3 (ch1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // Every feed is caught up to chron 3 — ch1 exactly (its own resume), ch2
      // and ch3 by the one-way high-water — so all articles at-or-below 3 are seen.
      expect(seen).toEqual({ "feed:1": 3, "feed:2": 3, "feed:3": 3 })
      expect(nav.isRowUnread(2, 3, seen)).toBe(false) // ch3 @ chron 2 (older) → seen
      expect(nav.isRowUnread(1, 2, seen)).toBe(false) // ch2 @ chron 1 (older) → seen
      expect(nav.isRowUnread(4, 2, seen)).toBe(true) // ch2 @ chron 4 (newer) → still unread
      expect(nav.isRowUnread(5, 3, seen)).toBe(true) // ch3 @ chron 5 (newer) → still unread
   })

   it("only marks feeds in the active filter, not the whole store", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      data.db.feeds[3] = makeFeed({ id: 3 }) // untagged — outside the filter
      // chron 0=ch1 1=ch3 2=ch2 3=ch1.
      setupIndex([{ feedId: 1 }, { feedId: 3 }, { feedId: 2 }, { feedId: 1 }])
      await nav.switchFilter("news") // tag {ch1, ch2}, opens at first() = chron 0
      await nav.right() // → chron 2 (ch2), skipping ch3's chron 1 (not in the filter)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:1"]).toBe(2) // tag member, caught up to chron 2
      expect(seen["feed:2"]).toBe(2) // current feed
      expect(seen["feed:3"]).toBeUndefined() // outside the filter — untouched
   })

   it("never lowers another feed's frontier when scrubbing back to an older article", async () => {
      // chron 0=ch1 1=ch2 2=ch1 3=ch2.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("3") // chron 3 (ch2): all caught up to 3
      await nav.fromHash("0") // step back to chron 0 (ch1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:1"]).toBe(0) // current feed tracks the exact resume position
      expect(seen["feed:2"]).toBe(3) // kept its higher frontier — a one-way raise
   })

   it("query (search) mode never advances the seen frontier", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      searchMod.available.mockReturnValue(true)
      searchMod.shortQuery.mockReturnValue(false)
      searchMod.search.mockImplementation(async function* () {
         yield [{ chron: 2, f: 1, w: 1000, t: "t" }]
      })
      await nav.switchFilter("q:zeta") // search mode, opens at the newest hit (chron 2)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({}) // a hit peeked via search stays unread
      searchMod.search.mockReset()
   })

   it("saved mode marks only the opened article's own feed (feed-agnostic set)", async () => {
      // chron 0=ch1 1=ch2 2=ch1; saved set spans both feeds.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([0, 1, 2]))
      await nav.switchFilter(nav.SAVED_TOKEN) // opens at the newest saved (chron 2, ch1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // filter.feeds is empty in saved mode, so "mark previous across the list"
      // can't apply (it would over-mark non-saved articles) — only the current
      // article's own feed is recorded.
      expect(seen).toEqual({ "feed:1": 2 })
   })
})

describe("filter mutations", () => {
   it("set() resolves tag and sets filter", async () => {
      data.db.feeds = { "5": makeFeed({ id: 5, tag: "news" }), "6": makeFeed({ id: 6, tag: "news" }) }
      for (const [k, s] of Object.entries(data.db.feeds)) s.id = Number(k)
      setupIndex([{ feedId: 5 }, { feedId: 6 }])
      await nav.fromHash("1!news")
      expect(nav.filter.active).toBe(true)
   })

   it("clear() clears filter", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0!1")
      expect(nav.filter.active).toBe(true)
      await nav.fromHash("0")
      expect(nav.filter.active).toBe(false)
   })
})

describe("jumpToEnd via last()", () => {
   it("navigates to last article", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.f).toBe(3)
   })

   it("returns last article when already at end", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("jumps to last article and snaps to filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0!1")
      const result = await nav.last()
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.f).toBe(1)
   })
})

describe("cycleFilter", () => {
   it("cycles forward from no filter to first tag", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2 })
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [data.db.feeds[1]]]]),
         sortedTags: ["news"],
         untagged: [data.db.feeds[2]],
      })
      await nav.fromHash("0")
      await nav.cycleFilter(1)
      expect(nav.filter.active).toBe(true)
   })

   it("cycles backward wrapping to last entry", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      data.db.feeds[1] = makeFeed({ id: 1 })
      data.db.feeds[2] = makeFeed({ id: 2 })
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[1], data.db.feeds[2]],
      })
      await nav.fromHash("0")
      // entries = ["", "1", "2"], current = "" (idx 0), dir = -1 → wraps to idx 2 ("2")
      await nav.cycleFilter(-1)
      expect(nav.filter.active).toBe(true)
   })

   it("clears filter when cycling back to all", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      data.db.feeds[1] = makeFeed({ id: 1 })
      data.db.feeds[2] = makeFeed({ id: 2 })
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[1], data.db.feeds[2]],
      })
      await nav.fromHash("1!2")
      // entries = ["", "1", "2"], current = "2" (idx 2), dir = 1 → wraps to idx 0 ("")
      await nav.cycleFilter(1)
      expect(nav.filter.active).toBe(false)
   })
})

describe("first", () => {
   it("navigates to first article", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("1")
      const result = await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(result.article.f).toBe(1)
   })

   it("navigates to first filtered article", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("2!1")
      await nav.first()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
   })

   it("starts findRight from min add_idx (skips packs before any filter sub existed)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      data.db.feeds[2].add_idx = 2
      await nav.fromHash("3!2")
      data.findRight.mockClear()
      await nav.first()
      expect(data.findRight).toHaveBeenCalledWith(2, expect.any(Map))
   })
})

describe("goTo", () => {
   it("navigates directly to target when no filter active", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("0")
      const result = await nav.goTo(2)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.f).toBe(3)
   })

   it("navigates directly when target matches filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("0")
      const result = await nav.goTo(1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.f).toBe(2)
   })

   it("snaps forward when target does not match active filter", async () => {
      setupIndex([{ feedId: 2 }, { feedId: 1 }, { feedId: 1 }])
      await nav.fromHash("2!1")
      const result = await nav.goTo(0)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(result.article.f).toBe(1)
   })

   it("falls back to last when no match at or after target", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0!1")
      const result = await nav.goTo(2)
      expect(result.article.f).toBe(1)
   })

   it("falls back to last for out-of-range target", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0")
      const result = await nav.goTo(99)
      expect(result.article.f).toBe(2)
   })

   it("commits resolved chronIdx to URL hash when no filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      await nav.fromHash("0")
      await nav.goTo(2)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#2")
   })

   it("commits target chronIdx to URL hash when active filter matches", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      await nav.fromHash("0!1")
      const result = await nav.goTo(2)
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(result.article.f).toBe(1)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#2!1")
   })

   it("commits snapped chronIdx (not input) to URL hash when filter forces a snap", async () => {
      setupIndex([{ feedId: 2 }, { feedId: 1 }, { feedId: 1 }])
      await nav.fromHash("2!1")
      await nav.goTo(0)
      expect(history.pushState).toHaveBeenLastCalledWith(null, "", "#1!1")
   })
})

describe("getCurrentFilterKey", () => {
   it("returns empty string when no filter is active", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0")
      expect(nav.getCurrentFilterKey()).toBe("")
   })

   it("returns the single token of a single-token filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0!1")
      expect(nav.getCurrentFilterKey()).toBe("1")
   })

   it("returns the tag string of a single-tag filter", async () => {
      data.db.feeds = { "1": makeFeed({ id: 1, tag: "tech" }) }
      setupIndex([{ feedId: 1 }])
      await nav.fromHash("0!tech")
      expect(nav.getCurrentFilterKey()).toBe("tech")
   })

   it("returns empty string for a multi-token filter (URL-only edge case)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0!1+2")
      expect(nav.getCurrentFilterKey()).toBe("")
   })
})

describe("unread-only mode", () => {
   afterEach(() => nav.setUnreadOnly(false))

   function tagSetup(entries: Array<{ feedId: number }>) {
      setupIndex(entries)
      for (const id of new Set(entries.map((e) => e.feedId))) data.db.feeds[id].tag = "news"
   }

   it("persists the toggle in localStorage (both states explicitly)", () => {
      expect(nav.isUnreadOnly()).toBe(false)
      nav.setUnreadOnly(true)
      expect(nav.isUnreadOnly()).toBe(true)
      expect(localStorage.getItem("srr-unread-only")).toBe("1")
      nav.setUnreadOnly(false)
      // Off persists as "0" (not a cleared key): an absent key is the first-run
      // unread-only default, so an explicit off must survive a reload.
      expect(localStorage.getItem("srr-unread-only")).toBe("0")
   })

   // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1; read ch1→2, ch2→1; unseen are 3,4.
   async function readSome() {
      tagSetup([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      // Seed the seen map directly so the two members sit at DIFFERENT positions
      // (ch1→2, ch2→1), the case these tests exercise — the tag resumes at the
      // min (ch2's chron 1). Reaching this via [ALL] browsing no longer works:
      // opening an article now marks every passed feed seen up to it (the
      // mark-previous-as-seen rule), which would collapse both members onto the
      // same frontier. See recordSeen and its dedicated test below.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:2": 1, "feed:1": 2 }))
   }

   it("opening a tag resumes at its current position, not the next unseen", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1)
      nav.setUnreadOnly(true)
      const shown = await nav.switchFilter("news")
      // Resumes at the tag's saved position (min seen = chron 1, ch2) — the same
      // current position a feed or a non-unseen tag opens at — NOT the oldest
      // unseen. The raised bounds no longer bounce the open forward.
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(shown.article.f).toBe(2)
      expect(shown.has_left).toBe(false) // nothing unseen to the left of the resume
      const next = await nav.right() // Right steps to the first unseen
      expect(data.loadArticle).toHaveBeenLastCalledWith(3) // ch2, first unseen
      expect(next.article.f).toBe(2)
   })

   it("steps right through the unseen and stops at the last one", async () => {
      await readSome()
      nav.setUnreadOnly(true)
      await nav.switchFilter("news") // resumes at chron 1 (seen); both unseen to the right
      const onFirst = await nav.right() // chron 3 (oldest unseen)
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      expect(onFirst.has_right).toBe(true)
      const onLast = await nav.right() // chron 4 (last unseen)
      expect(data.loadArticle).toHaveBeenLastCalledWith(4)
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

   it("the dropdown tag badge counts the unread you're sitting on (stable through select then step)", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1) → 2
      nav.setUnreadOnly(true)
      const group = [data.db.feeds[1], data.db.feeds[2]]

      // On select you resume at the seen position (chron 1): the current article
      // is seen, so the badge reads the full 2 unseen.
      await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      let counts = await nav.unreadCounts(group)
      expect(counts.get(2)).toBe(1) // ch2 unseen {3}
      expect(counts.get(1)).toBe(1) // ch1 unseen {4}
      expect(nav.tagUnreadFromCounts(group, counts)).toBe(2)

      // Regression: step onto the first unseen (chron 3, ch2). recordSeen bumps
      // ch2's LIVE seen to 3 the instant you arrive, which would drop ch2's badge
      // to 0. feedUnread counts the unread you're sitting on back, so the badge
      // stays at 2.
      await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      counts = await nav.unreadCounts(group)
      expect(counts.get(2)).toBe(1) // ch2: live seen now 3 → {} unread, +1 for the one you're on
      expect(counts.get(1)).toBe(1) // ch1: its remaining unseen {4}, not inflated
      expect(nav.tagUnreadFromCounts(group, counts)).toBe(2) // not 1
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
      expect(shown.article.f).toBe(1)
      // Stable across a reload of the same hash — no downward drift.
      const again = await nav.fromHash("2!news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(again.article.f).toBe(1)
   })

   it("filters a single-feed view to unread too (seen excluded)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      await nav.fromHash("1") // feed:1 seen → 1 (chron 0,1 seen; chron 2 unseen)
      nav.setUnreadOnly(true)
      await nav.switchFilter("1") // resumes at the feed's seen position (chron 1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      // The seen chron 0 is below the raised bound now — left can't reach it.
      await expect(nav.left()).rejects.toThrow("no left match")
      // Right still steps to the unseen chron 2.
      const r = await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
      expect(r.article.f).toBe(1)
   })

   it("filters [ALL] to unread too (seen articles excluded)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.fromHash("0") // feed:1 seen → 0 (chron 0 seen); chron 1 (ch2) unseen
      nav.setUnreadOnly(true)
      nav.filter.clear() // [ALL]
      const shown = await nav.last() // unread → newest unseen (chron 1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(shown.article.f).toBe(2)
      expect(shown.has_left).toBe(false) // the seen chron 0 is excluded, nothing unseen left
   })

   it("walking right past the resume position leaves unseen on the left", async () => {
      await readSome() // ch1→2, ch2→1; unseen are chron 3 (ch2), 4 (ch1) → 2 total
      nav.setUnreadOnly(true)
      // Open at the resume position (chron 1, seen): both unseen are to the right,
      // none to the left.
      const a = await nav.switchFilter("news") // chron 1 (resume, seen)
      expect(a.has_left).toBe(false)
      // Walk onto the oldest unseen, then the last; only past the first does an
      // unseen sit on the left.
      const b = await nav.right() // chron 3 (oldest unseen)
      expect(b.has_left).toBe(false)
      const c = await nav.right() // chron 4 (last unseen)
      expect(c.has_left).toBe(true)
   })

   it("R3-2: a cold-pack neighbor-lookup rejection does not fail the loaded nav", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1)
      nav.setUnreadOnly(true)
      const realFindRight = data.findRight.getMockImplementation()!
      // showFeed probes feedRight(pos+1) for has_right; if that neighbor sits in a
      // cold finalized idx pack whose fetch blips, the lookup rejects. The loaded
      // article must survive (button just disabled), not be replaced by the error
      // popup. Reject the right-neighbor probe; the left probe still resolves.
      data.findRight.mockImplementation(async () => {
         throw new Error("cold idx pack fetch failed")
      })
      try {
         const shown = await nav.switchFilter("news") // resumes at chron 1 (ch2, seen)
         expect(data.loadArticle).toHaveBeenLastCalledWith(1)
         expect(shown.article.f).toBe(2) // the loaded article is intact
         expect(shown.article.t).not.toBe("(no matching articles)")
         expect(shown.has_right).toBe(false) // degraded to "no neighbor", not thrown
      } finally {
         data.findRight.mockImplementation(realFindRight) // restore for later tests
      }
   })
})

describe("tagUnreadFromCounts", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("counts a never-seen member as fully unread; unseen-only resumes at the saved position", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1. Read ch1→2; ch2 NEVER seen here.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      data.db.feeds[1].tag = "news"
      data.db.feeds[2].tag = "news"
      // Seed directly: ch1 read to chron 2, ch2 NEVER seen. (Browsing to chron 2
      // via [ALL] would now also mark ch2 seen up to chron 2 — the mark-previous-
      // as-seen rule — so seed the never-seen member explicitly.)
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      const group = [data.db.feeds[1], data.db.feeds[2]]
      // ch1 unread after chron 2 = {4} = 1; ch2 fully unread = {1,3} = 2 → 3.
      // The badge is derived from the already-computed per-feed counts map.
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
   })

   it("sums to the badge for a mixed tag (seen, never-seen, fully-read members)", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      data.db.feeds[3] = makeFeed({ id: 3, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch3 4=ch1 5=ch3.
      // ch1: partially read (seen→2, so {4} unread = 1).
      // ch2: NEVER seen → fully unread ({1} = 1).
      // ch3: fully read (seen→5, so {} unread = 0).
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 3 }, { feedId: 1 }, { feedId: 3 }])
      data.db.feeds[1].tag = "news"
      data.db.feeds[2].tag = "news"
      data.db.feeds[3].tag = "news"
      // Seed directly: ch3 fully read (→5), ch1 partially read (→2), ch2 NEVER
      // seen. (Browsing via [ALL] would now mark every passed feed seen up to
      // the opened article — the mark-previous-as-seen rule — so seed the
      // distinct per-member positions explicitly.)
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:3": 5, "feed:1": 2 }))
      const group = [data.db.feeds[1], data.db.feeds[2], data.db.feeds[3]]
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
   })

   it("returns 0 when every member is fully read (never-seen members excepted)", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      data.db.feeds[1].tag = "news"
      await nav.fromHash("1") // feed:1 = 1 (fully read)
      const group = [data.db.feeds[1]]
      expect(nav.tagUnreadFromCounts(group, await nav.unreadCounts(group))).toBe(0)
   })

   it("sums member counts (never-seen members as their full backlog)", async () => {
      // A tag mixing seen / never-seen / fully-read members. feedUnread reports a
      // never-seen member as its full backlog, so the tag badge is a plain sum of
      // the per-feed counts and the row badges beneath the header add up to it.
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      data.db.feeds[3] = makeFeed({ id: 3, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch3 4=ch1 5=ch3 6=ch2.
      // ch1: partially read (seen→2 → {4} unread = 1).
      // ch2: NEVER seen → fully unread ({1,6} = 2).
      // ch3: NEVER seen → fully unread ({3,5} = 2).
      setupIndex([
         { feedId: 1 },
         { feedId: 2 },
         { feedId: 1 },
         { feedId: 3 },
         { feedId: 1 },
         { feedId: 3 },
         { feedId: 2 },
      ])
      for (const id of [1, 2, 3]) data.db.feeds[id].tag = "news"
      // Seed directly: ch1 read to chron 2, ch2/ch3 NEVER seen. (Browsing via
      // [ALL] would now mark ch2/ch3 seen up to chron 2 — mark-previous-as-seen.)
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      const group = [data.db.feeds[1], data.db.feeds[2], data.db.feeds[3]]
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
   })
})

describe("unreadCounts", () => {
   it("batches per-feed unread counts correctly", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 3 }])
      await nav.fromHash("0") // feed:1 = 0 seen; ch2/ch3 never seen
      const chs = [data.db.feeds[1], data.db.feeds[2], data.db.feeds[3]]
      const batch = await nav.unreadCounts(chs)
      // ch1 has chron 2 unread; ch2/ch3 never seen →
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
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
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
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
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
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
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
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
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
         setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
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

   it("filter.set([SAVED_TOKEN]) enters a feed-agnostic saved mode", () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      nav.filter.set([nav.SAVED_TOKEN])
      expect(nav.filter.saved).toBe(true)
      expect(nav.filter.active).toBe(true)
      expect(nav.filter.feeds.size).toBe(0)
   })

   it("matches() is saved-set membership, ignoring the feed", () => {
      nav.toggleSaved(5)
      nav.filter.set([nav.SAVED_TOKEN])
      expect(nav.filter.matches(99, 5)).toBe(true) // any feed
      expect(nav.filter.matches(1, 4)).toBe(false) // not saved
   })

   it("clear() leaves saved mode", () => {
      nav.filter.set([nav.SAVED_TOKEN])
      nav.filter.clear()
      expect(nav.filter.saved).toBe(false)
   })

   it("traverses only saved articles, newest-first", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // chrons 0..4
      nav.toggleSaved(1)
      nav.toggleSaved(3)
      nav.toggleSaved(4)
      // switchFilter resumes at the newest saved (4).
      const r4 = await nav.switchFilter(nav.SAVED_TOKEN)
      expect(data.loadArticle).toHaveBeenCalledWith(4)
      expect(nav.filter.active).toBe(true)
      expect(r4.has_right).toBe(false)
      expect(r4.has_left).toBe(true)

      const r3 = await nav.left()
      expect(data.loadArticle).toHaveBeenCalledWith(3)
      expect(r3.has_left).toBe(true)

      const r1 = await nav.left()
      expect(data.loadArticle).toHaveBeenCalledWith(1) // skips unsaved 2
      expect(r1.has_left).toBe(false) // oldest saved
      await expect(nav.left()).rejects.toThrow("no left match")
   })

   it("getFilterEntries surfaces the saved token only when something is saved", () => {
      setupIndex([{ feedId: 1 }])
      expect(nav.getFilterEntries()).not.toContain(nav.SAVED_TOKEN)
      nav.toggleSaved(0)
      expect(nav.getFilterEntries()).toContain(nav.SAVED_TOKEN)
   })

   it("switchFilter(SAVED) pushes a #pos!~saved hash", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      nav.toggleSaved(1)
      await nav.switchFilter(nav.SAVED_TOKEN)
      expect(history.pushState).toHaveBeenCalledWith(null, "", "#1!~saved")
   })

   it("fromHash validates the position against the saved set", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // 0,1,2
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
   const hit = (chron: number) => ({ chron, f: 1, w: 1000, t: "t" })
   async function* gen(hits: ReturnType<typeof hit>[]) {
      yield hits
   }
   const enter = (term: string) => nav.applyFilter([nav.SEARCH_PREFIX + term])

   beforeEach(() => {
      searchMod.search.mockReset()
      // loadHits is the primary seam nav calls; reset it so each test gets a clean
      // call count. The default impl (lines 53–73 of the hoisted mock) calls
      // search() internally, so tests can drive via search.mockImplementation.
      searchMod.loadHits.mockReset()
      searchMod.loadHits.mockImplementation(async (query: string, cap: number) => {
         const seen = new Set<number>()
         const chrons: number[] = []
         let truncated = false
         if (query) {
            outer: for await (const batch of searchMod.search(query, cap + 1) as AsyncGenerator<{ chron: number }[]>) {
               for (const h of batch) {
                  if (chrons.length >= cap) {
                     truncated = true
                     break outer
                  }
                  if (!seen.has(h.chron)) {
                     seen.add(h.chron)
                     chrons.push(h.chron)
                  }
               }
            }
         }
         chrons.sort((a, b) => a - b)
         return { chrons, truncated }
      })
      searchMod.available.mockReturnValue(true)
      searchMod.shortQuery.mockReturnValue(false)
   })

   it("walks the hit set newest-first via feedLeft / feedRight", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
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
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9)]))
      enter("bravo")
      await nav.feedLeft(19) // trigger the lazy load
      expect(nav.filter.matches(1, 3)).toBe(true)
      expect(nav.filter.matches(1, 4)).toBe(false)
   })

   it("last() opens the newest hit, first() the oldest, goTo snaps forward", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
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
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9), hit(15)]))
      enter("delta")
      const r = await nav.goTo(9)
      expect(r.has_left).toBe(true) // hit 3 is left of 9
      expect(r.has_right).toBe(true) // hit 15 is right of 9
   })

   it("fromHash honors a #pos!q: deep link that is a hit, else snaps to newest", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
      searchMod.search.mockImplementation(() => gen([hit(3), hit(9), hit(15)]))
      await nav.fromHash("9!" + nav.SEARCH_PREFIX + "echo")
      expect(nav.currentChron()).toBe(9)
      await nav.fromHash("7!" + nav.SEARCH_PREFIX + "echo2")
      expect(nav.currentChron()).toBe(15) // 7 isn't a hit → newest
   })

   it("an empty query yields no hits and never fetches", async () => {
      setupIndex(Array.from({ length: 5 }, () => ({ feedId: 1 })))
      enter("")
      expect(nav.isSearchFilter()).toBe(true)
      expect(await nav.feedLeft(4)).toBe(-1)
      expect(searchMod.search).not.toHaveBeenCalled()
   })

   it("caps the set at SEARCH_CAP and flags truncation", async () => {
      setupIndex(Array.from({ length: 600 }, () => ({ feedId: 1 })))
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
      setupIndex(Array.from({ length: 5 }, () => ({ feedId: 1 })))
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
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
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

describe("search hit-set snapshot (ensureSearchSet / loadHits)", () => {
   // The pull/dedup/cap loop now lives in search.loadHits (mocked by searchMod.loadHits).
   // Nav's role: await loadHits once per query, store the snapshot in searchSorted/searchSet,
   // and discard a stale result when the active query changed while awaiting.

   beforeEach(() => {
      searchMod.search.mockReset()
      searchMod.loadHits.mockReset()
      searchMod.available.mockReturnValue(true)
      searchMod.shortQuery.mockReturnValue(false)
   })

   it("feedLeft/feedRight load the full set once via loadHits then use the snapshot", async () => {
      setupIndex(Array.from({ length: 60 }, () => ({ feedId: 1 })))
      searchMod.loadHits.mockResolvedValue({ chrons: [45, 50, 55], truncated: false })
      nav.applyFilter([nav.SEARCH_PREFIX + "snap1"])
      expect(await nav.feedLeft(57)).toBe(55)
      expect(await nav.feedLeft(54)).toBe(50)
      expect(await nav.feedLeft(49)).toBe(45)
      expect(await nav.feedLeft(44)).toBe(-1)
      expect(searchMod.loadHits).toHaveBeenCalledTimes(1) // single load, snapshot reused
   })

   it("feedRight returns the smallest hit >= from", async () => {
      setupIndex(Array.from({ length: 60 }, () => ({ feedId: 1 })))
      searchMod.loadHits.mockResolvedValue({ chrons: [45, 50, 55], truncated: false })
      nav.applyFilter([nav.SEARCH_PREFIX + "snap2"])
      expect(await nav.feedRight(46)).toBe(50)
      expect(searchMod.loadHits).toHaveBeenCalledTimes(1)
   })

   it("resetSearchStream clears the snapshot; next feedLeft reloads via loadHits", async () => {
      setupIndex(Array.from({ length: 60 }, () => ({ feedId: 1 })))
      searchMod.loadHits.mockResolvedValue({ chrons: [45, 55], truncated: false })
      nav.applyFilter([nav.SEARCH_PREFIX + "snap3"])
      expect(await nav.feedLeft(57)).toBe(55) // snapshot loaded
      expect(nav.filter.matches(1, 55)).toBe(true)

      nav.resetSearchStream()
      expect(nav.filter.matches(1, 55)).toBe(false) // snapshot cleared
      expect(await nav.feedLeft(57)).toBe(55) // reloads from loadHits
      expect(searchMod.loadHits).toHaveBeenCalledTimes(2)
   })

   it("an empty query never calls loadHits and has no hits", async () => {
      setupIndex(Array.from({ length: 5 }, () => ({ feedId: 1 })))
      nav.applyFilter([nav.SEARCH_PREFIX]) // empty query
      expect(await nav.feedLeft(4)).toBe(-1)
      expect(searchMod.loadHits).not.toHaveBeenCalled()
   })

   it("cap and truncation are delegated to loadHits (mock returns them faithfully)", async () => {
      setupIndex(Array.from({ length: 600 }, () => ({ feedId: 1 })))
      // loadHits mock already applies the cap+dedup; return a truncated set
      const chrons = Array.from({ length: 500 }, (_, i) => i + 100) // 100..599
      searchMod.loadHits.mockResolvedValue({ chrons, truncated: true })
      nav.applyFilter([nav.SEARCH_PREFIX + "capn"])
      expect(await nav.feedLeft(0)).toBe(-1) // below the window
      expect(nav.searchTruncated()).toBe(true)
      expect(await nav.feedLeft(599)).toBe(599) // newest kept
      expect(await nav.feedLeft(100)).toBe(100) // oldest kept
      expect(await nav.feedLeft(99)).toBe(-1) // dropped by cap
   })

   it("dedup is handled by loadHits; nav walks a clean sorted set", async () => {
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))
      searchMod.loadHits.mockResolvedValue({ chrons: [3, 9, 15], truncated: false })
      nav.applyFilter([nav.SEARCH_PREFIX + "dedup"])
      expect(await nav.feedLeft(19)).toBe(15)
      expect(await nav.feedLeft(14)).toBe(9)
      expect(await nav.feedLeft(8)).toBe(3)
      expect(await nav.feedLeft(2)).toBe(-1)
      expect(await nav.feedRight(10)).toBe(15)
      expect(await nav.feedRight(4)).toBe(9)
   })

   it("fromHash deep-link loads all hits then honors a matching position", async () => {
      setupIndex(Array.from({ length: 60 }, () => ({ feedId: 1 })))
      searchMod.loadHits.mockResolvedValue({ chrons: [10, 25, 40, 55], truncated: false })
      await nav.fromHash("25!" + nav.SEARCH_PREFIX + "deep1")
      expect(nav.currentChron()).toBe(25) // honored
      await nav.fromHash("30!" + nav.SEARCH_PREFIX + "deep2")
      expect(nav.currentChron()).toBe(55) // 30 isn't a hit → snaps to the newest
   })
})

// ── Edge cases: listAnchor / fromHash foreign+malformed /
// cycle / saved-set parse / pruneSeen / tombstone / all-caught-up ────────────
const SEEN = "srr-seen"
const seedSeen = (m: Record<string, number>) => localStorage.setItem(SEEN, JSON.stringify(m))

describe("listAnchor", () => {
   it("returns the live reader position when it still matches the active filter", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.goTo(1) // pos=1, ch2
      expect(await nav.listAnchor()).toBe(1)
   })

   it("anchors [ALL] at the oldest unread across all feeds (fresh device = oldest overall)", async () => {
      // Nothing seen → every article unread → [ALL] lands at the oldest article,
      // exactly as a never-opened tag does over its members.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      nav.select(-1, -1) // no reader article
      nav.filter.clear()
      expect(await nav.listAnchor()).toBe(0)
   })

   it("anchors [ALL] at the oldest UNREAD across feeds, skipping older read articles", async () => {
      // feed 1 (chron 0,1) fully read; feed 2 (chron 2,3) read through chron 2.
      // Oldest unread overall = chron 3; the read feed-1 articles below it are
      // skipped — the same oldest-unread scan a tag runs, spanning every feed.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      seedSeen({ "feed:1": 1, "feed:2": 2 })
      nav.select(-1, -1)
      nav.filter.clear()
      expect(await nav.listAnchor()).toBe(3)
   })

   it("falls back to newest-first (-1) for [ALL] with nothing unread (fully caught up)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      seedSeen({ "feed:1": 0, "feed:2": 1 }) // both read through their newest
      nav.select(-1, -1)
      nav.filter.clear()
      expect(await nav.listAnchor()).toBe(-1)
   })

   it("returns -1 for [ALL] on an empty store (no feeds with articles)", async () => {
      // No setupIndex → no feeds; filter.clear() leaves filter.feeds empty, so the
      // oldest-unread scan is skipped (no Math.min over an empty map).
      nav.select(-1, -1)
      nav.filter.clear()
      expect(await nav.listAnchor()).toBe(-1)
   })

   it("returns -1 for ★ Saved (newest-first), never a resume", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([1]))
      nav.select(-1, -1)
      nav.filter.set([nav.SAVED_TOKEN])
      expect(await nav.listAnchor()).toBe(-1)
   })

   it("anchors a single feed at its OLDEST unread article (start of the backlog), not the seen resume", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      seedSeen({ "feed:1": 1 }) // read through chron 1 → unread is 2,3,4
      nav.select(-1, -1)
      nav.filter.set(["1"])
      expect(await nav.listAnchor()).toBe(2) // OLDEST unread (2), not the newest unread (4) nor resume (1)
   })

   it("anchors a never-opened feed at its OLDEST article (nothing seen → all unread)", async () => {
      // feed 9 spans chron 1..2; with no seen record every article is unread, so
      // the list opens at the OLDEST of them — the start of the unread backlog.
      setupIndex([{ feedId: 1 }, { feedId: 9 }, { feedId: 9 }])
      nav.select(-1, -1)
      nav.filter.set(["9"])
      expect(await nav.listAnchor()).toBe(1) // oldest feed-9 article
   })

   it("falls back to newest-first (-1) for a feed with nothing unread (caught up = latest available)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      seedSeen({ "feed:1": 2 }) // read through the newest → no unread left
      nav.select(-1, -1)
      nav.filter.set(["1"])
      expect(await nav.listAnchor()).toBe(-1) // latest available, nothing to catch up on
   })

   it("anchors a tag at its OLDEST UNREAD article, skipping older READ articles", async () => {
      // Tag T spans feeds 1 and 2. feed 1 (chron 0,1) is fully read; feed 2 (chron
      // 2,3) is unseen. The oldest UNREAD is chron 2 — not the oldest overall
      // (chron 0, read) nor the newest unread (chron 3).
      data.db.feeds = { "1": makeFeed({ id: 1, tag: "T" }), "2": makeFeed({ id: 2, tag: "T" }) }
      for (const [k, s] of Object.entries(data.db.feeds)) s.id = Number(k)
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      seedSeen({ "feed:1": 1 }) // feed 1 read through its newest (chron 1); feed 2 unseen
      nav.select(-1, -1)
      nav.filter.set(["T"])
      expect(await nav.listAnchor()).toBe(2) // oldest unread (feed 2 @ chron 2), not chron 0 or 3
   })

   it("anchors at the oldest unread even when unseen-only already raised the bound", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      seedSeen({ "feed:1": 1 }) // seen through chron 1 → unread is 2,3
      nav.setUnreadOnly(true)
      try {
         nav.select(-1, -1)
         nav.filter.set(["1"]) // bound raised to max(0, seen+1)=2
         expect(await nav.listAnchor()).toBe(2) // oldest unread (2), not 3
      } finally {
         nav.setUnreadOnly(false)
      }
   })
})

describe("fromHash — foreign + malformed hashes", () => {
   it("clamps a foreign non-numeric hash (no !, e.g. an OAuth fragment) to the last article", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      const r = await nav.fromHash("access_token=abc.def&state=xyz")
      expect(r.article.f).toBe(2) // Number(...) = NaN → clamp to last
   })

   it("passes a malformed %-escape token through verbatim instead of crashing", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      // lone "%" makes decodeURIComponent throw; the raw token resolves to no
      // feed → [ALL], and navigation still succeeds at the given position.
      const r = await nav.fromHash("0!%")
      expect(r.article.f).toBe(1)
      expect(nav.filter.tokens).toEqual([]) // "%" matched nothing → cleared to [ALL]
   })
})

describe("cycleOriginKey / cycleFilter edges", () => {
   it("resolves a tagged single-feed filter to its tag (so the cycle finds it)", () => {
      setupIndex([{ feedId: 5 }])
      data.db.feeds[5].tag = "news"
      nav.filter.set(["5"])
      expect(nav.cycleOriginKey()).toBe("news")
   })

   it("returns the id for an untagged single-feed filter", () => {
      setupIndex([{ feedId: 5 }])
      nav.filter.set(["5"])
      expect(nav.cycleOriginKey()).toBe("5")
   })

   it("cycles [ALL] → ★ Saved when something is saved (saved joins the rotation)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([0]))
      nav.filter.clear() // [ALL]
      data.groupFeedsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [] })
      await nav.cycleFilter(1) // entries = ["", "~saved"] → forward from "" lands on saved
      expect(nav.filter.saved).toBe(true)
   })

   it("a degenerate single-entry rotation ([ALL] only) stays on [ALL]", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      nav.filter.clear()
      data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
      await nav.cycleFilter(1) // entries = [""] → wraps to itself
      expect(nav.getCurrentFilterKey()).toBe("")
      data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
   })
})

describe("readSavedSet — corrupt localStorage", () => {
   it("filters non-integers and tolerates a non-array / invalid JSON without throwing", () => {
      localStorage.setItem("srr-saved", JSON.stringify([1, "x", 2.5, null, 3]))
      expect(nav.isSaved(1)).toBe(true)
      expect(nav.isSaved(3)).toBe(true)
      expect(nav.isSaved(2)).toBe(false) // 2.5 is not an integer
      expect(nav.savedCount()).toBe(2)
      localStorage.setItem("srr-saved", "{}") // non-array
      expect(nav.savedCount()).toBe(0)
      localStorage.setItem("srr-saved", "not json")
      expect(nav.savedCount()).toBe(0)
   })
})

describe("pruneSeen — keep live feeds (incl. id 0), drop deleted", () => {
   it("keeps a feed:0 key when feed 0 exists and drops a deleted feed's key", () => {
      setupIndex([{ feedId: 0 }, { feedId: 0 }]) // feed id 0 is valid
      seedSeen({ "feed:0": 1, "feed:9": 0, "tag:old": 3 })
      nav.pruneSeen()
      const seen = JSON.parse(localStorage.getItem(SEEN)!)
      expect(seen).toEqual({ "feed:0": 1 }) // feed:9 (deleted) and the legacy tag: key gone
   })

   it("does not throw on a corrupt seen blob", () => {
      localStorage.setItem(SEEN, "not json")
      expect(() => nav.pruneSeen()).not.toThrow()
   })
})

describe("saved navigation survives a deleted feed (tombstone)", () => {
   it("walks and counts a saved chron whose feed was removed from db.gz", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      localStorage.setItem("srr-saved", JSON.stringify([0, 1, 2]))
      delete data.db.feeds[2] // feed 2 deleted; its saved article (chron 1) stays in packs
      nav.filter.set([nav.SAVED_TOKEN])
      const shown = await nav.fromHash("1!~saved") // open the tombstoned saved article
      expect(nav.currentChron()).toBe(1)
      expect(shown.has_left).toBe(true) // chron 0 still to the left
      expect(shown.has_right).toBe(true) // chron 2 still to the right
   })
})

describe("unseen-only — fully-caught-up filter yields no match", () => {
   it("last() returns the placeholder when every article is already seen", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      seedSeen({ "feed:1": 2 }) // seen through the newest → nothing unread
      nav.setUnreadOnly(true)
      try {
         nav.filter.set(["1"]) // bound raised to 3 (== total_art) → no match
         const shown = await nav.last()
         expect(shown.placeholder).toBe(true)
         expect(shown.has_left).toBe(false)
         expect(shown.has_right).toBe(false)
      } finally {
         nav.setUnreadOnly(false)
      }
   })
})

// ── Bug #3 (recast): ensureSearchSet supersession guard ─────────────────────
// With loadHits, the guard is: capture term at call entry; after awaiting,
// discard if activeQuery() changed. A late B→A where B's load unblocks after A
// re-entered must not overwrite A's freshly-committed snapshot with B's stale one.
describe("ensureSearchSet supersession guard (#3)", () => {
   beforeEach(() => {
      searchMod.loadHits.mockReset()
      searchMod.available.mockReturnValue(true)
      searchMod.shortQuery.mockReturnValue(false)
   })

   it("a superseded load's result does NOT overwrite the active query's snapshot", async () => {
      // Scenario: A loads fine; B's load is in flight when A returns.
      // B's promise resolves late — after A has re-entered. The guard must discard B's result.
      setupIndex(Array.from({ length: 10 }, () => ({ feedId: 1 })))

      let releaseB!: () => void
      const bBlocked = new Promise<void>((r) => (releaseB = r))

      searchMod.loadHits.mockImplementation(async (query: string) => {
         if (query === "sup3a") return { chrons: [7], truncated: false }
         await bBlocked // "sup3b" blocks
         return { chrons: [5], truncated: false }
      })

      // 1. A loads and commits.
      nav.applyFilter([nav.SEARCH_PREFIX + "sup3a"])
      expect(await nav.feedLeft(9)).toBe(7)

      // 2. B supersedes A: resets snapshot, kicks off blocked load.
      nav.applyFilter([nav.SEARCH_PREFIX + "sup3b"])
      const bInflight = nav.feedLeft(9) // triggers ensureSearchSet for "sup3b"

      // 3. A returns before B resolves: clears snapshot, loads fresh.
      nav.applyFilter([nav.SEARCH_PREFIX + "sup3a"])
      expect(await nav.feedLeft(9)).toBe(7) // A's fresh result

      // 4. B's blocked load finally resolves — its guard sees activeQuery()="sup3a" ≠ "sup3b" → discards.
      releaseB()
      await bInflight.catch(() => {})

      // A's snapshot must still be intact.
      expect(nav.filter.matches(1, 7)).toBe(true)
      expect(nav.filter.matches(1, 5)).toBe(false) // B's chron was discarded
   })
})

// ── Bug #6: unread badge off-by-one on list cursor move ─────────────────────
describe("feedUnread onCurrent guard: select vs recordSeen (#6)", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("select() alone does NOT inflate the badge (+1 only after recordSeen)", async () => {
      // Setup: feed 1 has 3 articles (chron 0,1,2); feed 1 seen through chron 0.
      // Unread are chron 1 and 2 → raw unread count = 2.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      // Seed seen: ch1 seen at chron 0. Unread = 2 (chron 1, 2).
      seedSeen({ "feed:1": 0 })
      // Apply filter with unseen-only raised bounds.
      nav.filter.set(["1"])

      // Move the list cursor to chron 1 (unread article) via select() — no recordSeen.
      nav.select(1, 1)

      // The badge must read 2 (the true unread), NOT 3 (which would be the double-count).
      const counts = await nav.unreadCounts([data.db.feeds[1]])
      expect(counts.get(1)).toBe(2)
   })

   it("recordSeen (reader open) still produces the +1 correction", async () => {
      // Same setup, but use fromHash (resolve path) which calls recordSeen.
      // After recordSeen: seen["feed:1"] = 1 (== pos), so the base count dropped
      // chron 1 from unread, and +1 puts it back → still 2 total.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      seedSeen({ "feed:1": 0 })
      nav.filter.set(["1"])

      // Open chron 1 via the reader (goes through resolve → recordSeen sets seen=1).
      await nav.fromHash("1!1")

      // Badge must still be 2: base count excludes chron 1 (now seen), +1 adds it back.
      const counts = await nav.unreadCounts([data.db.feeds[1]])
      expect(counts.get(1)).toBe(2)
   })
})

// ── Bug #9: stale pos in hash on resolveNoMatch ───────────────────────────────
describe("resolveNoMatch writes positionless hash (#9)", () => {
   it("resolveNoMatch emits a positionless hash so reload shows the list, not the reader", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      // Navigate to chron 1 so pos = 1.
      await nav.fromHash("1")

      // Now trigger resolveNoMatch by setting up a filter with no matching articles,
      // then calling last(). last() calls feedLeft → -1 → resolveNoMatch.
      data.db.feeds[99] = makeFeed({ id: 99, total_art: 1 })
      nav.filter.set(["99"])
      // feedLeft will return -1 since no chron has feedId 99.
      await nav.last()

      // resolveNoMatch calls pushState (replace=false from last()'s default).
      // The hash must be POSITIONLESS: "#!99" — no numeric pos part.
      // A "#-1!99" hash would route to the reader (posStr "-1" matches /^-?\d+$/)
      // and open the last article. "#!99" routes to the list at the filter.
      const pushCalls = (history.pushState as ReturnType<typeof vi.spyOn>).mock.calls
      const lastPush = pushCalls[pushCalls.length - 1][2] as string
      // Must be exactly the positionless form.
      expect(lastPush).toBe("#!99")
      // Double-check: the posStr (before "!") must NOT match the reader-routing regex.
      const posStr = lastPush.split("!")[0].slice(1) // "" for "#!99"
      expect(/^-?\d+$/.test(posStr)).toBe(false)
   })
})
