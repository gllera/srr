import { gunzipSync } from "node:zlib"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { mountReader } from "./mount"

// Sparse articles — the omitempty half of the JSONL wire contract, against
// real bytes: an item with NO pubDate ships without `p` (and its meta card's
// `w` falls back to fetched_at), an item with NO title ships without `t` (and
// is invisible to title search), an item with NO link ships without `l`, and a
// title full of XML entities + unicode round-trips decoded and is searchable
// through the shared folding. Real feeds are exactly this ragged.

const ENTITY_TITLE = "AT&T “café” — 50% off"

const items: FeedItem[] = [
   {
      // No pubDate at all: p omitted, sorts wherever the writer puts it —
      // located by content below, never by chron position.
      title: "dateless dispatch",
      link: "http://example.com/sparse/0",
      guid: "sparse-0",
      content: "body zero",
   },
   {
      // No title: t omitted; a microblog-style item.
      title: "",
      link: "http://example.com/sparse/1",
      guid: "sparse-1",
      pubDate: pubDate(1),
      content: "body one orphanword",
   },
   {
      // Entities + unicode in the title: stored decoded, searchable folded.
      title: ENTITY_TITLE,
      link: "http://example.com/sparse/2",
      guid: "sparse-2",
      pubDate: pubDate(2),
      content: "body two",
   },
   {
      // No link: l omitted (guid is explicit, so nothing falls back to it).
      title: "linkless dispatch",
      link: "",
      guid: "sparse-3",
      pubDate: pubDate(3),
      content: "body three",
   },
]

describe("contract: sparse articles (omitempty wire fields)", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   let search: typeof import("../../src/js/search")
   // chron of each item, located by content (order across a p-less item is the
   // writer's business, not this contract's).
   const chronOf: Record<string, number> = {}

   beforeAll(async () => {
      feeds = await feedServer({ "/sparse.xml": rssFeed("Sparse", items) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Sparse", "-u", `${feeds.url}/sparse.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
      search = await import("../../src/js/search")
      for (let i = 0; i < items.length; i++) {
         const art = await reader.data.loadArticle(i)
         chronOf[art.c] = i
      }
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   const line = (content: string): string => {
      // One fetch on an empty store publishes the batch as delta segment
      // data/d1.gz (the default --max-deltas path) — the raw JSONL wire under
      // test is byte-identical to a data pack's, which is the point of the
      // delta design.
      const jsonl = gunzipSync(readFileSync(join(store, "data/d1.gz"))).toString("utf8")
      const hit = jsonl.split("\n").find((l) => l.includes(`"c":"${content}"`))
      expect(hit, `JSONL line with content ${content}`).toBeDefined()
      return hit!
   }

   it("all four ragged items were ingested", () => {
      expect(reader.data.db.total_art).toBe(4)
      expect(Object.keys(chronOf).length).toBe(4)
   })

   it("no pubDate → `p` absent from the raw JSONL; meta `w` falls back to fetched_at", async () => {
      expect(line("body zero")).not.toContain('"p":')
      const art = await reader.data.loadArticle(chronOf["body zero"])
      expect(art.p).toBeUndefined()
      expect(art.a).toBeGreaterThan(0)
      const card = await reader.data.loadMeta(chronOf["body zero"])
      expect(card.w).toBe(art.a) // precomputed fallback: published || fetched_at
   })

   it("no title → `t` absent; invisible to title search", async () => {
      expect(line("body one orphanword")).not.toContain('"t":')
      const art = await reader.data.loadArticle(chronOf["body one orphanword"])
      expect(art.t).toBeUndefined()
      expect((await reader.data.loadMeta(chronOf["body one orphanword"])).t).toBeUndefined()
      // Search is TITLE search: content words never match.
      const hits: number[] = []
      for await (const batch of search.search("orphanword")) hits.push(...batch.map((h) => h.chron))
      expect(hits).toEqual([])
   })

   it("entity/unicode title round-trips decoded and is searchable folded", async () => {
      const art = await reader.data.loadArticle(chronOf["body two"])
      expect(art.t).toBe(ENTITY_TITLE) // &amp; decoded, unicode intact
      const hits: string[] = []
      for await (const batch of search.search("café")) hits.push(...batch.map((h) => h.t ?? ""))
      expect(hits).toEqual([ENTITY_TITLE]) // NFD-folded on both sides
   })

   it("no link → `l` absent", async () => {
      expect(line("body three")).not.toContain('"l":')
      expect((await reader.data.loadArticle(chronOf["body three"])).l).toBeUndefined()
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
