import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { $rowTitles, clearDir, launchBrowser, open as openCtx, waitList, waitReader } from "./helpers"

// The filter-picker overlay and the frontier context menu, driven through the
// real UI: pick a feed row / a tag header / the [ALL] scope chip and watch the
// list re-filter; flip the header Info toggle and open a feed's stats card;
// open the settings menu from the list readout (status footer + version); and
// drive the reader's seen-frontier gestures (Mark all read / Mark unread from
// here) off the next pill's context menu, asserting the pending readout ticks
// 3 → 0 → 3. Own beforeAll clears + rebuilds the shared packsDir (browser
// files run serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// Disjoint published ranges → chron 0,1 = news (tag "world") · 2,3 = sport.
const news = nItems(2, "news", 0, 0)
const sport = nItems(2, "sport", 0, 10)

const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

const waitPicker = (p: Page) =>
   p.waitForFunction(() => {
      const el = document.querySelector(".srr-picker") as HTMLElement | null
      return !!el && !el.hidden
   })

// Open the picker and pick a row by its data-value (feed id / tag / "" = [ALL]).
const pickFilter = async (p: Page, value: string) => {
   await p.click(".srr-filter")
   await waitPicker(p)
   await p.waitForSelector(`.srr-picker [data-value="${value}"]`)
   await p.click(`.srr-picker [data-value="${value}"]`)
}

const waitRowTitles = (p: Page, want: string[]) =>
   p.waitForFunction(
      (w) =>
         JSON.stringify(
            [...document.querySelectorAll(".srr-list a.srr-row .srr-row-title")].map((e) => e.textContent),
         ) === JSON.stringify(w),
      {},
      want,
   )

const $pill = (p: Page) => p.$eval(".srr-next-count", (e) => e.textContent)
const waitPill = (p: Page, want: string) =>
   p.waitForFunction((w) => document.querySelector(".srr-next-count")?.textContent === w, {}, want)

const clickMenuItem = (p: Page, label: string) =>
   p.evaluate((l) => {
      const btn = [...document.querySelectorAll(".srr-ctxmenu-item")].find((b) => b.textContent === l)
      ;(btn as HTMLElement | undefined)?.click()
   }, label)

describe("browser: filter picker & frontier menu", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/sport.xml": rssFeed("Sport", sport),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "art", "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   const open = () => openCtx(browser, baseUrl, waitList)

   it("picks a feed from the picker, then returns via the [ALL] scope chip", async () => {
      const [page, close] = await open()
      try {
         expect((await $rowTitles(page)).length).toBe(4)

         await pickFilter(page, "1") // Sport's feed id
         // Picking closes the overlay, re-filters the LIST in place, and the
         // now-viewing readout names the lane.
         expect(await page.$eval(".srr-picker", (e) => (e as HTMLElement).hidden)).toBe(true)
         await waitRowTitles(page, ["sport title 1", "sport title 0"])
         expect(await page.$eval(".srr-feed-name", (e) => e.textContent)).toBe("Sport")

         await pickFilter(page, "") // the [ALL] scope chip
         await waitRowTitles(page, ["sport title 1", "sport title 0", "news title 1", "news title 0"])
      } finally {
         await close()
      }
   })

   it("picks a tag header and filters to its member feeds", async () => {
      const [page, close] = await open()
      try {
         await pickFilter(page, "world")
         await waitRowTitles(page, ["news title 1", "news title 0"])
         expect(await page.$eval(".srr-feed-name", (e) => e.textContent)).toBe("world")
      } finally {
         await close()
      }
   })

   it("Info mode routes a row tap to the feed's stats card instead of filtering", async () => {
      const [page, close] = await open()
      try {
         await page.click(".srr-filter")
         await waitPicker(page)
         await page.click(".srr-picker-info")
         expect(await page.$eval(".srr-picker-info", (e) => e.getAttribute("aria-pressed"))).toBe("true")

         await page.click('.srr-picker [data-value="1"]')
         await page.waitForSelector(".srr-info-dialog.srr-open") // shown via the srr-open class
         expect(await page.$eval(".srr-info-title", (e) => e.textContent)).toBe("Sport")
         expect(await page.$eval(".srr-info-body", (e) => e.textContent)).toContain("Articles")
         // A stats-mode tap must NOT have picked the filter.
         expect((await $rowTitles(page)).length).toBe(4)

         await page.click(".srr-info-close")
         await page.waitForFunction(() => !document.querySelector(".srr-info-dialog.srr-open"))
      } finally {
         await close()
      }
   })

   it("opens the settings menu from the readout with the status footer", async () => {
      const [page, close] = await open()
      try {
         await page.click(".srr-feed")
         await page.waitForSelector(".srr-ctxmenu")
         const labels = await page.$$eval(".srr-ctxmenu-item", (els) => els.map((e) => e.textContent))
         expect(labels).toContain("Search articles…")
         // The status footer always carries the build's version label.
         expect(await page.$eval(".srr-status-version", (e) => e.textContent)).toMatch(/^srr /)
         await page.keyboard.press("Escape")
         await page.waitForFunction(() => !document.querySelector(".srr-ctxmenu"))
      } finally {
         await close()
      }
   })

   it("marks all read / unread-from-here via the next pill's context menu", async () => {
      const [page, close] = await open()
      try {
         // Open the OLDEST article: a recorded landing raises every frontier to
         // chron 0, so the pending pill = the 3 articles ahead.
         await clickRow(page, "news title 0")
         await waitReader(page)
         await waitPill(page, "3")

         // Right-click the next pill → the frontier menu (its only anchor).
         await page.click(".srr-next", { button: "right" })
         await page.waitForSelector(".srr-ctxmenu")
         await clickMenuItem(page, "Mark all read")
         await waitPill(page, "0") // honest mid-history 0 in show-read mode
         expect(await $pill(page)).toBe("0")

         // The explicit rewind: everything from here (chron 0) is unread again.
         await page.click(".srr-next", { button: "right" })
         await page.waitForSelector(".srr-ctxmenu")
         await clickMenuItem(page, "Mark unread from here")
         await waitPill(page, "3")
      } finally {
         await close()
      }
   })
})
