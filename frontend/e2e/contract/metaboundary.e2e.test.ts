import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, srr, type FeedServer } from "../harness"
import { nItems, pubUnix, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// The 5,000-entry meta-shard boundary with a REAL writer (the contract layer's
// only finalized meta shard — the stress layer covers scale, but opt-in): 5,001
// articles in one fetch finalize shard 0 (bloom header + 5,000 entries),
// publish the bloom summary s1, and leave a 1-entry latest tail. The real
// reader must see full coverage (mp/mt), read cards across the shard→tail seam,
// and search across BOTH the bloom-pruned finalized shard and the tail.
// (~2s: the writer handles 5k items in one cycle — itself worth pinning.)
//
// startIdx is NEGATIVE so all 5,001 hourly pubDates stay in the past (the
// backend clamps future dates, which would scramble chron order).

const N = 5001
const START = -N

describe("contract: meta shard boundary (5,001 articles)", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   let search: typeof import("../../src/js/search")

   beforeAll(async () => {
      feeds = await feedServer({ "/big.xml": rssFeed("Big", nItems(N, "meta", 0, START)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Big", "-u", `${feeds.url}/big.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
      // Same fresh module registry as the mounted data/nav (import order
      // matters — after mountReader's resetModules), so search.ts sees the
      // same data.ts instance and the same fetch shim.
      search = await import("../../src/js/search")
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("publishes the boundary layout: finalized shard + bloom summary + 1-entry tail", () => {
      const raw = readDb<{ total_art: number; mp?: number; mt?: number; hdrs?: number }>(store)
      expect(raw.total_art).toBe(N)
      expect(raw.mp).toBe(1) // meta/0.gz finalized, covered by the summary
      expect(raw.mt).toBe(1) // the single article past the boundary
      expect(raw.hdrs).toBeUndefined() // still zero finalized IDX packs (5,001 < 50,000)
      expect(existsSync(join(store, "meta/0.gz"))).toBe(true)
      expect(existsSync(join(store, "meta/s1.gz"))).toBe(true)
      expect(existsSync(join(store, "meta/L1.gz"))).toBe(true)
   })

   it("the reader sees full coverage and counts through the boundary", () => {
      expect(reader.data.metaReady()).toBe(true)
      expect(reader.data.numFinalizedMeta()).toBe(1)
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(N)
   })

   it("meta cards read correctly across the shard, the head window, and the seam", async () => {
      // chron == item index (single feed, published ascending). 0 and 2500 come
      // from the finalized shard; 4999/5000 sit in the db.gz head window
      // (newest headMax=40), the zero-fetch newest-glance path — both sources
      // must agree with the writer.
      for (const chron of [0, 2500, 4999, 5000]) {
         const card = await reader.data.loadMeta(chron)
         expect(card.t, `card ${chron} title`).toBe(`meta title ${chron}`)
         expect(card.w, `card ${chron} when`).toBe(pubUnix(START + chron))
         expect(card.f).toBe(0)
      }
   })

   it("search finds hits in the finalized shard AND the tail; absent terms miss", async () => {
      expect(search.available()).toBe(true)
      const collect = async (q: string) => {
         const out: number[] = []
         for await (const batch of search.search(q)) out.push(...batch.map((h) => h.chron))
         return out
      }
      expect(await collect("4999")).toEqual([4999]) // deep in the finalized shard
      expect(await collect("5000")).toEqual([5000]) // the tail's only entry
      expect(await collect("zzzquux")).toEqual([]) // bloom prunes / no match
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
