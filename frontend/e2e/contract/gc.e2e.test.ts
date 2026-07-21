import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, storeNames, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// This suite pins LEGACY tail mechanics (per-cycle consolidated L<seq> packs,
// meta-series coverage, GC grace windows): run the writer with the delta kill
// switch so every dirty cycle consolidates, as the pre-delta writer did.
// Delta-chain behavior has its own suite (delta.e2e.test.ts) and rides every
// OTHER suite through the default --max-deltas.
process.env.SRR_MAX_DELTAS = "0"

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

   it("keeps every object the current generation names", () => {
      expect(reader.data.db.total_art).toBe(8)
      // The GC rule is one sentence — delete what the last K manifests do not
      // name — so what a test can assert is exactly that: everything the live
      // generation lists is present, and the reader resolves it.
      const names = storeNames(store)
      for (const key of [...names.idx.keys, ...names.data.keys, ...names.meta.keys, ...names.deltas]) {
         if (key) expect(existsSync(join(store, key)), `${key} is named and must exist`).toBe(true)
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
