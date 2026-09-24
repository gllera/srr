import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { clearDir, launchBrowser, waitReader } from "./helpers"

// A `#pos!tag` deep link on a desktop (split) boot: the reader opens the
// article and the list pane beside it must SCROLL to that article's row. No
// case covered where the pane lands (split.e2e only checks the row is marked).
// The pane builds cold on this path, beside the open article, and takes the
// immediate-anchor route; in production its centring once landed hundreds of
// pixels short, because rows reported stale remembered sizes
// (content-visibility:auto) until a frame after the fill. That frame timing
// depends on real data and did not reproduce with this fixture — list.test.ts
// pins it deterministically ("an immediate anchor follows its row…"); this
// case guards the end-to-end contract over a tag of interleaved feeds with
// rows of uneven height. Own beforeAll clears + rebuilds the shared packsDir
// (browser files run serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
// A chron of the deals tag with most of the tag newer than it. The case waits
// for this row to be the pane's highlighted one, so a fixture change that moved
// it out of the tag fails there, loudly, rather than passing vacuously.
const CHRON = 150
const packsDir = inject("packsDir")

const WORDS = "pack oferta leche desnatada sin lactosa descuento envío gratis cupón precio mínimo histórico".split(" ")
// Three interleaved feeds, two of them under one tag (a deals tag spread over
// several shops, among other traffic), 150 articles each, with titles running
// from a few words to three lines at the pane's width — deterministically.
const items = (feed: string, offset: number): FeedItem[] =>
   Array.from({ length: 150 }, (_, i) => ({
      title:
         `${feed} ${i}: ` +
         Array.from({ length: 3 + ((i * 7 + offset) % 23) }, (_, k) => WORDS[(i + k) % WORDS.length]).join(" "),
      link: `http://example.com/${feed}/${i}`,
      guid: `${feed}-${i}`,
      pubDate: pubDate(i * 3 + offset),
      content: `<p>${feed} ${i}</p>`,
   }))

describe("browser: split view — a deep link's row is scrolled into the pane", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/shop-a.xml": rssFeed("Shop A", items("shopa", 0)),
         "/shop-b.xml": rssFeed("Shop B", items("shopb", 1)),
         "/news.xml": rssFeed("News", items("news", 2)),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "Shop A", "-g", "deals", "-u", `${feeds.url}/shop-a.xml`)
      await srr(packsDir, "feed", "add", "-t", "Shop B", "-g", "deals", "-u", `${feeds.url}/shop-b.xml`)
      await srr(packsDir, "feed", "add", "-t", "News", "-g", "news", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("lands the deep-linked row inside the list pane", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 700 })
         // An old article of the deals tag: hundreds of newer rows sit above it.
         await p.goto(`${baseUrl}#${CHRON}!deals`, { waitUntil: "load" })
         await waitReader(p)
         await p.waitForFunction(
            (c: number) =>
               document.querySelector(".srr-list .srr-row-current")?.getAttribute("data-chron") === String(c),
            { timeout: 20_000 },
            CHRON,
         )
         // Let the fills and any settling finish before judging where it landed.
         await new Promise((r) => setTimeout(r, 1500))
         const at = await p.evaluate(() => {
            const pane = document.querySelector(".srr-list") as HTMLElement
            const row = document.querySelector(".srr-list .srr-row-current") as HTMLElement
            const pr = pane.getBoundingClientRect()
            const r = row.getBoundingClientRect()
            return {
               rowTop: r.top,
               rowBottom: r.bottom,
               paneTop: pr.top,
               paneBottom: Math.min(pr.bottom, innerHeight),
               scrolled: pane.scrollTop,
            }
         })
         expect(at.scrolled, "the pane never scrolled").toBeGreaterThan(0)
         expect(at.rowTop, "the row sits above the pane").toBeGreaterThanOrEqual(at.paneTop)
         expect(at.rowBottom, "the row sits below the pane").toBeLessThanOrEqual(at.paneBottom)
      } finally {
         await ctx.close()
      }
   })
})
