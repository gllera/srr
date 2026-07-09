import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// Live content sync in the real SPA: publish a second fetch cycle to the pack
// dir while a page is open, fire one of refresh.ts's real background triggers
// (the `online` event — unthrottled, unlike re-focus), and the new article is
// reachable WITHOUT a page reload — the silent contract
// list.onStoreGrown()/refresh.ts implement. There is no manual refresh button
// (a page reload is the manual gesture), so the trigger is dispatched directly.
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false — so each owns it in
// turn).

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
const waitTitle = (p: Page, t: string) =>
   p.waitForFunction((want) => document.querySelector(".srr-title")?.textContent === want, { timeout: 20000 }, t)

describe("browser: in-place refresh via a background trigger", () => {
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

      // Baseline: two articles, newest-first. Then wait for the boot render's
      // land-once anchor scroll — on this fresh profile everything is unread, so
      // the list top-aligns the OLDEST row ("live title 0") once fonts/layout
      // settle. Any position captured before that landing would misattribute the
      // landing scroll (~160px here) to the refresh flow under test. The landed
      // position keeps the top sentinel well inside the observer's 800px
      // rootMargin, so the sentinel kick still pages silently from here.
      expect(await $rowTitles(page)).toEqual(["live title 1", "live title 0"])
      await page.waitForFunction(
         () => {
            const t0 = [...document.querySelectorAll(".srr-list a.srr-row")].find(
               (r) => r.querySelector(".srr-row-title")?.textContent === "live title 0",
            )
            return t0 ? t0.getBoundingClientRect().top < 100 : false
         },
         { timeout: 20_000 },
      )

      // Publish the third item as a second backend fetch cycle — no reload, no
      // adoption yet (that only happens once a refresh trigger fires).
      feeds.set("/live.xml", rssFeed("Live", items))
      await srr(packsDir, "art", "fetch")

      // Reference point for the "no visual jump" check below, captured with the
      // list on screen BEFORE the trigger: the prepend compensation must hold
      // this row at the same viewport Y while the new article slots in above.
      const beforeTop1 = await $rowTop(page, "live title 1")
      expect(beforeTop1).not.toBeNull()

      // Fire the regained-connectivity trigger refresh.init wires — the
      // unthrottled one, so no clock games. The content-refresh chain
      // (data.refresh -> search.invalidate -> nav.onStoreRefreshed ->
      // list.onStoreGrown, all under app.ts's shared busy mutex) is
      // fire-and-forget from the event; wait for its network round-trip
      // (db.gz + the regenerated latest idx pack) to settle.
      await page.evaluate(() => window.dispatchEvent(new Event("online")))
      await page.waitForNetworkIdle({ timeout: 20_000 })

      // THE PARKED-AT-ANCHOR PROOF: this test never scrolls the list. If the
      // sentinel kick (list.onStoreGrown's unobserve/observe of the top
      // sentinel, still inside the observer's rootMargin at the landed anchor)
      // didn't silently reopen the exhausted top, the new article would need a
      // page reload to ever appear.
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
