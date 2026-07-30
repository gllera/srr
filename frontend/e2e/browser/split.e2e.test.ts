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
      // The pane RESTS before the session's first open — it does not blank. Two
      // thirds of a desktop window with nothing in it, under a toolbar whose
      // arrows are all disabled, is what "the desktop view looks broken" meant;
      // the reader's own directed panel stands in until something is opened, and
      // Next is armed so its "Tap Next to start reading" is a true sentence.
      await page.waitForFunction(
         () => document.querySelector("article.srr-reader.srr-reader-empty .srr-empty-eyebrow"),
         { timeout: 20_000 },
      )
      expect(await visible(page, "article.srr-reader")).toBe(true)
      expect(await page.$eval(".srr-next", (b) => (b as HTMLButtonElement).disabled)).toBe(false)
      // A resting paint is not a navigation: the LIST keeps the keyboard.
      expect(await page.evaluate(() => document.activeElement?.closest(".srr-content") !== null)).toBe(false)

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
      // Both scrolls must be REAL for this to assert anything: park the pane
      // off its top, then scroll the window and prove only the window moved. The
      // article has to be tall enough for the window to have somewhere to go —
      // asserted, because a short one makes the whole case vacuous (scrollBy on
      // an unscrollable document leaves 0 === 0).
      // The fixture's articles are SHORTER than the viewport, so the document has
      // nowhere to scroll and the case was vacuous (0 === 0 proves nothing about
      // independence). Give the reader column real height for the measurement —
      // the pane is already taller than any viewport at 30 rows.
      await page.evaluate(() => {
         ;(document.querySelector(".srr-content") as HTMLElement).style.minHeight = "3000px"
      })
      const pane = await page.evaluate(() => {
         const l = document.querySelector(".srr-list")!
         l.scrollTop = Math.min(300, l.scrollHeight - l.clientHeight)
         return { top: l.scrollTop, scrollH: l.scrollHeight, clientH: l.clientHeight }
      })
      expect(pane.top, `pane must be scrollable to park it (${JSON.stringify(pane)})`).toBeGreaterThan(0)
      const paneBefore = pane.top
      await page.evaluate(() => window.scrollBy(0, 400))
      const { paneAfter, scrolled } = await page.evaluate(() => ({
         paneAfter: document.querySelector(".srr-list")!.scrollTop,
         scrolled: window.scrollY,
      }))
      expect(scrolled).toBeGreaterThan(0) // the window really moved…
      expect(paneAfter).toBe(paneBefore) // …and the pane did not follow it
      await page.evaluate(() => {
         window.scrollTo(0, 0)
         document.querySelector(".srr-list")!.scrollTop = 0
         ;(document.querySelector(".srr-content") as HTMLElement).style.minHeight = ""
      })
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
            // Three of the four left-edge rules used to be asserted by NOTHING:
            // only the toolbar is up in this state, so every other bar took the
            // `continue` below and its rule could have been deleted silently.
            // Raise the other two by un-hiding them ([hidden] is the only thing
            // keeping either off screen): what is under test here is a
            // POSITIONING rule — where the box lands once it exists — not the
            // transport's or the snackbar's own show/hide logic, which their own
            // suites cover. Raising them "for real" is not available anyway:
            // headless Chromium decodes none of the fixture's media, so nothing
            // ever plays.
            await p.evaluate(() => {
               document.querySelector(".srr-player")!.removeAttribute("hidden")
               document.querySelector(".srr-snackbar")!.removeAttribute("hidden")
            })

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

            // Non-vacuity, per bar: a rule nothing measured is a rule nothing
            // asserts. Three of the four are up by construction above; only
            // .srr-pin-progress is genuinely conditional and keeps the `continue`.
            expect(m.bars[".srr-toolbar"], `toolbar measured at ${width}px`).not.toBeNull()
            expect(m.bars[".srr-player"], `player measured at ${width}px`).not.toBeNull()
            expect(m.bars[".srr-snackbar"], `snackbar measured at ${width}px`).not.toBeNull()
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
         const chip = await p.evaluate(() => {
            const c = document.querySelector(".srr-content .srr-queue-chip")
            // EXISTS (the queue entry stays — an `error` can be transient) but
            // paints nothing. Asserting only "not visible" would pass just as
            // happily if injectQueueChips had stopped making chips at all.
            return { present: !!c, shown: (c?.getClientRects().length ?? 0) > 0 }
         })
         expect(chip.present).toBe(true)
         expect(chip.shown).toBe(false)
         // …and the `p` key must not queue that invisible dead enclosure: with
         // the broken video the article's ONLY media, the key is a no-op rather
         // than a silent queueing of bytes that will never play.
         const queuedAfterKey = await p.evaluate(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }))
            await new Promise((r) => setTimeout(r, 200))
            return (document.querySelector(".srr-content .srr-queue-chip") as HTMLElement)?.getAttribute("aria-pressed")
         })
         expect(queuedAfterKey).toBe("false")
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
      // pane is still on screen with its arrows live. selectTokens asks the same
      // question the list just anchored on (nav.listAnchor) and lands the pane on
      // that answer, unrecorded; without it the pane would keep showing a news
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

   // nav.pos is ONE cursor for two surfaces. A rebuild of the list — a Show-read
   // flip, a search keystroke — used to re-seed it from the list's own anchor
   // while the reader kept its article: the pane then highlighted one article,
   // the reader showed another, and the toolbar arrows stepped from the
   // highlight (measured: Next from a displayed chron 20 landed on 25).
   it("a list rebuild leaves the cursor with the article the pane is showing", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 3")
         await waitReader(p)
         const before = await p.evaluate(() => location.hash)

         // Show read ON, then OFF: the second flip re-anchors the list at the
         // lane's oldest unread — a different article from the one on screen.
         const flipShowRead = async () => {
            await p.evaluate(() => document.querySelector<HTMLElement>(".srr-toolbar .srr-filter")?.click())
            await p.waitForFunction(() => !!document.querySelector(".srr-picker-showread"), { timeout: 20_000 })
            await p.evaluate(() => document.querySelector<HTMLElement>(".srr-picker-showread")?.click())
            await new Promise((r) => setTimeout(r, 400))
            await p.keyboard.press("Escape")
            await p.waitForFunction(() => !document.body.classList.contains("srr-loading"), { timeout: 20_000 })
         }
         await flipShowRead()
         await flipShowRead()

         // The reader never moved…
         expect(await p.evaluate(() => location.hash)).toBe(before)
         // …and the step from here is the NEXT article, not a jump from wherever
         // the rebuild would have parked the cursor.
         const chron = Number(before.slice(1).split("!")[0])
         await p.evaluate(() => document.querySelector<HTMLButtonElement>(".srr-next")?.click())
         await p.waitForFunction((h) => location.hash !== h, { timeout: 20_000 }, before)
         expect(Number((await p.evaluate(() => location.hash)).slice(1).split("!")[0])).toBe(chron + 1)
      } finally {
         await ctx.close()
      }
   })

   // Typing a query is the same rebuild from the other direction — and it used to
   // leave the toolbar arrows DEAD as well as desynced, because nav's cursor had
   // moved to a hit while the reader still showed the article behind it.
   it("keeps the reader steppable while a search query rebuilds the pane", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 2")
         await waitReader(p)
         const shown = await p.evaluate(() => document.querySelector(".srr-title")?.textContent)

         await p.keyboard.press("/")
         await p.waitForFunction(() => document.body.classList.contains("srr-searching"), { timeout: 20_000 })
         await p.keyboard.type("sport")
         await p.waitForFunction(
            () => [...document.querySelectorAll(".srr-list a.srr-row")].some((r) => /sport/i.test(r.textContent || "")),
            { timeout: 20_000 },
         )
         // The pane rebuilt into the results, the reader kept its article…
         expect(await p.evaluate(() => document.querySelector(".srr-title")?.textContent)).toBe(shown)
         // …and Next still steps it rather than sitting inert.
         const before = await p.evaluate(() => location.hash)
         await p.evaluate(() => document.querySelector<HTMLButtonElement>(".srr-next")?.click())
         await p.waitForFunction((h) => location.hash !== h, { timeout: 20_000 }, before)

         // The bar reserves its OWN height in the pane: a short query adds the
         // note line ("ne" is short enough to trigger it AND matches the news
         // fixture), which wraps in a 380px pane, and a fixed reserve then left
         // the bar sitting on the first rows.
         await p.evaluate(() => {
            const i = document.querySelector<HTMLInputElement>(".srr-search-input")!
            i.value = "ne"
            i.dispatchEvent(new Event("input", { bubbles: true }))
         })
         await p.waitForFunction(() => !document.querySelector<HTMLElement>(".srr-search-note")?.hidden, {
            timeout: 20_000,
         })
         const clearance = await p.evaluate(() => {
            const bar = document.querySelector(".srr-searchbar")!.getBoundingClientRect()
            const row = document.querySelector(".srr-list a.srr-row")?.getBoundingClientRect()
            return { barBottom: Math.round(bar.bottom), rowTop: row ? Math.round(row.top) : null }
         })
         expect(clearance.rowTop, "a row must be rendered to measure against").not.toBeNull()
         expect(clearance.rowTop!).toBeGreaterThanOrEqual(clearance.barBottom)

         // The bar rides the pane and stays up on the reader surface, so `/` has
         // to CLOSE it from there too — the list-only toggle made it a one-way
         // door under split: a pinned bar the key could no longer dismiss.
         await p.keyboard.press("/")
         await p.waitForFunction(() => !document.body.classList.contains("srr-searching"), { timeout: 20_000 })
      } finally {
         await ctx.close()
      }
   })

   // A `#pos` deep link (a shared link, a restored session) is the one entry
   // that never goes through the list surface: route()'s numeric branch makes no
   // list call at all, and the pane is built by guard()'s followCursor instead.
   // Nothing covered that seam, so a pane that failed to build behind an open
   // article would have gone unnoticed.
   it("builds the list pane beside a #pos deep link", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#7`, { waitUntil: "load" })
         await waitReader(p)
         expect(await visible(p, ".srr-list")).toBe(true)
         // …with rows, and the deep-linked article marked as the cursor row.
         await p.waitForFunction(
            () => document.querySelector(".srr-list .srr-row-current")?.getAttribute("data-chron") === "7",
            { timeout: 20_000 },
         )
      } finally {
         await ctx.close()
      }
   })

   // A breakpoint crossing must re-assert the LAYOUT without re-routing: the
   // reader keeps its article, its DOM and its scroll position (Chrome
   // re-evaluates width queries against the page box while printing, so Ctrl-P
   // fires a crossing and its undo).
   it("keeps the open article and its scroll across a breakpoint crossing", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#7`, { waitUntil: "load" })
         await waitReader(p)
         await p.evaluate(() => {
            ;(document.querySelector(".srr-content") as HTMLElement).style.minHeight = "3000px"
            window.scrollTo(0, 600)
         })
         const before = await p.evaluate(() => ({
            y: window.scrollY,
            hash: location.hash,
            title: document.querySelector(".srr-title")?.textContent,
         }))
         expect(before.y).toBeGreaterThan(0)
         await p.setViewport({ width: 800, height: 900 })
         await new Promise((r) => setTimeout(r, 400))
         await p.setViewport({ width: 1280, height: 900 })
         await new Promise((r) => setTimeout(r, 600))
         const after = await p.evaluate(() => ({
            y: window.scrollY,
            hash: location.hash,
            title: document.querySelector(".srr-title")?.textContent,
            split: document.body.classList.contains("srr-split"),
            listShown: !document.querySelector<HTMLElement>(".srr-list")!.hidden,
         }))
         expect(after.title).toBe(before.title)
         expect(after.hash).toBe(before.hash)
         expect(after.split).toBe(true)
         expect(after.listShown).toBe(true) // the pane is back, not left hidden
         expect(after.y).toBeGreaterThan(0) // …and the article did not jump to the top
      } finally {
         await ctx.close()
      }
   })

   // The same crossing made from the LIST surface, which is where it broke. The
   // single-surface layout HIDES the article and DISABLES the reader-only
   // prev/next; readerLive() reads that hidden flag, so on the way back the
   // question was being asked of a pane still marked hidden by the layout being
   // left. It answered "no article here" for a reader holding a perfectly good
   // one, and the resting paint replaced it with "Not started" — and the arrows
   // stayed disabled underneath, because the split branch deliberately doesn't
   // touch the chrome the narrow branch turned off.
   it("keeps the open article — and its chrome — when the LIST surface re-enters split", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 5")
         await waitReader(p)
         // Back to the LIST surface, article still beside it.
         await p.keyboard.press("Escape")
         await p.waitForFunction(() => document.body.classList.contains("srr-view-list"), { timeout: 10_000 })
         const chrome = () =>
            p.evaluate(() => ({
               title: document.querySelector(".srr-title")?.textContent,
               resting: !!document.querySelector(".srr-reader.srr-reader-empty"),
               prev: (document.querySelector(".srr-prev") as HTMLButtonElement).disabled,
               next: (document.querySelector(".srr-next") as HTMLButtonElement).disabled,
            }))
         const before = await chrome()
         expect(before.resting).toBe(false)

         await p.setViewport({ width: 800, height: 900 })
         await new Promise((r) => setTimeout(r, 400))
         await p.setViewport({ width: 1280, height: 900 })
         await new Promise((r) => setTimeout(r, 700))

         // Byte-for-byte the state it left with: the crossing re-asserts the
         // layout, it does not re-decide what the reader is showing.
         expect(await chrome()).toEqual(before)
      } finally {
         await ctx.close()
      }
   })

   // Under split the reader never leaves the screen, so Escape back into it is a
   // FOCUS change. Routing it through a render tore the mounted article down and
   // scrolled it to the top: glance at the list and come back, and you had lost
   // your place in an article that was visible the whole time.
   it("re-entering the reader keeps the mounted article and its scroll", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 700 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         await clickRow(p, "news title 5")
         await waitReader(p)
         // The shared fixture's articles are one line long, so give this one a
         // tall marker: it makes the reader column genuinely window-scrollable
         // AND is destroyed by a re-render (the content host's children are
         // replaced), so one node answers both halves of the contract.
         await p.evaluate(() => {
            const tall = document.createElement("div")
            tall.dataset.e2eMark = "kept"
            tall.style.height = "2000px"
            document.querySelector(".srr-content")!.append(tall)
            window.scrollTo(0, 300)
         })
         await new Promise((r) => setTimeout(r, 300))
         const scrolled = await p.evaluate(() => Math.round(scrollY))
         expect(scrolled).toBeGreaterThan(0)

         await p.keyboard.press("Escape") // → the list surface
         await p.waitForFunction(() => document.body.classList.contains("srr-view-list"), { timeout: 10_000 })
         await p.keyboard.press("Escape") // → back into the reader
         await p.waitForFunction(() => !document.body.classList.contains("srr-view-list"), { timeout: 10_000 })
         await new Promise((r) => setTimeout(r, 400))

         expect(
            await p.evaluate(() => ({
               kept: !!document.querySelector(".srr-content [data-e2e-mark='kept']"),
               title: document.querySelector(".srr-title")?.textContent,
               y: Math.round(scrollY),
            })),
         ).toEqual({ kept: true, title: "news title 5", y: scrolled })
      } finally {
         await ctx.close()
      }
   })

   // The resting pane's Next is the "start reading" affordance its own copy
   // advertises. nav.restingState builds that panel for a cursor of -1, but the
   // pane only exists beside a list that has ALREADY seeded the shared cursor at
   // its anchor — so the step landed one PAST it, opening the backlog's second
   // article and marking the first read behind you.
   it("starts reading at the article the list highlights, from the resting pane", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 1280, height: 900 })
         await p.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(p)
         // A list-only boot rests the pane; the list seeds its anchor row.
         await p.waitForFunction(() => !!document.querySelector(".srr-reader.srr-reader-empty"), { timeout: 10_000 })
         await p.waitForFunction(() => !!document.querySelector(".srr-row-current"), { timeout: 10_000 })
         const highlighted = await p.evaluate(
            () => document.querySelector(".srr-row-current .srr-row-title")?.textContent,
         )

         await p.evaluate(() => (document.querySelector(".srr-next") as HTMLButtonElement).click())
         await waitReader(p)
         // The panel offered the backlog; it must open the article it was
         // pointing at, not the one after it.
         expect(await p.evaluate(() => document.querySelector(".srr-title")?.textContent)).toBe(highlighted)
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
