import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader, type FetchIntercept } from "./mount"

// Navigation under a FLAKY network — the real-world failure mode: a pack
// fetch that 503s once and then serves. The contract under test is resolve()'s
// "load first, commit pos only on success" (nav.ts) + cachedPromise's
// rejection-drop (cache.ts): a failed navigation must reject WITHOUT moving
// the position or poisoning a cache slot, and the retry must replay the same
// target and succeed. Multi-pack store (-s 1) so a step can hit a cold pack.
//
// Each scenario mounts its own reader with fresh failure state — a pack that
// loaded once is LRU-cached and can never fail again in that mount.

// Fail the FIRST fetch of every matching path, then serve normally.
function failOnce(re: RegExp): FetchIntercept {
   const failed = new Set<string>()
   return async (path, serve) => {
      if (re.test(path) && !failed.has(path)) {
         failed.add(path)
         return new Response(null, { status: 503 })
      }
      return serve()
   }
}

describe("contract: navigation under transient pack failures", () => {
   let feeds: FeedServer
   let store: string

   // Incompressible pad + -s 1 → several finalized data packs (packsplit's recipe),
   // so chron 0 (finalized pack) and the newest chron (latest pack) live in
   // DIFFERENT packs — a navigation between them must fetch cold bytes. MORE
   // than headMax (40) articles, so old chrons sit outside the db.gz head
   // window and loadMeta really touches meta/ packs.
   const items = nItems(60, "flaky", 8000)

   beforeAll(async () => {
      feeds = await feedServer({ "/flaky.xml": rssFeed("Flaky", items) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Flaky", "-u", `${feeds.url}/flaky.xml`)
      await srr(store, "-s", "1", "art", "fetch")
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("a transiently failing article load rejects once, then the retry succeeds", async () => {
      const reader = await mountReader(store, failOnce(/^data\//))
      await expect(reader.data.loadArticle(0)).rejects.toThrow()
      // The rejected promise was dropped from its LRU slot — same call, fresh fetch.
      expect((await reader.data.loadArticle(0)).t).toBe("flaky title 0")
   })

   it("a failed navigation never moves the position; the retry replays the same target", async () => {
      const reader = await mountReader(store, failOnce(/^data\/L/)) // only the LATEST pack flakes
      // Land on chron 0 (finalized pack — serves fine). fromHash takes the hash
      // WITHOUT the "#" (route() strips it).
      const o = await reader.nav.fromHash("0")
      expect(o.article.t).toBe("flaky title 0")
      expect(reader.nav.currentChron()).toBe(0)

      // Jump to the newest article: its (latest) pack 503s → the navigation
      // rejects and pos must NOT move — left()/right()/goTo() all commit
      // through resolve(), which loads first and commits only on success.
      const last = reader.data.db.total_art - 1
      await expect(reader.nav.goTo(last)).rejects.toThrow()
      expect(reader.nav.currentChron()).toBe(0) // unmoved — Retry replays the same chron
      // A non-OK LATEST pack looks like a stale-tab db.gz, so the guarded
      // self-heal reload fired exactly once (a no-op here — the mount spies it).
      expect(reader.reloads).toHaveBeenCalledTimes(1)

      // The retry (what the error popup's Retry does) succeeds and commits.
      const retried = await reader.nav.goTo(last)
      expect(retried.article.t).toBe(`flaky title ${last}`)
      expect(reader.nav.currentChron()).toBe(last)
   })

   it("a transiently failing meta pack rejects once, then the retry serves the card", async () => {
      const reader = await mountReader(store, failOnce(/^meta\//))
      expect(reader.data.metaReady()).toBe(true)
      // chron 0 sits OUTSIDE the db.gz head window (headMax 40 < 60 articles),
      // so this really exercises the meta-pack fetch, not the zero-fetch head.
      await expect(reader.data.loadMeta(0)).rejects.toThrow()
      expect((await reader.data.loadMeta(0)).t).toBe("flaky title 0") // slot not poisoned
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
