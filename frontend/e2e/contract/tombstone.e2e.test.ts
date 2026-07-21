import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Feed deletion contract: `srr feed rm` removes the feed from db.gz but packs
// are immutable — its idx entries and data lines stay. chronIdx is a permanent
// article address, so a ★Saved id or deep link into the deleted feed keeps
// loading forever; the reader shows the "[DELETED]" tombstone title and drops
// the feed from every grouping/count, while the backend validator deliberately
// REPORTS the orphaned entries (operator visibility) — naming the tombstone.

describe("contract: deleted feed tombstone", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>

   // Disjoint published ranges → chron 0,1 = doomed · chron 2,3 = keeper.
   const doomed = nItems(2, "doomed", 0, 0)
   const keeper = nItems(2, "keeper", 0, 10)

   beforeAll(async () => {
      feeds = await feedServer({
         "/doomed.xml": rssFeed("Doomed", doomed),
         "/keeper.xml": rssFeed("Keeper", keeper),
      })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Doomed", "-u", `${feeds.url}/doomed.xml`)
      await srr(store, "feed", "add", "-t", "Keeper", "-u", `${feeds.url}/keeper.xml`)
      await srr(store, "art", "fetch")
      // --force: removing a feed that already has stored articles is the
      // irreversible case the CLI now guards (its idx entries stay in the
      // immutable packs as orphans) — which is exactly what this suite pins.
      await srr(store, "feed", "rm", "0", "--force")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("db.gz drops the feed but keeps the all-time totals", () => {
      const raw = readDb<{ total_art: number; feeds: Record<string, unknown> }>(store)
      expect(raw.feeds["0"]).toBeUndefined()
      expect(raw.feeds["1"]).toBeDefined()
      expect(raw.total_art).toBe(4) // packs are immutable — all-time count stays
   })

   it("the deleted feed's articles still load by chron with the tombstone title", async () => {
      // idx entries are orphaned but intact: chron 0,1 still resolve to feed 0.
      expect(await reader.data.getFeedId(0)).toBe(0)
      expect(await reader.data.getFeedId(1)).toBe(0)
      expect((await reader.data.loadArticle(0)).t).toBe("doomed title 0")
      expect((await reader.data.loadArticle(1)).t).toBe("doomed title 1")
      expect(reader.data.feedTitle(0)).toBe("[DELETED]")
      expect(reader.data.feedTitle(1)).toBe("Keeper")
   })

   it("groupings and filter entries exclude the deleted feed", async () => {
      const groups = reader.data.groupFeedsByTag(true)
      expect(groups.untagged.map((f) => f.id)).toEqual([1])
      const entries = await reader.nav.getFilterEntries()
      expect(entries).not.toContain("0")
      expect(entries).toContain("1")
   })

   it("counts over the surviving feed exclude the orphaned entries", async () => {
      const survivors = new Map([[1, reader.data.db.feeds[1].add_idx]])
      expect(reader.data.countAll(survivors)).toBe(2)
      expect(await reader.data.findRight(0, survivors)).toBe(2) // first keeper article
   })

   it("backend inspect --validate reports the orphans as a deliberate issue", async () => {
      // Exit 1 + the [unknown-feeds] census naming the exact reader fallback the
      // tests above proved — the operator sees the orphans, the reader survives.
      await expect(inspectValidate(store)).rejects.toThrow(/\[unknown-feeds\] feed_id 0: 2 entries/)
   })

   it("a later feed add REUSES the freed id, add_idx fencing off the orphans", async () => {
      // AddFeed takes the lowest free id (0 again) and seeds add_idx at the
      // CURRENT total_art — the id-reuse invariant: the new incarnation never
      // inherits the old feed's entries, which sit below its add_idx.
      feeds.set("/phoenix.xml", rssFeed("Phoenix", nItems(2, "phoenix", 0, 20)))
      await srr(store, "feed", "add", "-t", "Phoenix", "-u", `${feeds.url}/phoenix.xml`)
      await srr(store, "art", "fetch")

      const raw = readDb<{ feeds: Record<string, { title: string; add_idx: number; total_art: number }> }>(store)
      expect(raw.feeds["0"].title).toBe("Phoenix")
      expect(raw.feeds["0"].add_idx).toBe(4) // seeded at add-time total_art — orphans fenced off
      expect(raw.feeds["0"].total_art).toBe(2)

      const r2 = await mountReader(store)
      expect(r2.data.feedTitle(0)).toBe("Phoenix")
      // Counts and walks see ONLY the new incarnation's articles…
      const phoenix = new Map([[0, r2.data.db.feeds[0].add_idx]])
      expect(r2.data.countAll(phoenix)).toBe(2)
      expect(await r2.data.findRight(0, phoenix)).toBe(4) // first phoenix article, orphans skipped
      // …while the orphaned bytes stay immutable underneath (chron 0 unchanged).
      expect((await r2.data.loadArticle(0)).t).toBe("doomed title 0")
   })
})
