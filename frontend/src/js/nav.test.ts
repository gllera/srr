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
   // Route every feed through the `rare` fallback so unreadCounts keeps
   // exercising the per-feed feedUnread oracle these tests drive via the
   // getFeedId/countLeft mocks (the single-pass tally is pinned against that
   // same oracle by idx.test.ts's differential suite).
   unreadTally: vi.fn(<T extends { id: number }>(chs: T[]) => ({ counts: new Map<number, number>(), rare: chs })),
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

// right_count — the reader's pending readout. Feed/tag/[ALL]: the filter's
// live unread with each member's frontier floored at the cursor — what is
// UNREAD AND AHEAD. Equal to the picker badges on every recorded landing
// (recordSeen already raised the members to pos) and ticking down by exactly
// 1 per forward step; an unrecorded landing reads one below the badge (the
// badge counts the not-yet-consumed article on screen, the pill counts what
// → still has). Saved/search count their explicit sets strictly after pos
// (queue/hit countdowns — peek modes have no badge to agree with). The last
// article reads 0, recorded or not.
describe("right_count", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("ticks down by exactly 1 per forward step, meeting the badge at every recorded landing", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }])
      // A restored hash records nothing: 2 articles sit ahead of the entry
      // (the picker's ×3 also counts the not-yet-consumed one on screen).
      expect((await nav.fromHash("0")).right_count).toBe(2)
      // Each recorded step marks on ENTER and ticks the pill by exactly 1 —
      // the floor at the cursor absorbs the entry article's own consumption
      // (an unfloored badge pill dropped 2 on the first step: 3 → 1).
      expect((await nav.right()).right_count).toBe(1)
      expect((await nav.right()).right_count).toBe(0)
   })

   it("holds at the badge count while re-reading already-seen articles (never above it)", async () => {
      // The positional pill this replaces counted READ articles ahead of pos,
      // so it sat visibly above the picker's [ALL] badge whenever any feed was
      // read ahead of the walk — the recurring badge↔pill mismatch. Floored
      // frontiers exclude them: re-reading a caught-up store reads an honest,
      // steady 0 (Next stays armed off has_right), never a phantom backlog.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 3, "feed:2": 3 }))
      const opened = await nav.fromHash("0")
      expect(opened.has_right).toBe(true) // read articles ahead — steps still work
      expect(opened.right_count).toBe(0) // …but nothing is unread, matching the badge
      expect((await nav.right()).right_count).toBe(0)
      expect((await nav.right()).right_count).toBe(0)
   })

   it("excludes read-ahead articles in show-read mode — never above the [ALL] badge", async () => {
      // The originally-reported mismatch: read one lane to its end, then land
      // on [ALL]'s oldest unread — the read lane's articles sit AHEAD of pos.
      // They are still →-steps (has_right) but not unread: the old positional
      // pill said 3 here. The badge says ×1 — the on-screen article, not yet
      // consumed by this unrecorded landing — and the pill 0: nothing unread
      // is ahead.
      setupIndex([{ feedId: 2 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 3 })) // feed 1 read to its end
      const opened = await nav.fromHash("0") // [ALL], on feed 2's still-unread article
      expect(opened.has_right).toBe(true)
      expect(opened.right_count).toBe(0)
      const members = Object.values(data.db.feeds)
      expect(nav.tagUnreadFromCounts(members, await nav.unreadCounts(members))).toBe(1)
      // Reading it (a recorded landing) consumes it: pill and badge agree at 0.
      expect((await nav.goTo(0)).right_count).toBe(0)
      expect(nav.tagUnreadFromCounts(members, await nav.unreadCounts(members))).toBe(0)
   })

   it("counts only the filtered feed's unread in filtered mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      // Restored landing (nothing recorded): feed 1's {2,4} ahead of the entry.
      expect((await nav.fromHash("0!1")).right_count).toBe(2)
      expect((await nav.right()).right_count).toBe(1) // on chron 2 (recorded): {4} left
      expect((await nav.right()).right_count).toBe(0) // on chron 4: caught up
   })

   it("first → from [ALL]'s unrecorded resume ticks by exactly 1 (the −2 double-drop bug)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 3 }]) // nothing seen anywhere
      nav.setUnreadOnly(true)
      // [ALL] opens at the oldest unseen and records nothing (a switch must
      // not consume unread): the pill reads what → still has — 2 — one below
      // the ×3 badge, whose extra article is the one on screen.
      const r = await nav.switchFilter("")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      expect(r.right_count).toBe(2)
      // The first step marks the entry AND the landing on ENTER. An unfloored
      // badge pill dropped 2 at once here (3 → 1); floored at the cursor it
      // ticks −1 per step from the very first one.
      expect((await nav.right()).right_count).toBe(1)
      expect((await nav.right()).right_count).toBe(0)
   })

   it("re-counts after markUnreadFrom — the unread ahead, ticking by 1 from there", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      await nav.goTo(1) // recorded: read up to chron 1
      expect((await nav.probeCurrent())!.right_count).toBe(2) // {2,3}
      nav.markUnreadFrom(1) // rewind: {1,2,3} unread — the on-screen 1 included
      // The badge counts all three; the pill counts the two AHEAD of the
      // cursor (→ cannot reach the rewound on-screen article).
      const members = Object.values(data.db.feeds)
      expect(nav.tagUnreadFromCounts(members, await nav.unreadCounts(members))).toBe(3)
      expect((await nav.probeCurrent())!.right_count).toBe(2)
      expect((await nav.right()).right_count).toBe(1) // −1: on 2 (recorded), {3} left
   })

   it("counts what's ahead in unseen-only mode — the raised bounds keep seen articles out", async () => {
      // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1; seen ch1→2, ch2→1; unseen are 3,4.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      for (const id of [1, 2]) data.db.feeds[id].tag = "news"
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:2": 1, "feed:1": 2 }))
      nav.setUnreadOnly(true)
      const group = [data.db.feeds[1], data.db.feeds[2]]

      // Resumes at the seen position (chron 1, already read); both unseen sit ahead.
      const opened = await nav.switchFilter("news")
      expect(opened.right_count).toBe(2)

      // Stepping onto an unread article marks it read on ENTER, so its badge
      // drops the instant you open it — no pad holds it as still-unread. chron 3
      // (ch2) becomes read, leaving only ch1's {4}: the tag reads 1 (matching the
      // pill's "1 ahead" plus the now-read one on screen counting for nothing).
      const onFirst = await nav.right() // chron 3
      expect(onFirst.right_count).toBe(1)
      expect(nav.tagUnreadFromCounts(group, await nav.unreadCounts(group))).toBe(1)

      // The LAST unread: reading it marks it too, nothing is unread anywhere, so
      // both the pill and the badge read 0.
      const onLast = await nav.right() // chron 4
      expect(onLast.has_right).toBe(false)
      expect(onLast.right_count).toBe(0)
      expect(nav.tagUnreadFromCounts(group, await nav.unreadCounts(group))).toBe(0)
   })

   it("counts the saved set to the right in ★ Saved mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      localStorage.setItem("srr-saved", JSON.stringify([0, 2, 3]))
      // Saved opens at the OLDEST saved article — the rest of the queue is ahead.
      expect((await nav.switchFilter(nav.SAVED_TOKEN)).right_count).toBe(2)
      expect((await nav.right()).right_count).toBe(1) // on chron 2 → {3} remains
      expect((await nav.right()).right_count).toBe(0) // on chron 3 → nothing ahead
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

   it("reads 0 on the last article — nothing is ahead, recorded or not", async () => {
      setupIndex([{ feedId: 1 }])
      // Never recorded (a fresh device restoring a hash): the on-screen
      // article is still unread — the picker says ×1 — but nothing is AHEAD,
      // so the pill's 0 agrees with the disabled →.
      const fresh = await nav.fromHash("0")
      expect(fresh.has_right).toBe(false)
      expect(fresh.right_count).toBe(0)
      const members = Object.values(data.db.feeds)
      expect(nav.tagUnreadFromCounts(members, await nav.unreadCounts(members))).toBe(1)
      // Reading it (a recorded landing) consumes it: the badge drops to 0 too.
      const read = await nav.goTo(0)
      expect(read.right_count).toBe(0)
      expect(nav.tagUnreadFromCounts(members, await nav.unreadCounts(members))).toBe(0)
   })
})

// Badge↔pill differential oracle — the regression net for the whole class of
// counting bugs behind the 2026-07 reports (pill above the [ALL] badge from
// read-ahead articles; the −2 double-drop on the first step from an
// unrecorded resume; the entry off-by-one). Instead of more hand-picked
// scenarios, every action of scripted walks across modes × filters ×
// seen-states is checked against BRUTE-FORCE reference counts — the dumbest
// possible loops over the entries + seen map, independent of every production
// counting path (tallyWith / unreadTally / countAll / countLeft):
//   badge(members)     = # entries of a member feed with chron > its frontier
//   pill(members, pos) = # of those also with chron > pos  (pos −1 = badge)
// plus the per-step tick law: a →-step moves the pill by EXACTLY the landing
// article's own unread status — 1 when it was unread, 0 when re-reading — and
// both numbers are mode-independent for the same (seen, pos). Any future edit
// to pendingRight, recordSeen, unreadCounts, or the frontier gestures that
// re-breaks any of the reported behaviors fails here, whatever the scenario.
describe("badge↔pill differential oracle", () => {
   afterEach(() => nav.setUnreadOnly(false))

   // Three interleaved feeds, feeds 1+2 tagged "duo" — every filter shape
   // ([ALL] / tag / single feed) has members with articles between the others'.
   const ENTRIES = [1, 2, 1, 3, 2, 1, 3, 1, 2, 1].map((feedId) => ({ feedId }))

   // Seen-state seeds: a fresh device; one lane read to its end (the
   // read-ahead shape of the original mismatch report); a mixed mid-history.
   const SEEDS: Record<string, Record<string, number>> = {
      "fresh device": {},
      "read-ahead lane": { "feed:1": 9 },
      "mixed mid-history": { "feed:1": 2, "feed:2": 4 },
   }

   const seenOf = (feedId: number): number => {
      const seen = JSON.parse(localStorage.getItem("srr-seen") ?? "{}") as Record<string, number>
      return seen["feed:" + feedId] ?? -1
   }
   const refBadge = (members: number[]): number =>
      ENTRIES.filter((e, chron) => members.includes(e.feedId) && chron > seenOf(e.feedId)).length
   const refPill = (members: number[], pos: number): number =>
      ENTRIES.filter((e, chron) => members.includes(e.feedId) && chron > seenOf(e.feedId) && chron > pos).length

   // Assert both published numbers against the oracles for the CURRENT state.
   async function checkInvariants(shown: IShowFeed | null) {
      const members = [...nav.filter.feeds.keys()]
      const feeds = members.map((id) => data.db.feeds[id])
      expect(nav.tagUnreadFromCounts(feeds, await nav.unreadCounts(feeds))).toBe(refBadge(members))
      if (shown) expect(shown.right_count).toBe(refPill(members, nav.currentChron()))
   }

   // One recorded →-step with the tick law asserted: the pill moves by
   // exactly the landing article's own PRE-arrival unread status — 1 when it
   // was unread (consumed on ENTER), 0 when re-reading a seen one. The −2
   // double-drop and a frozen nonzero countdown both violate this law before
   // the oracle even looks. Returns null at the walk's end.
   async function stepChecked(prev: IShowFeed): Promise<IShowFeed | null> {
      const seenBefore = JSON.parse(localStorage.getItem("srr-seen") ?? "{}") as Record<string, number>
      let shown: IShowFeed
      try {
         shown = await nav.right()
      } catch {
         return null
      }
      const wasUnread = nav.currentChron() > (seenBefore["feed:" + shown.article.f] ?? -1)
      expect(prev.right_count - shown.right_count).toBe(wasUnread ? 1 : 0)
      await checkInvariants(shown)
      return shown
   }

   for (const unseenOnly of [false, true]) {
      for (const [seedName, seed] of Object.entries(SEEDS)) {
         it(`holds through a full walk — ${unseenOnly ? "unseen-only" : "show-read"}, ${seedName}`, async () => {
            setupIndex(ENTRIES)
            data.db.feeds[1].tag = "duo"
            data.db.feeds[2].tag = "duo"
            localStorage.setItem("srr-seen", JSON.stringify(seed))
            nav.setUnreadOnly(unseenOnly)

            // [ALL]: unrecorded resume, then read forward to the end.
            let shown: IShowFeed | null = await nav.switchFilter("")
            await checkInvariants(shown)
            while (shown) shown = await stepChecked(shown)

            // Step back and re-read — the pill must hold at the oracle count,
            // not tick through read articles (the phantom-backlog shape).
            try {
               shown = await nav.left()
               await checkInvariants(shown)
               if (shown) shown = await stepChecked(shown)
            } catch {
               // A single-article walk has no left neighbor; the oracle pass
               // above already covered the state.
            }

            // Tag lane: resume, rewind at the cursor (the u-key gesture, with
            // app.ts's unseen-only re-apply), read one forward.
            shown = await nav.switchFilter("duo")
            await checkInvariants(shown)
            if (!shown.placeholder && nav.markUnreadFrom(nav.currentChron())) {
               if (unseenOnly) nav.applyFilter([...nav.filter.tokens])
               await checkInvariants(await nav.probeCurrent())
               const cur = await nav.probeCurrent()
               if (cur) await stepChecked(cur)
            }

            // Single-feed lane, then catch up wholesale and verify the zeros.
            shown = await nav.switchFilter("3")
            await checkInvariants(shown)
            if (nav.markAllRead()) {
               if (unseenOnly) nav.applyFilter([...nav.filter.tokens])
               await checkInvariants(await nav.probeCurrent())
            }
         })
      }
   }

   it("pill and badge are mode-independent for the same (seen, pos)", async () => {
      setupIndex(ENTRIES)
      data.db.feeds[1].tag = "duo"
      data.db.feeds[2].tag = "duo"
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2, "feed:2": 4 }))
      const before = await nav.goTo(5) // recorded landing, mid-history
      // Flipping the view mode re-applies the filter bounds but must not move
      // either published number — they derive from (seen, pos, members) only.
      nav.setUnreadOnly(true)
      const after = await nav.probeCurrent()
      expect(after!.right_count).toBe(before.right_count)
      const members = [...nav.filter.feeds.keys()].map((id) => data.db.feeds[id])
      expect(nav.tagUnreadFromCounts(members, await nav.unreadCounts(members))).toBe(before.right_count)
   })
})

// The unseen-only entry anchor (filter.anchor): opening a filter can land on a
// SEEN article — switchFilter's resume position, a restored/shared #pos — that
// the raised (seen+1) bounds exclude. feedLeft/feedRight keep that entry in the
// navigable sequence so ← can return to the first article shown after → steps
// into the unseen; the anchor resets when the filter changes.
describe("unseen-only entry anchor", () => {
   afterEach(() => nav.setUnreadOnly(false))

   // chron 0=ch1 1=ch2 2=ch1 3=ch2 4=ch1, both feeds tagged "news".
   function setupNews() {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      for (const id of [1, 2]) data.db.feeds[id].tag = "news"
   }

   it("← returns to the resume article after → steps into the unseen", async () => {
      setupNews()
      // seen ch1→2, ch2→1 ⇒ the tag resumes at min = chron 1; unseen are 3, 4.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2, "feed:2": 1 }))
      nav.setUnreadOnly(true)

      const opened = await nav.switchFilter("news")
      expect(nav.currentChron()).toBe(1) // the first article shown — a seen resume position
      expect(opened.has_left).toBe(false) // nothing before the entry
      expect(opened.has_right).toBe(true)

      const ahead = await nav.right()
      expect(nav.currentChron()).toBe(3) // first unseen
      expect(ahead.has_left).toBe(true) // the entry stays reachable…

      await nav.left() // …and ← lands back on it
      expect(nav.currentChron()).toBe(1)
   })

   it("keeps a restored #pos deep link reachable the same way", async () => {
      setupNews()
      // seen ch1→2, ch2→3 ⇒ the only unseen is chron 4.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2, "feed:2": 3 }))
      nav.setUnreadOnly(true)

      await nav.fromHash("0!news") // a read article, honored as the entry anchor
      expect(nav.currentChron()).toBe(0)
      await nav.right()
      expect(nav.currentChron()).toBe(4)
      await nav.left()
      expect(nav.currentChron()).toBe(0)
   })

   it("→ can return to an anchor sitting past the unseen backlog", async () => {
      setupNews()
      // seen ch1→4, ch2→1 ⇒ the only unseen is chron 3, OLDER than the entry.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 4, "feed:2": 1 }))
      nav.setUnreadOnly(true)

      const opened = await nav.fromHash("4!news") // a read article newer than every unseen
      expect(opened.has_right).toBe(false) // nothing after the entry
      expect(opened.has_left).toBe(true)
      await nav.left()
      expect(nav.currentChron()).toBe(3)
      await nav.right() // the walk slots the anchor back in from the left too
      expect(nav.currentChron()).toBe(4)
   })

   it("resets when the filter changes", async () => {
      setupNews()
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2, "feed:2": 1 }))
      nav.setUnreadOnly(true)

      await nav.switchFilter("news")
      expect(nav.filter.anchor).toBe(1)
      await nav.switchFilter("") // [ALL] lands on the oldest unseen — a matching article
      expect(nav.filter.anchor).toBe(-1)
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

   it("selecting [ALL] marks nothing seen — a switch is a resume, not a read", async () => {
      // Switching to [ALL] lands on the oldest unseen (chron 2) but must NOT
      // advance any frontier: merely opening a filter cannot consume an unread.
      // The stored feed:1 frontier is untouched and feed:2 stays absent, so both
      // chron 2 and 3 remain unread until the reader steps forward into them.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      await nav.switchFilter("")
      expect(data.loadArticle).toHaveBeenLastCalledWith(2) // still resumes at the oldest unseen
      const seen = JSON.parse(localStorage.getItem("srr-seen")!)
      expect(seen).toEqual({ "feed:1": 1 }) // unchanged — no new frontier written
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
      await nav.goTo(2) // read chronIdx 2 (sub 1) → seen sub:1=2
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
      // Seeded directly: navigation can no longer produce a lower frontier for
      // ch6 after ch5 was read further (the seen frontier is raise-only now);
      // a synced-in or historical state still can, and the tag must resume at
      // its least-recently-read member either way.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:5": 4, "feed:6": 1 }))
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
      await nav.goTo(1) // read chronIdx 1
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:5"]).toBe(1)
      // No tag key is ever written — the tag's position is read back from its
      // member feeds (here a single feed at chron 1).
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })

   it("never records a tag key", async () => {
      setupIndex([{ feedId: 1 }])
      await nav.goTo(0)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:1"]).toBe(0)
      expect(Object.keys(seen).filter((k) => k.startsWith("tag:"))).toHaveLength(0)
   })

   it("switchFilter falls back to [ALL] on an unknown token", async () => {
      // "nosuchtag" is neither a numeric feed id nor a tag any feed carries, so
      // filter.set clears to [ALL] and isKnownToken is false → last() over [ALL].
      setupIndex([{ feedId: 1 }, { feedId: 2 }]) // newest article is chron 1 (feed 2)
      const result = await nav.switchFilter("nosuchtag")
      expect(nav.filter.active).toBe(false) // cleared to [ALL], not scoped to a placeholder
      expect(data.loadArticle).toHaveBeenLastCalledWith(1) // opens the newest article
      expect(result.article.f).toBe(2)
   })
})

// Switching a filter (a picker click, or the W/S / ↑↓ / two-finger cycle — all
// route through switchFilter) resumes at the tag/feed's last-seen position but
// must NEVER advance the seen frontier: opening a lane cannot decrement its
// unread count. Only reading forward (step/right) records. For a previously-read
// feed the resume landing is already seen (a no-op raise); for a never-seen
// feed/tag it lands on the oldest article WITHOUT marking it, so the badge keeps
// its full count until the reader actually steps into the backlog.
describe("switchFilter never advances the seen frontier (a resume, not a read)", () => {
   it("opening a never-seen feed marks nothing seen", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0) // oldest match, still shown
      expect(result.article.f).toBe(1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({}) // the landing article stays unread
   })

   it("opening a never-seen tag marks no member seen", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      data.db.feeds[6] = makeFeed({ id: 6, tag: "news" })
      setupIndex([{ feedId: 5 }, { feedId: 6 }, { feedId: 5 }])
      await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(0)
      // Previously the chron-0 landing raised BOTH members' frontiers to 0 (ch5's
      // oldest was consumed); now neither member is touched.
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({})
   })

   it("resuming a previously-read feed leaves its frontier untouched", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      const result = await nav.switchFilter("1")
      expect(data.loadArticle).toHaveBeenLastCalledWith(1) // resumes at the high-water
      expect(result.article.f).toBe(1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({ "feed:1": 1 })
   })

   it("cycling to another lane (cycleFilter) also records nothing", async () => {
      nav.setUnreadOnly(false) // show-read: cyclableLanes keeps every lane
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[1], data.db.feeds[2]],
      })
      await nav.switchFilter("1") // origin lane, feed 1 (records nothing)
      await nav.cycleFilter(1) // → feed 2 lane (never seen)
      expect(nav.getCurrentFilterKey()).toBe("2")
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen).toEqual({})
   })

   it("but reading forward after the switch still records — recordSeen is not disabled", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      await nav.switchFilter("1") // lands chron 0, nothing recorded
      expect(JSON.parse(localStorage.getItem("srr-seen") || "{}")).toEqual({})
      await nav.right() // step to chron 1 — a real read
      expect(JSON.parse(localStorage.getItem("srr-seen") || "{}")).toEqual({ "feed:1": 1 })
   })
})

// The boot re-anchor after a sync pull raised the seen map is app.ts's job
// (applyFilter + list.render — see app.test.ts "profile re-anchor"); nav's own
// contribution is that applyFilter re-snapshots the unseen bounds from LIVE
// seen, which the applyFilter suite below and the unseen-only suites pin.
describe("applyFilter re-derives bounds from live seen (the sync re-anchor seam)", () => {
   it("a re-apply after seen rose elsewhere raises the member bounds", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 2 }, { feedId: 2 }])
      nav.setUnreadOnly(true)
      try {
         nav.applyFilter([])
         // Everything unread: the oldest match under the raised bounds is chron 0.
         expect(await nav.feedRight(0)).toBe(0)
         // A sync pull raised feed:1 past its whole backlog (read on another device).
         localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
         nav.applyFilter([])
         // Re-applying re-reads live seen: feed:1's rows are out of the walk now.
         expect(await nav.feedRight(0)).toBe(2)
      } finally {
         nav.setUnreadOnly(false)
      }
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

   it("pruneSeen drops orphaned srr-seen-ts keys", () => {
      data.db.feeds = { 1: makeFeed({ id: 1 }) }
      // feed:1 lives; feed:9 is a deleted feed (pruned from srr-seen below);
      // feed:99 never had a srr-seen entry at all. Both are orphans in srr-seen-ts.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 5, "feed:9": 3 }))
      localStorage.setItem("srr-seen-ts", JSON.stringify({ "feed:1": 111, "feed:9": 222, "feed:99": 333 }))
      nav.pruneSeen()
      // feed:9's seen entry was pruned (deleted feed) and feed:99 never had one, so
      // both st stamps are now orphaned and dropped; the live feed:1 stamp survives.
      const st = JSON.parse(localStorage.getItem("srr-seen-ts") || "{}")
      expect(st).toEqual({ "feed:1": 111 })
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
      await nav.goTo(3) // read chron 3 (ch1)
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

   it("never lowers ANY frontier when scrubbing back to an older article — the own feed included", async () => {
      // chron 0=ch1 1=ch2 2=ch1 3=ch2.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      await nav.goTo(3) // read chron 3 (ch2): all caught up to 3
      await nav.goTo(0) // scrub back to chron 0 (ch1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // Re-reading an older article is not un-reading the newer ones: the seen
      // frontier is raise-only everywhere — only the explicit markUnreadFrom
      // rewinds it.
      expect(seen["feed:1"]).toBe(3)
      expect(seen["feed:2"]).toBe(3)
   })

   it("stamps a per-key ordering timestamp (srr-seen-ts) beside every frontier raise", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }])
      await nav.goTo(1)
      const st = JSON.parse(localStorage.getItem("srr-seen-ts") || "{}")
      expect(st["feed:1"]).toBeGreaterThan(0)
      expect(st["feed:2"]).toBeGreaterThan(0)
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

   it("saved mode never records seen — it's a peek like search", async () => {
      // chron 0=ch1 1=ch2 2=ch1; saved set spans both feeds.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([0, 1, 2]))
      await nav.switchFilter(nav.SAVED_TOKEN) // opens at the oldest saved (chron 0, ch1)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // recordSeen now exempts saved mode entirely, the same carve-out as
      // search — opening a saved article never touches the seen frontier.
      expect(seen).toEqual({})
   })

   it("saved mode never records seen — opening an old saved article is a peek", async () => {
      // chron 0=ch1 1=ch1 2=ch1 (old/mid/new); the feed is already read up to
      // chron 2 and only the oldest article is saved.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      localStorage.setItem("srr-saved", JSON.stringify([0]))
      await nav.switchFilter(nav.SAVED_TOKEN) // opens the only saved article, chron 0
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // Own feed's resume position must NOT rewind to 0.
      expect(seen).toEqual({ "feed:1": 2 })
   })

   it("recordSeen is a no-op for an article whose feed was deleted", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }]) // filter.feeds snapshots both feeds
      delete data.db.feeds[2] // feed 2 gone from db.gz AFTER the [ALL] filter snapshot
      // goTo records (record:true) and feedRight still lands on chron 1 (feed 2 is
      // in the snapshotted filter.feeds), but recordSeen looks the feed up in
      // db.feeds — now missing — so it must hit `if (!ch) return`: no throw, no write.
      await expect(nav.goTo(1)).resolves.toBeDefined()
      expect(nav.currentChron()).toBe(1) // landed on the deleted-feed article
      expect(JSON.parse(localStorage.getItem("srr-seen") || "{}")).toEqual({}) // nothing written
   })
})

describe("markAllRead / markUnreadFrom — the explicit frontier gestures", () => {
   it("markAllRead raises every filter member to the newest chron, and only them", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      data.db.feeds[3] = makeFeed({ id: 3 }) // untagged — outside the filter
      // chron 0=ch1 1=ch3 2=ch2 3=ch1.
      setupIndex([{ feedId: 1 }, { feedId: 3 }, { feedId: 2 }, { feedId: 1 }])
      await nav.switchFilter("news") // never seen → opens at first(), frontier 0
      expect(nav.markAllRead()).toBe(true)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      expect(seen["feed:1"]).toBe(3) // the store's newest chron — the same
      expect(seen["feed:2"]).toBe(3) // foreign-chron high-water recordSeen writes
      expect(seen["feed:3"]).toBeUndefined() // outside the filter — untouched
      const st = JSON.parse(localStorage.getItem("srr-seen-ts") || "{}")
      expect(st["feed:1"]).toBeGreaterThan(0)
      // Idempotent: with everything already at the top there is nothing to raise.
      expect(nav.markAllRead()).toBe(false)
   })

   it("markAllRead is a no-op in peek modes (saved/search)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([0]))
      await nav.switchFilter(nav.SAVED_TOKEN)
      expect(nav.markAllRead()).toBe(false)
      expect(JSON.parse(localStorage.getItem("srr-seen") || "{}")).toEqual({})
   })

   it("markUnreadFrom lowers every member frontier at-or-past the position to chron−1, leaving lower ones alone", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch2.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 3, "feed:2": 1 }))
      await nav.fromHash("2!news") // reader at chron 2 (recordSeen raises ch2 1→2)
      expect(nav.markUnreadFrom(2)).toBe(true)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // Everything from chron 2 to the latest is unread again for the lane.
      expect(seen["feed:1"]).toBe(1)
      expect(seen["feed:2"]).toBe(1)
      expect(nav.isRowUnread(2, 1, seen)).toBe(true)
      expect(nav.isRowUnread(3, 2, seen)).toBe(true)
      expect(nav.isRowUnread(0, 1, seen)).toBe(false) // older read stays read
   })

   it("markUnreadFrom(0) stores −1 (never-seen equivalent) and keeps its ordering timestamp", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      await nav.goTo(1) // read chron 1 → raises feed:1 to 1
      expect(nav.markUnreadFrom(0)).toBe(true)
      const seen = JSON.parse(localStorage.getItem("srr-seen") || "{}")
      // −1 reads as never-seen everywhere, but the KEY survives so its st
      // timestamp can outrank older raises on other devices (sync's per-key LWW).
      expect(seen["feed:1"]).toBe(-1)
      expect(nav.isRowUnread(0, 1, seen)).toBe(true)
      const st = JSON.parse(localStorage.getItem("srr-seen-ts") || "{}")
      expect(st["feed:1"]).toBeGreaterThan(0)
   })

   it("markUnreadFrom is a no-op in peek modes and below zero", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      localStorage.setItem("srr-saved", JSON.stringify([0]))
      await nav.switchFilter(nav.SAVED_TOKEN)
      expect(nav.markUnreadFrom(0)).toBe(false)
      expect(nav.markUnreadFrom(-1)).toBe(false)
      expect(JSON.parse(localStorage.getItem("srr-seen") || "{}")).toEqual({ "feed:1": 1 })
   })

   it("markUnreadFrom is a no-op when every member is already below the floor", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }]) // [ALL], feeds {1,2}
      // floor = chron−1 = 2. Both members already sit at/below it (feed:1 at 1,
      // feed:2 at 2), so nothing is above the floor to lower → touched stays empty.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1, "feed:2": 2 }))
      expect(nav.markUnreadFrom(3)).toBe(false)
      expect(JSON.parse(localStorage.getItem("srr-seen") || "{}")).toEqual({ "feed:1": 1, "feed:2": 2 }) // unchanged
      expect(localStorage.getItem("srr-seen-ts")).toBeNull() // nothing stamped
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

// cycleToken is the shared W/S / ↑↓ / two-finger step. In unread-only mode it
// skips tag/feed lanes with nothing unread (mirroring the picker's fillUnread
// hiding); ★ Saved is ALWAYS skipped (reached deliberately via the picker); and
// [ALL] is always reachable. With read shown, only ★ Saved is skipped — every
// other lane is a valid step. (feedUnread is the plain live unread now, so a
// fully-read feed counts a clean 0 with no current-article pad.)
describe("cycleToken — lane skipping", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("skips a fully-read feed lane in unread-only mode", async () => {
      setupIndex([{ feedId: 3 }, { feedId: 4 }]) // chron0=f3 (read), chron1=f4 (unread)
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[3], data.db.feeds[4]],
      })
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:3": 0 }))
      nav.setUnreadOnly(true)
      nav.select(-1, -1)
      // entries = ["", "3", "4"], origin "" → forward hops over the read "3" to "4"
      expect(await nav.cycleToken(1)).toBe("4")
   })

   it("skips a fully-read tag group in unread-only mode", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 5 }]) // news = f1,f2 (read); f5 unread
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [data.db.feeds[1], data.db.feeds[2]]]]),
         sortedTags: ["news"],
         untagged: [data.db.feeds[5]],
      })
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0, "feed:2": 1 }))
      nav.setUnreadOnly(true)
      nav.select(-1, -1)
      // entries = ["", "news", "5"], origin "" → forward hops over the read "news" to "5"
      expect(await nav.cycleToken(1)).toBe("5")
   })

   it("always skips ★ Saved, in both modes", async () => {
      setupIndex([{ feedId: 3 }]) // f3 unread — so only ★ Saved's own skip is under test
      data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [data.db.feeds[3]] })
      localStorage.setItem("srr-saved", JSON.stringify([0]))
      nav.select(-1, -1)
      // entries = ["", "~saved", "3"], origin "" → forward hops over ★ Saved to the feed
      nav.setUnreadOnly(true)
      expect(await nav.cycleToken(1)).toBe("3")
      nav.setUnreadOnly(false)
      expect(await nav.cycleToken(1)).toBe("3")
   })

   it("does not skip read lanes when read is shown", async () => {
      setupIndex([{ feedId: 3 }, { feedId: 4 }]) // f3 read
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[3], data.db.feeds[4]],
      })
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:3": 0 }))
      nav.setUnreadOnly(false)
      nav.select(-1, -1)
      // read shown → the read "3" is a valid step, no skipping
      expect(await nav.cycleToken(1)).toBe("3")
   })

   it("stays on [ALL] when no other lane has unread", async () => {
      setupIndex([{ feedId: 3 }, { feedId: 4 }]) // both read
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[3], data.db.feeds[4]],
      })
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:3": 0, "feed:4": 1 }))
      nav.setUnreadOnly(true)
      nav.select(-1, -1)
      // every feed read → the walk wraps back to [ALL] (a no-op)
      expect(await nav.cycleToken(1)).toBe("")
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

   it("the dropdown tag badge drops as you read — the article is marked read on enter", async () => {
      await readSome() // ch1 seen→2, ch2 seen→1; unseen chron 3 (ch2), 4 (ch1) → 2
      nav.setUnreadOnly(true)
      const group = [data.db.feeds[1], data.db.feeds[2]]

      // On select you resume at the seen position (chron 1, already read): nothing
      // new is marked, so the badge reads the full 2 unseen.
      await nav.switchFilter("news")
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      let counts = await nav.unreadCounts(group)
      expect(counts.get(2)).toBe(1) // ch2 unseen {3}
      expect(counts.get(1)).toBe(1) // ch1 unseen {4}
      expect(nav.tagUnreadFromCounts(group, counts)).toBe(2)

      // Step onto the first unseen (chron 3, ch2). recordSeen bumps ch2's seen to
      // 3 the instant you arrive — reading is accounted on ENTER, so ch2's badge
      // drops to 0 right away (no pad holds it up). The tag now reads 1 (ch1's {4}).
      await nav.right()
      expect(data.loadArticle).toHaveBeenLastCalledWith(3)
      counts = await nav.unreadCounts(group)
      expect(counts.get(2)).toBe(0) // ch2: read on enter → {} unread
      expect(counts.get(1)).toBe(1) // ch1: its remaining unseen {4}
      expect(nav.tagUnreadFromCounts(group, counts)).toBe(1)
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
      await nav.goTo(1) // read chron 1 → feed:1 seen → 1 (chron 0,1 seen; chron 2 unseen)
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
      await nav.goTo(0) // read chron 0 → feed:1 seen → 0 (chron 0 seen); chron 1 (ch2) unseen
      nav.setUnreadOnly(true)
      nav.filter.clear() // [ALL]
      const shown = await nav.last() // unread → newest unseen (chron 1)
      expect(data.loadArticle).toHaveBeenLastCalledWith(1)
      expect(shown.article.f).toBe(2)
      expect(shown.has_left).toBe(false) // the seen chron 0 is excluded, nothing unseen left
   })

   it("walking right past the resume position keeps it reachable on the left", async () => {
      await readSome() // ch1→2, ch2→1; unseen are chron 3 (ch2), 4 (ch1) → 2 total
      nav.setUnreadOnly(true)
      // Open at the resume position (chron 1, seen): both unseen are to the right,
      // none to the left.
      const a = await nav.switchFilter("news") // chron 1 (resume, seen)
      expect(a.has_left).toBe(false)
      // Step onto the oldest unseen: the entry anchor (chron 1) now sits on the
      // left (filter.anchor keeps the entry navigable — see the entry-anchor
      // suite); past it, the first unseen does too.
      const b = await nav.right() // chron 3 (oldest unseen)
      expect(b.has_left).toBe(true)
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

   it("counts a never-seen member as fully unread", async () => {
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
   })

   it("returns 0 when every member is fully read (never-seen members excepted)", async () => {
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      data.db.feeds[1].tag = "news"
      await nav.goTo(1) // read chron 1 → feed:1 = 1 (fully read)
      const group = [data.db.feeds[1]]
      expect(nav.tagUnreadFromCounts(group, await nav.unreadCounts(group))).toBe(0)
   })

   it("sums member counts (never-seen members as their full backlog)", async () => {
      // A tag spanning all three member kinds — seen (partial), never-seen, and
      // fully-read (0-contributing). feedUnread reports a never-seen member as its
      // full backlog and a fully-read one as 0, so the tag badge is a plain sum of
      // the per-feed counts and the row badges beneath the header add up to it.
      data.db.feeds[1] = makeFeed({ id: 1, tag: "news" })
      data.db.feeds[2] = makeFeed({ id: 2, tag: "news" })
      data.db.feeds[3] = makeFeed({ id: 3, tag: "news" })
      // chron 0=ch1 1=ch2 2=ch1 3=ch3 4=ch1 5=ch3 6=ch2.
      // ch1: partially read (seen→2 → {4} unread = 1).
      // ch2: NEVER seen → fully unread ({1,6} = 2).
      // ch3: fully read (seen→5 → {} unread = 0).
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
      // Seed directly: ch1 read to chron 2, ch3 fully read (→5), ch2 NEVER seen.
      // (Browsing via [ALL] would mark passed feeds seen up to the opened article —
      // mark-previous-as-seen — so seed the distinct per-member positions.)
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2, "feed:3": 5 }))
      const group = [data.db.feeds[1], data.db.feeds[2], data.db.feeds[3]]
      const counts = await nav.unreadCounts(group)
      // counts: ch1 = 1 (read down to chron 2); ch2 = its full backlog (2); ch3 = 0.
      expect(counts.get(1)).toBe(1)
      expect(counts.get(2)).toBe(2)
      expect(counts.get(3)).toBe(0)
      const badge = nav.tagUnreadFromCounts(group, counts)
      expect(badge).toBe(3) // 1 (ch1) + 2 (ch2 full) + 0 (ch3 fully read)
   })
})

describe("unreadCounts", () => {
   it("batches per-feed unread counts correctly", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 3 }])
      await nav.goTo(0) // read chron 0 under [ALL] → every feed caught up to 0
      const chs = [data.db.feeds[1], data.db.feeds[2], data.db.feeds[3]]
      const batch = await nav.unreadCounts(chs)
      // ch1 has chron 2 unread; ch2/ch3's only articles (chron 1, 3) are newer
      // than the chron-0 frontier → one unread each.
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
   let videos: HTMLVideoElement[]
   let createSpy: ReturnType<typeof vi.spyOn>
   let pendingIdle: Array<() => Promise<void>>

   beforeEach(() => {
      // localStorage `srr-img-proxy` is unset (passthrough) by default; install
      // a prefix so the assertions about encoded srcs exercise the proxy path.
      setImgProxy(PROXY_PREFIX)
      images = []
      videos = []
      pendingIdle = []
      window.Image = function () {
         const img = new RealImage()
         images.push(img)
         return img
      } as unknown as typeof Image
      const realCreateElement = document.createElement.bind(document)
      createSpy = vi.spyOn(document, "createElement").mockImplementation(((
         tag: string,
         opts?: ElementCreationOptions,
      ) => {
         const el = realCreateElement(tag, opts)
         if (tag === "video") videos.push(el as HTMLVideoElement)
         return el
      }) as typeof document.createElement)
      window.requestIdleCallback = ((cb: () => unknown) => {
         pendingIdle.push(cb as () => Promise<void>)
         return 0
      }) as unknown as typeof window.requestIdleCallback
   })

   afterEach(() => {
      window.Image = RealImage
      window.requestIdleCallback = RealRIC
      createSpy.mockRestore()
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

   it("aborts the prior prefetch when a filter switch resolves to a placeholder", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      data.db.feeds[9] = makeFeed({ id: 9, total_art: 0 }) // a pickable empty feed → placeholder
      data.loadArticle.mockImplementation(async (idx: number) =>
         makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      const prefetched = images[0]
      expect(prefetched.getAttribute("src")).not.toBe("")

      const result = await nav.switchFilter("9") // empty feed → resolveNoMatch
      expect(result.placeholder).toBe(true)
      expect(prefetched.getAttribute("src")).toBe("") // the now-stale prefetch is aborted
   })

   it("caps the image prefetch at 6 (an image-stuffed neighbor must not flood the connection)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      const many = Array.from({ length: 9 }, (_, i) => `<img src="http://example.com/${i}.jpg">`).join("")
      data.loadArticle.mockImplementation(async () => makeArticle({ c: many }))
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      expect(images).toHaveLength(6)
   })

   it("does NOT abort when navigating onto the prefetched neighbor itself (loads must survive arrival)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      data.loadArticle.mockImplementation(async (idx: number) =>
         makeArticle({ c: `<img src="http://example.com/${idx}.jpg">` }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      const prefetched = images[0]
      expect(prefetched.getAttribute("src")).not.toBe("")

      await nav.right() // arrive at the article those images belong to
      expect(prefetched.getAttribute("src")).not.toBe("")
   })

   it("prefetches the video poster (proxied) and the video metadata (un-proxied src, preload=metadata)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      data.loadArticle.mockImplementation(async () =>
         makeArticle({ c: '<video poster="http://example.com/p.jpg" src="http://example.com/v.mp4"></video>' }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      expect(images).toHaveLength(1)
      expect(images[0].src).toContain(encodeURIComponent("http://example.com/p.jpg"))
      expect(videos).toHaveLength(1)
      expect(videos[0].getAttribute("preload")).toBe("metadata")
      expect(videos[0].getAttribute("src")).toBe("http://example.com/v.mp4")
   })

   it("caps the video metadata prefetch at 2", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      const many = Array.from({ length: 4 }, (_, i) => `<video src="http://example.com/${i}.mp4"></video>`).join("")
      data.loadArticle.mockImplementation(async () => makeArticle({ c: many }))
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      expect(videos).toHaveLength(2)
   })

   it("aborts prefetched videos too when navigating away (src emptied)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      data.loadArticle.mockImplementation(async () =>
         makeArticle({ c: '<video src="http://example.com/v.mp4"></video>' }),
      )
      await nav.fromHash("0")
      await nav.right()
      await flushIdle()
      expect(videos[0].getAttribute("src")).toBe("http://example.com/v.mp4")

      await nav.goTo(3)
      expect(videos[0].getAttribute("src")).toBe("")
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

   it("traverses only saved articles, opening at the oldest (front of the queue)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // chrons 0..4
      nav.toggleSaved(1)
      nav.toggleSaved(3)
      nav.toggleSaved(4)
      // switchFilter opens at the oldest saved (1) — read the queue forward from there.
      const r1 = await nav.switchFilter(nav.SAVED_TOKEN)
      expect(data.loadArticle).toHaveBeenCalledWith(1)
      expect(nav.filter.active).toBe(true)
      expect(r1.has_left).toBe(false)
      expect(r1.has_right).toBe(true)

      const r3 = await nav.right()
      expect(data.loadArticle).toHaveBeenCalledWith(3) // skips unsaved 2
      expect(r3.has_right).toBe(true)

      const r4 = await nav.right()
      expect(data.loadArticle).toHaveBeenCalledWith(4)
      expect(r4.has_right).toBe(false) // newest saved
      await expect(nav.right()).rejects.toThrow("no right match")
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

   // ── Save ORDER (appended, not sorted) ──────────────────────────────────────
   it("toggleSaved appends to the queue in save order, not sorted by chronIdx", () => {
      nav.toggleSaved(4)
      nav.toggleSaved(1)
      nav.toggleSaved(3)
      // Stored in the order saved — a chronIdx sort would be [1,3,4].
      expect(JSON.parse(localStorage.getItem("srr-saved")!)).toEqual([4, 1, 3])
      // un-saving removes in place without reordering the survivors.
      nav.toggleSaved(1)
      expect(JSON.parse(localStorage.getItem("srr-saved")!)).toEqual([4, 3])
   })

   it("traverses in SAVE order (front-to-back), independent of chronIdx", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // 0..4
      nav.toggleSaved(4) // saved first → front of the queue
      nav.toggleSaved(1)
      nav.toggleSaved(3) // saved last → back of the queue

      // Opens at the FRONT (first save = 4), NOT the lowest chronIdx.
      const r1 = await nav.switchFilter(nav.SAVED_TOKEN)
      expect(nav.currentChron()).toBe(4)
      expect(r1.has_left).toBe(false)
      expect(r1.has_right).toBe(true)
      expect(r1.right_count).toBe(2) // two saves ahead in the queue

      // Forward walks save order 4 → 1 → 3 (a chronIdx walk could never go 4→1).
      const r2 = await nav.right()
      expect(nav.currentChron()).toBe(1)
      expect(r2.has_left).toBe(true)
      expect(r2.right_count).toBe(1)

      const r3 = await nav.right()
      expect(nav.currentChron()).toBe(3) // newest save = back of the queue
      expect(r3.has_right).toBe(false)
      expect(r3.right_count).toBe(0)
      await expect(nav.right()).rejects.toThrow("no right match")

      // Back walks the queue in reverse save order: 3 → 1 → 4.
      const b2 = await nav.left()
      expect(nav.currentChron()).toBe(1)
      expect(b2.has_left).toBe(true)
      const b1 = await nav.left()
      expect(nav.currentChron()).toBe(4)
      expect(b1.has_left).toBe(false)
   })

   it("first()/last() open the front/back of the save-ordered queue", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.toggleSaved(4)
      nav.toggleSaved(1)
      nav.toggleSaved(3)
      nav.filter.set([nav.SAVED_TOKEN])
      await nav.last()
      expect(nav.currentChron()).toBe(3) // newest save
      await nav.first()
      expect(nav.currentChron()).toBe(4) // earliest save (front)
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
      expect(await nav.feedRight(4)).toBe(9) // smallest hit >= 4 (folded from the deleted dedup test)
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
      expect(nav.isSearchFilter()).toBe(true) // still search mode, not cleared to [ALL]
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

   it("anchors ★ Saved at its OLDEST saved article (front of the read-later queue)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([1, 2]))
      nav.select(-1, -1)
      nav.filter.set([nav.SAVED_TOKEN])
      expect(await nav.listAnchor()).toBe(1) // oldest saved, not the newest (2)
   })

   it("returns -1 for ★ Saved with an empty saved set", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
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

   it("always skips ★ Saved in the rotation (reached only from the picker)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-saved", JSON.stringify([0]))
      nav.setUnreadOnly(false)
      nav.filter.clear() // [ALL]
      data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [data.db.feeds[1]] })
      // entries = ["", "~saved", "1"] → forward from "" hops over ★ Saved to the feed
      await nav.cycleFilter(1)
      expect(nav.filter.saved).toBe(false)
      expect(nav.getCurrentFilterKey()).toBe("1")
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

// ── feedUnread reflects live seen: reading marks on ENTER, no pad ───────────
describe("feedUnread is the plain live unread (enter-based accounting)", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("select() (list cursor move) does not touch the count — it records no seen", async () => {
      // Setup: feed 1 has 3 articles (chron 0,1,2); feed 1 seen through chron 0.
      // Unread are chron 1 and 2 → unread count = 2.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      seedSeen({ "feed:1": 0 })
      nav.filter.set(["1"])

      // Move the list cursor to chron 1 (unread article) via select() — no recordSeen.
      nav.select(1, 1)

      // Still the true unread (2): the cursor move marks nothing.
      const counts = await nav.unreadCounts([data.db.feeds[1]])
      expect(counts.get(1)).toBe(2)
   })

   it("opening an article in the reader drops the count on enter — the read one no longer counts", async () => {
      // goTo is the list-tap open (resolve with record:true). recordSeen sets
      // seen["feed:1"] = 1 (== pos), so chron 1 is now read: the badge drops to 1
      // (only chron 2 remains) the instant you open it — reading is accounted on
      // ENTER, with no pad holding the read article as unread.
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      seedSeen({ "feed:1": 0 })
      nav.filter.set(["1"])

      await nav.goTo(1)

      const counts = await nav.unreadCounts([data.db.feeds[1]])
      expect(counts.get(1)).toBe(1)
   })

   it("opening the last article reads 0 — a fully-read feed is caught up", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      seedSeen({ "feed:1": 0 })
      nav.filter.set(["1"])

      await nav.goTo(2)

      const counts = await nav.unreadCounts([data.db.feeds[1]])
      expect(counts.get(1)).toBe(0)
   })

   it("reloading the page (fromHash restore) does not consume unread — no cross-feed frontier on restore", async () => {
      // feed1 {0,2,4}, feed2 {1,3}; feed1 read to chron 2, feed2 never read.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      const group = [data.db.feeds[1], data.db.feeds[2]]
      const before = (await nav.unreadCounts(group)).get(2)
      // Reload restoring the reader at chron 2 (a feed1 article) under [ALL].
      await nav.fromHash("2")
      const after = (await nav.unreadCounts(group)).get(2)
      // Restoring a feed1 position must not mark feed2's chron 1 read via the
      // cross-feed frontier — a reload isn't reading.
      expect(before).toBe(2) // feed2 {1,3}
      expect(after).toBe(2) // unchanged by the reload
   })

   it("switching feed/tag filters does not move a feed's count (the reported bug)", async () => {
      // chron 0=f1 1=f2 2=f1 3=f2 4=f1 → feed1 {0,2,4}, feed2 {1,3}.
      setupIndex([{ feedId: 1 }, { feedId: 2 }, { feedId: 1 }, { feedId: 2 }, { feedId: 1 }])
      nav.setUnreadOnly(true)
      await nav.switchFilter("1") // never opened → the not-started placeholder (records nothing)
      await nav.goTo(0) // start reading from the list (tap the oldest) — marks chron 0 on ENTER
      await nav.right() // read forward onto chron 2 — accounted on ENTER
      const afterRead = (await nav.unreadCounts([data.db.feeds[1], data.db.feeds[2]])).get(1)
      await nav.switchFilter("2") // switch to feed2 (its own never-opened placeholder)
      const afterSwitch = (await nav.unreadCounts([data.db.feeds[1], data.db.feeds[2]])).get(1)
      // Reading marked feed1 up to chron 2 on enter ({0,2} read); the SWITCH must
      // not drop it further — no pad to lift, no seen written on the switch landing.
      expect(afterRead).toBe(1) // {4} left after reading chron 0 then 2
      expect(afterSwitch).toBe(1) // unchanged by the switch
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

// ── Task 6: onStoreRefreshed / probeCurrent ─────────────────────────────────
// data.refresh() (merged) swaps in a fresh db.gz snapshot; search.invalidate()
// (merged) drops search.ts's caches. onStoreRefreshed() is nav's side of that
// same reconciliation: adopt the new snapshot's membership/bounds WITHOUT
// re-snapshotting the walk (bounds only ever RISE, by a grown add_idx —
// re-deriving from seen would yank the unseen-only sequence mid-session), drop
// the stale neighbor caches, and reload an active search snapshot.
describe("onStoreRefreshed", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("keeps existing bounds, raises only by a grown add_idx, adds new members", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }]) // [ALL] over feed 1 (2 articles, add_idx 0)
      expect(nav.filter.feeds.get(1)).toBe(0)

      // Simulate a refresh: feed 1 expired past chron 0 (add_idx advances to 1)
      // and a brand-new feed 2 appears (add_idx 2); total_art grows to 3.
      data.db.feeds[1].add_idx = 1
      data.db.feeds[2] = makeFeed({ id: 2, total_art: 1, add_idx: 2 })
      data.db.total_art = 3

      await nav.onStoreRefreshed()
      expect(nav.filter.feeds.get(1)).toBe(1) // raised by the grown add_idx
      expect(nav.filter.feeds.get(2)).toBe(2) // new member joins at its own add_idx
   })

   it("does NOT re-snapshot unseen-only bounds from seen", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // 3 articles, add_idx 0
      nav.setUnreadOnly(true)
      nav.filter.set(["1"]) // never seen ⇒ bound snapshots at max(0, -1+1) = 0
      expect(nav.filter.feeds.get(1)).toBe(0)

      // User reads onward THIS session — srr-seen now records chron 1 as seen.
      // Re-deriving the bound from seen would raise it to 2 (seen+1) and yank
      // the walk past the article just read.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 }))
      await nav.onStoreRefreshed()
      expect(nav.filter.feeds.get(1)).toBe(0) // unchanged — no re-snapshot
   })

   it("drops a feed deleted from the store", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }]) // [ALL]
      expect(nav.filter.feeds.has(1)).toBe(true)
      delete data.db.feeds[1]
      await nav.onStoreRefreshed()
      expect(nav.filter.feeds.has(1)).toBe(false)
   })

   it("reloads the search snapshot when a q: filter is active", async () => {
      // loadHits is the seam nav calls; drive it directly (like the
      // "search hit-set snapshot" suite above) rather than through the
      // search()-generator stand-in — cleanest way to prove a grown hit set.
      searchMod.loadHits.mockReset()
      setupIndex(Array.from({ length: 20 }, () => ({ feedId: 1 })))

      searchMod.loadHits.mockResolvedValueOnce({ chrons: [5], truncated: false })
      nav.applyFilter([nav.SEARCH_PREFIX + "refresh1"])
      expect(await nav.feedRight(0)).toBe(5)

      // Simulate a refresh that grew the hit set: a newer article now matches.
      searchMod.loadHits.mockResolvedValueOnce({ chrons: [5, 12], truncated: false })
      await nav.onStoreRefreshed()
      expect(await nav.feedRight(6)).toBe(12) // sees the new hit
   })
})

describe("probeCurrent", () => {
   it("recomputes has_right/right_count for the current position after growth", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }])
      await nav.goTo(1) // lands on chron 1, the newest of the original 2 articles

      // Grow the store: a new article appears at chron 2 (still feed 1).
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      await nav.onStoreRefreshed() // reconciles the filter, drops stale neighbor caches

      const o = await nav.probeCurrent()
      expect(o).not.toBeNull()
      expect(o!.has_right).toBe(true)
      expect(o!.right_count).toBe(1)
   })

   it("returns null with no article on screen", async () => {
      nav.select(-1, -1)
      expect(await nav.probeCurrent()).toBeNull()
   })
})

// In unread-only mode a fully-read feed/tag (or [ALL] fully caught up) has
// nothing unread to resume onto, so switchFilter/fromHash surface the directed
// "All caught up" placeholder (resolveNoMatch) instead of opening an already-read
// article. Show-read mode keeps opening the article (you browse read items there).
describe("no-unread feed/tag shows the caught-up placeholder", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("switching to a fully-read feed (unread-only) shows the placeholder, not a read article", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // feed1 {0,1,2}
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 })) // fully read
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("1")
      expect(r.placeholder).toBe(true)
      expect(nav.currentChron()).toBe(-1) // no article resolved
   })

   it("switching to a fully-read tag (unread-only) shows the placeholder", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      data.db.feeds[6] = makeFeed({ id: 6, tag: "news" })
      setupIndex([{ feedId: 5 }, { feedId: 6 }, { feedId: 5 }]) // f5 {0,2}, f6 {1}
      data.db.feeds[5].tag = "news"
      data.db.feeds[6].tag = "news"
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:5": 2, "feed:6": 1 })) // all read
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("news")
      expect(r.placeholder).toBe(true)
   })

   it("in show-read mode a fully-read feed opens the article, NOT the placeholder", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      nav.setUnreadOnly(false) // browse read items
      const r = await nav.switchFilter("1")
      expect(r.placeholder).toBeFalsy()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })

   it("[ALL] fully caught up (unread-only) shows the placeholder instead of the newest read article", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 2 }]) // f1 {0}, f2 {1}
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0, "feed:2": 1 })) // all read
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("")
      expect(r.placeholder).toBe(true)
   })

   it("reloading (fromHash) onto a fully-read feed shows the placeholder", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      nav.setUnreadOnly(true)
      const r = await nav.fromHash("2!1")
      expect(r.placeholder).toBe(true)
   })

   it("reloading onto a feed that still has unread honors the #pos (no placeholder)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0 })) // 1,2 unread
      nav.setUnreadOnly(true)
      const r = await nav.fromHash("2!1")
      expect(r.placeholder).toBeFalsy()
      expect(data.loadArticle).toHaveBeenLastCalledWith(2)
   })
})

// A feed/tag you've NEVER opened has unread but no already-read article to resume
// onto. In unread-only mode the reader is a resume surface, so switchFilter shows
// a distinct "not started" placeholder (notStarted=true → its own message, NOT
// the "All caught up" one, since the feed HAS unread) instead of dropping the
// reader onto an unread article a mere switch must not consume. The placeholder
// arrives with Next ARMED (has_right + the pill, which — being the badge count
// by construction — reads the feed's full backlog here): reading starts with a
// →-step from right here. Show-read mode still opens the oldest article (you
// browse there).
describe("never-opened feed/tag shows the not-started placeholder (unread-only)", () => {
   afterEach(() => nav.setUnreadOnly(false))

   it("switching to a never-opened feed (unread-only) shows the not-started placeholder", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // feed1 {0,1,2}, nothing seen
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("1")
      expect(r.placeholder).toBe(true)
      expect(r.notStarted).toBe(true)
      // No article resolved — the reader stays a resume surface; the pill (the
      // badge count by construction) reads the full backlog either way.
      expect(nav.currentChron()).toBe(-1)
      expect(data.loadArticle).not.toHaveBeenCalled()
      expect(nav.getCurrentFilterKey()).toBe("1") // scoped to the feed for its message
      // Next is armed with the full backlog — the pill equals the badge here.
      expect(r.has_right).toBe(true)
      expect(r.right_count).toBe(3)
      expect(r.has_left).toBe(false)
      expect(r.startFeed).toBe(1) // the feed the armed Next opens, named by the message
   })

   it("→ from the not-started placeholder opens the oldest unread and records it", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // feed1 {0,1,2}, nothing seen
      nav.setUnreadOnly(true)
      await nav.switchFilter("1") // → the armed placeholder (asserted above)
      const r = await nav.right() // reading starts here, not from the list
      expect(r.placeholder).toBeFalsy()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0) // oldest unread
      // A →-step is a READ, not a resume: the landing records the seen frontier,
      // so the badge/pill tick down exactly as any forward step does.
      expect(JSON.parse(localStorage.getItem("srr-seen")!)["feed:1"]).toBe(0)
      expect(r.right_count).toBe(2)
   })

   it("switching to a never-opened tag (no member seen) shows the not-started placeholder", async () => {
      data.db.feeds[5] = makeFeed({ id: 5, tag: "news" })
      data.db.feeds[6] = makeFeed({ id: 6, tag: "news" })
      setupIndex([{ feedId: 5 }, { feedId: 6 }, { feedId: 5 }]) // f5 {0,2}, f6 {1}
      data.db.feeds[5].tag = "news"
      data.db.feeds[6].tag = "news"
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("news")
      expect(r.placeholder).toBe(true)
      expect(r.notStarted).toBe(true)
      // The lane label alone says "news" — startFeed pins WHICH member feed the
      // unread backlog starts with: the oldest unread (chron 0) belongs to feed 5.
      expect(r.startFeed).toBe(5)
   })

   it("in show-read mode a never-opened feed opens the oldest article, NOT the placeholder", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }])
      nav.setUnreadOnly(false) // browse read + unread
      const r = await nav.switchFilter("1")
      expect(r.placeholder).toBeFalsy()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0) // oldest, shown as before
   })

   it("a fully-read feed's placeholder is caught-up (NOT flagged not-started)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }]) // feed1 {0,1}
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 })) // fully read
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("1")
      expect(r.placeholder).toBe(true)
      expect(r.notStarted).toBeFalsy() // caught-up ⇒ the reward message, a different one
   })

   it("a partially-read feed resumes onto its seen article (never the not-started placeholder)", async () => {
      setupIndex([{ feedId: 1 }, { feedId: 1 }, { feedId: 1 }]) // feed1 {0,1,2}
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 0 })) // 1,2 unread
      nav.setUnreadOnly(true)
      const r = await nav.switchFilter("1")
      expect(r.placeholder).toBeFalsy()
      expect(r.notStarted).toBeFalsy()
      expect(data.loadArticle).toHaveBeenLastCalledWith(0) // the seen entrypoint (already read ⇒ pill == badge)
   })

   it("cycling (W/S) onto a never-opened feed also shows the not-started placeholder", async () => {
      nav.setUnreadOnly(true)
      data.db.feeds[1] = makeFeed({ id: 1 })
      data.db.feeds[2] = makeFeed({ id: 2 })
      setupIndex([{ feedId: 1 }, { feedId: 2 }]) // f1 {0}, f2 {1}; nothing seen
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [data.db.feeds[1], data.db.feeds[2]],
      })
      await nav.switchFilter("1") // origin lane (also a not-started placeholder, records nothing)
      const r = await nav.cycleFilter(1) // → feed 2 lane, never opened
      expect(nav.getCurrentFilterKey()).toBe("2")
      expect(r.placeholder).toBe(true)
      expect(r.notStarted).toBe(true)
   })
})
