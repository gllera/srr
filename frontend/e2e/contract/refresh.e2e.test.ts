import { renameSync, rmSync } from "node:fs"
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

// The live content-sync contract: ONE mounted reader instance adopts a second
// backend fetch cycle in place via data.refresh() — no remount, no reload —
// and navigates to the new articles.
//
// DELIBERATE DEVIATION from the sibling contract suites (all mutations in
// beforeAll, independent `it`s): here the `it`s form an ORDERED SEQUENCE —
// each mutates the store, then asserts the same live reader adopts the change
// — because that temporal mutate→refresh→assert progression IS the contract
// under test. They must not be reordered, isolated, or run shuffled.

describe("contract: in-place refresh across a fetch cycle", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   const all = nItems(5, "alpha")

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Alpha", all.slice(0, 3)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Alpha", "-u", `${feeds.url}/a.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("refresh() with no backend run is 'unchanged'", async () => {
      expect(await reader.data.refresh()).toBe("unchanged")
      expect(reader.data.db.total_art).toBe(3)
   })

   it("adopts a new fetch cycle in place: totals, generation, and new-article navigation", async () => {
      const before = reader.data.db.m ?? 0
      feeds.set("/a.xml", rssFeed("Alpha", all))
      await srr(store, "art", "fetch")
      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(all.length)
      expect(reader.data.db.m ?? 0).toBeGreaterThan(before)
      // The SAME instance reads the new articles (fresh latest pack, cleared caches).
      for (let i = 0; i < all.length; i++) expect((await reader.data.loadArticle(i)).t).toBe(all[i].title)
      // countAll over the full store reflects the growth without a remount.
      // Alpha is the only (and thus first) feed added, so its id is 0.
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(all.length)
      // The real nav state machine sees the grown store too: [ALL] now reaches
      // the newest of the 5 articles, not the 3 that existed at mount time.
      reader.nav.filter.clear()
      expect((await reader.nav.last()).article.t).toBe(all[4].title)
   })

   it("a second refresh with nothing new is 'unchanged' again", async () => {
      expect(reader.data.db.total_art).toBe(all.length) // guard: the second fetch cycle really landed
      expect(await reader.data.refresh()).toBe("unchanged")
   })

   it("a failed apply restores the previous snapshot and stays retryable", async () => {
      // Publish a 6th article. nItems is deterministic/seeded by (prefix, index),
      // so items 0..4 of this call are byte-identical to `all` — only index 5 is new.
      const extra = nItems(6, "alpha")
      feeds.set("/a.xml", rssFeed("Alpha", extra))
      await srr(store, "art", "fetch")

      // Take the tail idx pack the NEW generation names away, so applyDb's
      // fetch of it 404s. The name is listed, so read it from the manifest.
      const names = storeNames(store)
      const idxPath = join(store, names.idx.keys[names.idx.tail])
      const idxBak = `${idxPath}.bak`
      renameSync(idxPath, idxBak)

      // The root has already advanced by the time applyDb awaits the tail idx
      // pack fetch, which 404s on the renamed-away file.
      await expect(reader.data.refresh()).rejects.toThrow()

      // The reader must still be coherent on the OLD snapshot — not half-swapped
      // with a new db but stale idx structures.
      expect(reader.data.db.total_art).toBe(all.length)
      expect((await reader.data.loadArticle(all.length - 1)).t).toBe(all[all.length - 1].title)
      reader.nav.filter.clear()
      expect((await reader.nav.last()).article.t).toBe(all[all.length - 1].title)

      // Restore the pack; refresh() retries cleanly from the old fetched_at and
      // now adopts the 6th article.
      renameSync(idxBak, idxPath)
      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(all.length + 1)
      expect((await reader.data.loadArticle(all.length)).t).toBe(extra[all.length].title)
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
