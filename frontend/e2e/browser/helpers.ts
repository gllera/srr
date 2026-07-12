// Puppeteer setup shared by the browser e2e suites (the design screenshotter
// borrows launchBrowser too): the one Chromium launch recipe, the shared
// packsDir clear, the wait/read helpers each suite used to duplicate, and the
// fresh-incognito-context open().

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
// presence alone would let a bulk title read race the progressive fill.
export const waitList = (p: Page) =>
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
