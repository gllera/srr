import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// Drives the REAL built SPA in headless Chrome against real srrb packs: proves
// the Parcel build, app.ts render, hash routing, and real-browser
// fetch/DecompressionStream all work end-to-end — not just the data modules.

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
const waitTitle = (p: Page, t: string) =>
   p.waitForFunction((want) => document.querySelector(".srr-title")?.textContent === want, { timeout: 20000 }, t)
const waitRendered = (p: Page) =>
   p.waitForFunction(() => (document.querySelector(".srr-title")?.textContent?.length ?? 0) > 0, { timeout: 20000 })

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
      await waitRendered(page)
      return [page, async () => ctx.close()]
   }

   it("renders the latest article and navigates with the keyboard", async () => {
      const [page, close] = await open()
      try {
         expect(await $title(page)).toBe("sport title 1")
         expect(await $content(page)).toContain("sport body 1")
         expect(await $link(page)).toBe("http://example.com/sport/1")
         expect(await $popupOpen(page)).toBe(false)

         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "sport title 0")
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, "tech title 1")
         expect(await $popupOpen(page)).toBe(false)
      } finally {
         await close()
      }
   })

   it("deep-links to a specific chronIdx", async () => {
      const [page, close] = await open("#2")
      try {
         await waitTitle(page, "tech title 0")
         expect(await $content(page)).toContain("tech body 0")
         expect(await $link(page)).toBe("http://example.com/tech/0")
      } finally {
         await close()
      }
   })

   it("filters to a tag and traverses only that subset", async () => {
      const [page, close] = await open("#0!world")
      try {
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

   // The service worker (src/sw.ts) makes the reader work fully offline: the shell
   // (navigation + hashed JS/CSS) and the packs (db.gz + latest idx/data, here a
   // single pack) are runtime-cached on the first online visit, then served from
   // cache when the network is cut. Headless Chrome over http://127.0.0.1 is a
   // secure context, so the SW registers and activates as it does in production.
   it("serves the reader offline after one online visit", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         // Cold load: the SW registers, activates (skipWaiting), and claims control.
         await page.goto(baseUrl, { waitUntil: "load" })
         await waitRendered(page)
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })

         // Reload so every shell + pack request now flows through the controlling SW
         // and is cached. The initial render of the latest article already pulls in
         // the (single) data pack covering the whole store.
         await page.reload({ waitUntil: "load" })
         await waitRendered(page)

         // The pack and shell buckets are populated (asset bucket only fills when a
         // store actually self-hosts images, which these plain-text fixtures don't).
         const cacheNames = await page.evaluate(() => caches.keys())
         expect(cacheNames).toEqual(expect.arrayContaining(["srr-packs-v3", "srr-shell-v1"]))

         // Cut the network and reload — the reader must still boot and render purely
         // from cache. A clean render with no error popup proves db.gz + idx + data
         // all resolved offline (any miss would throw in data.init() → popup).
         await page.setOfflineMode(true)
         await page.reload({ waitUntil: "load" })
         await waitRendered(page)
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
