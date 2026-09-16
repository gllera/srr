import { beforeEach, describe, expect, it, vi } from "vitest"

const data = vi.hoisted(() => ({
   db: { total_art: 6, feeds: {} as Record<number, IFeed> } as unknown as IDB,
   feedTitle: vi.fn((id: number) => `F${id}`),
   watchRules: vi.fn(() => ({ hot: 0 }) as Record<string, number>),
   watchCovered: vi.fn(() => 0),
   activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
}))
vi.mock("../data", () => data)
vi.mock("../search", () => ({ loadHits: vi.fn() }))

import type { LaneEnv } from "./lane"
import { makeLane } from "./make-lane"

const env = (unreadOnly = false): LaneEnv => ({ unreadOnly: () => unreadOnly, searchKey: () => "" })

beforeEach(() => {
   localStorage.clear()
   data.db.feeds = {
      1: { id: 1, title: "F1", url: "u", tag: "news", total_art: 3, add_idx: 0 } as IFeed,
      2: { id: 2, title: "F2", url: "u", tag: "news", total_art: 3, add_idx: 0 } as IFeed,
      3: { id: 3, title: "F3", url: "u", tag: "empty", total_art: 0, add_idx: 0 } as IFeed,
   }
})

describe("makeLane", () => {
   it("classifies every token shape", () => {
      expect(makeLane([], env()).kind).toBe("all")
      expect(makeLane(["~saved"], env()).kind).toBe("saved")
      expect(makeLane(["q:x"], env()).kind).toBe("search")
      expect(makeLane(["news", "q:x"], env()).kind).toBe("search")
      expect(makeLane(["news"], env()).kind).toBe("members")
      expect(makeLane(["q:x", "news", "1"], env()).kind).toBe("members")
   })

   it("folds unread-only into a membership lane it builds, and only then", () => {
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
      expect([...makeLane(["news"], env(true)).members]).toEqual([
         [1, 3],
         [2, 0],
      ])
      expect(makeLane([], env(true)).members.get(1)).toBe(3)
      expect(makeLane(["news"], env(false)).members.get(1)).toBe(0)
   })

   it("falls back to [ALL] for an unresolved token", () => {
      const nope = makeLane(["nope"], env(), { keepKnownEmpty: true })
      expect([nope.kind, nope.tokens]).toEqual(["all", []])
      expect(makeLane(["empty"], env()).kind).toBe("all")
      expect(makeLane(["empty", "nope"], env(), { keepKnownEmpty: true }).kind).toBe("all")
   })

   it("builds a watch lane only for a rule the store lists", () => {
      expect(makeLane(["w:hot"], env()).kind).toBe("watch")
      const gone = makeLane(["w:gone"], env(), { keepKnownEmpty: true })
      expect([gone.kind, gone.tokens]).toEqual(["all", []])
      expect(makeLane(["w:hot", "1"], env()).kind).toBe("members")
   })

   it("keeps a KNOWN empty feed or tag scoped to itself when asked (D8)", () => {
      const l = makeLane(["empty"], env(), { keepKnownEmpty: true })
      expect([l.kind, l.tokens, l.members.size]).toEqual(["members", ["empty"], 0])
   })
})
