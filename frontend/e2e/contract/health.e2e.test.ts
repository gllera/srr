import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, srr, type FeedServer } from "../harness"
import { nItems, pubUnix, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Per-feed fetch-health vitals on the wire: a healthy cycle stamps last_ok /
// last_new / wm and leaves ferr clear; a failing cycle (route gone → 404) sets
// ferr + fail_streak on that feed only, leaves its last-known-good vitals
// untouched, and stays non-fatal for the rest of the store. These fields are
// reader-consumed (picker health tints, the "Latest published" info card), so
// the REAL reader must see them through the real db.gz.

interface Vitals {
   ferr?: string
   last_ok?: number
   fail_streak?: number
   last_new?: number
   wm?: number
}
interface RawDb {
   feeds: Record<string, Vitals>
   fetched_at: number
}

describe("contract: fetch-health vitals", () => {
   let feeds: FeedServer
   let store: string
   let healthy: RawDb // snapshot after the first (all-green) cycle

   const stable = nItems(2, "stable", 0, 0)
   const flaky = nItems(2, "flaky", 0, 10)

   beforeAll(async () => {
      feeds = await feedServer({
         "/stable.xml": rssFeed("Stable", stable),
         "/flaky.xml": rssFeed("Flaky", flaky),
      })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Stable", "-u", `${feeds.url}/stable.xml`)
      await srr(store, "feed", "add", "-t", "Flaky", "-u", `${feeds.url}/flaky.xml`)
      await srr(store, "art", "fetch")
      healthy = readDb<RawDb>(store)

      // Second cycle: the flaky feed's route is gone (404). Per-feed errors are
      // non-fatal — the cycle exits 0 and still commits the vitals.
      feeds.remove("/flaky.xml")
      await srr(store, "art", "fetch")
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("a green cycle stamps last_ok/last_new/wm and no ferr", () => {
      for (const id of ["0", "1"]) {
         const f = healthy.feeds[id]
         expect(f.ferr, `feed ${id} ferr`).toBeUndefined()
         expect(f.fail_streak, `feed ${id} fail_streak`).toBeUndefined()
         expect(f.last_ok, `feed ${id} last_ok`).toBeGreaterThan(0)
         expect(f.last_new, `feed ${id} last_new`).toBeGreaterThan(0)
      }
      // wm = max published unix ever seen (reader-displayed "Latest published").
      expect(healthy.feeds["0"].wm).toBe(pubUnix(1))
      expect(healthy.feeds["1"].wm).toBe(pubUnix(11))
   })

   it("a failing fetch marks only the failing feed, keeping its last-good vitals", () => {
      const raw = readDb<RawDb>(store)
      expect(raw.feeds["1"].ferr).toBeTruthy()
      expect(raw.feeds["1"].fail_streak).toBe(1)
      // The failure never rewrites the last-known-good vitals…
      expect(raw.feeds["1"].last_ok).toBe(healthy.feeds["1"].last_ok)
      expect(raw.feeds["1"].last_new).toBe(healthy.feeds["1"].last_new)
      expect(raw.feeds["1"].wm).toBe(pubUnix(11))
      // …and the healthy feed is untouched by its sibling's failure.
      expect(raw.feeds["0"].ferr).toBeUndefined()
      expect(raw.feeds["0"].fail_streak).toBeUndefined()
      expect(raw.feeds["0"].last_ok).toBeGreaterThanOrEqual(healthy.feeds["0"].last_ok!)
   })

   it("the real reader sees the vitals through db.gz", async () => {
      const reader = await mountReader(store)
      expect(reader.data.db.feeds[1].ferr).toBeTruthy()
      expect(reader.data.db.feeds[0].ferr).toBeUndefined()
      expect(reader.data.db.feeds[1].wm).toBe(pubUnix(11))
      // Article data is unaffected by the failed cycle.
      expect(reader.data.db.total_art).toBe(4)
      expect((await reader.data.loadArticle(3)).t).toBe("flaky title 1")
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
