import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList, waitReader } from "./helpers"

// The narrow ★ Saved return in real Chrome: back from the reader, the list
// re-centres on the article you were reading (show()'s fast path). In ★ Saved a
// row un-saved from the reader leaves the list on that return — and when it sat
// ABOVE the article, its removal after the centring scroll moved the article up
// by one row height. Only real layout shows that (jsdom rows have no height).
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// A landing holds the guard mutex until after its render; a key pressed before
// it lets go is dropped as busy. The loading veil is on for exactly that span.
const settled = (p: Page) =>
   p.waitForFunction(() => !document.body.classList.contains("srr-loading"), { timeout: 20_000 })

const frames = (p: Page, n = 3) =>
   p.evaluate(
      (k) =>
         new Promise<void>((r) => {
            const step = (i: number) => (i <= 0 ? r() : requestAnimationFrame(() => step(i - 1)))
            step(k)
         }),
      n,
   )

describe("★ Saved return (narrow)", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({ "/news.xml": rssFeed("News", nItems(40, "news", 0, 0)) })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // Open 18, un-save it (b), step to the older save 17 (←), go back (Escape):
   // row 18 — above 17 in the list — is dropped, and 17 must still sit centred.
   it("centres the article after dropping a row un-saved above it", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.setViewport({ width: 420, height: 900 })
         await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await page.evaluate(() => {
            const saved: number[] = []
            for (let c = 5; c <= 30; c++) saved.push(c)
            localStorage.setItem("srr-saved", JSON.stringify(saved))
            localStorage.setItem("srr-unread-only", "0")
            location.hash = "#!~saved"
         })
         await page.reload({ waitUntil: "load" })
         await waitList(page)
         await page.evaluate(() =>
            (document.querySelector('.srr-list a.srr-row[data-chron="18"]') as HTMLElement).click(),
         )
         await waitReader(page)
         await page.waitForFunction(() => location.hash.startsWith("#18"), { timeout: 20_000 })
         await settled(page)
         await page.keyboard.press("b")
         await page.waitForFunction(() => !document.querySelector(".srr-save")?.classList.contains("srr-saved"))
         await page.keyboard.press("ArrowLeft")
         await page.waitForFunction(() => location.hash.startsWith("#17"), { timeout: 20_000 })
         await settled(page)
         await frames(page)
         await page.keyboard.press("Escape")
         await page.waitForFunction(
            () =>
               !(document.querySelector(".srr-list") as HTMLElement).hidden &&
               !!document.querySelector('.srr-list a.srr-row[data-chron="17"]') &&
               !document.querySelector('.srr-list a.srr-row[data-chron="18"]'),
            { timeout: 20_000 },
         )
         await frames(page, 5)
         const m = await page.evaluate(() => {
            const r = (
               document.querySelector('.srr-list a.srr-row[data-chron="17"]') as HTMLElement
            ).getBoundingClientRect()
            return { offCenter: Math.round(r.top + r.height / 2 - innerHeight / 2), rowH: Math.round(r.height) }
         })
         expect(m.rowH).toBeGreaterThan(20) // a real row, so one row's shift is unmistakable
         expect(Math.abs(m.offCenter)).toBeLessThan(m.rowH / 4)
      } finally {
         await ctx.close()
      }
   })
})
