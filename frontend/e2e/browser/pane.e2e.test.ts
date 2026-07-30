import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList } from "./helpers"

// The desktop pane's width and visibility as a pure CSS layer, driven through
// the real SPA in real Chrome. Nothing here touches pane.ts: every case stamps
// the class or writes the custom property by hand, so what is under test is the
// styles.css/tokens.css contract alone — the reserve derived on <body> from the
// open width on <html>, and what body.srr-pane-hidden does to it.
// 30 articles make the pane genuinely taller than the viewport, so the
// scroll-survival case measures a real (non-zero) scrollTop.
const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const news = nItems(15, "news", 0, 0)
const sport = nItems(15, "sport", 0, 20)

// The px width the page actually reserves for the pane. NaN when the property
// resolves to nothing at all, which is a louder failure than a wrong number.
const reserved = (p: Page) =>
   p.evaluate(() => parseFloat(getComputedStyle(document.body).getPropertyValue("--split-pane-w")))

// Viewport-relative box of a selector (null when it generates no box).
const box = (p: Page, sel: string) =>
   p.evaluate((s) => {
      const n = document.querySelector(s)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { left: r.left, right: r.right, width: r.width }
   }, sel)

// The LAYOUT viewport width — the box every centred thing on the page is
// centred in — READ from the page rather than assumed to be the puppeteer
// viewport. The two are equal in this headless Chrome (overlay scrollbars),
// but html sets overflow-y: scroll, so an engine that reserves a classic
// scrollbar makes them differ and every predicted centre miss by half of it.
const clientW = (p: Page) => p.evaluate(() => document.documentElement.clientWidth)

const setOpen = (p: Page, v: string | null) =>
   p.evaluate((w) => {
      if (w === null) document.documentElement.style.removeProperty("--split-pane-open-w")
      else document.documentElement.style.setProperty("--split-pane-open-w", w)
   }, v)

describe("browser: split pane width + visibility", () => {
   let feeds: FeedServer
   let browser: Browser
   let page: Page

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/sport.xml": rssFeed("Sport", sport),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "fetch")
      browser = await launchBrowser()
      page = await browser.newPage()
      await page.setViewport({ width: 1600, height: 900 })
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("reserves the default width with no JavaScript writing it", async () => {
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      await waitList(page)
      // Nothing has written --split-pane-open-w: the tokens.css default alone
      // must carry the whole layout, which is the contract pane.ts is allowed
      // to be absent under.
      expect(await reserved(page)).toBe(380)
      const pane = await box(page, ".srr-list")
      expect(pane!.left).toBe(0)
      expect(pane!.width).toBe(380)
   })

   it("follows --split-pane-open-w, and the reader column recentres in the remainder", async () => {
      await setOpen(page, "500px")
      expect(await reserved(page)).toBe(500)
      expect((await box(page, ".srr-list"))!.width).toBe(500)
      // The column centres in body's content box, which body's padding-left has
      // pushed clear of the pane — so its midpoint is halfway between the pane's
      // inner edge and the window's right edge. (html's own symmetric side
      // padding cancels out of that midpoint.)
      const col = await box(page, ".srr-container")
      expect((col!.left + col!.right) / 2).toBeCloseTo((500 + (await clientW(page))) / 2, 0)
   })

   it("hidden zeroes the reserve, recentres the column in the FULL window, and takes the pane off screen", async () => {
      await page.evaluate(() => document.body.classList.add("srr-pane-hidden"))
      expect(await reserved(page)).toBe(0)
      const col = await box(page, ".srr-container")
      expect((col!.left + col!.right) / 2).toBeCloseTo((await clientW(page)) / 2, 0)
      // Moved out, not display:none'd — it still has a box, at its REAL width.
      // The width is the load-bearing half here: right <= 0 holds for a
      // display:none pane too (every rect reads zero), while only a pane still
      // LAID OUT at its true width keeps its row wrapping and the row heights
      // list.ts pinned by measuring them, so showing it again re-measures
      // nothing.
      const pane = await box(page, ".srr-list")
      expect(pane!.width).toBe(500)
      expect(pane!.left).toBe(-500)
      expect(pane!.right).toBeLessThanOrEqual(0)
      // …and out of the a11y/hit-test tree.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector(".srr-list")!).visibility)).toBe(
         "hidden",
      )
   })

   it("keeps the pane's scroll position across a hide/show round trip", async () => {
      await page.evaluate(() => document.body.classList.remove("srr-pane-hidden"))
      // The list's deferred "land once" scroll commits a centred position well
      // after boot (fonts.ready plus a bounded settle loop), and it flaked this
      // case by landing between the park and the read — the round trip got
      // blamed for a scroll the app itself made. Wait past the settle window
      // (split.e2e.test.ts's own idiom) and then for the pane to have actually
      // stopped moving, so the only thing that can touch scrollTop afterwards
      // is the class toggle under test.
      await new Promise((r) => setTimeout(r, 1300))
      await page.waitForFunction(
         () => {
            const w = window as unknown as { __paneY?: number; __paneStill?: number }
            const y = document.querySelector(".srr-list")!.scrollTop
            w.__paneStill = y === w.__paneY ? (w.__paneStill ?? 0) + 1 : 0
            w.__paneY = y
            return (w.__paneStill ?? 0) >= 6
         },
         { polling: 100, timeout: 20_000 },
      )

      // The promise the hidden state makes to a reader: glance away, come back,
      // and the list is where you left it. What ENFORCES it is the case above —
      // the pane stays laid out at its real width — and that is also where a
      // display:none regression is caught, because Chrome hands scrollTop back
      // even from display:none and this case would not notice. So this one pins
      // the promise, not the mechanism: a future hide that tears the pane down
      // or reflows it has something to fail.
      // Park and hide in one task (nothing can interleave between them), then
      // cross a real rendering update before measuring, so what is read is a
      // pane the engine actually laid out hidden rather than a coalesced pair
      // of class writes.
      const hidden = await page.evaluate(async () => {
         const l = document.querySelector(".srr-list")!
         l.scrollTop = Math.min(400, l.scrollHeight - l.clientHeight)
         const before = l.scrollTop
         document.body.classList.add("srr-pane-hidden")
         await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
         return { before, right: l.getBoundingClientRect().right }
      })
      expect(hidden.before, "the pane must be scrollable for this to assert anything").toBeGreaterThan(0)
      expect(hidden.right, "the hidden layout must actually have happened").toBeLessThanOrEqual(0)

      const after = await page.evaluate(async () => {
         document.body.classList.remove("srr-pane-hidden")
         await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
         return document.querySelector(".srr-list")!.scrollTop
      })
      expect(after).toBe(hidden.before)
   })

   it("hides the list's arrivals pill with the pane", async () => {
      await page.evaluate(() => {
         document.body.classList.add("srr-pane-hidden")
         // The pill is a .srr-list child created by list.ts on arrival; assert
         // what the RULES do to it rather than waiting for a real fetch cycle.
         const pill = document.createElement("div")
         pill.className = "srr-new-pill"
         pill.textContent = "3 new"
         document.querySelector(".srr-list")!.appendChild(pill)
      })
      // It is the LIST's affordance and its one action scrolls the pane, so it
      // goes where the pane goes: inherited visibility takes it out of the a11y
      // tree, and the pane's transform — which makes the pane the containing
      // block for its position:fixed descendants — carries its box off screen.
      const pill = await page.evaluate(() => {
         const n = document.querySelector(".srr-new-pill")!
         const r = n.getBoundingClientRect()
         return { visibility: getComputedStyle(n).visibility, right: r.right }
      })
      expect(pill.visibility).toBe("hidden")
      expect(pill.right).toBeLessThanOrEqual(0)
      await page.evaluate(() => {
         document.querySelector(".srr-new-pill")?.remove()
         document.body.classList.remove("srr-pane-hidden")
      })
   })

   it("hides the pinned search bar with the pane", async () => {
      // The bar is pane chrome (fixed over the pane's top, at the pane's width)
      // but a .srr-container child, so the pane's own offset does NOT carry it.
      // Left to the zero reserve alone it stays on screen at width 0.
      await page.evaluate(() => document.body.classList.add("srr-searching"))
      const shown = await box(page, ".srr-searchbar")
      expect(shown!.width, "the bar must be up before hiding proves anything").toBeGreaterThan(0)
      await page.evaluate(() => document.body.classList.add("srr-pane-hidden"))
      expect(await page.evaluate(() => document.querySelector(".srr-searchbar")!.getClientRects().length)).toBe(0)
      await page.evaluate(() => document.body.classList.remove("srr-searching", "srr-pane-hidden"))
   })

   it("keeps a gutter between the pane and the reading measure, and holds the fixed lanes to it", async () => {
      // A NARROW window is where this bites, not a wide one: at 1024px the
      // default 380px pane already leaves less than the 680px measure, so the
      // column takes whatever is left — flush against the pane's border on one
      // side and the page's edge on the other, with only html's own 1.5rem page
      // padding between the text and the pane. The reload below drops the
      // earlier cases' inline override, so this runs on the shipped 380px.
      await page.setViewport({ width: 1024, height: 900 })
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      await waitList(page)
      // Raise the player: [hidden] is the only thing keeping it off screen, and
      // what is under test is where the box lands once it exists (the same move
      // split.e2e.test.ts makes for the left-edge rules).
      await page.evaluate(() => document.querySelector(".srr-player")!.removeAttribute("hidden"))

      const m = await page.evaluate(() => {
         const b = (sel: string) => {
            const n = document.querySelector(sel)!
            const r = n.getBoundingClientRect()
            return { left: r.left, right: r.right, width: r.width }
         }
         return { pane: b(".srr-list"), col: b(".srr-container"), player: b(".srr-player") }
      })
      // The measure must not be pinned against the pane: the page padding alone
      // gives 24px, and this asserts the column clamp adds a real gutter on top.
      expect(m.col.left - m.pane.right, `column gutter (${JSON.stringify(m)})`).toBeGreaterThanOrEqual(40)
      // …and the fixed lanes ride the SAME measure. A fixed box resolves its
      // percentages against the viewport, so without a rule of its own the bar
      // spans pane→edge: wider than the column it controls and touching the
      // pane's border.
      expect(m.player.left, "player left vs column").toBeCloseTo(m.col.left, 0)
      expect(m.player.right, "player right vs column").toBeCloseTo(m.col.right, 0)
   })
})
