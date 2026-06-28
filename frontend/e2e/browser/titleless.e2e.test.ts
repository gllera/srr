import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// Titleless feeds (Telegram-style: the title duplicates the content lead). A
// feed flagged `nt` in db.gz makes the reader HIDE the <h1> and expose a
// masthead permalink icon instead; the list still uses the title as its row
// label. Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false — so each owns it).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// micro = the titleless feed (newest, startIdx 30 → top of the list). news =
// an ordinary feed for contrast.
const micro = nItems(1, "micro", 0, 30)
const news = nItems(1, "news", 0, 0)

const $hasTitleless = (p: Page) => p.$eval(".srr-reader", (e) => e.classList.contains("srr-reader-titleless"))
// offsetParent is null for a display:none element → a robust "is it visible".
const $titleVisible = (p: Page) => p.$eval(".srr-title-link", (e) => (e as HTMLElement).offsetParent !== null)
const $kickerVisible = (p: Page) => p.$eval(".srr-kicker-link", (e) => (e as HTMLElement).offsetParent !== null)
const $kickerHref = (p: Page) => p.$eval(".srr-kicker-link", (e) => e.getAttribute("href"))
const $titleText = (p: Page) => p.$eval(".srr-title", (e) => e.textContent)

const waitReader = (p: Page) =>
   p.waitForFunction(
      () => {
         const a = document.querySelector(".srr-reader") as HTMLElement | null
         return !!a && !a.hidden && (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0
      },
      { timeout: 20000 },
   )
const waitList = (p: Page) =>
   p.waitForFunction(
      () => {
         const l = document.querySelector(".srr-list") as HTMLElement | null
         return (
            !!l &&
            !l.hidden &&
            l.querySelector("a.srr-row") != null &&
            l.querySelector("a.srr-row.srr-row-skeleton") == null
         )
      },
      { timeout: 20000 },
   )

// Click the list row whose title matches (rows are <a> with intercepted clicks).
const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

describe("browser: titleless feeds (reader hides the duplicate heading)", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/micro.xml": rssFeed("Micro", micro),
         "/news.xml": rssFeed("News", news),
      })
      for (const f of readdirSync(packsDir)) rmSync(join(packsDir, f), { recursive: true, force: true })

      // The titleless feed is created via `feed apply` (offline) with no_title:true.
      const applyDir = mkdtempSync(join(tmpdir(), "srr-titleless-apply-"))
      const applyFile = join(applyDir, "micro.json")
      writeFileSync(applyFile, JSON.stringify({ title: "Micro", url: `${feeds.url}/micro.xml`, no_title: true }))
      await srr(packsDir, "feed", "apply", "-f", applyFile)
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "art", "fetch")
      rmSync(applyDir, { recursive: true, force: true })

      browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   async function open(): Promise<[Page, () => Promise<void>]> {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      await page.goto(baseUrl, { waitUntil: "load" })
      await waitList(page)
      return [page, async () => ctx.close()]
   }

   it("hides the heading and shows a masthead permalink for a titleless feed", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "micro title 0")
         await waitReader(page)
         // The reader is flagged titleless: the <h1> permalink block is hidden…
         expect(await $hasTitleless(page)).toBe(true)
         expect(await $titleVisible(page)).toBe(false)
         // …and the masthead permalink stands in, pointing at the article link.
         expect(await $kickerVisible(page)).toBe(true)
         expect(await $kickerHref(page)).toBe("http://example.com/micro/0")
      } finally {
         await close()
      }
   })

   it("keeps the heading and hides the masthead permalink for an ordinary feed", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "news title 0")
         await waitReader(page)
         expect(await $hasTitleless(page)).toBe(false)
         expect(await $titleVisible(page)).toBe(true)
         expect(await $titleText(page)).toBe("news title 0")
         expect(await $kickerVisible(page)).toBe(false)
      } finally {
         await close()
      }
   })
})
