import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

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

   it("adopts a new fetch cycle in place: totals, seq, and new-article navigation", async () => {
      feeds.set("/a.xml", rssFeed("Alpha", all))
      await srr(store, "art", "fetch")
      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(all.length)
      expect(reader.data.db.seq).toBe(2)
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

   it("adopts a gen bump (in-place rebuild signal) through the same path", async () => {
      await srr(store, "gen", "--bump")
      expect(await reader.data.refresh()).toBe("updated")
      expect((await reader.data.loadArticle(4)).t).toBe(all[4].title) // still readable
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
