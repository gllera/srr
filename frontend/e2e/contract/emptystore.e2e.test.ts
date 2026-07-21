import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, srr, storeNames, type FeedServer } from "../harness"
import { nItems, pubUnix, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// The empty-store contract, against REAL bytes: a store that has feeds but has
// never ingested an article publishes a db.gz whose omitempty fields (seq,
// hdrs, mp, mt, gen…) are ABSENT, and no pack of any series exists yet. The
// real reader must boot on that (db.gz only — no idx/meta/latest fetch, no
// guarded reload), report zero everywhere, and keep search off. Then the first
// article-producing fetch publishes generation 1 and the SAME mounted reader
// adopts it in place via data.refresh() — the empty→first-batch transition.
//
// Ordered mutate→refresh→assert sequence (like refresh.e2e.test.ts): the
// temporal progression IS the contract under test.

interface RawDb {
   seq?: number
   hdrs?: number
   mp?: number
   mt?: number
   gen?: number
   total_art?: number
   next_pid?: number
}

describe("contract: empty store boot + first-batch transition", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   let emptyValidate = ""

   beforeAll(async () => {
      feeds = await feedServer({ "/empty.xml": rssFeed("Empty", []) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Empty", "-u", `${feeds.url}/empty.xml`)
      await srr(store, "art", "fetch") // zero items — nothing published
      emptyValidate = await inspectValidate(store) // captured while still empty
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("an empty store names nothing", () => {
      const raw = readDb<RawDb>(store)
      expect(raw.total_art ?? 0).toBe(0)
      expect(raw.mt).toBeUndefined()
      const names = storeNames(store)
      expect(names.idx.keys).toEqual([])
      expect(names.meta.keys).toEqual([])
      expect(names.deltas).toEqual([])
      expect(names.hsum).toBeNull()
      expect(names.ssum).toBeNull()
   })

   it("the reader boots on the root + its manifest alone: no pack fetch", () => {
      expect(reader.data.db.total_art).toBe(0)
      const urls = reader.fetchMock.mock.calls.map((c) => String((c[0] as { href?: string }).href ?? c[0]))
      expect(urls.length).toBeGreaterThan(0)
      for (const u of urls) {
         expect(u.includes("db.gz") || /manifest\/\d+\.gz/.test(u), `empty-store boot touched ${u}`).toBe(true)
      }
   })

   it("zero everywhere: counts, meta, search", () => {
      expect(reader.data.countAll(new Map())).toBe(0)
      expect(reader.data.hasArticles()).toBe(false)
      expect(reader.data.metaReady()).toBe(false) // gate: list falls back, search stays off
      expect(reader.nav.searchAvailable()).toBe(false)
      // total_art===0 feeds are dropped by the default grouping (nav's cycle must
      // never land on an empty feed) but kept by includeEmpty (the picker).
      expect(reader.data.groupFeedsByTag().untagged.length).toBe(0)
      expect(reader.data.groupFeedsByTag(true).untagged.length).toBe(1)
   })

   it("the first article-producing fetch publishes generation 1 and refresh() adopts it", async () => {
      feeds.set("/empty.xml", rssFeed("Empty", nItems(2, "first")))
      await srr(store, "art", "fetch")

      // The first article-producing cycle publishes one delta segment.
      expect(storeNames(store).deltas).toHaveLength(1)
      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(2)
      expect(reader.data.countAll(new Map([[0, reader.data.db.feeds[0].add_idx]]))).toBe(2)

      const art = await reader.data.loadArticle(0)
      expect(art.t).toBe("first title 0")
      expect(art.p).toBe(pubUnix(0))
      expect(reader.data.metaReady()).toBe(true)
      expect(reader.nav.searchAvailable()).toBe(true)
   })

   it("backend inspect --validate agrees in both states", async () => {
      // The empty store validates clean (exit 0 — srr() throws otherwise) with
      // the explicit "no articles" report; the populated store gets the full OK.
      expect(emptyValidate).toContain("no articles")
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
