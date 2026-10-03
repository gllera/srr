import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, pubDate, rssFeed, type FeedItem } from "../fixtures"
import { clearDir, clickRow, launchBrowser, open as openCtx, waitList, waitReader, withPage } from "./helpers"

// Titleless feeds (Telegram-style: the title duplicates the content lead). A
// feed flagged `nt` in db.gz makes the reader HIDE the <h1>; the whole masthead
// row is the permalink, so its source · date kicker stands in. The list still
// uses the title as its row label. Own beforeAll clears + rebuilds the shared
// packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false — so each owns it).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// micro = the titleless feed (newest, startIdx 30 → top of the list). news =
// an ordinary feed for contrast.
const micro = nItems(1, "micro", 0, 30)
// long = a microblog post whose title is its whole opening paragraph, the case
// the list's two-line title clamp exists for — and the case where a search term
// can sit past those two lines (the last word here).
const LONG_TITLE =
   "A microblog post whose title is simply its own opening paragraph, running well past " +
   "the two lines a list row has room for before it finally gets around to the zeppelin"
const long: FeedItem = {
   title: LONG_TITLE,
   link: "http://example.com/micro/long",
   guid: "micro-long",
   pubDate: pubDate(31),
   content: `<p>${LONG_TITLE}</p>`,
}
const news = nItems(1, "news", 0, 0)
// wall = a titleless article TALLER than the viewport: many paragraphs, no
// media, so its full height is laid out the instant it renders. Focusing a
// partially-visible element taller than the scrollport aligns its top edge with
// the viewport top (CSSOM "nearest"), so a bare el.content.focus() after
// scrollReaderTop() scrolls the masthead off and auto-hides the toolbar.
const wall: FeedItem[] = [
   {
      title: "wall title 0",
      link: "http://example.com/wall/0",
      guid: "wall-0",
      pubDate: pubDate(60),
      content: Array.from({ length: 80 }, (_, i) => `<p>wall line ${i}</p>`).join(""),
   },
]

const $hasTitleless = (p: Page) => p.$eval(".srr-reader", (e) => e.classList.contains("srr-reader-titleless"))
// offsetParent is null for a display:none element → a robust "is it visible".
const $titleVisible = (p: Page) => p.$eval(".srr-title", (e) => (e as HTMLElement).offsetParent !== null)
// The whole masthead row is the permalink now (no separate icon). For a titleless
// feed the <h1> hides but the row (its source · date kicker) stays visible.
const $rowVisible = (p: Page) => p.$eval(".srr-title-row", (e) => (e as HTMLElement).offsetParent !== null)
const $rowHref = (p: Page) => p.$eval(".srr-title-row", (e) => e.getAttribute("href"))
const $titleText = (p: Page) => p.$eval(".srr-title", (e) => e.textContent)
const $deskVisible = (p: Page) => p.$eval(".srr-desk", (e) => (e as HTMLElement).offsetParent !== null)
const $deskText = (p: Page) => p.$eval(".srr-desk", (e) => e.textContent)

// Click the list row whose title matches (rows are <a> with intercepted clicks).
describe("browser: titleless feeds (reader hides the duplicate heading)", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/micro.xml": rssFeed("Micro", [...micro, long]),
         "/news.xml": rssFeed("News", news),
         "/wall.xml": rssFeed("Wall", wall),
      })
      clearDir(packsDir)

      // The titleless feeds are created via `feed apply` (offline) with no_title:true;
      // micro also carries a tag (the reader desk reads the feed's tag).
      const applyDir = mkdtempSync(join(tmpdir(), "srr-titleless-apply-"))
      const applyFile = join(applyDir, "micro.json")
      writeFileSync(
         applyFile,
         JSON.stringify({ title: "Micro", url: `${feeds.url}/micro.xml`, no_title: true, tag: "updates" }),
      )
      await srr(packsDir, "feed", "apply", "-f", applyFile)
      const wallFile = join(applyDir, "wall.json")
      writeFileSync(wallFile, JSON.stringify({ title: "Wall", url: `${feeds.url}/wall.xml`, no_title: true }))
      await srr(packsDir, "feed", "apply", "-f", wallFile)
      // News is left untagged → its desk stays empty/hidden.
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "fetch")
      rmSync(applyDir, { recursive: true, force: true })

      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   const open = () => openCtx(browser, baseUrl, waitList)

   it("hides the heading and shows a masthead permalink for a titleless feed", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "micro title 0")
         await waitReader(page)
         // The reader is flagged titleless: the <h1> heading is hidden…
         expect(await $hasTitleless(page)).toBe(true)
         expect(await $titleVisible(page)).toBe(false)
         // …and the masthead row (its source · date kicker) stands in as the
         // permalink, pointing at the article link.
         expect(await $rowVisible(page)).toBe(true)
         expect(await $rowHref(page)).toBe("http://example.com/micro/0")
         // The desk shows the feed's tag (as a hashtag) above the byline.
         expect(await $deskVisible(page)).toBe(true)
         expect(await $deskText(page)).toBe("#updates")
      } finally {
         await close()
      }
   })

   it("lands a taller-than-viewport titleless article at the top with the toolbar shown", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "wall title 0")
         await waitReader(page)
         // The article must be tall enough that focusing it CAN scroll — the
         // regression's precondition (content bottom below the viewport).
         const tall = await page.evaluate(
            () => document.querySelector(".srr-content")!.getBoundingClientRect().bottom > window.innerHeight,
         )
         expect(tall).toBe(true)
         // Let the render's focus and any scroll event it queued land.
         await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
         // The reader lands at the very top (masthead visible)…
         expect(await page.evaluate(() => window.scrollY)).toBe(0)
         // …and the phantom downward scroll hasn't auto-hidden the toolbar.
         const slid = await page.$eval(".srr-toolbar", (e) => e.classList.contains("srr-toolbar-slide"))
         expect(slid).toBe(false)
      } finally {
         await close()
      }
   })

   // The list clamps every title to two lines, but a search hit's <mark> is the
   // only thing on screen that says WHY the row matched — so a hit whose term sits
   // past line two must not have it clipped away. Phone width, where two lines
   // hold the least. The search is entered by hash, the path where the bar's
   // body.srr-searching only arrives after the build has measured its rows.
   it("search shows a long title's matched term past the two-line clamp", async () => {
      await withPage(browser, async (page) => {
         await page.setViewport({ width: 375, height: 800 })
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitList(page)
         // The ordinary list keeps the clamp: the long title overflows its box.
         const overflows = await page.$$eval(
            ".srr-list a.srr-row .srr-row-title",
            (els, t) => {
               const e = els.find((x) => x.textContent === t)!
               return e.scrollHeight > e.clientHeight
            },
            LONG_TITLE,
         )
         expect(overflows).toBe(true)

         await page.goto(`${baseUrl}#!q%3Azeppelin`, { waitUntil: "load" })
         await page.waitForSelector(".srr-list a.srr-row .srr-row-title mark", { timeout: 20000 })
         await waitList(page)
         const box = await page.$eval(".srr-list a.srr-row .srr-row-title mark", (m) => {
            const row = m.closest("a.srr-row") as HTMLElement
            const title = m.closest(".srr-row-title")!.getBoundingClientRect()
            const mark = m.getBoundingClientRect()
            const cs = getComputedStyle(row)
            const chrome = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const
            return {
               text: m.textContent,
               markTop: mark.top,
               markBottom: mark.bottom,
               titleTop: title.top,
               titleBottom: title.bottom,
               rowBottom: row.getBoundingClientRect().bottom,
               // What pinHeights reserved for the row when it was skipped, against
               // the content box it really renders at.
               pinned: parseFloat(row.style.getPropertyValue("contain-intrinsic-size").split(" ").pop() ?? ""),
               content: row.offsetHeight - chrome.reduce((n, k) => n + parseFloat(cs[k]), 0),
            }
         })
         expect(box.text).toBe("zeppelin")
         // Inside the title's own (overflow-clipping) box, and so inside the row.
         expect(box.markTop).toBeGreaterThanOrEqual(box.titleTop)
         expect(box.markBottom).toBeLessThanOrEqual(box.titleBottom)
         expect(box.markBottom).toBeLessThanOrEqual(box.rowBottom)
         // A search row is as tall as its title, so its reserved height must be
         // the one it renders at: a mismatch is the offscreen-row correction that
         // shoves the viewport when the row scrolls back in (see pinHeights).
         expect(box.pinned).toBeCloseTo(box.content, 0)
      })
   })

   it("keeps the heading AND offers the masthead permalink for an ordinary feed", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "news title 0")
         await waitReader(page)
         expect(await $hasTitleless(page)).toBe(false)
         expect(await $titleVisible(page)).toBe(true)
         expect(await $titleText(page)).toBe("news title 0")
         // The row permalink is available on ordinary feeds too, pointing at the article.
         expect(await $rowHref(page)).toBe("http://example.com/news/0")
         // News is untagged → the desk stays hidden.
         expect(await $deskVisible(page)).toBe(false)
      } finally {
         await close()
      }
   })
})
