import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// This suite pins LEGACY tail mechanics (per-cycle consolidated L<seq> packs,
// meta-series coverage, GC grace windows): run the writer with the delta kill
// switch so every dirty cycle consolidates, as the pre-delta writer did.
// Delta-chain behavior has its own suite (delta.e2e.test.ts) and rides every
// OTHER suite through the default --max-deltas.
process.env.SRR_MAX_DELTAS = "0"

// Force the data series to split into multiple packs (tiny --pack-size + bulky
// content). This is the core getPackRef test: every chronIdx must resolve to the
// right (packId, offset) across finalized packs (data/1.gz, data/2.gz, …) AND
// the latest generation pack (data/L<seq>.gz) — including the never-produced
// data/0.gz edge.

describe("contract: multi data-pack split", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   // One feed, published-ascending = chronIdx order. Content is incompressible
   // (high-entropy) so the gzip data buffer actually flushes and rolls packs —
   // ~240KB total reliably produces several finalized packs under -s 1.
   const items = nItems(30, "big", 8000)

   beforeAll(async () => {
      feeds = await feedServer({ "/big.xml": rssFeed("Big", items) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Big", "-u", `${feeds.url}/big.xml`)
      // -s 1 = 1KB target; finalized packs roll as the gzip buffer flushes.
      await srr(store, "-s", "1", "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("produced several finalized data packs", () => {
      expect(reader.data.db.total_art).toBe(items.length)
      // next_pid advances past 1 only when finalized packs exist beyond the latest.
      expect(reader.data.db.next_pid).toBeGreaterThan(1)
   })

   it("every chronIdx resolves the correct pack+offset and content", async () => {
      for (let i = 0; i < items.length; i++) {
         const art = await reader.data.loadArticle(i)
         expect(art.t, `article ${i} title`).toBe(items[i].title)
         expect(art.l, `article ${i} link`).toBe(items[i].link)
         expect(art.c, `article ${i} content`).toBe(items[i].content)
         expect(await reader.data.getFeedId(i)).toBe(0)
      }
   })

   it("backend inspect --validate agrees across pack boundaries", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
