import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Two sequential fetches. The second feed re-presents every old item, adds two
// new ones, and includes a duplicate GUID. Asserts the backend dedup/watermark
// only appends the new items, the latest-pack generation (seq) advances — the
// first batch publishes generation 1, the second generation 2 — and the reader
// still round-trips all articles in published order.

describe("contract: incremental fetch + dedup + seq", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   let seq1: number
   let total1: number
   const all = nItems(5, "alpha") // published hours 0..4

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Alpha", all.slice(0, 3)) }) // items 0,1,2
      store = makeStore()
      await srr(store, "chan", "add", "-t", "Alpha", "-u", `${feeds.url}/a.xml`)
      await srr(store, "art", "fetch")

      const r1 = await mountReader(store)
      seq1 = r1.data.db.seq
      total1 = r1.data.db.total_art

      // Re-present all old items + 2 new + a duplicate GUID of item 2.
      feeds.set("/a.xml", rssFeed("Alpha", [...all, all[2]]))
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("first fetch stored only the initial items and published generation 1", () => {
      expect(total1).toBe(3)
      expect(seq1).toBe(1)
   })

   it("second fetch appended new-only (dedup held) and advanced seq", () => {
      expect(reader.data.db.total_art).toBe(5)
      expect(reader.data.db.seq).toBe(2)
   })

   it("all chronIdx round-trip in published order with no duplicates", async () => {
      const links: string[] = []
      for (let i = 0; i < 5; i++) {
         const art = await reader.data.loadArticle(i)
         expect(art.t).toBe(all[i].title)
         expect(art.l).toBe(all[i].link)
         links.push(art.l)
      }
      expect(new Set(links).size).toBe(5)
   })

   it("backend inspect --validate agrees after the generation advance", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
