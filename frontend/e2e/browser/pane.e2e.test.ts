import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList } from "./helpers"

// The desktop pane's width and visibility, driven through the real SPA in real
// Chrome. Two layers, in this order:
//   1. the CSS contract alone — every case up to the toolbar rail stamps the
//      class or writes the custom property BY HAND, so what is under test is
//      styles.css/tokens.css: the reserve derived on <body> from the open width
//      on <html>, and what body.srr-pane-hidden does to it. pane.ts is allowed
//      to be absent under all of it, which is why the first case removes what
//      pane.ts wrote at boot before asserting the token default.
//   2. the GRIP (the last four cases) — the real pointer/keyboard splitter,
//      dragged, double-clicked and Tab-walked with the real mouse and keyboard.
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

// Viewport-relative box of a selector — null when NOTHING MATCHES, which is not
// the same as generating no box: a display:none element matches and hands back
// an all-zero rect, so "is it laid out" is a getClientRects().length question.
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

// Walk the REAL tab order and report where it went. Focus cannot be moved by a
// synthetic KeyboardEvent, so this has to be the browser's own Tab — which is
// the whole point: `display: none` is what takes an element out of the
// sequential focus order, while every merely-invisible treatment (visibility
// aside, a zero box, opacity 0, a transform off screen) leaves the stop in
// place. A focusin listener collects the walk so the presses need no round trip
// each, and `stops` is what proves the walk happened at all — a broken harness
// would otherwise report "never focused the grip" and pass.
async function tabWalk(p: Page, sel: string, presses = 200) {
   await p.evaluate((s) => {
      type Probe = { hits: number; stops: number; off?: () => void }
      const w = window as unknown as { __tab?: Probe }
      // These suites share one document across cases, so a previous walk's
      // listener would still be live and count every stop twice.
      w.__tab?.off?.()
      const probe: Probe = { hits: 0, stops: 0 }
      const on = (e: Event) => {
         const t = e.target as Element
         probe.stops++
         if (t.matches?.(s)) probe.hits++
      }
      document.addEventListener("focusin", on, true)
      probe.off = () => document.removeEventListener("focusin", on, true)
      w.__tab = probe
      ;(document.activeElement as HTMLElement | null)?.blur()
   }, sel)
   for (let i = 0; i < presses; i++) await p.keyboard.press("Tab")
   return p.evaluate(() => (window as unknown as { __tab: { hits: number; stops: number } }).__tab)
}

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
      // With --split-pane-open-w unwritten, the tokens.css default alone must
      // carry the whole layout — the contract pane.ts is allowed to be absent
      // under (an older shell, a boot that threw before initPane). Removing the
      // property is what makes that state reachable now: initPane restores the
      // stored width at boot and so writes this same 380 inline, which would
      // otherwise leave the token default asserted by nothing.
      await setOpen(page, null)
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

   it("spans the window and lands each segment over its own pane", async () => {
      await page.setViewport({ width: 1600, height: 900 })
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      await waitList(page)
      // The app rewrites the hash on boot, so a goto back to `#!` is a
      // same-document navigation, NOT a reload — an earlier case's inline
      // --split-pane-open-w is still on <html>. Every number below is stated
      // against the shipped 380, so say so rather than assume a fresh document.
      await setOpen(page, null)
      const bar = await box(page, ".srr-toolbar")
      expect(bar!.left).toBe(0)
      expect(bar!.width).toBe(1600)
      // The pane segment is exactly pane-wide, at the left edge.
      const seg = await box(page, ".srr-tb-pane")
      expect(seg!.left).toBe(0)
      expect(seg!.width).toBeCloseTo(380, 0)
      // The reader group centers on the reading column, not on the window.
      const grp = await box(page, ".srr-tb-reader")
      expect((grp!.left + grp!.right) / 2).toBeCloseTo(380 + (1600 - 380) / 2, 0)
      // The list's controls now sit over the list.
      const filter = await box(page, ".srr-filter")
      expect(filter!.right).toBeLessThanOrEqual(380)
   })

   it("centers the reader group on the full window while the pane is hidden", async () => {
      await page.evaluate(() => document.body.classList.add("srr-pane-hidden"))
      const grp = await box(page, ".srr-tb-reader")
      expect((grp!.left + grp!.right) / 2).toBeCloseTo(800, 0)
      await page.evaluate(() => document.body.classList.remove("srr-pane-hidden"))
   })

   it("reserves the rail's height at the bottom of the pane", async () => {
      const pad = await page.evaluate(() => getComputedStyle(document.querySelector(".srr-list")!).paddingBottom)
      expect(parseFloat(pad)).toBeGreaterThan(60)
   })

   it("leaves the phone bar's control order untouched below the breakpoint", async () => {
      await page.setViewport({ width: 420, height: 900 })
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      await waitList(page)
      // List surface: open-article at the left edge, filter at the right.
      const open = await box(page, ".srr-open-reader")
      const filter = await box(page, ".srr-filter")
      expect(open!.left).toBeLessThan(filter!.left)
      // Reader surface: back at the left edge, filter still at the right.
      await page.evaluate(() => (document.querySelector(".srr-list a.srr-row") as HTMLElement)?.click())
      await page.waitForFunction(() => !(document.querySelector(".srr-reader") as HTMLElement).hidden, {
         timeout: 20_000,
      })
      const back = await box(page, ".srr-back")
      const filter2 = await box(page, ".srr-filter")
      const next = await box(page, ".srr-next")
      expect(back!.left).toBeLessThan(next!.left)
      expect(next!.left).toBeLessThan(filter2!.left)
      expect(filter2!.right).toBeGreaterThan(400 - 60)
      await page.setViewport({ width: 1600, height: 900 })
   })

   it("drags to a new width, persists it, and keeps the rows filled", async () => {
      await page.setViewport({ width: 1600, height: 900 })
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      // A REAL reload on a cleared store, for two reasons the earlier cases in
      // this file don't have: the case above opened an article, and reading the
      // newest one under [ALL] raises every member feed's frontier — so the
      // unread-only list this case waits on is legitimately "caught up" until
      // the seen map is gone. And the width is restored ONCE, at boot: that
      // boot happened at 420px, where the half-viewport clamp pins the pane to
      // its 280 floor, so the grip is not where a 1600px window says it is.
      await page.evaluate(() => localStorage.clear())
      await page.reload({ waitUntil: "load" })
      await waitList(page)
      const grip = await box(page, ".srr-pane-grip")
      expect(grip).not.toBeNull()

      await page.mouse.move(grip!.left + 3, 400)
      await page.mouse.down()
      await page.mouse.move(500, 400, { steps: 12 })

      // Mid-drag, before the release: the pane already follows the pointer…
      await page.waitForFunction(
         () => parseFloat(getComputedStyle(document.body).getPropertyValue("--split-pane-w")) === 500,
         { timeout: 10_000 },
      )
      expect((await box(page, ".srr-list"))!.width).toBe(500)
      // …and has written nothing: a drag drives this once per animation frame,
      // and the persist is on release alone.
      expect(await page.evaluate(() => localStorage.getItem("srr-pane-w"))).toBe(null)

      await page.mouse.up()
      // The re-layout ran: rows are present and none is left a skeleton.
      await waitList(page)
      expect(await page.evaluate(() => localStorage.getItem("srr-pane-w"))).toBe("500")

      // …and it survives a reload. It has to be a RELOAD: the app rewrites the
      // hash on boot, so a goto back to `#!` is a same-document navigation that
      // re-runs nothing — the inline width from the drag would still be on
      // <html> and this would assert the drag over again instead of restore.
      await page.reload({ waitUntil: "load" })
      await waitList(page)
      expect(await reserved(page)).toBe(500)
   })

   it("collapses when dragged below the floor, keeping the width it had", async () => {
      await page.mouse.move(500 + 3, 400)
      await page.mouse.down()
      await page.mouse.move(180, 400, { steps: 10 })
      await page.mouse.up()
      await page.waitForFunction(() => document.body.classList.contains("srr-pane-hidden"), { timeout: 10_000 })
      expect(await reserved(page)).toBe(0)
      // The stored width is the last REAL one, not the 180 the pointer passed.
      expect(await page.evaluate(() => localStorage.getItem("srr-pane-w"))).toBe("500")
      await page.evaluate(() => {
         localStorage.clear()
         document.body.classList.remove("srr-pane-hidden")
      })
   })

   // The reset gesture, through the browser's own event synthesis rather than a
   // dispatched MouseEvent — which is the only way to see it at all. The drag
   // cancels `pointerdown`, and that suppresses the compatibility `mousedown`
   // entirely (measured); `click` and `dblclick` survive it, but nothing about
   // that is obvious from the code, and a unit test firing a synthetic dblclick
   // would keep passing on the day it stopped being true.
   it("double-click on the grip resets it to the default width", async () => {
      const grip = await box(page, ".srr-pane-grip")
      expect(grip!.width).toBeGreaterThan(0)
      await page.mouse.click(grip!.left + 3, 400, { count: 2 })
      await page.waitForFunction(
         () => parseFloat(getComputedStyle(document.body).getPropertyValue("--split-pane-w")) === 380,
         { timeout: 10_000 },
      )
      expect(await page.evaluate(() => localStorage.getItem("srr-pane-w"))).toBe("380")
   })

   // The grip is in the markup at every width and pane.ts stamps tabindex="0"
   // on it unconditionally, so what keeps it off a phone is the base rule's
   // `display: none` and nothing else. A box test alone would pass on a merely
   // invisible grip that a phone's Tab still lands on — a control the user
   // cannot see, cannot use, and cannot skip.
   it("does not exist below the breakpoint: no box, and no tab stop", async () => {
      await page.setViewport({ width: 800, height: 900 })
      await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
      await waitList(page)
      // Wait for the BREAKPOINT, not just the resize: the viewport override and
      // the matchMedia change that follows it are separate turns, and a goto
      // that lands inside that gap leaves body.srr-split still stamped — the
      // whole premise of this case, asserted one frame too early.
      await page.waitForFunction(() => !document.body.classList.contains("srr-split"), { timeout: 10_000 })
      // The NODE is there (a missing one would make every assertion below pass
      // vacuously) and it generates no box at all. box() above cannot say this:
      // it nulls on a missing selector, and a display:none element hands back a
      // zero rect rather than nothing.
      const rects = await page.evaluate(() => {
         const g = document.querySelector(".srr-pane-grip")
         return g ? g.getClientRects().length : -1
      })
      expect(rects).toBe(0)
      const narrow = await tabWalk(page, ".srr-pane-grip")
      expect(narrow.stops, "the walk must actually reach controls to mean anything").toBeGreaterThan(10)
      expect(narrow.hits).toBe(0)

      // …and the SAME walk finds it under split, so the zero above is a fact
      // about the breakpoint rather than about a grip nothing can ever focus.
      await page.setViewport({ width: 1600, height: 900 })
      await page.waitForFunction(() => document.body.classList.contains("srr-split"), { timeout: 10_000 })
      await waitList(page)
      const wide = await tabWalk(page, ".srr-pane-grip")
      expect(wide.hits).toBeGreaterThan(0)
   })
})
