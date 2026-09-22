import { beforeEach, describe, expect, it, vi } from "vitest"

const data = vi.hoisted(() => ({
   db: { total_art: 6, feeds: {} as Record<number, IFeed> } as unknown as IDB,
   feedTitle: vi.fn(() => "x"),
   findLeft: vi.fn(async () => -1),
   findRight: vi.fn(async () => -1),
   getFeedId: vi.fn(async () => 1),
   activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
}))
vi.mock("../data", () => data)

import { toggleSaved } from "../saved"
import { SavedLane } from "./lane-saved"

const lane = () => new SavedLane(["~saved"])

beforeEach(() => {
   localStorage.clear()
   // Save ORDER, not chron order: 4 was saved first, then 1, then 3.
   localStorage.setItem("srr-saved", JSON.stringify([4, 1, 3]))
   vi.clearAllMocks()
})

describe("SavedLane", () => {
   it("is a feed-agnostic peek lane in save order", () => {
      const l = lane()
      expect([l.kind, l.key, l.peek, l.dividers, l.chronOrdered]).toEqual(["saved", "~saved", true, false, false])
      expect(l.members.size).toBe(0)
      expect(l.entryAnchor()).toBe(-1)
   })

   it("matches set membership, whatever the feed", () => {
      expect(lane().matches(99, 1)).toBe(true)
      expect(lane().matches(1, 2)).toBe(false)
   })

   it("steps by save index, never by chron value", async () => {
      const l = lane()
      expect(await l.newer(4)).toBe(1)
      expect(await l.older(1)).toBe(4)
      expect(await l.newer(3)).toBe(-1)
      expect(await l.older(4)).toBe(-1)
   })

   it("is a queue: front, back, anchor at the front, a countdown ahead", async () => {
      const l = lane()
      expect([await l.oldest(), await l.newest(), await l.anchor()]).toEqual([4, 3, 4])
      expect([await l.ahead(4), await l.ahead(1), await l.ahead(3), await l.ahead(2)]).toEqual([2, 1, 0, 0])
      localStorage.setItem("srr-saved", "[]")
      expect([await l.oldest(), await l.newest()]).toEqual([-1, -1])
   })

   it("keeps answering for the article just un-saved on screen (the saved.ts ghost)", async () => {
      toggleSaved(1, { savedMode: true, pos: 1, onQueueChange: () => {} })
      const l = lane()
      expect(await l.older(1)).toBe(4)
      expect(await l.newer(1)).toBe(3)
      expect(await l.ahead(1)).toBe(1)
   })

   it("admits a member of the set and nothing else, and never knows an unread", async () => {
      expect(await lane().admits(4)).toBe(true)
      expect(await lane().admits(2)).toBe(false)
      expect(await lane().admits(9)).toBe(false) // out of range
      expect(await lane().firstUnread()).toEqual({ chron: -1, known: false })
   })

   it("lands a switch on the front of the queue", async () => {
      expect(await lane().entry()).toEqual({ land: 4 })
      localStorage.setItem("srr-saved", "[]")
      expect(await lane().entry()).toEqual({ land: -1 })
   })

   it("answers the value seam as a walk over no feeds, as feedLeft/feedRight always did here", async () => {
      expect(await lane().atOrBelow(5)).toBe(-1)
      expect(await lane().atOrAbove(0)).toBe(-1)
      expect(data.findLeft).not.toHaveBeenCalled()
      expect(data.findRight).not.toHaveBeenCalled()
   })
})
