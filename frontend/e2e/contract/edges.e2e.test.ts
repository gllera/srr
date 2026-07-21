import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
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

// Reader-robustness edges over one real store: an out-of-range deep link
// clamps to the LAST article (not the first, not an error), a multi-token
// hash (tag + feed id — the URL-only mixed filter) resolves through the one
// membership rule, and a corrupt pack rejects cleanly AND retries once the
// bytes are good again (a rejected cachedPromise slot must not stay poisoned).

describe("contract: robustness edges", () => {
   let feeds: FeedServer
   let store: string

   // Disjoint ranges → chron 0,1 news (tag world) · 2,3 tech · 4,5 sport (tag world).
   const news = nItems(2, "news", 0, 0)
   const tech = nItems(2, "tech", 0, 10)
   const sport = nItems(2, "sport", 0, 20)

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/tech.xml": rssFeed("Tech", tech),
         "/sport.xml": rssFeed("Sport", sport),
      })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(store, "feed", "add", "-t", "Tech", "-u", `${feeds.url}/tech.xml`)
      await srr(store, "feed", "add", "-t", "Sport", "-g", "world", "-u", `${feeds.url}/sport.xml`)
      await srr(store, "art", "fetch")
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   // fromHash receives the hash WITHOUT the leading "#" — app.ts's route()
   // strips it before dispatching (a "#…" string would parse as NaN and mask
   // the very clamp under test with the same last-article landing).

   it("an out-of-range deep link clamps to the LAST article", async () => {
      const reader = await mountReader(store)
      // A valid mid-range position is honored exactly…
      expect((await reader.nav.fromHash("2")).article.t).toBe("tech title 0")
      expect(reader.nav.currentChron()).toBe(2)
      // …while an out-of-range one clamps to the last, not the first.
      const o = await reader.nav.fromHash("999999")
      expect(o.article.t).toBe("sport title 1") // total_art-1, not 0
      expect(reader.nav.currentChron()).toBe(5)
   })

   it("a multi-token hash (tag + feed id) resolves the union membership", async () => {
      const reader = await mountReader(store)
      // world (news 0 + sport 2) + feed id 1 (tech) — every article matches.
      const o = await reader.nav.fromHash("0!world+1")
      expect(o.article.t).toBe("news title 0")
      expect(reader.nav.getCurrentFilterKey()).toBe("") // multi-token: no single key
      expect([...reader.nav.filter.feeds.keys()].sort()).toEqual([0, 1, 2])

      // Drop tech from the filter: the walk must skip its chrons entirely.
      reader.nav.filter.set(["world"])
      const visited: number[] = []
      for (
         let i = await reader.data.findRight(0, reader.nav.filter.feeds);
         i !== -1;
         i = await reader.data.findRight(i + 1, reader.nav.filter.feeds)
      )
         visited.push(i)
      expect(visited).toEqual([0, 1, 4, 5]) // news + sport, chron order, no tech
   })

   it("a corrupt pack rejects cleanly and recovers once the bytes are good again", async () => {
      const pack = join(store, "data/L1.gz")
      const backup = join(store, "data-L1.bak")
      copyFileSync(pack, backup)
      try {
         writeFileSync(pack, "these are not gzip bytes")
         const reader = await mountReader(store) // idx loads fine; data is lazy
         // DecompressionStream chokes on the garbage → a clean rejection, not a hang.
         await expect(reader.data.loadArticle(0)).rejects.toThrow()
         // Restore the real bytes: the SAME mounted reader must recover — a
         // rejected promise is dropped from its LRU slot, so the retry refetches.
         copyFileSync(backup, pack)
         expect((await reader.data.loadArticle(0)).t).toBe("news title 0")
      } finally {
         copyFileSync(backup, pack)
         rmSync(backup, { force: true })
      }
   })

   // Version skew is the one case the reader must NOT try to muddle through:
   // a db.gz stamped past DB_FORMAT_VERSION may have moved fields this build
   // would misread, so init rejects with a legible message (the error-popup
   // path) instead of rendering something wrong.
   it("refuses a db.gz written by a newer srr", async () => {
      const future = gzipSync(
         Buffer.from(
            JSON.stringify({ ...JSON.parse(gunzipSync(readFileSync(join(store, "db.gz"))).toString()), v: 99 }),
         ),
      )
      await expect(
         mountReader(store, async (path, serve) =>
            path === "db.gz" ? new Response(new Uint8Array(future), { status: 200 }) : serve(),
         ),
      ).rejects.toThrow(/older than the store/)
      // The store's own (current-version) db.gz still mounts — the gate is the
      // version, not the presence of the field.
      const reader = await mountReader(store)
      expect(reader.data.db.total_art).toBe(6)
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
