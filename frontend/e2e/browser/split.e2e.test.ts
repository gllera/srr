import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, pubDate, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList, waitReader } from "./helpers"

// The two-pane split view (body.srr-split, ≥1000px), driven through the real
// SPA in real Chrome: the breakpoint stamp, the blank-right-pane v1 contract on
// a list-only boot, both panes staying visible after the first open, the reader
// arrows pulling the list's cursor row along (list.followCursor), the pane's
// OWN scroll staying independent of the window (reader) scroll, browser-back to
// a list hash, and the narrow-viewport regression (single surface, exactly as
// before). Like refresh/delta, the first four cases form an ordered
// open → step → scroll → back SEQUENCE over one page — that temporal
// progression IS the contract under test (a session's first open is what
// un-blanks the pane). Own beforeAll clears + rebuilds the shared packsDir
// (browser files run serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// Disjoint published ranges → chron 0..14 = news, 15..29 = sport. 30 articles
// make the fixed list pane genuinely taller than a 900px viewport, so the
// pane-scroll independence case measures a real (non-zero) scroll position.
const news = nItems(15, "news", 0, 0)
const sport = nItems(15, "sport", 0, 20)
// One article carrying a video whose bytes are NOT servable: "/dead.mp4" is
// same-origin (the static server 404s unknown paths), so the element fires
// `error`, fmt.ts stamps .srr-broken (display:none) and the queue chip beside it
// loses its positioning anchor. Published above sport so it takes the newest
// chron and leaves the news/sport chron ranges the other cases rely on alone.
const media = [
   {
      title: "media title 0",
      link: "http://example.com/media/0",
      guid: "media-0",
      pubDate: pubDate(40),
      content: `<p>before</p><p><video src="/dead.mp4" controls width="640" height="360"></video></p><p>after</p>`,
   },
]

// Rendered and on screen: present, not [hidden], and generating boxes.
const visible = (p: Page, sel: string) =>
   p.evaluate((s) => {
      const n = document.querySelector<HTMLElement>(s)
      return !!n && !n.hidden && n.getClientRects().length > 0
   }, sel)

const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

describe("browser: split view (two-pane desktop)", () => {
   let feeds: FeedServer
   let browser: Browser
   let page: Page

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/sport.xml": rssFeed("Sport", sport),
         "/media.xml": rssFeed("Media", media),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "feed", "add", "-t", "Media", "-u", `${feeds.url}/media.xml`)
      await srr(packsDir, "fetch")
      browser = await launchBrowser()
      page = await browser.newPage()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("activates above the breakpoint and keeps both panes visible after opening a row", async () => {
      await page.setViewport({ width: 1280, height: 900 })
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      await waitList(page)

      expect(await page.evaluate(() => document.body.classList.contains("srr-split"))).toBe(true)
      // Blank right pane before the session's first open (v1 contract).
      expect(await visible(page, "article.srr-reader")).toBe(false)

      // Open the OLDEST article, not the first (newest) row: the next case
      // steps → (newer) from here, which the newest article could not.
      await clickRow(page, "news title 0")
      await waitReader(page)
      expect(await visible(page, ".srr-list")).toBe(true) // the list never left
      expect(await visible(page, "article.srr-reader")).toBe(true)
   })

   it("reader arrows step the article and the list highlight follows", async () => {
      const before = await page.evaluate(() => location.hash)
      await page.keyboard.press("ArrowRight")
      await page.waitForFunction((h) => location.hash !== h, { timeout: 20_000 }, before)
      const pos = await page.evaluate(() => location.hash.slice(1).split("!")[0])
      // The cursor row in the pane tracks the open article (list.followCursor).
      await page.waitForFunction(
         (p) => document.querySelector(".srr-row-current")?.getAttribute("data-chron") === p,
         { timeout: 20_000 },
         pos,
      )
   })

   it("window scroll (reader) leaves the list pane's scroll untouched", async () => {
      const paneBefore = await page.evaluate(() => document.querySelector(".srr-list")!.scrollTop)
      await page.evaluate(() => window.scrollBy(0, 400))
      const paneAfter = await page.evaluate(() => document.querySelector(".srr-list")!.scrollTop)
      expect(paneAfter).toBe(paneBefore)
      await page.evaluate(() => window.scrollTo(0, 0))
   })

   it("browser-back to a list hash keeps the list intact (the pane keeps its article)", async () => {
      // Walk back through the forward steps until the hash is list-only (no
      // leading digit). Each same-document traversal settles before the next:
      // a back-to-back goBack can land while the previous route's guard still
      // holds the busy mutex, and renderListSurface DROPS on a held mutex —
      // the URL would move with no surface render behind it.
      while (await page.evaluate(() => /^#\d/.test(location.hash))) {
         const h = await page.evaluate(() => location.hash)
         await page.goBack()
         await page.waitForFunction((prev) => location.hash !== prev, { timeout: 20_000 }, h)
         await page.waitForFunction(() => !document.body.classList.contains("srr-loading"), { timeout: 20_000 })
      }
      await page.waitForFunction(() => document.body.classList.contains("srr-view-list"), { timeout: 20_000 })
      expect(await visible(page, ".srr-list")).toBe(true)
      // The committed v1 contract (app.ts showList): the pane blanks only
      // BEFORE the session's first open — after it, both panes stay live, so
      // browser-back keeps the article beside the list rather than blanking
      // it. (The plan's prose "back = undo the open" describes an unbuilt
      // variant; its own test body asserts only the list. Flip this
      // expectation if that variant ever lands.)
      expect(await page.$eval("article.srr-reader", (e) => (e as HTMLElement).hidden)).toBe(false)
   })

   it("an open right after boot is not yanked by the deferred anchor landing", async () => {
      // Land-once is armed on a fresh [ALL] boot (anchoredMid = the oldest
      // unread) and commits its centered scroll only AFTER fonts.ready + a
      // bounded settle loop. In split view the list stays visible, so the
      // reader-open cancellation (container.hidden) never trips — an immediate
      // row open used to be yanked when that stale landing parked the pane at
      // the BOOT anchor's centered position, leaving the opened row far above
      // the view. The armedChron guard makes the landing yield to followCursor:
      // the opened row must still sit inside the pane well after the settle
      // window. Fresh context — the shared page carries the ordered sequence's
      // history.
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "sport title 5") // immediately — before the deferred landing
         await waitReader(p)
         await new Promise((r) => setTimeout(r, 1200)) // past the bounded ~20-frame settle
         const ok = await p.evaluate(() => {
            const pane = document.querySelector<HTMLElement>(".srr-list")!
            const row = document.querySelector<HTMLElement>(".srr-row-current")
            if (!row) return false
            const r = row.getBoundingClientRect()
            return r.top >= 0 && r.bottom <= pane.clientHeight
         })
         expect(ok).toBe(true)
      } finally {
         await ctx.close()
      }
   })

   // The layout regression this suite originally shipped without. Reserving the
   // pane with body padding moves IN-FLOW content only, so every fixed bar has to
   // move its own left edge or it stays centered in the whole WINDOW: half a pane
   // width off the column it controls, and — because a viewport-centered 680px bar
   // starts at (vw − 680)/2 — painting over the pane at any width below
   // pane + 2*column. Asserted as an identity against .srr-container rather than
   // against numbers, so it holds if the pane width or the column ever changes.
   it("aligns every fixed bar with the reader column and clears the pane", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         for (const width of [1000, 1280, 1440, 1920]) {
            await p.setViewport({ width, height: 900 })
            await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
            await waitList(p)
            // Open an article so the reader column, the toolbar's reader controls
            // and the "Marked N read" snackbar are all live at once.
            await clickRow(p, "news title 0")
            await waitReader(p)
            await p.waitForFunction(() => !document.body.classList.contains("srr-loading"), { timeout: 20_000 })

            const m = await p.evaluate(() => {
               const box = (sel: string) => {
                  const n = document.querySelector<HTMLElement>(sel)
                  if (!n || !n.getClientRects().length) return null
                  const r = n.getBoundingClientRect()
                  return { left: Math.round(r.left), right: Math.round(r.right) }
               }
               const col = box(".srr-container")!
               const pane = box(".srr-list")!
               const bars: Record<string, { left: number; right: number } | null> = {}
               for (const sel of [".srr-toolbar", ".srr-player", ".srr-snackbar", ".srr-pin-progress"])
                  bars[sel] = box(sel)
               return { col, pane, bars, pill: box(".srr-new-pill") }
            })

            // Non-vacuity: the toolbar is permanent chrome, so if it did not
            // measure, the loop below is asserting nothing at all.
            expect(m.bars[".srr-toolbar"], `toolbar measured at ${width}px`).not.toBeNull()
            for (const [sel, bar] of Object.entries(m.bars)) {
               if (!bar) continue // not up in this state — nothing to place
               // Centred on the reader column (±1px for subpixel rounding)…
               const barMid = (bar.left + bar.right) / 2
               const colMid = (m.col.left + m.col.right) / 2
               expect(Math.abs(barMid - colMid), `${sel} centre at ${width}px`).toBeLessThanOrEqual(1)
               // …and never over the pane.
               expect(bar.left, `${sel} vs pane at ${width}px`).toBeGreaterThanOrEqual(m.pane.right)
            }
            // The arrivals pill is the LIST's affordance, so it goes the other
            // way: over the pane, never over the reader.
            if (m.pill) expect(m.pill.right).toBeLessThanOrEqual(m.pane.right)
         }
      } finally {
         await ctx.close()
      }
   })

   it("hides the queue chip of a video whose bytes are gone", async () => {
      // A display:none anchor makes the corner chip's anchor() top/right invalid,
      // so the still-absolutely-positioned chip would fall back to its STATIC
      // position — a loose circle sitting on top of the prose.
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "media title 0")
         await waitReader(p)
         // Wait for the media error to land, not a fixed sleep.
         await p.waitForFunction(() => !!document.querySelector(".srr-content video.srr-broken"), {
            timeout: 20_000,
         })
         const chipShown = await p.evaluate(
            () => (document.querySelector(".srr-content .srr-queue-chip")?.getClientRects().length ?? 0) > 0,
         )
         expect(chipShown).toBe(false)
      } finally {
         await ctx.close()
      }
   })

   it("stands the pager drag down under split", async () => {
      // The reader is in normal flow, so its drag transform paints above the
      // z-auto fixed pane with nothing to clip it — the article would slide
      // straight across the list. gestures.ts declines the gesture instead.
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 1")
         await waitReader(p)
         const hashBefore = await p.evaluate(() => location.hash)

         const previewShown = await p.evaluate(async () => {
            const art = document.querySelector<HTMLElement>("article.srr-reader")!
            const r = art.getBoundingClientRect()
            const cx = r.left + r.width / 2
            const cy = r.top + 200
            const fire = (type: string, x: number, y: number) => {
               const t = new Touch({ identifier: 1, target: art, clientX: x, clientY: y })
               const empty = type === "touchend"
               art.dispatchEvent(
                  new TouchEvent(type, {
                     bubbles: true,
                     cancelable: true,
                     touches: empty ? [] : [t],
                     targetTouches: empty ? [] : [t],
                     changedTouches: [t],
                  }),
               )
            }
            fire("touchstart", cx, cy)
            let seen = false
            for (let d = 10; d <= 160; d += 30) {
               fire("touchmove", cx - d, cy)
               await new Promise((res) => requestAnimationFrame(res))
               if (document.querySelector(".srr-pager-page.srr-pager-show")) seen = true
            }
            fire("touchend", cx - 160, cy)
            return seen
         })
         expect(previewShown).toBe(false)
         // And the drag committed no step.
         expect(await p.evaluate(() => location.hash)).toBe(hashBefore)
      } finally {
         await ctx.close()
      }
   })

   it("brings the reader pane along when a lane change moves the cursor", async () => {
      // The LIST-surface lane change specifically: picker.onSelect routes a pick
      // to nav.switchFilter when view is "reader" (the reader has always followed
      // there) but to selectFilter when it is "list" — and in split the reader
      // pane is still on screen with its arrows live. list.render() then makes the
      // new lane's anchor the cursor (nav.select) because the open article is not a
      // member, so without the follow-up the pane would keep showing a news
      // article while Next stepped from an invisible sport position.
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 0")
         await waitReader(p)
         // Back to the list HASH: view flips to "list" while the pane keeps its
         // article (the contract the browser-back case above pins) — the exact
         // state in which a lane change used to desync.
         await p.goBack()
         await p.waitForFunction(() => document.body.classList.contains("srr-view-list"), { timeout: 20_000 })
         await p.waitForFunction(() => !document.body.classList.contains("srr-loading"), { timeout: 20_000 })
         expect(await p.evaluate(() => document.querySelector(".srr-title")?.textContent)).toBe("news title 0")

         // Open the picker and pick the Sport lane — a disjoint chron range, so
         // the open news article cannot be a member and the cursor must move.
         await p.evaluate(() => document.querySelector<HTMLElement>(".srr-toolbar .srr-filter")?.click())
         // Wait for real ROWS, not the always-present overlay element.
         await p.waitForFunction(
            () =>
               [...document.querySelectorAll(".srr-picker-filter a")].some((e) => /sport/i.test(e.textContent || "")),
            { timeout: 20_000 },
         )
         await p.evaluate(() => {
            const row = [...document.querySelectorAll<HTMLElement>(".srr-picker-filter a")].find((e) =>
               /sport/i.test(e.textContent || ""),
            )
            row?.click()
         })
         // The reader must land on a Sport article, not stay on news title 0.
         await p.waitForFunction(() => /^sport title/.test(document.querySelector(".srr-title")?.textContent ?? ""), {
            timeout: 20_000,
         })
         // …and the list pane highlights that same article.
         await p.waitForFunction(
            () =>
               document.querySelector(".srr-list .srr-row-current .srr-row-title")?.textContent ===
               document.querySelector(".srr-title")?.textContent,
            { timeout: 20_000 },
         )
      } finally {
         await ctx.close()
      }
   })

   it("stays single-surface below the breakpoint (regression)", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 420, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         expect(await p.evaluate(() => document.body.classList.contains("srr-split"))).toBe(false)

         await clickRow(p, "news title 0")
         await waitReader(p)
         // Narrow: opening the reader hides the list, exactly as before.
         expect(await visible(p, ".srr-list")).toBe(false)
      } finally {
         await ctx.close()
      }
   })

   it("a live viewport crossing rewires both directions", async () => {
      // The breakpoint owner (split.ts) re-routes on a LIVE resize — no reload,
      // no goto. Crossing split→narrow from the reader view must land the plain
      // single-surface reader (the list hidden, its pane observer/pill torn down
      // by invalidate), and crossing back must bring both panes up with the
      // cursor row highlighted — and leave the mutex/nav live, proven by a
      // keyboard step actually advancing the hash afterwards.
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 0")
         await waitReader(p)
         expect(await visible(p, ".srr-list")).toBe(true)

         // Split → narrow on the live page: single surface, reader keeps the view.
         await p.setViewport({ width: 420, height: 900 })
         await p.waitForFunction(
            () => !document.body.classList.contains("srr-split") && !document.body.classList.contains("srr-loading"),
            { timeout: 20_000 },
         )
         expect(await visible(p, "article.srr-reader")).toBe(true)
         expect(await visible(p, ".srr-list")).toBe(false)

         // Narrow → split: both panes return, the pane highlights the open article.
         await p.setViewport({ width: 1280, height: 900 })
         await p.waitForFunction(
            () => document.body.classList.contains("srr-split") && !document.body.classList.contains("srr-loading"),
            { timeout: 20_000 },
         )
         await p.waitForFunction(() => !!document.querySelector(".srr-list .srr-row-current"), { timeout: 20_000 })
         expect(await visible(p, ".srr-list")).toBe(true)
         expect(await visible(p, "article.srr-reader")).toBe(true)

         // The re-route released the mutex and nav is live: a step advances.
         const before = await p.evaluate(() => Number(location.hash.slice(1).split("!")[0]))
         await p.keyboard.press("ArrowRight")
         await p.waitForFunction((b) => Number(location.hash.slice(1).split("!")[0]) > b, { timeout: 20_000 }, before)
      } finally {
         await ctx.close()
      }
   })
})
