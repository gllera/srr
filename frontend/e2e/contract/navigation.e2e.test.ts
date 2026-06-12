import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Filtering/navigation over real idx packs: drive the real nav state machine
// (switchFilter/right) and the data filter primitives (findRight/findLeft/
// countLeft) and assert the traversed chronIdx set matches the channel/tag
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

   const walkRight = (channels: Map<number, number>): number[] => {
      const out: number[] = []
      for (let i = reader.data.findRight(0, channels); i !== -1; i = reader.data.findRight(i + 1, channels)) out.push(i)
      return out
   }

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/tech.xml": rssFeed("Tech", tech),
         "/sport.xml": rssFeed("Sport", sport),
      })
      store = makeStore()
      await srr(store, "chan", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(store, "chan", "add", "-t", "Tech", "-g", "world", "-u", `${feeds.url}/tech.xml`)
      await srr(store, "chan", "add", "-t", "Sport", "-g", "play", "-u", `${feeds.url}/sport.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("tag filter scans exactly the tagged channels' articles", () => {
      reader.nav.filter.set(["world"])
      expect(walkRight(reader.nav.filter.channels)).toEqual([0, 1, 2, 3])
      expect(reader.data.countLeft(reader.data.db.total_art, reader.nav.filter.channels)).toBe(4)
      expect(reader.data.findLeft(5, reader.nav.filter.channels)).toBe(3)
   })

   it("single-channel filter scans only that channel", () => {
      reader.nav.filter.set(["0"]) // News
      expect(walkRight(reader.nav.filter.channels)).toEqual([0, 1])
      expect(reader.data.countLeft(reader.data.db.total_art, reader.nav.filter.channels)).toBe(2)
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
})
