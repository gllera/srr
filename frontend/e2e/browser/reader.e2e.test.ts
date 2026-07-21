import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, readRoot, srr, storeNames, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// This suite pins the CONSOLIDATED-tail layout at the browser layer — the SW's
// pin/prune/cache-bound machinery and the head-only boot budget — so the writer
// runs with the delta kill switch (every dirty cycle consolidates). Delta-chain
// behavior is covered by contract/delta.e2e.test.ts and rides the OTHER browser
// suites (incl. the live refresh flow) through the default --max-deltas.
process.env.SRR_MAX_DELTAS = "0"
import {
   $rowTitles,
   $rowTop,
   clearDir,
   launchBrowser,
   open as openCtx,
   waitList,
   waitReader,
   waitTitle,
} from "./helpers"

// Drives the REAL built SPA in headless Chrome against real srr packs: proves
// the Parcel build, app.ts render, hash routing (list home + reader drill-down),
// and real-browser fetch/DecompressionStream all work end-to-end.

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// Tagged 6-article store. Disjoint published ranges → global chronIdx order:
// news0,news1 (0,1) · tech0,tech1 (2,3) · sport0,sport1 (4,5). Latest = sport1.
const news = nItems(2, "news", 0, 0)
const tech = nItems(2, "tech", 0, 10)
const sport = nItems(2, "sport", 0, 20)

// The store's generation counter (db.gz `m`) — the ONE field a root carries
// that moves, and the signal the SW reconciles its cache on.
const storeM = (dir: string): number => readRoot(dir).m ?? 0
// The tail object of a series, as the store names it (there is no derived form).
const tailKey = (dir: string, series: "idx" | "data" | "meta"): string => {
   const list = storeNames(dir)[series]
   if (list.tail < 0) throw new Error(`${series} names no tail in ${dir}`)
   return list.keys[list.tail]
}

const $title = (p: Page) => p.$eval(".srr-title", (e) => e.textContent)
const $content = (p: Page) => p.$eval(".srr-content", (e) => e.textContent ?? "")
const $link = (p: Page) => p.$eval(".srr-title-row", (e) => e.getAttribute("href"))
const $nextDisabled = (p: Page) => p.$eval(".srr-next", (e) => (e as HTMLButtonElement).disabled)
const $popupOpen = (p: Page) => p.$eval(".srr-popup", (e) => e.classList.contains("srr-open"))

// Title of the list's currently selected (highlighted) row, or null if none.
const $currentTitle = (p: Page) =>
   p.$$eval(".srr-list a.srr-row", (els) => {
      const row = els.find((e) => e.classList.contains("srr-row-current"))
      return row?.querySelector(".srr-row-title")?.textContent ?? null
   })
// Wait until the selected (.srr-row-current) row's title matches.
const waitCurrent = (p: Page, t: string) =>
   p.waitForFunction(
      (want) => {
         const row = [...document.querySelectorAll(".srr-list a.srr-row")].find((e) =>
            e.classList.contains("srr-row-current"),
         )
         return (row?.querySelector(".srr-row-title")?.textContent ?? null) === want
      },
      { timeout: 20000 },
      t,
   )

// The app has booted into EITHER surface (used where the surface is irrelevant).
const waitBoot = (p: Page) =>
   p.waitForFunction(
      () =>
         (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0 ||
         (document.querySelector(".srr-list a.srr-row") != null &&
            document.querySelector(".srr-list a.srr-row.srr-row-skeleton") == null),
      { timeout: 20000 },
   )

describe("browser: real SPA over real packs", () => {
   let feeds: FeedServer
   let browser: Browser
   // The shared store's tail object names, LISTED by its manifest. Every stem
   // is opaque, so the pin/unpin scenarios below read them from the store
   // rather than spelling a derived name.
   let idxKey = ""
   let dataKey = ""
   let metaKey = ""

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/tech.xml": rssFeed("Tech", tech),
         "/sport.xml": rssFeed("Sport", sport),
      })
      // Write packs straight into the served pack dir (cleared first).
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Tech", "-g", "world", "-u", `${feeds.url}/tech.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-g", "play", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "art", "fetch")
      ;[idxKey, dataKey, metaKey] = [tailKey(packsDir, "idx"), tailKey(packsDir, "data"), tailKey(packsDir, "meta")]

      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // Fresh incognito context per scenario → isolated localStorage/cache.
   const open = (hash = "") => openCtx(browser, baseUrl + hash, waitBoot)

   it("boots into the list, newest-first", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         // The list IS home: no article is shown until a row is tapped.
         expect(await page.$eval(".srr-reader", (e) => (e as HTMLElement).hidden)).toBe(true)
         expect(await $rowTitles(page)).toEqual([
            "sport title 1",
            "sport title 0",
            "tech title 1",
            "tech title 0",
            "news title 1",
            "news title 0",
         ])
         // A never-seen store → every row unread.
         expect(
            await page.$$eval(".srr-list a.srr-row", (els) => els.every((e) => e.classList.contains("srr-row-unread"))),
         ).toBe(true)
      } finally {
         await close()
      }
   })

   it("opens an article from the list, navigates with the keyboard, and returns", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         // Tap the top row (latest) → reader.
         await page.click(".srr-list a.srr-row")
         await waitReader(page)
         expect(await $title(page)).toBe("sport title 1")
         expect(await $content(page)).toContain("sport body 1")
         expect(await $link(page)).toBe("http://example.com/sport/1")
         expect(await $popupOpen(page)).toBe(false)

         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "sport title 0")
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "tech title 1")

         // Back to the list via the toolbar back button.
         await page.click(".srr-back")
         await waitList(page)
         expect(await page.$eval(".srr-reader", (e) => (e as HTMLElement).hidden)).toBe(true)
      } finally {
         await close()
      }
   })

   // On the LIST, the same A/D and ←/→ keys that step prev/next in the reader move
   // the highlighted SELECTION (.srr-row-current) through the feed WITHOUT opening
   // it: A/← to the older neighbor (the row below, newest-first), D/→ to the newer
   // (the row above) — so the same key reaches the same article on both surfaces.
   it("steps the list selection with the reader's prev/next keys", async () => {
      const [page, close] = await open()
      try {
         await page.setViewport({ width: 500, height: 600 }) // tall enough for all 6 rows
         await waitList(page)
         // [ALL] boots anchored at the oldest unread row (start of the backlog),
         // which is the selected cursor — nothing seen, so that's the oldest article.
         await waitCurrent(page, "news title 0")

         // D / → step to the NEWER neighbor (up the newest-first list).
         await page.keyboard.press("d")
         await waitCurrent(page, "news title 1")
         await page.keyboard.press("ArrowRight")
         await waitCurrent(page, "tech title 0")

         // A / ← step back to the OLDER neighbor (down).
         await page.keyboard.press("ArrowLeft")
         await waitCurrent(page, "news title 1")
         await page.keyboard.press("a")
         await waitCurrent(page, "news title 0")

         // Exactly one row is ever highlighted, and the reader never opened.
         expect(await page.$$eval(".srr-list a.srr-row-current", (e) => e.length)).toBe(1)
         expect(await page.$eval(".srr-reader", (e) => (e as HTMLElement).hidden)).toBe(true)
      } finally {
         await close()
      }
   })

   // Stepping the selection DOWN (older) must keep the highlighted row clear of
   // the toolbar fixed to the bottom of the viewport — otherwise the row you just
   // selected is parked behind it and you can't see it.
   it("keeps the downward-stepped selection above the bottom toolbar", async () => {
      const [page, close] = await open()
      try {
         // Short viewport so stepping to the oldest row must scroll the list and
         // could collide with the bottom toolbar.
         await page.setViewport({ width: 500, height: 320 })
         await waitList(page)
         await waitCurrent(page, "news title 0") // boot anchors at the oldest unread, selected
         // Climb to the newest, then step back DOWN to the oldest so the final
         // downward step has to scroll the list toward the bottom toolbar.
         for (let i = 0; i < 5; i++) await page.keyboard.press("d") // newer ×5 → the newest row
         await waitCurrent(page, "sport title 1")
         for (let i = 0; i < 5; i++) await page.keyboard.press("a") // older ×5 → the oldest row
         await waitCurrent(page, "news title 0")
         // The selected row sits ENTIRELY above the (visible) toolbar.
         const clear = await page.evaluate(() => {
            const row = [...document.querySelectorAll(".srr-list a.srr-row")].find((e) =>
               e.classList.contains("srr-row-current"),
            )!
            const bar = document.querySelector(".srr-toolbar")!
            const r = row.getBoundingClientRect()
            const b = bar.getBoundingClientRect()
            return r.bottom <= b.top + 0.5 && r.top >= 0 // above the toolbar and on screen
         })
         expect(clear).toBe(true)
      } finally {
         await close()
      }
   })

   // Stepping past the start/end of the list can't move — instead the current row
   // gets a directional "bump" so the boundary is clear, not a dropped key.
   it("bumps the current row when stepping past the oldest end", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         await waitCurrent(page, "news title 0") // boot anchors at the oldest end, selected
         // Already at the oldest — one more older step can't advance; the row takes the down-bump cue.
         await page.keyboard.press("a")
         await page.waitForFunction(
            () => {
               const row = [...document.querySelectorAll(".srr-list a.srr-row")].find((e) =>
                  e.classList.contains("srr-row-current"),
               )
               return !!row && row.classList.contains("srr-row-bump-down")
            },
            { timeout: 5000 },
         )
         expect(await $currentTitle(page)).toBe("news title 0") // selection held at the edge
      } finally {
         await close()
      }
   })

   // The list is a bidirectional infinite window anchored at the reader's
   // position: returning from the reader drops you back at the article you were
   // reading — CENTERED in the viewport and highlighted (.srr-row-current) — with
   // newer ("next") articles loaded ABOVE it and older ones below — literally the
   // reader's prev/next sequence laid out vertically.
   it("centers + highlights the article you were reading, newer above / older below", async () => {
      const [page, close] = await open()
      try {
         // A short viewport so this 6-row store is taller than the fold — only
         // then is there room above AND below the anchor to actually center it.
         await page.setViewport({ width: 500, height: 140 })
         await waitList(page)
         await page.click(".srr-list a.srr-row") // top row = sport title 1 (newest)
         await waitReader(page)
         expect(await $title(page)).toBe("sport title 1")
         // Step older (prev) into the middle of the feed.
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "sport title 0")
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "tech title 1")
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "tech title 0")

         // Return to the list — it re-anchors at the article we were reading,
         // centered in the viewport (the row's midpoint near the viewport center).
         await page.click(".srr-back")
         await waitList(page)
         await page.waitForFunction(
            () => {
               const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
                  (e) => e.querySelector(".srr-row-title")?.textContent === "tech title 0",
               )
               if (!row) return false
               const r = row.getBoundingClientRect()
               return Math.abs(r.top + r.height / 2 - window.innerHeight / 2) <= 3
            },
            { timeout: 20000 },
         )
         // The anchored row carries the current-article highlight.
         const anchorIsCurrent = await page.$$eval(".srr-list a.srr-row", (els) => {
            const row = els.find((e) => e.querySelector(".srr-row-title")?.textContent === "tech title 0")
            return row?.classList.contains("srr-row-current") ?? false
         })
         expect(anchorIsCurrent).toBe(true)
         // Newer ("next") articles are loaded ABOVE the anchor...
         const anchorTop = (await $rowTop(page, "tech title 0"))!
         expect(await $rowTop(page, "sport title 1")).toBeLessThan(anchorTop)
         expect(await $rowTop(page, "tech title 1")).toBeLessThan(anchorTop)
         // ...and older ones are BELOW it.
         expect(await $rowTop(page, "news title 0")).toBeGreaterThan(anchorTop)
      } finally {
         await close()
      }
   })

   // A tag/feed with no navigation information (never opened on this device) opens
   // the list at its OLDEST unread article — the start of the unread backlog, to
   // read forward from there — and selects it (the shared cursor the reader would
   // open). Every "world" article is unread on a fresh boot, so the list anchors
   // at the oldest, scrolling the newer rows off ABOVE the fold (scrollY > 0).
   it("a never-opened tag opens at its oldest unread article (start of the backlog), selected", async () => {
      const [page, close] = await open()
      try {
         // Short viewport so the filtered list is taller than the fold and scrollable.
         await page.setViewport({ width: 500, height: 240 })

         // Deep-link straight to the never-read "world" tag (News + Tech) — a fresh
         // boot at #!world, every article unread.
         await page.goto(baseUrl + "#!world", { waitUntil: "load" })
         await waitList(page)
         expect(await page.evaluate(() => location.hash)).toBe("#!world")

         // Oldest world (news title 0) is the anchor + selection, and the list
         // scrolled down to bring it ON SCREEN (above the bottom toolbar) with the
         // newer world rows pushed ABOVE the fold — only possible when it anchored
         // at the oldest (not pinned at the newest) AND the post-fill re-anchor put
         // that bottom-most selected row into view rather than below the fold.
         await waitCurrent(page, "news title 0")
         await page.waitForFunction(() => window.scrollY > 0, { timeout: 20000 })
         expect(await $rowTop(page, "tech title 1")).toBeLessThan(0) // newest world, scrolled off above
         const sel = await page.evaluate(() => {
            const row = [...document.querySelectorAll(".srr-list a.srr-row")].find((e) =>
               e.classList.contains("srr-row-current"),
            )!
            const r = row.getBoundingClientRect()
            const b = document.querySelector(".srr-toolbar")!.getBoundingClientRect()
            return { top: r.top, visibleAboveToolbar: r.top >= 0 && r.bottom <= b.top + 0.5 }
         })
         expect(sel.visibleAboveToolbar).toBe(true) // the selected oldest row is fully on screen
         // Sport (tag "play") is excluded entirely.
         expect(await $rowTop(page, "sport title 1")).toBeNull()
      } finally {
         await close()
      }
   })

   it("deep-links to a specific chronIdx (reader)", async () => {
      const [page, close] = await open("#2")
      try {
         await waitReader(page)
         await waitTitle(page, "tech title 0")
         expect(await $content(page)).toContain("tech body 0")
         expect(await $link(page)).toBe("http://example.com/tech/0")
      } finally {
         await close()
      }
   })

   it("deep-links to a filtered list (#!tag)", async () => {
      const [page, close] = await open("#!world")
      try {
         await waitList(page)
         // world = News + Tech, newest-first; Sport excluded.
         expect(await $rowTitles(page)).toEqual(["tech title 1", "tech title 0", "news title 1", "news title 0"])
      } finally {
         await close()
      }
   })

   it("filters to a tag and traverses only that subset in the reader", async () => {
      const [page, close] = await open("#0!world")
      try {
         await waitReader(page)
         await waitTitle(page, "news title 0")
         const titles = [await $title(page)]
         while (!(await $nextDisabled(page))) {
            const before = await $title(page)
            await page.keyboard.press("ArrowRight")
            await page.waitForFunction(
               (b) => document.querySelector(".srr-title")?.textContent !== b,
               { timeout: 20000 },
               before,
            )
            titles.push(await $title(page))
         }
         expect(titles).toEqual(["news title 0", "news title 1", "tech title 0", "tech title 1"])
      } finally {
         await close()
      }
   })

   // Search drives the MAIN list now (no dropdown): the `/` shortcut toggles the
   // "q:<query>" list filter, a pinned search bar takes the query, matches render
   // as ordinary list rows, the query rides in the #!q:… hash, and tapping a
   // result opens the reader walking the search set. The pinned bar carries the
   // magnifier as an inner .srr-search-icon <span>.
   it("search renders matches into the main list and the reader walks the hits", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         // `/` opens the search bar (body gains srr-searching) ready for input.
         await page.keyboard.press("/")
         await page.waitForFunction(() => document.body.classList.contains("srr-searching"), { timeout: 20000 })
         expect(await page.$eval(".srr-searchbar .srr-search-icon", (e) => e.tagName)).toBe("SPAN")
         await page.type(".srr-search-input", "tech")
         // The list narrows (debounced) to the two "tech" titles, newest-first.
         await page.waitForFunction(
            () => {
               const t = [...document.querySelectorAll(".srr-list a.srr-row .srr-row-title")].map((e) => e.textContent)
               return t.length === 2 && t.every((x) => (x ?? "").includes("tech"))
            },
            { timeout: 20000 },
         )
         expect(await $rowTitles(page)).toEqual(["tech title 1", "tech title 0"])
         expect(await page.evaluate(() => location.hash)).toContain("q")
         // Tapping the top result opens the reader; prev steps to the older hit.
         await page.click(".srr-list a.srr-row")
         await waitReader(page)
         expect(await $title(page)).toBe("tech title 1")
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "tech title 0")
      } finally {
         await close()
      }
   })

   // The home list renders thin meta cards — NOT full data/ records — so the
   // list launch never fetches a data/ pack. The newest window rides inside
   // db.gz itself (the head-in-db.gz fast path, DBCore.Head), so a store whose
   // whole content fits the head (headMax=40 ≥ this 6-article store) renders
   // with ZERO meta/ AND ZERO data/ pack fetches — served straight from the
   // db.gz snapshot. Opening a row then fetches the data/ pack for that article.
   // This captures the read-amplification win of the meta/ design plus its
   // head-in-db.gz refinement. (The meta/ fetch path for windows beyond the head
   // is covered at the contract layer: summary/metafallback e2e.)
   it("list boot renders rows from db.gz head with no data/ fetch until a row is opened", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         const requested: string[] = []
         page.on("request", (req) => {
            const url = new URL(req.url())
            requested.push(url.pathname)
         })

         await page.goto(baseUrl, { waitUntil: "load" })
         await waitList(page)

         // After list boot: no data/ pack fetched — and, because the whole store
         // fits db.gz's inlined head window, not even a meta/ pack is needed to
         // render the rows. The list is served entirely from the db.gz snapshot.
         expect(requested.some((p) => /\/packs\/data\//.test(p))).toBe(false)
         expect(requested.some((p) => /\/packs\/meta\//.test(p))).toBe(false)

         // Tap the top row → reader opens and fetches the data/ pack.
         await page.click(".srr-list a.srr-row")
         await waitReader(page)
         expect(await $title(page)).toBe("sport title 1")

         // Now a data/ pack must have been fetched.
         expect(requested.some((p) => /\/packs\/data\//.test(p))).toBe(true)
      } finally {
         await ctx.close()
      }
   })

   // Saved articles: the reader's ★ toggle adds the current article to the
   // device-local srr-saved set; "★ Saved" in the filter picker overlay is a
   // distinct filter view that shows exactly that set, and it survives a reload
   // (the set lives in localStorage, the #!~saved hash re-enters the view).
   it("saves an article, lists it under ★ Saved, and persists across reload", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         // Open the latest article and save it from the keyboard.
         await page.click(".srr-list a.srr-row")
         await waitReader(page)
         expect(await $title(page)).toBe("sport title 1")
         await page.keyboard.press("b")
         await page.waitForFunction(() => document.querySelector(".srr-save")?.classList.contains("srr-saved"), {
            timeout: 20000,
         })
         expect(await page.$eval(".srr-save", (e) => e.getAttribute("aria-pressed"))).toBe("true")

         // Back to the list → tap the filter button → pick "★ Saved" in the
         // picker overlay. Choosing a filter closes the overlay and shows the LIST
         // under that filter: exactly the saved row, the saved-row marker, and the
         // shareable #!~saved hash.
         await page.click(".srr-back")
         await waitList(page)
         await page.click(".srr-filter")
         await page.waitForSelector('.srr-picker-filter a[data-value="~saved"]', { timeout: 20000 })
         await page.click('.srr-picker-filter a[data-value="~saved"]')
         await waitList(page)
         // The overlay closed on pick.
         expect(await page.$eval(".srr-picker", (e) => (e as HTMLElement).hidden)).toBe(true)
         await page.waitForFunction(() => document.querySelectorAll(".srr-list a.srr-row").length === 1, {
            timeout: 20000,
         })
         expect(await $rowTitles(page)).toEqual(["sport title 1"])
         expect(await page.$eval(".srr-list a.srr-row", (e) => e.classList.contains("srr-row-saved"))).toBe(true)
         expect(await page.evaluate(() => location.hash)).toBe("#!~saved")

         // Reload: the saved set persists and #!~saved re-enters the saved view.
         await page.reload({ waitUntil: "load" })
         await waitList(page)
         await page.waitForFunction(() => document.querySelectorAll(".srr-list a.srr-row").length === 1, {
            timeout: 20000,
         })
         expect(await $rowTitles(page)).toEqual(["sport title 1"])
      } finally {
         await close()
      }
   })

   // ★ Saved is a save-ordered queue: new saves append to the end, so the list
   // reads in SAVE order, not by article date. Save the NEWEST article first, then
   // the OLDEST: a chronIdx sort would list them [sport title 1, news title 0], but
   // save order (newest save on top) lists them [news title 0, sport title 1].
   it("orders the ★ Saved view by save time (appended), not by chronIdx", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         // Save the newest article (top row = "sport title 1") first.
         await page.click(".srr-list a.srr-row")
         await waitReader(page)
         expect(await $title(page)).toBe("sport title 1")
         await page.keyboard.press("b")
         await page.waitForFunction(() => document.querySelector(".srr-save")?.classList.contains("srr-saved"), {
            timeout: 20000,
         })
         await page.click(".srr-back")
         await waitList(page)

         // Save the OLDEST article (bottom row = "news title 0") second.
         const rows = await page.$$(".srr-list a.srr-row")
         await rows[rows.length - 1].click()
         await waitReader(page)
         expect(await $title(page)).toBe("news title 0")
         await page.keyboard.press("b")
         await page.waitForFunction(() => document.querySelector(".srr-save")?.classList.contains("srr-saved"), {
            timeout: 20000,
         })

         // Enter ★ Saved and assert the SAVE order (newest save on top), not chronIdx.
         await page.click(".srr-back")
         await waitList(page)
         await page.click(".srr-filter")
         await page.waitForSelector('.srr-picker-filter a[data-value="~saved"]', { timeout: 20000 })
         await page.click('.srr-picker-filter a[data-value="~saved"]')
         await waitList(page)
         await page.waitForFunction(() => document.querySelectorAll(".srr-list a.srr-row").length === 2, {
            timeout: 20000,
         })
         expect(await $rowTitles(page)).toEqual(["news title 0", "sport title 1"])
      } finally {
         await close()
      }
   })

   // The service worker (src/sw.ts) makes the reader work fully offline: the shell
   // (navigation + hashed JS/CSS) and the packs (db.gz + latest idx/data, here a
   // single pack) are runtime-cached on the first online visit, then served from
   // cache when the network is cut. Headless Chrome over http://127.0.0.1 is a
   // secure context, so the SW registers and activates as it does in production.
   // Deep-links to the reader (#5) so the offline assertions are about pack/SW
   // behavior, not the surface.
   it("serves the reader offline after one online visit", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         // Cold load: the SW registers, activates (skipWaiting), and claims control.
         await page.goto(baseUrl + "#5", { waitUntil: "load" })
         await waitReader(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })

         // This test exercises offline PACK SERVING, not unread filtering. Unread-only
         // (catch-up) is the first-run default, and deep-linking to the newest article
         // (#5) marks every feed seen — so in that mode the older neighbor (chron 4)
         // is seen and a back-step would (correctly) find nothing unread, disabling
         // prev. Persist show-all ("0") before the SW takes over so the older cached
         // neighbor stays navigable offline. app.ts only force-enables unread-only
         // when the key is unset, so a stored "0" sticks across the reloads below.
         await page.evaluate(() => localStorage.setItem("srr-unread-only", "0"))

         // Reload so every shell + pack request now flows through the controlling SW
         // and is cached. The reader at chron 5 pulls in the (single) data pack.
         await page.reload({ waitUntil: "load" })
         await waitReader(page)

         // The pack and shell buckets are populated (asset bucket only fills when a
         // store actually self-hosts images, which these plain-text fixtures don't).
         const cacheNames = await page.evaluate(() => caches.keys())
         expect(cacheNames).toEqual(expect.arrayContaining(["srr-packs-v4", "srr-shell-v1"]))

         // Cut the network and reload — the reader must still boot and render purely
         // from cache. A clean render with no error popup proves db.gz + idx + data
         // all resolved offline (any miss would throw in data.init() → popup).
         await page.setOfflineMode(true)
         await page.reload({ waitUntil: "load" })
         await waitReader(page)
         expect(await $title(page)).toBe("sport title 1")
         expect(await $content(page)).toContain("sport body 1")
         expect(await $popupOpen(page)).toBe(false)

         // Offline navigation across the cached store still works.
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "sport title 0")
         expect(await $popupOpen(page)).toBe(false)
      } finally {
         await ctx.close()
      }
   })

   // Installability: a linked, valid web app manifest plus the SW's fetch handler
   // are what make the reader an installable PWA. This checks the manifest contract
   // (name, deployment-relative start_url, standalone, 192+512+maskable icons) and
   // that every icon — and the apple-touch-icon for iOS — actually resolves.
   it("exposes a valid, installable web app manifest", async () => {
      const [page, close] = await open()
      try {
         // Resolve the <link rel="manifest"> href and fetch the manifest itself.
         const href = await page.$eval("link[rel=manifest]", (l) => (l as HTMLLinkElement).href)
         const manifest = await page.evaluate(async (u) => (await fetch(u)).json(), href)

         expect(manifest.name).toBeTruthy()
         expect(manifest.display).toBe("standalone")
         // start_url/scope are deployment-relative so the bundle works under any path.
         expect(manifest.start_url).toBe(".")
         expect(manifest.scope).toBe(".")

         // At least a 512 "any" and a 512 "maskable" icon — Chrome's install bar.
         const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[]
         expect(icons.some((i) => i.sizes.includes("512") && (i.purpose ?? "any").includes("any"))).toBe(true)
         expect(icons.some((i) => (i.purpose ?? "").includes("maskable"))).toBe(true)

         // Every icon src (resolved against the manifest URL) must actually load,
         // plus the iOS apple-touch-icon.
         const appleHref = await page.$eval("link[rel=apple-touch-icon]", (l) => (l as HTMLLinkElement).href)
         const urls = [...new Set(icons.map((i) => new URL(i.src, href).href)), appleHref]
         const statuses = await page.evaluate(
            (list) => Promise.all(list.map((u) => fetch(u).then((r) => r.status))),
            urls,
         )
         expect(statuses.every((s) => s === 200)).toBe(true)
      } finally {
         await close()
      }
   })

   // The SW bounds client storage: each article series keeps its PACK_KEEP
   // highest-stem entries (stems are handed out in write order, so higher is
   // newer) and the assets bucket keeps the ASSET_KEEP most recently cached.
   // Stuffs the caches with synthetic over-cap entries, reloads (a successful
   // online db.gz fetch triggers enforceCacheBounds), and checks the eviction
   // order. The manifest reconciliation does not interfere: it only runs when
   // the generation MOVES, and this test never advances the store.
   it("bounds the pack and asset caches, evicting oldest entries first", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
         // One reload through the controlling SW FIRST, so it adopts the current
         // generation. The reconciliation only runs when the generation moves, so
         // once adopted it stays out of this test's way — otherwise it would
         // (correctly) evict the synthetic names as unnamed by any manifest.
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)

         // 130 synthetic data objects (30 over PACK_KEEP=100), 10 synthetic idx
         // objects (under the cap), 510 assets (10 over ASSET_KEEP=500) — puts
         // awaited sequentially so the assets' insertion order is exact. The
         // stems start well above anything the store has handed out, so they
         // never collide with a real object's name.
         await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            for (let n = 1000; n <= 1129; n++)
               await packs.put(new URL(`packs/data/${n}.gz`, location.href).href, new Response("x"))
            for (let n = 900; n < 910; n++)
               await packs.put(new URL(`packs/idx/${n}.gz`, location.href).href, new Response("x"))
            const assets = await caches.open("srr-assets-v1")
            for (let n = 0; n < 510; n++) {
               const name = n.toString(16).padStart(16, "0")
               await assets.put(new URL(`packs/assets/aa/${name}.webp`, location.href).href, new Response("x"))
            }
         })

         // Reload: db.gz now flows through the SW online → prune runs in
         // waitUntil after the response resolves. Poll until it lands.
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(
            async () => {
               const packs = await caches.open("srr-packs-v4")
               const keys = await packs.keys()
               return keys.filter((k) => /\/packs\/data\/\d{4}\.gz$/.test(new URL(k.url).pathname)).length === 100
            },
            { timeout: 20000 },
         )

         const state = await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            const packPaths = (await packs.keys()).map((k) => new URL(k.url).pathname)
            const assets = await caches.open("srr-assets-v1")
            const assetPaths = (await assets.keys()).map((k) => new URL(k.url).pathname)
            return { packPaths, assetPaths }
         })
         const nums = (series: string) =>
            state.packPaths
               .map((p) => new RegExp(`/packs/${series}/(\\d+)\\.gz$`).exec(p)?.[1])
               .filter((v): v is string => v != null)
               .map(Number)
               .sort((a, b) => a - b)

         // Data series: the lowest-stem (oldest) entries evicted, newest 100 kept.
         // Stems are handed out in write order, so the store's own low-stem data
         // objects go with the synthetic ones below the cut.
         expect(nums("data")).toEqual(Array.from({ length: 100 }, (_, i) => i + 1030))
         // The under-cap idx series is untouched — the store's real idx objects
         // ride along with the synthetic ones, all of them under the cap.
         expect(nums("idx")).toEqual(expect.arrayContaining(Array.from({ length: 10 }, (_, i) => i + 900)))
         expect(nums("idx").length).toBeLessThanOrEqual(100)
         // db.gz is exempt: enforceCacheBounds only touches the article series.
         expect(state.packPaths.some((p) => p.endsWith("/packs/db.gz"))).toBe(true)
         // Assets: exactly ASSET_KEEP remain, the 10 oldest-cached gone —
         // the first surviving key is #10 (0xa), the last is #509 (0x1fd).
         expect(state.assetPaths).toHaveLength(500)
         expect(state.assetPaths[0].endsWith("/000000000000000a.webp")).toBe(true)
         expect(state.assetPaths[499].endsWith("/00000000000001fd.webp")).toBe(true)
      } finally {
         await ctx.close()
      }
   })

   // ── Offline-pin (PINNED bucket) ─────────────────────────────────────────────
   // The "pin" SW message caches pack names into srr-pinned-v1, which is
   // EXEMPT from enforceCacheBounds eviction and PURGED on gen change.
   //
   // These tests require navigator.serviceWorker.controller to be non-null (the SW
   // controlling the page); the browser global setup builds with NODE_ENV=production
   // so app.ts actually registers the SW (a non-production build compiles in the dev
   // branch that UNregisters it). They also assume the shared 6-article store, so the
   // store-replacing "purges stale finalized packs" test is ordered AFTER them below.

   it("caches named packs into srr-pinned-v1 on a 'pin' message", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })

         // Reload so the SW controls the page and db.gz is cached.
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)

         // Send a pin message with two valid object names. The SW should fetch
         // them into srr-pinned-v1. The names are LISTED by the store's manifest
         // — there is no derived form to hardcode.
         const result = await page.evaluate(
            async ([idxKey, dataKey]: string[]) => {
               const sw = navigator.serviceWorker.controller!
               const { port1, port2 } = new MessageChannel()
               const progress: { done: number; total: number }[] = []
               const done = new Promise<void>((resolve) => {
                  port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number }>) => {
                     if (e.data?.type === "pin-progress") {
                        progress.push({ done: e.data.done, total: e.data.total })
                        if (e.data.done >= e.data.total) resolve()
                     }
                  }
               })
               sw.postMessage({ type: "pin", names: [idxKey, dataKey], base: new URL("packs/", location.href).href }, [
                  port2,
               ])
               await done
               const pinned = await caches.open("srr-pinned-v1")
               const keys = (await pinned.keys()).map((k) => new URL(k.url).pathname)
               return { keys, progress }
            },
            [idxKey, dataKey],
         )

         // Both packs should be in srr-pinned-v1.
         expect(result.keys.some((k) => k.endsWith(`/packs/${idxKey}`))).toBe(true)
         expect(result.keys.some((k) => k.endsWith(`/packs/${dataKey}`))).toBe(true)
         // Progress messages: [0 done, 1 done, 2 done] (initial + one per pack).
         expect(result.progress.length).toBeGreaterThanOrEqual(2)
         expect(result.progress[result.progress.length - 1].done).toBe(2)
         expect(result.progress[result.progress.length - 1].total).toBe(2)
      } finally {
         await ctx.close()
      }
   })

   it("pinned packs survive enforceCacheBounds (eviction-exempt)", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)

         // Pin one real object name.
         await page.evaluate(async (key: string) => {
            const sw = navigator.serviceWorker.controller!
            const { port1, port2 } = new MessageChannel()
            await new Promise<void>((resolve) => {
               port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number }>) => {
                  if (e.data?.type === "pin-progress" && e.data.done >= e.data.total) resolve()
               }
               sw.postMessage({ type: "pin", names: [key], base: new URL("packs/", location.href).href }, [port2])
            })
         }, idxKey)

         // Stuff 130 finalized data packs into PACKS (30 over PACK_KEEP=100) to
         // trigger enforceCacheBounds on the next db.gz reload.
         await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            for (let n = 1; n <= 130; n++)
               await packs.put(new URL(`packs/data/${n}.gz`, location.href).href, new Response("x"))
         })

         // Reload so db.gz flows through the SW online and enforceCacheBounds runs.
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)
         // Wait for the prune to complete (data series back to 100).
         await page.waitForFunction(
            async () => {
               const packs = await caches.open("srr-packs-v4")
               const keys = await packs.keys()
               return keys.filter((k) => /\/packs\/data\/\d+\.gz$/.test(new URL(k.url).pathname)).length === 100
            },
            { timeout: 20000 },
         )

         // The pinned pack must still be in srr-pinned-v1, untouched by the prune.
         const pinnedKeys = await page.evaluate(async () => {
            const pinned = await caches.open("srr-pinned-v1")
            return (await pinned.keys()).map((k) => new URL(k.url).pathname)
         })
         expect(pinnedKeys.some((k) => k.endsWith(`/packs/${idxKey}`))).toBe(true)
      } finally {
         await ctx.close()
      }
   })

   // An offline-pinned pack is served from srr-pinned-v1 even when it has been
   // evicted from (or was never in) the rolling srr-packs-v4 bucket. This proves
   // pinnedCacheFirst's PINNED-first path keeps a pinned filter fully readable after
   // PACKS eviction — the core offline-pin correctness guarantee.
   //
   // NOTE: requires navigator.serviceWorker.controller (same sandbox limit as the
   // other pinned-bucket tests above — see the block comment above this suite).
   it("reads a pinned pack from srr-pinned-v1 after it is absent from srr-packs-v4 (offline)", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         // Cold load: SW registers, claims, caches db.gz + pack into PACKS.
         await page.goto(baseUrl + "#5", { waitUntil: "load" })
         await waitReader(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })

         // Reload so the SW controls the page and the latest pack is in PACKS.
         await page.reload({ waitUntil: "load" })
         await waitReader(page)

         // Pin the latest idx and data packs directly into PINNED (bypassing the SW
         // message path so we don't need app.ts wired — same as the other pinned
         // tests that post directly to the SW controller).
         await page.evaluate(
            async ([a, b]: string[]) => {
               const sw = navigator.serviceWorker.controller!
               const { port1, port2 } = new MessageChannel()
               await new Promise<void>((resolve) => {
                  port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number }>) => {
                     if (e.data?.type === "pin-progress" && e.data.done >= e.data.total) resolve()
                  }
                  sw.postMessage({ type: "pin", names: [a, b], base: new URL("packs/", location.href).href }, [port2])
               })
            },
            [idxKey, dataKey],
         )

         // Delete both packs from the rolling PACKS bucket so the only copy is in
         // PINNED — simulates what enforceCacheBounds does to evicted packs.
         await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            const keys = await packs.keys()
            await Promise.all(
               keys
                  .filter((k) => /\/packs\/(idx|data)\/L\d+\.gz$/.test(new URL(k.url).pathname))
                  .map((k) => packs.delete(k)),
            )
         })

         // Confirm the packs are gone from PACKS but present in PINNED.
         const state = await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            const packKeys = (await packs.keys()).map((k) => new URL(k.url).pathname)
            const pinned = await caches.open("srr-pinned-v1")
            const pinnedKeys = (await pinned.keys()).map((k) => new URL(k.url).pathname)
            return { packKeys, pinnedKeys }
         })
         expect(state.packKeys.some((k) => /\/packs\/(idx|data)\/L\d+\.gz$/.test(k))).toBe(false)
         expect(state.pinnedKeys.some((k) => k.endsWith(`/packs/${idxKey}`))).toBe(true)
         expect(state.pinnedKeys.some((k) => k.endsWith(`/packs/${dataKey}`))).toBe(true)

         // Go offline and reload. The reader must boot and render purely from the
         // PINNED bucket (db.gz is still in PACKS as it's exempt from eviction;
         // the idx and data packs come from PINNED via pinnedCacheFirst).
         await page.setOfflineMode(true)
         await page.reload({ waitUntil: "load" })
         await waitReader(page)
         // The reader renders the pinned content — no error popup (a PINNED miss
         // would throw in data.init() → popup).
         expect(await $title(page)).toBe("sport title 1")
         expect(await $content(page)).toContain("sport body 1")
         expect(await $popupOpen(page)).toBe(false)
      } finally {
         await ctx.close()
      }
   })

   // The "unpin" / "unpin-all" SW messages are the user-facing "Remove offline
   // copy": unpin deletes the NAMED entries from srr-pinned-v1 (leaving the rest
   // of a pinned scope intact), unpin-all empties the bucket. Neither reports
   // back over a MessagePort (fire-and-forget in event.waitUntil), so both are
   // observed by polling srr-pinned-v1. Same SW-controller sandbox limit as the
   // pin tests above (see the block comment there).
   it("removes named pins on 'unpin' and clears all on 'unpin-all'", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)

         // Pin all three tail objects the 6-article store names.
         const pinnedAfter = await page.evaluate(
            async (names: string[]) => {
               const sw = navigator.serviceWorker.controller!
               const base = new URL("packs/", location.href).href
               const { port1, port2 } = new MessageChannel()
               await new Promise<void>((resolve) => {
                  port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number }>) => {
                     if (e.data?.type === "pin-progress" && e.data.done >= e.data.total) resolve()
                  }
                  sw.postMessage({ type: "pin", names, base }, [port2])
               })
               const pinned = await caches.open("srr-pinned-v1")
               return (await pinned.keys()).map((k) => new URL(k.url).pathname)
            },
            [idxKey, dataKey, metaKey],
         )
         // Both known-cacheable packs landed in the eviction-exempt bucket.
         expect(pinnedAfter.some((k) => k.endsWith(`/packs/${idxKey}`))).toBe(true)
         expect(pinnedAfter.some((k) => k.endsWith(`/packs/${dataKey}`))).toBe(true)

         // (a) unpin ONLY the data tail — the SW deletes that exact entry. base MUST
         // match the pin's so the resolved URL (the cache key) is identical.
         await page.evaluate(async (key: string) => {
            const sw = navigator.serviceWorker.controller!
            const base = new URL("packs/", location.href).href
            sw.postMessage({ type: "unpin", names: [key], base })
         }, dataKey)
         // No progress reply — poll until the named entry is gone.
         await page.waitForFunction(
            async (gone: string) => {
               const pinned = await caches.open("srr-pinned-v1")
               const paths = (await pinned.keys()).map((k) => new URL(k.url).pathname)
               return !paths.some((p) => p.endsWith(`/packs/${gone}`))
            },
            { timeout: 20000 },
            dataKey,
         )
         const afterUnpin = await page.evaluate(async () => {
            const pinned = await caches.open("srr-pinned-v1")
            return (await pinned.keys()).map((k) => new URL(k.url).pathname)
         })
         // Only the named entry was removed — the sibling pin survives.
         expect(afterUnpin.some((k) => k.endsWith(`/packs/${dataKey}`))).toBe(false)
         expect(afterUnpin.some((k) => k.endsWith(`/packs/${idxKey}`))).toBe(true)

         // (b) unpin-all — the whole srr-pinned-v1 bucket is emptied.
         await page.evaluate(async () => {
            navigator.serviceWorker.controller!.postMessage({ type: "unpin-all" })
         })
         await page.waitForFunction(
            async () => {
               const pinned = await caches.open("srr-pinned-v1")
               return (await pinned.keys()).length === 0
            },
            { timeout: 20000 },
         )
      } finally {
         await ctx.close()
      }
   })

   // isPinnableName closes the cache-key surface: a "pin" name that is neither a
   // write-once pack name nor a content-hash asset key is dropped BEFORE the
   // fetch loop (no arbitrary cache-key injection). "../evil" and "db.gz" fail
   // validation outright; "idx/999.gz" is a syntactically valid pack name that
   // simply does not exist in this 6-article store, so it 404s and caches
   // nothing — either way srr-pinned-v1 gains no such entry.
   it("drops non-pinnable pin names (isPinnableName) — no cache-key injection", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
         await page.reload({ waitUntil: "load" })
         await waitBoot(page)

         const result = await page.evaluate(async () => {
            const sw = navigator.serviceWorker.controller!
            const base = new URL("packs/", location.href).href
            const { port1, port2 } = new MessageChannel()
            // The pin loop only runs over names that PASS isPinnableName, and it
            // reports `total` = that surviving count — so total < names.length is
            // the observable proof that the invalid names were filtered out.
            const last = await new Promise<{ done: number; total: number; cached: number }>((resolve) => {
               port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number; cached: number }>) => {
                  if (e.data?.type === "pin-progress" && e.data.done >= e.data.total)
                     resolve({ done: e.data.done, total: e.data.total, cached: e.data.cached })
               }
               sw.postMessage({ type: "pin", names: ["../evil", "db.gz", "idx/999.gz"], base }, [port2])
            })
            const pinned = await caches.open("srr-pinned-v1")
            const keys = (await pinned.keys()).map((k) => new URL(k.url).pathname)
            return { last, keys }
         })

         // isPinnableName filtered "../evil" and "db.gz" out of the loop entirely,
         // leaving only the syntactically-valid (but absent) "idx/999.gz".
         expect(result.last.total).toBe(1)
         // ...which 404'd, so nothing was cached.
         expect(result.last.cached).toBe(0)
         // No injected/invalid name landed in the eviction-exempt bucket.
         expect(result.keys).toHaveLength(0)
      } finally {
         await ctx.close()
      }
   })

   // A store rebuild used to need an invalidation signal: it reused finalized
   // pack names with new bytes, so the SW's cache-first would serve the stale
   // packs forever, and `srr gen --bump` existed to purge them. It cannot happen
   // any more — a stem is drawn from a counter that is never reused, so a
   // rebuild writes NEW names beside the old ones. What replaces the purge is
   // the manifest reconciliation (docs/MANIFEST-SPEC.md §8.3): on adopting a new
   // generation the SW evicts every cached object named by neither it nor the
   // previously-adopted one. This drives that: cache a generation's tail packs,
   // advance the store until the reconciliation must drop them, and check the
   // eviction happened while the live generation and db.gz survive.
   // Rebuilds the shared store, so it runs after everything that reads it.
   it("evicts cached objects the adopted manifest no longer names", async () => {
      clearDir(packsDir)
      feeds.set("/seq.xml", rssFeed("Seq", nItems(2, "seq")))
      await srr(packsDir, "feed", "add", "-t", "Seq", "-u", `${feeds.url}/seq.xml`)
      await srr(packsDir, "art", "fetch")
      const firstIdx = tailKey(packsDir, "idx")
      const firstData = tailKey(packsDir, "data")
      const firstM = storeM(packsDir)

      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         // Cold load at chron 0, wait for the SW to claim, then reload so db.gz
         // and this generation's tail packs are cached through it.
         await page.goto(baseUrl + "#0", { waitUntil: "load" })
         await waitTitle(page, "seq title 0")
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
         await page.reload({ waitUntil: "load" })
         await waitTitle(page, "seq title 0")

         const before = await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            return (await packs.keys()).map((k) => new URL(k.url).pathname)
         })
         expect(before.some((k) => k.endsWith(`/packs/${firstIdx}`))).toBe(true)
         expect(before.some((k) => k.endsWith(`/packs/${firstData}`))).toBe(true)

         // Advance the store TWICE: the reconciliation keeps one generation of
         // overlap (covering a tab mid-swap), so two consolidations are what put
         // the first generation's tail packs outside the kept set.
         for (const n of [5, 8]) {
            feeds.set("/seq.xml", rssFeed("Seq", nItems(n, "seq")))
            await srr(packsDir, "art", "fetch")
            await page.reload({ waitUntil: "load" })
            await waitTitle(page, "seq title 0")
         }
         expect(storeM(packsDir)).toBeGreaterThan(firstM)
         const liveIdx = tailKey(packsDir, "idx")
         expect(liveIdx).not.toBe(firstIdx)

         await page.waitForFunction(
            async (gone: string) => {
               const packs = await caches.open("srr-packs-v4")
               const paths = (await packs.keys()).map((k) => new URL(k.url).pathname)
               return !paths.some((p) => p.endsWith(`/packs/${gone}`))
            },
            { timeout: 20000 },
            firstIdx,
         )
         const after = await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            return (await packs.keys()).map((k) => new URL(k.url).pathname)
         })
         // The superseded generation's objects are gone...
         expect(after.some((k) => k.endsWith(`/packs/${firstIdx}`))).toBe(false)
         expect(after.some((k) => k.endsWith(`/packs/${firstData}`))).toBe(false)
         // ...while the live generation and the exempt db.gz survive.
         expect(after.some((k) => k.endsWith(`/packs/${liveIdx}`))).toBe(true)
         expect(after.some((k) => k.endsWith("/packs/db.gz"))).toBe(true)
         expect(await $popupOpen(page)).toBe(false)
      } finally {
         await ctx.close()
      }
   })

   // Regression heir: enabling "unread only" once froze the tab — the toggle then
   // lived on a surface that hid the list (display:none), whose all-zero
   // getBoundingClientRect broke the pump's below-the-fold stop and paged the
   // WHOLE archive. The toggle now rides the gear's anchored settings menu over
   // the VISIBLE list, but the bounded-window property is the same contract:
   // with the list anchored at a LIVE position (chron 0, ~99 newer unread rows
   // above it), flipping the mode must rerender a window near the initial batch
   // (BATCH=30), never the whole 100-article archive.
   // Runs LAST: replaces the shared store with a single 100-article feed.
   it("keeps the rerender window bounded when unread-only is toggled from the filter picker", async () => {
      clearDir(packsDir)
      feeds.set("/bulk.xml", rssFeed("Bulk", nItems(100, "bulk")))
      await srr(packsDir, "feed", "add", "-t", "Bulk", "-u", `${feeds.url}/bulk.xml`)
      await srr(packsDir, "art", "fetch")

      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitList(page)
         // [ALL] boots anchored at the oldest unread row (chron 0) — a live anchor
         // (render's nav.select sets pos without recordSeen), so it stays the anchor
         // through the unread toggle.
         await waitCurrent(page, "bulk title 0")
         // Open the filter picker (tap the filter button) — "Show read" lives in its
         // header now; the list stays in the DOM beneath the overlay.
         await page.click(".srr-filter")
         await page.waitForSelector(".srr-picker-showread", { visible: true })
         expect(await page.$eval(".srr-list", (e) => (e as HTMLElement).hidden)).toBe(false)
         // Flip "Show read" — the surface beneath rerenders in place (the overlay
         // stays open, so the list rows are still in the DOM to count).
         await page.click(".srr-picker-showread")
         // Give a runaway pump ample time to page the whole archive if it regressed.
         await new Promise((r) => setTimeout(r, 1500))
         const rows = await page.$$eval(".srr-list a.srr-row", (els) => els.length)
         expect(rows).toBeGreaterThan(0) // it DID rerender (initial batch loaded)
         expect(rows).toBeLessThanOrEqual(45) // ~BATCH, NOT all 100
      } finally {
         await ctx.close()
      }
   })
})
