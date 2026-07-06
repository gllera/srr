import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// Live content sync in the real SPA: publish a second fetch cycle to the pack
// dir while a page is open, tap the Refresh ("Sync now") quick action in the
// config surface, and the new article is reachable WITHOUT a page reload — the
// silent contract list.onStoreGrown()/refresh.ts implement. Own beforeAll
// clears + rebuilds the shared packsDir (browser files run serially —
// vitest.browser.config fileParallelism:false — so each owns it in turn).

declare global {
   interface Window {
      __srrStamp?: number
   }
}

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const items = nItems(3, "live")

const $rowTitles = (p: Page) => p.$$eval(".srr-list a.srr-row .srr-row-title", (els) => els.map((e) => e.textContent))
// Viewport-relative top of the row whose title matches (null if absent) — used
// to prove the prepend-compensated list doesn't visually jump.
const $rowTop = (p: Page, title: string) =>
   p.$$eval(
      ".srr-list a.srr-row",
      (els, t) => {
         const row = els.find((e) => e.querySelector(".srr-row-title")?.textContent === t)
         return row ? row.getBoundingClientRect().top : null
      },
      title,
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
const waitReader = (p: Page) =>
   p.waitForFunction(
      () => {
         const a = document.querySelector(".srr-reader") as HTMLElement | null
         return !!a && !a.hidden && (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0
      },
      { timeout: 20000 },
   )
const waitTitle = (p: Page, t: string) =>
   p.waitForFunction((want) => document.querySelector(".srr-title")?.textContent === want, { timeout: 20000 }, t)

describe("browser: in-place refresh via Sync now", () => {
   let browser: Browser
   let page: Page
   let feeds: FeedServer

   beforeAll(async () => {
      feeds = await feedServer({ "/live.xml": rssFeed("Live", items.slice(0, 2)) })
      for (const f of readdirSync(packsDir)) rmSync(join(packsDir, f), { recursive: true, force: true })
      await srr(packsDir, "feed", "add", "-t", "Live", "-u", `${feeds.url}/live.xml`)
      await srr(packsDir, "art", "fetch")
      browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      page = await browser.newPage()
      // Short viewport: a 2-3 row store is shorter than a default-size viewport,
      // which leaves the document with no scrollable "reserve" — the prepend's
      // scroll compensation would have nowhere to scroll TO and every position
      // trivially clamps to 0. A short viewport (matches the pattern already used
      // in reader.e2e.test.ts for analogous reasons) makes the list genuinely
      // taller than the fold, so the compensation actually has work to do.
      await page.setViewport({ width: 500, height: 200 })
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("a tab picks up a new fetch cycle without reloading, parked at the top", async () => {
      await page.goto(`${baseUrl}#`, { waitUntil: "load" })
      await waitList(page)

      // Stamp the window so a reload anywhere in this flow would be caught.
      await page.evaluate(() => (window.__srrStamp = 1))

      // Baseline: two articles, newest-first, parked at (or very near) the top —
      // the "already intersecting" precondition the sentinel kick targets.
      expect(await $rowTitles(page)).toEqual(["live title 1", "live title 0"])
      expect(await page.evaluate(() => window.scrollY)).toBeLessThan(50)

      // Publish the third item as a second backend fetch cycle — no reload, no
      // adoption yet (that only happens once Sync now runs).
      feeds.set("/live.xml", rssFeed("Live", items))
      await srr(packsDir, "art", "fetch")

      // Sync now, from the config surface's Refresh quick action.
      await page.click(".srr-settings")
      await page.waitForSelector(".srr-config-refresh")
      await page.click(".srr-config-refresh")
      // manualSyncNow's content-refresh chain (data.refresh -> search.invalidate
      // -> nav.onStoreRefreshed -> list.onStoreGrown, all under app.ts's shared
      // busy mutex) is fire-and-forget from the click handler. Wait for its
      // network round-trip (db.gz + the regenerated latest idx pack) to fully
      // settle before touching any surface transition below — those share the
      // same mutex (guard()/guardBg()), and racing a still-busy cycle would
      // silently drop the transition rather than queue it.
      await page.waitForNetworkIdle({ timeout: 20_000 })

      // Close config back to the list. There is no direct config -> list
      // shortcut in the real UI: Escape routes config -> reader, then
      // reader -> list (see app.ts's keydown handler closeConfig()/goToList()) —
      // mirror that exactly rather than reaching for an internal API.
      await page.keyboard.press("Escape")
      await waitReader(page)
      await page.keyboard.press("Escape")
      await waitList(page)

      // Reference point for the "no visual jump" check below, captured the
      // moment the list is back on screen. NOT the original boot measurement:
      // getting here detoured through config (which hides the list — so
      // onStoreGrown's own removal of the exhausted-top "LATEST" sign-off runs
      // invisibly) and the reader (whose return path re-anchors on the CURRENT
      // article, centered, rather than the boot's top-aligned anchor) — both
      // legitimate, unrelated position changes that would swamp the one delta
      // this test actually cares about: whether the sentinel-kicked prepend
      // itself holds the viewport still. Per manual runs the prepend can already
      // have landed by this point. If it has, the delta assertion below only
      // proves self-consistency (the row holds its place), not the compensation
      // itself — which is why no row-count is asserted here.
      const beforeTop1 = await $rowTop(page, "live title 1")
      expect(beforeTop1).not.toBeNull()

      // THE PARKED-AT-TOP PROOF: this test never scrolls the list. If the
      // sentinel kick (list.onStoreGrown's unobserve/observe of the still-
      // intersecting top sentinel) didn't silently reopen the exhausted top,
      // the new article would need a manual refresh/reload to ever appear.
      await page.waitForFunction(
         () =>
            [...document.querySelectorAll(".srr-list a.srr-row .srr-row-title")].some(
               (e) => e.textContent === "live title 2",
            ),
         { timeout: 20_000 },
      )

      // Same page instance throughout — no reload anywhere in this flow.
      expect(await page.evaluate(() => window.__srrStamp)).toBe(1)

      // The viewport did not jump: "live title 1" sits at (about) the same
      // viewport Y as the reference above, the prepend compensation pinning what
      // was already on screen. Headless sub-pixel/font rounding measured well
      // under 1px in manual runs; ±15px keeps real margin without masking an
      // actual jump (a single row is ~40px tall).
      const top1After = await $rowTop(page, "live title 1")
      expect(top1After).not.toBeNull()
      expect(Math.abs(top1After! - beforeTop1!)).toBeLessThanOrEqual(15)

      // Scrolling to the top reveals the new row above the old ones — the
      // silent prepend sat it just off-screen until the user scrolls up.
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForFunction(() => window.scrollY === 0, { timeout: 20_000 })
      expect(await $rowTitles(page)).toEqual(["live title 2", "live title 1", "live title 0"])

      // Deep navigation also works: total_art grew to 3, so chron 2 resolves the
      // new article in the reader.
      await page.evaluate(() => (location.hash = "#2"))
      await waitTitle(page, items[2].title)
   })
})
