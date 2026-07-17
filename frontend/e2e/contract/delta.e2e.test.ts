import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader, type FetchIntercept } from "./mount"

// The delta-segment tail contract (docs/DELTA-TAIL-SPEC.md §12.2): dirty
// cycles publish one immutable data/d<seq>.gz holding the whole batch, the
// reader keeps the chain resident and serves tail-region idx entries, meta
// cards, AND content from it with zero pack fetches, and a consolidation
// cycle folds the chain back into the L<tailGen> packs. Chain length is
// pinned at 2 so the third dirty cycle consolidates deterministically.
//
// DELIBERATE DEVIATION from the sibling suites (the refresh.e2e.test.ts
// precedent): the `it`s form an ordered publish→refresh→assert sequence —
// that temporal progression IS the contract under test.
process.env.SRR_MAX_DELTAS = "2"

const all = nItems(6, "deltaseek") // published hours 0..5

// Store-relative path of one shim fetch call (mirrors mount.ts's hrefOf).
function calledPaths(fetchMock: { mock: { calls: unknown[][] } }): string[] {
   return fetchMock.mock.calls.map(([input]) => {
      const obj = input as { href?: string; url?: string }
      return new URL(obj.href ?? obj.url ?? String(input)).pathname.replace(/^\/+/, "")
   })
}

describe("contract: delta-segment tail", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Delta", all.slice(0, 2)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Delta", "-u", `${feeds.url}/a.xml`)
      await srr(store, "art", "fetch") // cycle 1 → data/d1.gz (all-delta store, no tail packs yet)
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("publishes the first batch as a delta segment, not tail packs", () => {
      expect(reader.data.db.seq).toBe(1)
      expect(reader.data.db.nd).toBe(1)
      expect(reader.data.db.na).toBe(2)
      expect(existsSync(join(store, "data/d1.gz"))).toBe(true)
      expect(existsSync(join(store, "idx/L1.gz"))).toBe(false)
      expect(existsSync(join(store, "data/L1.gz"))).toBe(false)
      expect(existsSync(join(store, "meta/L1.gz"))).toBe(false)
   })

   it("boots from db.gz + the chain alone and serves everything resident", async () => {
      const boot = new Set(calledPaths(reader.fetchMock))
      expect(boot).toEqual(new Set(["db.gz", "data/d1.gz"]))

      const before = reader.fetchMock.mock.calls.length
      for (let chron = 0; chron < 2; chron++) {
         const a = await reader.data.loadArticle(chron)
         expect(a.t).toBe(all[chron].title)
         const card = await reader.data.loadMeta(chron)
         expect(card.f).toBe(a.f)
         expect(card.t).toBe(a.t)
      }
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(2)
      // The whole point: tail-region reads cost zero further requests.
      expect(reader.fetchMock.mock.calls.length).toBe(before)
   })

   it("offers search over the resident chain (metaReady counts na)", async () => {
      expect(reader.data.metaReady()).toBe(true)
      const search = await import("../../src/js/search")
      const hits = await search.loadHits("deltaseek", 50)
      expect(hits.chrons).toEqual([0, 1])
   })

   it("backend inspect --validate agrees on the mid-chain store", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })

   it("a second delta cycle reaches an open tab as db.gz + delta segments only", async () => {
      feeds.set("/a.xml", rssFeed("Delta", all.slice(0, 4)))
      await srr(store, "art", "fetch") // cycle 2 → data/d2.gz (nd=2)

      reader.fetchMock.mock.calls.length = 0
      expect(await reader.data.refresh()).toBe("updated")
      // The wholesale applyDb re-fetches the chain (d1 rides the SW/HTTP
      // cache in production — write-once names); the contract here is that NO
      // tail/idx/meta pack is touched.
      expect(new Set(calledPaths(reader.fetchMock))).toEqual(new Set(["db.gz", "data/d1.gz", "data/d2.gz"]))
      expect(reader.data.db.nd).toBe(2)

      const before = reader.fetchMock.mock.calls.length
      const a = await reader.data.loadArticle(3)
      expect(a.t).toBe(all[3].title)
      expect(reader.fetchMock.mock.calls.length).toBe(before)
   })

   it("the chain-cap cycle consolidates into L<seq> and the tab adopts it", async () => {
      feeds.set("/a.xml", rssFeed("Delta", all))
      await srr(store, "art", "fetch") // cycle 3: nd == MAX_DELTAS → consolidation

      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.seq).toBe(3)
      expect(reader.data.db.nd ?? 0).toBe(0)
      expect(reader.data.db.na ?? 0).toBe(0)
      expect(reader.data.db.mt).toBe(6)
      for (const name of ["idx/L3.gz", "data/L3.gz", "meta/L3.gz"]) {
         expect(existsSync(join(store, name)), `${name} after consolidation`).toBe(true)
      }
      // The consolidated deltas survive as the stale-tab grace window.
      expect(existsSync(join(store, "data/d1.gz"))).toBe(true)
      expect(existsSync(join(store, "data/d2.gz"))).toBe(true)

      for (let chron = 0; chron < 6; chron++) {
         const a = await reader.data.loadArticle(chron)
         expect(a.t).toBe(all[chron].title)
      }
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })

   it("a fresh boot after consolidation fetches no delta segments", async () => {
      const fresh = await mountReader(store)
      const paths = calledPaths(fresh.fetchMock)
      expect(paths.some((p) => /^data\/d\d+\.gz$/.test(p))).toBe(false)
      expect(paths).toContain("idx/L3.gz")
      const a = await fresh.data.loadArticle(5)
      expect(a.t).toBe(all[5].title)
   })

   it("a mount whose chain was GC'd under it fails loudly (guarded-reload path)", async () => {
      // Simulate a tab far past the grace window: db.gz still names d<g>
      // segments that no longer exist. init must reject through assertPackOk
      // (isLatest → the sessionStorage-guarded reload), never mis-serve.
      const feeds2 = await feedServer({ "/a.xml": rssFeed("Gone", all.slice(0, 2)) })
      const store2 = makeStore()
      try {
         await srr(store2, "feed", "add", "-t", "Gone", "-u", `${feeds2.url}/a.xml`)
         await srr(store2, "art", "fetch")
         rmSync(join(store2, "data/d1.gz"))
         await expect(mountReader(store2)).rejects.toThrow(/pack fetch failed: 404/)
      } finally {
         await feeds2.close()
         rmSync(store2, { recursive: true, force: true })
      }
   })
})

// A transient (NON-404) delta-fetch failure during a live refresh must roll
// the reader back WHOLESALE — including the resident delta chain. applyDb
// wipes deltaArts=[] before re-fetching the new chain, so if refresh()'s
// snapshot/restore omitted deltaArts/deltaLoad, a rolled-back tab would keep
// db (na>0) but an empty chain, and every tail-region read would throw "out
// of sync" until a full reload. A rejection (network drop / timeout), unlike
// a 404, does NOT take the guarded-reload path, so nothing else repairs it.
describe("contract: delta chain survives a failed refresh", () => {
   let feeds: FeedServer
   let store: string
   let failDeltas = false
   const intercept: FetchIntercept = async (pathname, serve) => {
      if (failDeltas && /^data\/d\d+\.gz$/.test(pathname)) {
         throw new Error(`simulated network failure fetching ${pathname}`)
      }
      return serve()
   }

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Delta", all.slice(0, 2)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Delta", "-u", `${feeds.url}/a.xml`)
      await srr(store, "art", "fetch") // cycle 1 → data/d1.gz (na=2, all-delta)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("keeps the old chain resident when the new chain fetch rejects mid-apply", async () => {
      const reader = await mountReader(store, intercept)
      // Sanity: the newest article is resident and readable before the refresh.
      expect((await reader.data.loadArticle(1)).t).toBe(all[1].title)

      // A newer snapshot lands, but the network drops on the delta segments.
      feeds.set("/a.xml", rssFeed("Delta", all.slice(0, 4)))
      await srr(store, "art", "fetch") // cycle 2 → data/d2.gz (na=4)
      failDeltas = true
      await expect(reader.data.refresh()).rejects.toThrow(/simulated network failure/)

      // Rolled back wholesale: db is the old snapshot AND the old chain is
      // still resident, so the previously-readable articles still load with
      // zero fetches (the regression left deltaArts=[] and threw here).
      expect(reader.data.db.na).toBe(2)
      expect(reader.data.db.total_art).toBe(2)
      expect((await reader.data.loadArticle(0)).t).toBe(all[0].title)
      expect((await reader.data.loadArticle(1)).t).toBe(all[1].title)
      expect((await reader.data.loadMeta(1)).t).toBe(all[1].title)
   })
})
