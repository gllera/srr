import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// Drives the REAL built SPA in headless Chrome against real srrb packs: proves
// the Parcel build, app.ts render, hash routing (list home + reader drill-down),
// and real-browser fetch/DecompressionStream all work end-to-end.

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// Tagged 6-article store. Disjoint published ranges → global chronIdx order:
// news0,news1 (0,1) · tech0,tech1 (2,3) · sport0,sport1 (4,5). Latest = sport1.
const news = nItems(2, "news", 0, 0)
const tech = nItems(2, "tech", 0, 10)
const sport = nItems(2, "sport", 0, 20)

const $title = (p: Page) => p.$eval(".srr-title", (e) => e.textContent)
const $content = (p: Page) => p.$eval(".srr-content", (e) => e.textContent ?? "")
const $link = (p: Page) => p.$eval(".srr-title-link", (e) => e.getAttribute("href"))
const $nextDisabled = (p: Page) => p.$eval(".srr-next", (e) => (e as HTMLButtonElement).disabled)
const $popupOpen = (p: Page) => p.$eval(".srr-popup", (e) => e.classList.contains("srr-open"))
const $rowTitles = (p: Page) => p.$$eval(".srr-list a.srr-row .srr-row-title", (els) => els.map((e) => e.textContent))
// Viewport-relative top of the row whose title matches (null if absent) — used to
// assert where the list anchored a given article (top-aligned, centered, or
// relative to another row).
const $rowTop = (p: Page, title: string) =>
   p.$$eval(
      ".srr-list a.srr-row",
      (els, t) => {
         const row = els.find((e) => e.querySelector(".srr-row-title")?.textContent === t)
         return row ? row.getBoundingClientRect().top : null
      },
      title,
   )

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

const waitTitle = (p: Page, t: string) =>
   p.waitForFunction((want) => document.querySelector(".srr-title")?.textContent === want, { timeout: 20000 }, t)
// The reader surface is shown with a non-empty title.
const waitReader = (p: Page) =>
   p.waitForFunction(
      () => {
         const a = document.querySelector(".srr-reader") as HTMLElement | null
         return !!a && !a.hidden && (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0
      },
      { timeout: 20000 },
   )
// The list surface is shown with at least one rendered row AND every row filled
// (no skeletons left) — rows now paint as skeletons first, so gating on row
// presence alone would let a bulk title read race the progressive fill.
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

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/tech.xml": rssFeed("Tech", tech),
         "/sport.xml": rssFeed("Sport", sport),
      })
      // Write packs straight into the served pack dir (cleared first).
      for (const f of readdirSync(packsDir)) rmSync(join(packsDir, f), { recursive: true, force: true })
      await srr(packsDir, "feed", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Tech", "-g", "world", "-u", `${feeds.url}/tech.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-g", "play", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "art", "fetch")

      browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // Fresh incognito context per scenario → isolated localStorage/cache.
   async function open(hash = ""): Promise<[Page, () => Promise<void>]> {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      await page.goto(baseUrl + hash, { waitUntil: "load" })
      await waitBoot(page)
      return [page, async () => ctx.close()]
   }

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
         expect(await $currentTitle(page)).toBeNull() // fresh boot: nothing selected

         // First key drops the cursor on the topmost visible row (the newest), no step.
         await page.keyboard.press("d")
         await waitCurrent(page, "sport title 1")

         // A / ← step to the OLDER neighbor (down the newest-first list).
         await page.keyboard.press("a")
         await waitCurrent(page, "sport title 0")
         await page.keyboard.press("ArrowLeft")
         await waitCurrent(page, "tech title 1")

         // D / → step back to the NEWER neighbor (up).
         await page.keyboard.press("ArrowRight")
         await waitCurrent(page, "sport title 0")
         await page.keyboard.press("d")
         await waitCurrent(page, "sport title 1")

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
         await page.keyboard.press("d") // establish the cursor on the newest visible row
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
         await page.keyboard.press("d") // cursor on the newest row
         await waitCurrent(page, "sport title 1")
         for (let i = 0; i < 5; i++) await page.keyboard.press("a") // older → the oldest row
         await waitCurrent(page, "news title 0")
         // One more older step can't advance — the row takes the down-bump cue.
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
         await page.setViewport({ width: 500, height: 140 })
         await waitList(page)

         // Pick the never-read "world" tag (News + Tech) from a fresh boot.
         await page.click(".srr-feed")
         await page.waitForSelector('#srr-feed-menu.srr-open a[data-value="world"]', { timeout: 20000 })
         await page.click('#srr-feed-menu a[data-value="world"]')
         await waitList(page)
         expect(await page.evaluate(() => location.hash)).toBe("#!world")

         // Oldest world (news title 0) is the anchor + selection; the list scrolled
         // down to it so the newer world rows sit ABOVE the fold — only possible
         // when it anchored at the oldest, not pinned at the newest ([ALL]).
         await waitCurrent(page, "news title 0")
         await page.waitForFunction(() => window.scrollY > 0, { timeout: 20000 })
         expect(await $rowTop(page, "tech title 1")).toBeLessThan(0) // newest world, scrolled off above
         expect(await $rowTop(page, "tech title 0")).toBeLessThan(0)
         const oldestTop = await $rowTop(page, "news title 0") // oldest world = the anchor, near the top
         expect(oldestTop).not.toBeNull()
         expect(oldestTop!).toBeGreaterThanOrEqual(0)
         expect(oldestTop!).toBeLessThan(140)
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

   // Search drives the MAIN list now (no dropdown): the magnifier toggles the
   // "q:<query>" list filter, a pinned search bar takes the query, matches render
   // as ordinary list rows, the query rides in the #!q:… hash, and tapping a
   // result opens the reader walking the search set. The magnifier still renders
   // as an inner .srr-search-icon <span> filling the button.
   it("search renders matches into the main list and the reader walks the hits", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         expect(await page.$eval(".srr-search .srr-search-icon", (e) => e.tagName)).toBe("SPAN")
         await page.click(".srr-search")
         // The search bar appears (body gains srr-searching) ready for input.
         await page.waitForFunction(() => document.body.classList.contains("srr-searching"), { timeout: 20000 })
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

   // The home list reads thin meta/ cards (the derived projection) to populate
   // its rows — NOT full data/ records — so the list launch is O(1) data pack
   // fetches. Opening a row then fetches the data/ pack for that article.
   // This test captures the core read-amplification win of the meta/ design.
   it("list boot fetches meta/ packs and NOT data/ until a row is opened", async () => {
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

         // After list boot: meta/ pack fetched (the list reads it for card data).
         expect(requested.some((p) => /\/packs\/meta\//.test(p))).toBe(true)
         // No data/ pack fetched yet — the list uses meta/ projections only.
         expect(requested.some((p) => /\/packs\/data\//.test(p))).toBe(false)

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
   // device-local srr-saved set; "★ Saved" in the feed menu is a distinct
   // filter view that shows exactly that set, and it survives a reload (the set
   // lives in localStorage, the #!~saved hash re-enters the view).
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

         // Back to the list → feed menu → pick "★ Saved".
         await page.click(".srr-back")
         await waitList(page)
         await page.click(".srr-feed")
         await page.waitForSelector('#srr-feed-menu.srr-open a[data-value="~saved"]', { timeout: 20000 })
         await page.click('#srr-feed-menu a[data-value="~saved"]')
         await waitList(page)
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

         // Reload so every shell + pack request now flows through the controlling SW
         // and is cached. The reader at chron 5 pulls in the (single) data pack.
         await page.reload({ waitUntil: "load" })
         await waitReader(page)

         // The pack and shell buckets are populated (asset bucket only fills when a
         // store actually self-hosts images, which these plain-text fixtures don't).
         const cacheNames = await page.evaluate(() => caches.keys())
         expect(cacheNames).toEqual(expect.arrayContaining(["srr-packs-v3", "srr-shell-v1"]))

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

   // The SW bounds client storage: each finalized pack series keeps its
   // PACK_KEEP highest-numbered entries (the names encode chron age) and the
   // assets bucket keeps the ASSET_KEEP most recently cached. Everything
   // offline correctness depends on (db.gz, L<seq>, h<N>) is exempt. Stuffs
   // the caches with synthetic over-cap entries, reloads (a successful online
   // db.gz fetch triggers enforceCacheBounds), and checks the eviction order.
   // Uses the shared 6-article store, where every real pack is L-named — so
   // the synthetic entries are the only finalized-numeric keys in the bucket
   // and the assertions can be exact.
   it("bounds the pack and asset caches, evicting oldest entries first", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitBoot(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })

         // 130 finalized data packs (30 over PACK_KEEP=100), 10 finalized idx
         // packs (under the cap), 510 assets (10 over ASSET_KEEP=500) — puts
         // awaited sequentially so the assets' insertion order is exact.
         await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v3")
            for (let n = 1; n <= 130; n++)
               await packs.put(new URL(`packs/data/${n}.gz`, location.href).href, new Response("x"))
            for (let n = 0; n < 10; n++)
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
               const packs = await caches.open("srr-packs-v3")
               const keys = await packs.keys()
               return keys.filter((k) => /\/packs\/data\/\d+\.gz$/.test(new URL(k.url).pathname)).length === 100
            },
            { timeout: 20000 },
         )

         const state = await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v3")
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

         // Data series: the 30 lowest-numbered (oldest) evicted, newest 100 kept.
         expect(nums("data")).toEqual(Array.from({ length: 100 }, (_, i) => i + 31))
         // The under-cap idx series is untouched.
         expect(nums("idx")).toEqual(Array.from({ length: 10 }, (_, i) => i))
         // Exempt names survive the prune.
         expect(state.packPaths.some((p) => p.endsWith("/packs/db.gz"))).toBe(true)
         expect(state.packPaths.some((p) => /\/packs\/idx\/L\d+\.gz$/.test(p))).toBe(true)
         // Assets: exactly ASSET_KEEP remain, the 10 oldest-cached gone —
         // the first surviving key is #10 (0xa), the last is #509 (0x1fd).
         expect(state.assetPaths).toHaveLength(500)
         expect(state.assetPaths[0].endsWith("/000000000000000a.webp")).toBe(true)
         expect(state.assetPaths[499].endsWith("/00000000000001fd.webp")).toBe(true)
      } finally {
         await ctx.close()
      }
   })

   // An in-place store rebuild reuses finalized pack ids (data/N.gz) with new
   // bytes — the SW's cache-first would serve the stale packs forever. The db.gz
   // `gen` field is the invalidation signal: when it changes, the SW purges the
   // packs bucket BEFORE db.gz resolves to the page (which only then requests
   // idx/data packs). Proves both directions with a real srrb rebuild: without a
   // gen bump the stale cache wins (that's cache-first working as designed); with
   // `srr gen --bump` the fresh bytes win. Runs LAST: it replaces the shared store.
   it("purges stale finalized packs when db.gz gen changes", async () => {
      // Wipe the served store and write a fresh one with the same shape (one
      // feed, same item count/order → chron 0 is always data pack 1, offset 0)
      // but different content. -s 1 + incompressible filler → finalized packs.
      const rebuild = async (prefix: string) => {
         for (const f of readdirSync(packsDir)) rmSync(join(packsDir, f), { recursive: true, force: true })
         feeds.set("/bulk.xml", rssFeed("Bulk", nItems(30, prefix, 8000)))
         await srr(packsDir, "feed", "add", "-t", "Bulk", "-u", `${feeds.url}/bulk.xml`)
         await srr(packsDir, "-s", "1", "art", "fetch")
      }

      await rebuild("alpha")
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         // Cold load at chron 0 (lives in finalized, cache-first data/1.gz), wait
         // for the SW to claim, then reload so the pack is cached through it.
         await page.goto(baseUrl + "#0", { waitUntil: "load" })
         await waitTitle(page, "alpha title 0")
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
         await page.reload({ waitUntil: "load" })
         await waitTitle(page, "alpha title 0")

         // Rebuild with new content but unchanged gen (absent == 0): the stale
         // cached pack must still be served — the purge is gen-driven, not a side
         // effect of the rebuild itself.
         await rebuild("beta")
         await page.reload({ waitUntil: "load" })
         await waitTitle(page, "alpha title 0")

         // Bump gen → next db.gz fetch purges the packs bucket → fresh bytes.
         await srr(packsDir, "gen", "--bump")
         await page.reload({ waitUntil: "load" })
         await waitTitle(page, "beta title 0")
         expect(await $popupOpen(page)).toBe(false)
      } finally {
         await ctx.close()
      }
   })
})
