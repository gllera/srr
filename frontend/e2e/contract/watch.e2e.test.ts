import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { feedServer, inspectValidate, makeStore, readDb, srr, storeNames, type FeedServer } from "../harness"
import { mountReader, type MountedReader } from "./mount"

// The keyword-watchlist lane end to end: the REAL writer stamps a rule and
// publishes its bitmap planes, and the REAL reader walks the lane. The planes are
// decoded HERE, independently of watch-plane.ts (Buffer base64, the writer's
// `plane[i>>3] |= 1 << (i&7)` layout read back by hand), so a disagreement about
// bit order, encoding or the coverage gate fails this file and nothing else.

// Titles by publish index (= chron). Items 0–2 are fetched BEFORE the rule exists,
// so the two "hot" ones among them sit below its coverage floor.
const TITLES = ["hot early", "cold early", "hot too early", "cold", "hot one", "hot two", "cold again", "hot three"]
const item = (i: number): FeedItem => ({
   title: TITLES[i],
   link: `http://example.com/w/${i}`,
   guid: `w-${i}`,
   pubDate: pubDate(i),
   content: `body ${i}`,
})

interface WatchDoc {
   v: number
   base: number
   n: number
   bits?: Record<string, string>
}

// Every chron the store's own objects mark for `rule`, clipped to [from, to).
function markedChrons(store: string, rule: string, from: number, to: number): number[] {
   const out: number[] = []
   for (const key of storeNames(store).series.get("watch")?.keys ?? []) {
      if (!key) continue
      const doc = JSON.parse(gunzipSync(readFileSync(join(store, key))).toString("utf8")) as WatchDoc
      const b64 = doc.bits?.[rule]
      if (!b64) continue
      const bytes = Buffer.from(b64, "base64")
      for (let i = 0; i < doc.n; i++) if (bytes[i >> 3] & (1 << (i & 7))) out.push(doc.base + i)
   }
   return out.filter((c) => c >= from && c < to).sort((a, b) => a - b)
}

describe("contract: keyword-watchlist lane", () => {
   let feeds: FeedServer
   let store: string
   let reader: MountedReader
   let wf = -1
   let wc = -1

   beforeAll(async () => {
      feeds = await feedServer({ "/w.xml": rssFeed("Wire", [0, 1, 2].map(item)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Wire", "-u", `${feeds.url}/w.xml`)
      await srr(store, "fetch")
      await srr(store, "watch", "set", "hot", "title=/hot/i")
      feeds.set(
         "/w.xml",
         rssFeed(
            "Wire",
            TITLES.map((_, i) => item(i)),
         ),
      )
      await srr(store, "fetch")
      const man = readDb<{ wf?: Record<string, number>; wc?: number }>(store)
      wf = man.wf?.hot ?? -1
      wc = man.wc ?? -1
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("the writer stamped the floor at the pre-rule count and covered the rest", async () => {
      expect(wf).toBe(3)
      expect(wc).toBe(8)
      expect(markedChrons(store, "hot", wf, wc)).toEqual([4, 5, 7])
      expect(reader.data.watchRules()).toEqual({ hot: 3 })
      expect(reader.data.watchCovered()).toBe(8)
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })

   it("walks exactly the marked chrons newest-first, never below the floor, moving no frontier", async () => {
      const opened = await reader.nav.switchFilter("w:hot")
      expect(opened.has_right).toBe(false)
      const walked = [reader.nav.currentChron()]
      for (;;) {
         try {
            await reader.nav.left()
         } catch {
            break // "no left match" at the lane's oldest hit
         }
         walked.push(reader.nav.currentChron())
      }
      expect(walked).toEqual(markedChrons(store, "hot", wf, wc).reverse())
      expect(walked).not.toContain(0)
      expect(walked).not.toContain(2)
      expect(localStorage.getItem("srr-seen")).toBeNull()
   })

   it("the picker's count is the independent popcount", async () => {
      expect(await reader.nav.watchLaneCount("hot")).toBe(markedChrons(store, "hot", wf, wc).length)
   })

   it("#pos!w%3Ahot round-trips through the hash grammar", async () => {
      expect(reader.nav.parseHashTokens("!w%3Ahot")).toEqual(["w:hot"])
      await reader.nav.fromHash("5!w%3Ahot")
      expect(reader.nav.currentChron()).toBe(5)
      expect(reader.nav.getCurrentFilterKey()).toBe("w:hot")
      expect(reader.nav.tokensSuffix()).toBe("!w%3Ahot")
   })
})
