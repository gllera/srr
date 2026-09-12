import { beforeEach, describe, expect, it, vi } from "vitest"

const data = vi.hoisted(() => {
   const d = {
      db: { total_art: 0, feeds: {} as Record<number, IFeed> } as unknown as IDB,
      ids: [] as number[],
      // Brute-force stand-ins over `ids` — the same shapes nav.test.ts's mock uses.
      count: (upTo: number, feeds: Map<number, number>) => {
         let n = 0
         for (let i = 0; i < upTo; i++) {
            const b = feeds.get(d.ids[i])
            if (b !== undefined && i >= b) n++
         }
         return n
      },
      getFeedId: vi.fn(async (chron: number) => d.ids[chron]),
      feedTitle: vi.fn((id: number) => d.db.feeds[id]?.title ?? "[DELETED]"),
      countLeft: vi.fn(async (upTo: number, feeds: Map<number, number>) => d.count(upTo, feeds)),
      countAll: vi.fn((feeds: Map<number, number>) => d.count(d.db.total_art, feeds)),
      // Every feed through seen.ts's per-feed oracle (feedUnread).
      unreadTally: vi.fn(<T extends { id: number }>(chs: T[]) => ({ counts: new Map<number, number>(), rare: chs })),
      findLeft: vi.fn(async (from: number, feeds: Map<number, number>) => {
         for (let i = Math.min(from, d.db.total_art - 1); i >= 0; i--) {
            const b = feeds.get(d.ids[i])
            if (b !== undefined && i >= b) return i
         }
         return -1
      }),
      findRight: vi.fn(async (from: number, feeds: Map<number, number>) => {
         for (let i = Math.max(from, 0); i < d.db.total_art; i++) {
            const b = feeds.get(d.ids[i])
            if (b !== undefined && i >= b) return i
         }
         return -1
      }),
      activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
   }
   return d
})
vi.mock("../data", () => data)

import type { LaneEnv } from "./lane"
import { isKnownToken, MembersLane, reconcileMembers, resolveMembership } from "./lane-members"

const env = (unreadOnly = false): LaneEnv => ({ unreadOnly: () => unreadOnly, searchKey: () => "" })
const feed = (id: number, over: Partial<IFeed> = {}): IFeed =>
   ({
      id,
      title: `F${id}`,
      url: `http://f/${id}`,
      total_art: data.ids.filter((f) => f === id).length,
      add_idx: 0,
      ...over,
   }) as IFeed
const seen = (m: Record<string, number>) => localStorage.setItem("srr-seen", JSON.stringify(m))
const lane = (tokens: string[], unreadOnly = false) =>
   new MembersLane(tokens, resolveMembership(tokens), env(unreadOnly))

// chron: 0 1 2 3 4 5 — feed: 1 2 1 2 1 2. Feeds 1 and 2 are tagged "news";
// feed 3 ("empty") has no articles.
beforeEach(() => {
   localStorage.clear()
   data.ids = [1, 2, 1, 2, 1, 2]
   data.db.total_art = 6
   data.db.feeds = {
      1: feed(1, { tag: "news" }),
      2: feed(2, { tag: "news" }),
      3: feed(3, { tag: "empty", total_art: 0 }),
   }
})

describe("resolveMembership / isKnownToken", () => {
   it("[] is every feed with articles, at its add_idx", () => {
      data.db.feeds[2].add_idx = 3
      expect([...resolveMembership([])]).toEqual([
         [1, 0],
         [2, 3],
      ])
   })

   it("a numeric token is that feed, a tag its members, a union has no duplicates", () => {
      expect([...resolveMembership(["2"])]).toEqual([[2, 0]])
      expect([...resolveMembership(["news"])]).toEqual([
         [1, 0],
         [2, 0],
      ])
      expect([...resolveMembership(["1", "news"])]).toEqual([
         [1, 0],
         [2, 0],
      ])
      expect(resolveMembership(["empty"]).size).toBe(0)
      expect(resolveMembership(["nope"]).size).toBe(0)
   })

   it("tells a real feed or tag from a stale token", () => {
      expect(isKnownToken("3")).toBe(true)
      expect(isKnownToken("empty")).toBe(true)
      expect(isKnownToken("9")).toBe(false)
      expect(isKnownToken("nope")).toBe(false)
   })
})

describe("MembersLane — shape and walk", () => {
   it("is the non-peek, chron-ordered, divided lane", () => {
      const all = lane([])
      expect([all.kind, all.key, all.peek, all.dividers, all.chronOrdered]).toEqual(["all", "", false, true, true])
      const one = lane(["2"])
      expect([one.kind, one.key, one.label()]).toEqual(["members", "2", "F2"])
      expect(lane(["1", "2"]).key).toBe("")
   })

   it("walks the membership by value and by strict neighbour", async () => {
      const l = lane(["1"])
      expect(await l.atOrAbove(1)).toBe(2)
      expect(await l.atOrBelow(3)).toBe(2)
      expect(await l.newer(2)).toBe(4)
      expect(await l.older(2)).toBe(0)
      expect(l.matches(1, 4)).toBe(true)
      expect(l.matches(2, 3)).toBe(false)
   })

   it("raises bounds past the seen high-water only under unread-only", () => {
      const s = { "feed:1": 2, "feed:2": 1 }
      const off = lane(["news"])
      off.applyUnseen(s)
      expect([...off.members]).toEqual([
         [1, 0],
         [2, 0],
      ])
      const on = lane(["news"], true)
      on.applyUnseen(s)
      expect([...on.members]).toEqual([
         [1, 3],
         [2, 2],
      ])
   })

   it("slots the unseen-only entry anchor into both walks without making it a match", async () => {
      const l = lane(["news"], true)
      l.applyUnseen({ "feed:1": 2, "feed:2": 1 }) // bounds {1:3, 2:2}
      l.landed(1, 2) // chron 1 is feed 2's, below its raised bound: an entry anchor
      expect(l.entryAnchor()).toBe(1)
      expect(await l.atOrBelow(2)).toBe(1)
      expect(await l.atOrAbove(0)).toBe(1)
      expect(await l.newer(1)).toBe(3)
      expect(l.matches(2, 1)).toBe(false)
   })

   it("records no anchor for a matching landing, or in show-read", () => {
      const on = lane(["news"], true)
      on.applyUnseen({})
      on.landed(3, 2)
      expect(on.entryAnchor()).toBe(-1)
      const off = lane(["news"])
      off.landed(1, 2)
      expect(off.entryAnchor()).toBe(-1)
   })
})

describe("MembersLane — ends, anchor, ahead", () => {
   it("oldest is the first member at or after the smallest bound, newest the last", async () => {
      const l = lane(["2"])
      expect(await l.oldest()).toBe(1)
      expect(await l.newest()).toBe(5)
   })

   it("anchor() is the oldest UNREAD member, even in show-read", async () => {
      seen({ "feed:1": 2, "feed:2": 1 })
      expect(await lane(["news"]).anchor()).toBe(3)
      expect(await new MembersLane(["x"], new Map(), env()).anchor()).toBe(-1)
   })

   it("counts unread AND ahead: each frontier floored at the cursor", async () => {
      seen({ "feed:1": 2, "feed:2": 1 })
      const l = lane(["news"])
      expect(await l.ahead(-1)).toBe(3) // the whole unread backlog: chrons 3, 4, 5
      expect(await l.ahead(3)).toBe(2) // strictly after 3: chrons 4, 5
      expect(await l.ahead(3, { "feed:1": 4, "feed:2": 1 })).toBe(1) // a passed map wins over storage
   })
})

describe("MembersLane — entry (switchFilter's decision tree)", () => {
   it("unread-only + caught up: the plain placeholder", async () => {
      const l = lane(["news"], true)
      l.applyUnseen({ "feed:1": 4, "feed:2": 5 })
      expect(await l.entry()).toEqual({ placeholder: true, notStarted: false, hasRight: false })
   })

   it("resumes on the tag's oldest member frontier, accepted by the TRUE add_idx", async () => {
      seen({ "feed:1": 2, "feed:2": 1 })
      const l = lane(["news"], true)
      l.applyUnseen({ "feed:1": 2, "feed:2": 1 })
      expect(await l.entry()).toEqual({ land: 1, record: false })
   })

   it("show-read with nothing to resume opens the oldest article", async () => {
      expect(await lane(["news"]).entry()).toEqual({ land: 0, record: false })
   })

   it("unread-only + never opened: the ARMED not-started placeholder naming the first feed", async () => {
      const l = lane(["news"], true)
      l.applyUnseen({})
      expect(await l.entry()).toEqual({
         placeholder: true,
         notStarted: true,
         hasRight: true,
         rightCount: 6,
         startFeed: 1,
      })
   })

   it("a known feed with no articles is an unarmed placeholder under its own token", async () => {
      expect(await new MembersLane(["empty"], new Map(), env(true)).entry()).toEqual({
         placeholder: true,
         notStarted: false,
         hasRight: false,
      })
   })

   it("[ALL] opens at the oldest unread, else caught-up (unread-only) or the newest", async () => {
      seen({ "feed:1": 2, "feed:2": 1 })
      expect(await lane([]).entry()).toEqual({ land: 3, record: false })
      seen({ "feed:1": 4, "feed:2": 5 })
      expect(await lane([], true).entry()).toEqual({ placeholder: true, notStarted: false, hasRight: false })
      expect(await lane([]).entry()).toEqual({ land: 5, record: false })
   })
})

describe("MembersLane — refreshed (reconcile, never rebuild)", () => {
   it("raises by a grown add_idx, joins new members, drops gone ones, never re-derives from seen", async () => {
      const l = lane(["news"], true) // natural bounds {1:0, 2:0}
      seen({ "feed:1": 3, "feed:4": 6 })
      data.ids.push(4)
      data.db.total_art = 7
      data.db.feeds[1].add_idx = 1
      data.db.feeds[4] = feed(4, { tag: "news", add_idx: 6 })
      delete data.db.feeds[2]
      await l.refreshed()
      expect([...l.members]).toEqual([
         [1, 1],
         [4, 7],
      ])
   })

   it("joins a new member at its natural bound in show-read", () => {
      const members = new Map([[1, 0]])
      seen({ "feed:4": 6 })
      reconcileMembers(
         members,
         new Map([
            [1, 0],
            [4, 6],
         ]),
         false,
      )
      expect(members.get(4)).toBe(6)
   })
})
