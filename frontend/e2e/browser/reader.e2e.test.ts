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
// The list surface is shown with at least one rendered row.
const waitList = (p: Page) =>
   p.waitForFunction(
      () => {
         const l = document.querySelector(".srr-list") as HTMLElement | null
         return !!l && !l.hidden && l.querySelector("a.srr-row") != null
      },
      { timeout: 20000 },
   )
// The app has booted into EITHER surface (used where the surface is irrelevant).
const waitBoot = (p: Page) =>
   p.waitForFunction(
      () =>
         (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0 ||
         document.querySelector(".srr-list a.srr-row") != null,
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
      await srr(packsDir, "chan", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "chan", "add", "-t", "Tech", "-g", "world", "-u", `${feeds.url}/tech.xml`)
      await srr(packsDir, "chan", "add", "-t", "Sport", "-g", "play", "-u", `${feeds.url}/sport.xml`)
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

   it("opens the headlines peek with the keyboard and jumps to a nearby article", async () => {
      const [page, close] = await open("#5") // reader on the latest article (chron 5)
      try {
         await waitReader(page)
         await page.keyboard.press("l")
         await page.waitForFunction(
            () => document.querySelectorAll("#srr-peek-menu.srr-open a[data-value]").length === 6,
            { timeout: 20000 },
         )
         // Newest-first: the current (latest) article tops the list.
         const [topCurrent, topTitle] = await page.$eval("#srr-peek-menu a[data-value]", (e) => [
            e.getAttribute("aria-current"),
            e.querySelector(".srr-peek-title")?.textContent,
         ])
         expect(topCurrent).toBe("true")
         expect(topTitle).toBe("sport title 1")

         await page.click('#srr-peek-menu a[data-value="3"]')
         await waitTitle(page, "tech title 1")
         expect(await page.evaluate(() => location.hash)).toBe("#3")
         expect(await page.$eval("#srr-peek-menu", (e) => e.classList.contains("srr-open"))).toBe(false)
      } finally {
         await close()
      }
   })

   // Regression guard: the search button must open the search menu on click/tap
   // (it's reachable from both surfaces). The magnifier renders as an inner
   // .srr-search-icon <span> that fills the button, so a tap's event target is
   // the span, not the button — app.ts's outside-click close handler uses
   // .closest() so it doesn't close the menu the button just opened.
   it("opens the search menu when the magnifier button is clicked", async () => {
      const [page, close] = await open()
      try {
         await waitList(page)
         expect(await page.$eval(".srr-search .srr-search-icon", (e) => e.tagName)).toBe("SPAN")
         await page.click(".srr-search")
         await page.waitForSelector("#srr-search-menu.srr-open", { timeout: 20000 })
         // It must STAY open: the bug closed it a tick after opening.
         await new Promise((r) => setTimeout(r, 200))
         expect(await page.$eval("#srr-search-menu", (e) => e.classList.contains("srr-open"))).toBe(true)
      } finally {
         await close()
      }
   })

   // Saved articles: the reader's ★ toggle adds the current article to the
   // device-local srr-saved set; "★ Saved" in the channel menu is a distinct
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

         // Back to the list → channel menu → pick "★ Saved".
         await page.click(".srr-back")
         await waitList(page)
         await page.click(".srr-channel")
         await page.waitForSelector('#srr-channel-menu.srr-open a[data-value="~saved"]', { timeout: 20000 })
         await page.click('#srr-channel-menu a[data-value="~saved"]')
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
      // channel, same item count/order → chron 0 is always data pack 1, offset 0)
      // but different content. -s 1 + incompressible filler → finalized packs.
      const rebuild = async (prefix: string) => {
         for (const f of readdirSync(packsDir)) rmSync(join(packsDir, f), { recursive: true, force: true })
         feeds.set("/bulk.xml", rssFeed("Bulk", nItems(30, prefix, 8000)))
         await srr(packsDir, "chan", "add", "-t", "Bulk", "-u", `${feeds.url}/bulk.xml`)
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
