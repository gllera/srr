import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Four article-producing fetches advance the latest-pack generation to L4.
// The backend GC (keep=2, run after every fetch commit) must have dropped
// generation 1 while keeping the grace window 2..4, and the reader must still
// round-trip every article from the surviving current generation.

describe("contract: latest-pack GC grace window", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   const all = nItems(8, "gc") // published hours 0..7

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("GC", all.slice(0, 2)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "GC", "-u", `${feeds.url}/a.xml`)
      await srr(store, "art", "fetch")

      // Three more fetches, each re-presenting everything + 2 new items
      // (watermark dedup appends new-only, so each fetch publishes one
      // generation).
      for (const n of [4, 6, 8]) {
         feeds.set("/a.xml", rssFeed("GC", all.slice(0, n)))
         await srr(store, "art", "fetch")
      }
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("kept the grace window and dropped expired generations", () => {
      expect(reader.data.db.seq).toBe(4)
      expect(reader.data.db.total_art).toBe(8)
      for (const prefix of ["idx", "data"]) {
         expect(existsSync(join(store, prefix, "L1.gz")), `${prefix}/L1.gz should be GC'd`).toBe(false)
         for (const g of [2, 3, 4]) {
            expect(existsSync(join(store, prefix, `L${g}.gz`)), `${prefix}/L${g}.gz should survive`).toBe(true)
         }
      }
   })

   it("reader round-trips all articles from the current generation", async () => {
      for (let i = 0; i < 8; i++) {
         const art = await reader.data.loadArticle(i)
         expect(art.t).toBe(all[i].title)
         expect(art.l).toBe(all[i].link)
      }
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
