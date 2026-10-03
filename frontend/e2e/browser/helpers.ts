// Puppeteer setup shared by the browser e2e suites (the design screenshotter
// borrows launchBrowser too): the one Chromium launch recipe, the shared
// packsDir clear, the wait/read helpers each suite used to duplicate, and the
// fresh-incognito-context open() and withPage().

import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import puppeteer, { type Browser, type Page } from "puppeteer"

// Headless Chromium with the no-sandbox flags containerized CI needs.
export const launchBrowser = () =>
   puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })

// Empty a directory in place — each suite/scenario clears the shared packsDir
// before writing its own store into it.
export const clearDir = (dir: string) => {
   for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true })
}

export const $rowTitles = (p: Page) =>
   p.$$eval(".srr-list a.srr-row .srr-row-title", (els) => els.map((e) => e.textContent))
// Click the list row whose title matches. In-page rather than page.click() so it
// doesn't depend on the row being scrolled into view — the suites drive lists
// longer than the viewport. Seven suites had this byte-for-byte.
export const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

// Viewport-relative top of the row whose title matches (null if absent) — used
// to assert where the list put a given article (anchored, centered, or held in
// place across a prepend).
export const $rowTop = (p: Page, title: string) =>
   p.$$eval(
      ".srr-list a.srr-row",
      (els, t) => {
         const row = els.find((e) => e.querySelector(".srr-row-title")?.textContent === t)
         return row ? row.getBoundingClientRect().top : null
      },
      title,
   )

export const waitTitle = (p: Page, t: string) =>
   p.waitForFunction((want) => document.querySelector(".srr-title")?.textContent === want, { timeout: 20000 }, t)
// The reader surface is shown with a non-empty title.
export const waitReader = (p: Page) =>
   p.waitForFunction(
      () => {
         const a = document.querySelector(".srr-reader") as HTMLElement | null
         return !!a && !a.hidden && (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0
      },
      { timeout: 20000 },
   )
// The list surface is shown with at least one rendered row AND every row filled
// (no skeletons left) — rows paint as skeletons first, so gating on row
// presence alone would let a bulk title read race the progressive fill. With
// `landed`, also past an anchored build's settle (waitList).
const listShown = (p: Page, landed: boolean) =>
   p.waitForFunction(
      (landed) => {
         const l = document.querySelector(".srr-list") as HTMLElement | null
         return (
            !!l &&
            !l.hidden &&
            l.querySelector("a.srr-row") != null &&
            l.querySelector("a.srr-row.srr-row-skeleton") == null &&
            !(landed && l.classList.contains("srr-list-anchoring"))
         )
      },
      { timeout: 20000 },
      landed,
   )
// Filled, but NOT necessarily landed: an anchored build's scroll may still be
// to come. Only for a test that must act INSIDE that window — and such a test
// should assert `srr-list-anchoring` is still up in the same task it acts in,
// or a landing that beats it leaves the case passing without exercising
// anything.
export const waitFilled = (p: Page) => listShown(p, false)
// The list filled AND landed. An anchored build (a boot or filter change
// resuming mid-list, a return from the reader) scrolls onto its row only AFTER
// the fill, once fonts and layout settle. A page that scrolls at all — a short
// store whose two-line rows are already taller than the viewport — meets that
// scroll a few frames after "filled", and it dismisses whatever menu the test
// has just opened. `srr-list-anchoring` (list.ts) is up from the mount until
// that settle commits. Then one more frame: a scrollTo moves the page at once,
// but its scroll EVENT is dispatched at the next frame's scroll steps, ahead of
// that frame's rAF callbacks — so a commit in the very frame the poll saw the
// class go still has its event in flight.
export const waitList = async (p: Page) => {
   await listShown(p, true)
   await p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
}

// Fresh incognito context per scenario → isolated localStorage/cache. Loads
// the url, waits for the caller's readiness condition, and returns the page
// plus a context closer.
export async function open(
   browser: Browser,
   url: string,
   wait: (p: Page) => Promise<unknown>,
): Promise<[Page, () => Promise<void>]> {
   const ctx = await browser.createBrowserContext()
   const page = await ctx.newPage()
   await page.goto(url, { waitUntil: "load" })
   await wait(page)
   return [page, async () => ctx.close()]
}

// Fresh incognito context per scenario, like open(), but fn drives the page
// itself (viewport, navigation, waits) and the context closes however fn exits.
export async function withPage(browser: Browser, fn: (p: Page) => Promise<void>): Promise<void> {
   const ctx = await browser.createBrowserContext()
   try {
      await fn(await ctx.newPage())
   } finally {
      await ctx.close()
   }
}
