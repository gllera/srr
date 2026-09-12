import { beforeEach, describe, expect, it, vi } from "vitest"

const data = vi.hoisted(() => ({
   db: { total_art: 0, feeds: {} as Record<number, IFeed> } as unknown as IDB,
   ids: [] as number[],
   getFeedId: vi.fn(async (chron: number) => data.ids[chron]),
   feedTitle: vi.fn((id: number) => data.db.feeds[id]?.title ?? "[DELETED]"),
   activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
}))
vi.mock("../data", () => data)

import {
   classifyTokens,
   firstUnreadProbe,
   keyOf,
   labelFor,
   minOf,
   oldestByBounds,
   validResume,
   type Lane,
} from "./lane"

// A lane with every method answering "nothing", overridden per case — the
// helpers under test must work over ANY implementation of the interface.
function fakeLane(over: Partial<Lane> = {}): Lane {
   const base: Lane = {
      kind: "members",
      tokens: [],
      key: "",
      peek: false,
      members: new Map(),
      dividers: true,
      chronOrdered: true,
      label: () => "",
      matches: () => false,
      atOrBelow: async () => -1,
      atOrAbove: async () => -1,
      older: async () => -1,
      newer: async () => -1,
      oldest: async () => -1,
      newest: async () => -1,
      anchor: async () => -1,
      ahead: async () => 0,
      entry: async () => ({ land: -1, record: false }),
      prepare: async () => {},
      refreshed: async () => {},
      landed: () => {},
      applyUnseen: () => {},
      entryAnchor: () => -1,
   }
   return { ...base, ...over }
}

beforeEach(() => {
   // chron: 0 1 2 3 4 5 — feed: 1 2 1 2 1 2; feed 2's articles start at chron 2.
   data.ids = [1, 2, 1, 2, 1, 2]
   data.db.total_art = 6
   data.db.feeds = {
      1: { id: 1, title: "One", url: "u1", total_art: 3, add_idx: 0 } as IFeed,
      2: { id: 2, title: "Two", url: "u2", total_art: 3, add_idx: 2 } as IFeed,
   }
})

describe("classifyTokens — the one place a token list is classified", () => {
   it("tells saved, search and membership apart exactly as filter.set did", () => {
      expect(classifyTokens([])).toEqual({ kind: "members" })
      expect(classifyTokens(["~saved"])).toEqual({ kind: "saved" })
      expect(classifyTokens(["~saved", "1"])).toEqual({ kind: "members" })
      expect(classifyTokens(["q:x"])).toEqual({ kind: "search", q: 0 })
      expect(classifyTokens(["tech", "q:x"])).toEqual({ kind: "search", q: 1 })
      expect(classifyTokens(["q:x", "q:y"])).toEqual({ kind: "search", q: 0 })
      expect(classifyTokens(["q:x", "a", "b"])).toEqual({ kind: "members" })
   })
})

describe("keyOf / labelFor / minOf", () => {
   it("keys a lane by its single token, else ''", () => {
      expect(keyOf([])).toBe("")
      expect(keyOf(["5"])).toBe("5")
      expect(keyOf(["5", "9"])).toBe("")
   })

   it("labels every key shape nav produces", () => {
      expect(labelFor("")).toBe("All")
      expect(labelFor("~saved")).toBe("★ Saved")
      expect(labelFor("q:rust")).toBe("Search: rust")
      expect(labelFor("q:")).toBe("Search")
      expect(labelFor("2")).toBe("Two")
      expect(labelFor("99")).toBe("[DELETED]")
      expect(labelFor("news")).toBe("news")
      expect(labelFor("1e3")).toBe("1e3")
   })

   it("takes a minimum without spreading, 0 for nothing", () => {
      expect(minOf([3, 1, 2])).toBe(1)
      expect(minOf([])).toBe(0)
      expect(minOf(new Set(Array.from({ length: 70000 }, (_, i) => 70000 - i)))).toBe(1)
   })
})

describe("firstUnreadProbe", () => {
   it("answers unknown outside unread-only, on a peek lane, or with no members", async () => {
      const atOrAbove = vi.fn(async () => 3)
      const members = new Map([[1, 3]])
      expect(await firstUnreadProbe(fakeLane({ atOrAbove, members }), false)).toEqual({ chron: -1, known: false })
      expect(await firstUnreadProbe(fakeLane({ atOrAbove, members, peek: true }), true)).toEqual({
         chron: -1,
         known: false,
      })
      expect(await firstUnreadProbe(fakeLane({ atOrAbove }), true)).toEqual({ chron: -1, known: false })
      expect(atOrAbove).not.toHaveBeenCalled()
   })

   it("walks from the smallest bound, and a failed walk is unknown rather than caught up", async () => {
      const atOrAbove = vi.fn(async () => 4)
      const members = new Map([
         [1, 5],
         [2, 3],
      ])
      expect(await firstUnreadProbe(fakeLane({ atOrAbove, members }), true)).toEqual({ chron: 4, known: true })
      expect(atOrAbove).toHaveBeenCalledWith(3)
      const failing = fakeLane({ members, atOrAbove: async () => Promise.reject(new Error("blip")) })
      expect(await firstUnreadProbe(failing, true)).toEqual({ chron: -1, known: false })
   })
})

describe("validResume", () => {
   it("rejects out-of-range positions", async () => {
      expect(await validResume(fakeLane({ matches: () => true }), -1, false)).toBe(false)
      expect(await validResume(fakeLane({ matches: () => true }), 6, false)).toBe(false)
   })

   it("under unread-only validates against the TRUE add_idx, not the raised bound", async () => {
      const lane = fakeLane({ members: new Map([[2, 5]]), matches: () => false })
      expect(await validResume(lane, 3, true)).toBe(true) // feed 2, 3 >= add_idx 2
      expect(await validResume(lane, 1, true)).toBe(false) // feed 2, 1 < add_idx 2
      expect(await validResume(lane, 0, true)).toBe(false) // feed 1 is not a member
   })

   it("otherwise asks the lane", async () => {
      const matches = vi.fn((f: number, c: number) => f === 2 && c === 3)
      expect(await validResume(fakeLane({ matches }), 3, false)).toBe(true)
      expect(matches).toHaveBeenCalledWith(2, 3)
      expect(await validResume(fakeLane({ matches, peek: true }), 3, true)).toBe(true) // peek ignores unread-only
   })
})

describe("oldestByBounds", () => {
   it("is the first member at or after the smallest bound, else the newest", async () => {
      const atOrAbove = vi.fn(async () => 3)
      const members = new Map([
         [1, 4],
         [2, 2],
      ])
      expect(await oldestByBounds(fakeLane({ members, atOrAbove, newest: async () => 5 }))).toBe(3)
      expect(atOrAbove).toHaveBeenCalledWith(2)
      expect(await oldestByBounds(fakeLane({ members, newest: async () => 5 }))).toBe(5)
   })

   it("skips the walk when the smallest bound is past the store", async () => {
      const atOrAbove = vi.fn(async () => 0)
      const lane = fakeLane({ members: new Map([[1, 6]]), atOrAbove, newest: async () => -1 })
      expect(await oldestByBounds(lane)).toBe(-1)
      expect(atOrAbove).not.toHaveBeenCalled()
   })
})
