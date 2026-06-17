import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { mountReader } from "./mount"

// The meta/ series end-to-end: real srrb writes the latest meta tail
// (SyncMeta) from real pipeline-processed titles; the real search.ts reads
// it back. Pins the write-side JSONL contract, the available() gate, TS
// folding at query time over Go-written titles, generation naming across
// fetches, and chron addressing (every hit must load the article it claims).
// meta/ is the derived projection shared between search and the home list,
// at a 5,000-entry stride (META_PACK_SIZE). Bloom pruning and Go-side folding
// only engage with finalized 5k shards — per the summary.e2e.test.ts
// precedent that real ≥5k writer coverage is Go's job, those live in the
// backend tests plus the shared fold-vector tables and bloomBits literal pins
// in both unit suites.

type SearchModule = typeof import("../../src/js/search")

const TITLES = [
   "İstanbul Daily News",
   "Café Éclair Recipe",
   "ΓΛΩΣΣΑΣ field report",
   "日本語のニュース速報",
   "Plain ASCII headline",
]

function items(): FeedItem[] {
   return TITLES.map((title, i) => ({
      title,
      link: `http://example.com/${i}`,
      guid: `search-${i}`,
      pubDate: pubDate(i),
      content: `body ${i}`,
   }))
}

async function collect(gen: AsyncGenerator<import("../../src/js/search").ISearchHit[]>) {
   const out: import("../../src/js/search").ISearchHit[] = []
   for await (const batch of gen) out.push(...batch)
   return out
}

describe("contract: search", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   let search: SearchModule

   beforeAll(async () => {
      feeds = await feedServer({ "/feed.xml": rssFeed("Feed", items()) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Feed", "-u", `${feeds.url}/feed.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
      // Same fresh module registry as the mounted data/nav, so search.ts sees
      // the same data.ts instance and the same fetch shim.
      search = await import("../../src/js/search")
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("publishes coverage fields and the reader offers search", () => {
      expect(reader.data.db.mp ?? 0).toBe(0) // no finalized packs at this size
      expect(reader.data.db.mt).toBe(TITLES.length)
      expect(search.available()).toBe(true)
   })

   it("finds Go-written titles through TS query folding", async () => {
      for (const [q, want] of [
         ["istanbul", "İstanbul Daily News"], // NFD+mark-strip beats the İ divergence
         ["CAFE eclair", "Café Éclair Recipe"], // case + diacritics
         ["γλώσσας", "ΓΛΩΣΣΑΣ field report"], // lowercase + final-sigma map
         ["日本語", "日本語のニュース速報"], // CJK substring
         ["plain headline", "Plain ASCII headline"], // AND across words
      ] as const) {
         const hits = await collect(search.search(q))
         expect(
            hits.map((h) => h.t),
            `query ${JSON.stringify(q)}`,
         ).toContain(want)
      }
      expect(await collect(search.search("zzz absent"))).toEqual([])
   })

   it("every hit's chron loads the article it claims", async () => {
      const hits = await collect(search.search("a")) // short query, matches most titles
      expect(hits.length).toBeGreaterThan(0)
      for (const hit of hits) {
         const art = await reader.data.loadArticle(hit.chron)
         expect(art.t, `chron ${hit.chron}`).toBe(hit.t)
         expect(art.f, `chron ${hit.chron}`).toBe(hit.f)
         expect(hit.w, `chron ${hit.chron}`).toBe(art.p ?? art.a)
      }
   })

   it("a second fetch extends the tail under the new generation name", async () => {
      feeds.set(
         "/feed.xml",
         rssFeed("Feed", [
            ...items(),
            {
               title: "Brand new article",
               link: "http://example.com/new",
               guid: "search-new",
               pubDate: pubDate(10),
               content: "new body",
            },
         ]),
      )
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
      search = await import("../../src/js/search")

      expect(reader.data.db.mt).toBe(TITLES.length + 1)
      const hits = await collect(search.search("brand new"))
      expect(hits.map((h) => h.t)).toEqual(["Brand new article"])
      // The read-back-and-extend path must keep the original entries too.
      expect((await collect(search.search("istanbul"))).length).toBe(1)
   })

   it("backend inspect --validate covers the meta series", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
