import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// `srr inspect` is the Go-side mirror of the frontend parser (idx.ts parse +
// data.ts getPackRef + nav filter math). Running its modes against a real
// multi-channel, multi-pack store keeps that mirror honest and exercises the
// --chron / --filter code paths the other scenarios don't.

describe("contract: inspect cross-check", () => {
   let feeds: FeedServer
   let store: string

   beforeAll(async () => {
      // Incompressible content + many items → genuinely multiple data packs, so
      // the Go validator's bounds-vs-data / continuity checks span pack boundaries.
      const news = nItems(16, "news", 8000, 0)
      const tech = nItems(16, "tech", 8000, 100)
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/tech.xml": rssFeed("Tech", tech),
      })
      store = makeStore()
      await srr(store, "chan", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(store, "chan", "add", "-t", "Tech", "-g", "world", "-u", `${feeds.url}/tech.xml`)
      await srr(store, "-s", "1", "art", "fetch") // small packs → multiple data packs
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("--validate passes on a multi-channel, multi-pack store", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })

   it("--chron resolves a single entry without error", async () => {
      const out = await srr(store, "inspect", "--chron", "0")
      expect(out.length).toBeGreaterThan(0)
   })

   it("--filter resolves a tag without error", async () => {
      const out = await srr(store, "inspect", "--filter", "world")
      expect(out.length).toBeGreaterThan(0)
   })
})
