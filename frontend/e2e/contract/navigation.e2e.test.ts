import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Filtering/navigation over real idx packs: drive the real nav state machine
// (switchFilter/right) and the data filter primitives (findRight/findLeft/
// countLeft) and assert the traversed chronIdx set matches the feed/tag
// subset — the contract `srr inspect --filter` mirrors in Go.

describe("contract: filtering & navigation", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>

   // Disjoint published ranges → global chronIdx order is fully determined:
   // news0,news1 (0,1) · tech0,tech1 (2,3) · sport0,sport1 (4,5).
   const news = nItems(2, "news", 0, 0)
   const tech = nItems(2, "tech", 0, 10)
   const sport = nItems(2, "sport", 0, 20)

   const walkRight = async (feeds: Map<number, number>): Promise<number[]> => {
      const out: number[] = []
      for (let i = await reader.data.findRight(0, feeds); i !== -1; i = await reader.data.findRight(i + 1, feeds))
         out.push(i)
      return out
   }

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/tech.xml": rssFeed("Tech", tech),
         "/sport.xml": rssFeed("Sport", sport),
      })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(store, "feed", "add", "-t", "Tech", "-g", "world", "-u", `${feeds.url}/tech.xml`)
      await srr(store, "feed", "add", "-t", "Sport", "-g", "play", "-u", `${feeds.url}/sport.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("tag filter scans exactly the tagged feeds' articles", async () => {
      reader.nav.filter.set(["world"])
      expect(await walkRight(reader.nav.filter.feeds)).toEqual([0, 1, 2, 3])
      expect(await reader.data.countLeft(reader.data.db.total_art, reader.nav.filter.feeds)).toBe(4)
      expect(reader.data.countAll(reader.nav.filter.feeds)).toBe(4)
      expect(await reader.data.findLeft(5, reader.nav.filter.feeds)).toBe(3)
   })

   it("single-feed filter scans only that feed", async () => {
      reader.nav.filter.set(["0"]) // News
      expect(await walkRight(reader.nav.filter.feeds)).toEqual([0, 1])
      expect(await reader.data.countLeft(reader.data.db.total_art, reader.nav.filter.feeds)).toBe(2)
      expect(reader.data.countAll(reader.nav.filter.feeds)).toBe(2)
   })

   it("nav.switchFilter + right() visits the tag subset in chronIdx order", async () => {
      localStorage.clear() // no resume position → start at first match
      const first = await reader.nav.switchFilter("world")
      const visited = [first.article.l]
      for (;;) {
         try {
            visited.push((await reader.nav.right()).article.l)
         } catch {
            break
         }
      }
      expect(visited).toEqual([...news.map((i) => i.link), ...tech.map((i) => i.link)])
   })

   it("backend inspect --validate + --filter agree", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })

   // Badge↔pill contract over real packs — the reported counting bugs, pinned
   // end-to-end: the reader's next-pill (IShowFeed.right_count) must equal the
   // picker badge sum on every recorded landing, sit exactly one below it on an
   // unrecorded resume (the badge counts the not-yet-consumed on-screen
   // article), tick by exactly 1 on the first → (the −2 double-drop), and
   // never count read-ahead articles (the pill-above-badge mismatch).
   it("pill ≡ badge when recorded, −1 tick from an unrecorded resume, read-ahead excluded", async () => {
      const badge = async () => {
         const members = [...reader.nav.filter.feeds.keys()].map((id) => reader.data.db.feeds[id])
         return reader.nav.tagUnreadFromCounts(members, await reader.nav.unreadCounts(members))
      }
      localStorage.clear()
      // Tech (feed 1, chron 2-3) read to its end — the read-ahead lane.
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 3 }))

      // [ALL] resumes at the oldest unread (news0, chron 0) without recording:
      // unread = news {0,1} + sport {4,5}; the pill counts the 3 ahead.
      const entry = await reader.nav.switchFilter("")
      expect(reader.nav.currentChron()).toBe(0)
      expect(await badge()).toBe(4)
      expect(entry.right_count).toBe(3)

      // The first → consumes the entry AND the landing (account on ENTER) —
      // the pill still ticks by exactly 1, and parity holds once recorded.
      const second = await reader.nav.right() // news1 (chron 1), recorded
      expect(second.right_count).toBe(2)
      expect(await badge()).toBe(2)

      // Stepping onto the read tech lane: a step exists (has_right) but the
      // pill holds at the unread count — read-ahead is never counted.
      const third = await reader.nav.right() // tech0 (chron 2), already read
      expect(third.has_right).toBe(true)
      expect(third.right_count).toBe(2)
      expect(await badge()).toBe(2)
   })
})
