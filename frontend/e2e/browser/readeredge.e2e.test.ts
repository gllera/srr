import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, open as openCtx, waitReader, waitTitle } from "./helpers"

// Reader edge states through the real UI: the "Not started" placeholder (a
// never-opened lane picked from the reader in the default unread-only mode —
// a resume surface must not silently open unread) with Next armed to start the
// backlog, and the dead-edge behavior on the newest article (explicit "0"
// pill, disabled next, the margin bell on a step into the wall instead of a
// silent no-op). Own beforeAll clears + rebuilds the shared packsDir (browser
// files run serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// Disjoint ranges → chron 0,1 = news · 2,3 = sport (sport newest).
const news = nItems(2, "news", 0, 0)
const sport = nItems(2, "sport", 0, 10)

const $pill = (p: Page) => p.$eval(".srr-next-count", (e) => e.textContent)

describe("browser: reader edge states", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/sport.xml": rssFeed("Sport", sport),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "art", "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("a never-opened lane shows the Not-started placeholder with Next armed to start the backlog", async () => {
      // Deep-link into the reader FILTERED to news (#0!0), so Sport's seen
      // frontier stays untouched (an [ALL] landing would record every feed).
      const [page, close] = await openCtx(browser, `${baseUrl}#0!0`, waitReader)
      try {
         // From the reader, pick the never-opened Sport lane in the picker.
         await page.click(".srr-filter")
         await page.waitForSelector('.srr-picker [data-value="1"]')
         await page.click('.srr-picker [data-value="1"]')

         // Not the article, not "All caught up": the distinct Not-started state,
         // its wire-head naming WHICH feed the backlog starts with.
         await page.waitForSelector(".srr-reader.srr-reader-empty .srr-list-empty")
         expect(await page.$eval(".srr-empty-eyebrow", (e) => e.textContent)).toBe("Not started")
         expect(await page.$eval(".srr-empty-name", (e) => e.textContent)).toBe("Sport")

         // Next is ARMED: enabled, pill = the full backlog (== the picker badge).
         expect(await page.$eval(".srr-next", (e) => (e as HTMLButtonElement).disabled)).toBe(false)
         expect(await $pill(page)).toBe("2")

         // One step starts reading at the oldest unread — no detour via the list.
         await page.keyboard.press("ArrowRight")
         await waitTitle(page, "sport title 0")
         expect(await $pill(page)).toBe("1") // recorded landing: badge ticks with it
      } finally {
         await close()
      }
   })

   it("the newest article is a dead edge: explicit 0 pill, disabled next, margin bell on a step", async () => {
      const [page, close] = await openCtx(browser, `${baseUrl}#3`, waitReader) // newest chron
      try {
         expect(await page.$eval(".srr-title", (e) => e.textContent)).toBe("sport title 1")
         expect(await $pill(page)).toBe("0") // the last article reads an explicit 0
         expect(await page.$eval(".srr-next", (e) => (e as HTMLButtonElement).disabled)).toBe(true)

         // The bell class is transient (240ms) — record it with an observer
         // armed BEFORE the keypress instead of racing a poll against it.
         await page.evaluate(() => {
            const reader = document.querySelector(".srr-reader")!
            new MutationObserver(() => {
               if (reader.classList.contains("srr-bell-right")) (window as unknown as { __bell: boolean }).__bell = true
            }).observe(reader, { attributes: true, attributeFilter: ["class"] })
         })
         await page.keyboard.press("ArrowRight")
         await page.waitForFunction(() => (window as unknown as { __bell?: boolean }).__bell === true)
         // The dead-edge step never navigated anywhere.
         expect(await page.$eval(".srr-title", (e) => e.textContent)).toBe("sport title 1")
      } finally {
         await close()
      }
   })
})
