import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { clearDir, launchBrowser, open as openCtx, waitList, waitReader } from "./helpers"

// The image lightbox (RDR7) in a REAL browser. jsdom can prove the module's
// logic but not the two things that actually decide whether this feature works:
// real focus semantics (Escape must hand focus back to the <img> that opened the
// viewer) and real event ordering (the viewer's capture-phase key trap sitting in
// front of app.ts's document-level reader keymap). Both are asserted here over a
// real store whose article carries a real, loading image.

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// A big SVG: text, so the canned feed server can serve it as a plain string
// body, and 2000px wide so it is genuinely larger than the box the viewer fits
// it into (⇒ the zoom toggle has something to do).
const PIC = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500"><rect width="2000" height="1500" fill="#4488cc"/></svg>`

const $viewerOpen = (p: Page) =>
   p.evaluate(() => document.querySelector(".srr-lightbox")?.classList.contains("srr-open") === true)
const $viewerSrc = (p: Page) => p.evaluate(() => document.querySelector(".srr-lightbox-img")?.getAttribute("src"))
const $title = (p: Page) => p.$eval(".srr-title", (e) => e.textContent)
// Is the focused element the article's own <img>? (Focus identity, not a selector
// match — the point of the assertion is that it is THAT element.)
const $focusIsArticleImg = (p: Page) =>
   p.evaluate(() => document.activeElement === document.querySelector(".srr-content img"))

const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

// The reader is showing `title` AND its content image has actually decoded — a
// broken image is hidden by CSS, so clicking one would fail for the wrong reason.
const waitArticleImage = (p: Page, title: string) =>
   p.waitForFunction(
      (want) => {
         if (document.querySelector(".srr-title")?.textContent !== want) return false
         const img = document.querySelector(".srr-content img") as HTMLImageElement | null
         return !!img && img.complete && img.naturalWidth > 0
      },
      { timeout: 20000 },
      title,
   )

const clickArticleImage = (p: Page, selector = ".srr-content img") =>
   p.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.click(), selector)

describe("browser: content image lightbox", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      // Route table first so the article bodies can point at the live port.
      feeds = await feedServer({ "/pic.svg": { body: PIC, type: "image/svg+xml" } })
      const items: FeedItem[] = [
         {
            title: "bare image",
            link: "http://example.com/pics/0",
            guid: "pics-0",
            pubDate: pubDate(0),
            content: `<p>lead paragraph</p><img src="${feeds.url}/pic.svg" alt="a wide chart">`,
         },
         {
            // The exemption: an <img> the author wrapped in a link is a
            // navigation control, and the viewer must leave it alone.
            title: "linked image",
            link: "http://example.com/pics/1",
            guid: "pics-1",
            pubDate: pubDate(1),
            content: `<p>lead paragraph</p><a href="http://example.com/full"><img src="${feeds.url}/pic.svg" alt="linked chart"></a>`,
         },
      ]
      feeds.set("/pics.xml", rssFeed("Pics", items))

      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "Pics", "-u", `${feeds.url}/pics.xml`)
      await srr(packsDir, "art", "fetch")

      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   const open = () => openCtx(browser, baseUrl, waitList)

   it("opens on a bare content image, and Escape closes it with focus back on the image", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "bare image")
         await waitReader(page)
         await waitArticleImage(page, "bare image")

         await clickArticleImage(page)
         expect(await $viewerOpen(page)).toBe(true)
         expect(await $viewerSrc(page)).toBe(`${feeds.url}/pic.svg`)

         await page.keyboard.press("Escape")
         expect(await $viewerOpen(page)).toBe(false)
         // Focus returns to the originating <img> — and the Escape that closed
         // the viewer did NOT also drop the reader back to the list.
         expect(await $focusIsArticleImg(page)).toBe(true)
         expect(await $title(page)).toBe("bare image")
      } finally {
         await close()
      }
   })

   it("swallows the reader keymap while it is open", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "bare image")
         await waitReader(page)
         await waitArticleImage(page, "bare image")
         await clickArticleImage(page)
         expect(await $viewerOpen(page)).toBe(true)

         // ← / → walk articles in the reader. Behind an open viewer they must do
         // nothing at all: same article, viewer still up.
         await page.keyboard.press("ArrowLeft")
         await page.keyboard.press("ArrowRight")
         expect(await $viewerOpen(page)).toBe(true)
         expect(await $title(page)).toBe("bare image")
      } finally {
         await close()
      }
   })

   it("enlarges on a press inside the viewer and restores on the next", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "bare image")
         await waitReader(page)
         await waitArticleImage(page, "bare image")
         await clickArticleImage(page)

         const zoomed = await page.evaluate(() => {
            ;(document.querySelector(".srr-lightbox-stage") as HTMLElement).click()
            return {
               transform: (document.querySelector(".srr-lightbox-img") as HTMLElement).style.transform,
               flagged: document.querySelector(".srr-lightbox")!.classList.contains("srr-lightbox-zoomed"),
            }
         })
         expect(zoomed.transform).toMatch(/^scale\(/)
         expect(zoomed.flagged).toBe(true)
         // Still open — a zoom toggle is not a dismissal.
         expect(await $viewerOpen(page)).toBe(true)

         const restored = await page.evaluate(() => {
            ;(document.querySelector(".srr-lightbox-stage") as HTMLElement).click()
            return (document.querySelector(".srr-lightbox-img") as HTMLElement).style.transform
         })
         expect(restored).toBe("")
         expect(await $viewerOpen(page)).toBe(true)
      } finally {
         await close()
      }
   })

   it("leaves a linked image to its link", async () => {
      const [page, close] = await open()
      try {
         await clickRow(page, "linked image")
         await waitReader(page)
         await waitArticleImage(page, "linked image")

         // index.html's <base target="_blank"> sends external links to a new tab,
         // so the reader stays put; catch and discard whatever opens.
         const popup = new Promise<void>((resolve) => {
            page.once("popup", (p) => void p?.close().then(resolve, resolve))
            setTimeout(resolve, 1500)
         })
         await clickArticleImage(page)
         await popup
         expect(await $viewerOpen(page)).toBe(false)
         expect(await $title(page)).toBe("linked image")
      } finally {
         await close()
      }
   })
})
