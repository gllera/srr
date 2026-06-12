import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, pubUnix, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Two channels fetched into one store, then read back through the real
// idx.ts/data.ts. Asserts the central contract: every chronIdx maps to the
// right article (title/link/content/published/channel) and the global order is
// published-ascending (cmd_fetch.go sorts articles asc before PutArticles).

interface Expected {
   chanId: number
   title: string
   link: string
   content: string
   p: number
}

describe("contract: round-trip", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   const expected: Expected[] = []

   beforeAll(async () => {
      const alpha = nItems(3, "alpha", 0, 0) // published hours 0,1,2
      const beta = nItems(2, "beta", 0, 10) // published hours 10,11 (disjoint range)
      feeds = await feedServer({
         "/alpha.xml": rssFeed("Alpha", alpha),
         "/beta.xml": rssFeed("Beta", beta),
      })
      store = makeStore()
      await srr(store, "chan", "add", "-t", "Alpha", "-u", `${feeds.url}/alpha.xml`)
      await srr(store, "chan", "add", "-t", "Beta", "-u", `${feeds.url}/beta.xml`)
      await srr(store, "art", "fetch")

      alpha.forEach((it, i) => expected.push({ chanId: 0, title: it.title, link: it.link, content: it.content, p: pubUnix(i) }))
      beta.forEach((it, i) => expected.push({ chanId: 1, title: it.title, link: it.link, content: it.content, p: pubUnix(10 + i) }))
      expected.sort((a, b) => a.p - b.p)

      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("db reflects fetched totals", () => {
      expect(reader.data.db.total_art).toBe(expected.length)
      expect(reader.data.db.channels[0].total_art).toBe(3)
      expect(reader.data.db.channels[1].total_art).toBe(2)
   })

   it("every chronIdx round-trips through the real reader", async () => {
      for (let i = 0; i < expected.length; i++) {
         expect(await reader.data.getChannelId(i), `getChannelId(${i})`).toBe(expected[i].chanId)
         const art = await reader.data.loadArticle(i)
         expect(art.s, `article ${i} chan`).toBe(expected[i].chanId)
         expect(art.t, `article ${i} title`).toBe(expected[i].title)
         expect(art.l, `article ${i} link`).toBe(expected[i].link)
         expect(art.c, `article ${i} content`).toBe(expected[i].content)
         expect(art.p, `article ${i} published`).toBe(expected[i].p)
      }
   })

   it("backend inspect --validate agrees with the pack layout", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
