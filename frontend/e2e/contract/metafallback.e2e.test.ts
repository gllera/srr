import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, makeStore, srr, type FeedServer } from "../harness"
import { pubDate, pubUnix, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// This suite pins LEGACY tail mechanics (per-cycle consolidated L<seq> packs,
// meta-series coverage, GC grace windows): run the writer with the delta kill
// switch so every dirty cycle consolidates, as the pre-delta writer did.
// Delta-chain behavior has its own suite (delta.e2e.test.ts) and rides every
// OTHER suite through the default --max-deltas.
process.env.SRR_MAX_DELTAS = "0"

// Contract: when the meta/ projection lags (metaReady() is false), loadMeta()
// must still return the correct card by falling back to the data/ source of
// truth. This is the safety guarantee of the warn-only derived design — a
// failed SyncMeta never breaks the list or search.
//
// We force metaReady()=false after a real srr fetch by patching db.mp/db.mt
// to values that leave the store "uncovered" (mp=0, mt=0), then assert that
// loadMeta(chronIdx) returns the same {f, w, t} card as the underlying data/
// pack at every chronIdx.

describe("contract: meta fallback to data/", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>

   const ITEMS = [
      { title: "Alpha article", link: "http://ex.com/0", guid: "a0", pubDate: pubDate(0), content: "body 0" },
      { title: "Beta article", link: "http://ex.com/1", guid: "a1", pubDate: pubDate(1), content: "body 1" },
      { title: "Gamma article", link: "http://ex.com/2", guid: "a2", pubDate: pubDate(2), content: "body 2" },
   ]

   beforeAll(async () => {
      feeds = await feedServer({ "/feed.xml": rssFeed("Feed", ITEMS) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Feed", "-u", `${feeds.url}/feed.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("metaReady() is true after a normal fetch", () => {
      // Sanity: the store has meta coverage before we break it.
      expect(reader.data.metaReady()).toBe(true)
      expect(reader.data.db.total_art).toBe(ITEMS.length)
   })

   it("serves the newest window from db.head with zero meta fetches", async () => {
      // The writer's newest-glance projection rides db.gz: every card in the
      // head window must resolve without ANY meta/ request (the whole point —
      // the generation-named tail is the one object no cache can hold).
      const db = reader.data.db
      expect(db.head).toBeDefined()
      expect(db.head!.length).toBe(ITEMS.length)
      expect(db.hb ?? 0).toBe(0)
      const before = reader.fetchMock.mock.calls.length
      for (let chron = 0; chron < ITEMS.length; chron++) {
         const card = await reader.data.loadMeta(chron)
         const art = await reader.data.loadArticle(chron)
         expect(card.f, `chron ${chron} f`).toBe(art.f)
         expect(card.w, `chron ${chron} w`).toBe(art.p || art.a)
         expect(card.t, `chron ${chron} t`).toBe(art.t)
      }
      const metaFetches = reader.fetchMock.mock.calls.slice(before).filter(([url]) => String(url).includes("meta/"))
      expect(metaFetches).toEqual([])
   })

   it("a stale head (failed-sync commit) still serves ITS OWN chrons correctly", async () => {
      // SyncMeta is warn-only: a failed sync commits a grown total_art with
      // the previous cycle's head. Anchored to db.hb the stale head must keep
      // serving its own (immutable) range — never shifted addressing.
      const db = reader.data.db
      const savedTotal = db.total_art
      db.total_art = savedTotal + 5 // pretend a batch landed without a sync
      try {
         const card0 = await reader.data.loadMeta(0)
         expect(card0.t).toBe(ITEMS[0].title)
      } finally {
         db.total_art = savedTotal
      }
   })

   it("loadMeta falls back to data/ when metaReady() is false", async () => {
      // Force metaReady()=false by setting mp=0 and mt=0.
      // (Real scenario: SyncMeta failed warn-only, or first run before any meta
      // is written — both leave mp/mt at 0.)
      reader.data.db.mp = 0
      reader.data.db.mt = 0
      // Clear the head projection too: it rides the same sync, so the
      // failed-sync scenario leaves it absent as well — and it would
      // otherwise satisfy these newest chrons before the fallback runs.
      reader.data.db.head = undefined
      expect(reader.data.metaReady()).toBe(false)

      // Every chronIdx must still return the correct card via data/ fallback.
      for (let chron = 0; chron < ITEMS.length; chron++) {
         const art = await reader.data.loadArticle(chron)
         const card = await reader.data.loadMeta(chron)
         // The card's feed id and timestamp must match the article.
         expect(card.f, `chron ${chron} f`).toBe(art.f)
         expect(card.w, `chron ${chron} w`).toBe(art.p || art.a)
         expect(card.t, `chron ${chron} t`).toBe(art.t)
      }
   })

   it("loadMeta returns published over fetched_at when published is set", async () => {
      // All our items have a pubDate, so w should equal published (art.p).
      reader.data.db.mp = 0
      reader.data.db.mt = 0
      reader.data.db.head = undefined
      const art0 = await reader.data.loadArticle(0)
      expect(art0.p).toBe(pubUnix(0))
      const card0 = await reader.data.loadMeta(0)
      expect(card0.w).toBe(pubUnix(0)) // p takes priority over a
   })
})
