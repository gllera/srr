import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, open as openCtx, waitList, waitReader } from "./helpers"

// Cross-device sync end-to-end over a REAL HTTP endpoint (static-serve.ts's
// in-memory /sync/<name> route — the exact GET-or-404 / PUT contract sync.ts
// asks of a user-supplied endpoint): device A reads an article and its
// debounced push uploads the v2 profile blob; device B (a fresh profile) boots
// with the same endpoint, and the boot pull merges A's seen frontier in — the
// article A read is read on B, through real fetch/debounce/merge, no mocks.
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const wire = nItems(3, "wire") // one feed, chron 0..2

interface ProfileBlob {
   v: number
   seen: Record<string, number>
   st?: Record<string, number>
}

const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

// Configure the sync endpoint the way the dialog would (localStorage), then
// reload so sync.init wires the lifecycle with the URL in place. The caller
// owns the post-reload wait: the boot pull races the first list fill, so a
// device whose pull empties the list must not wait for filled rows.
const enableSync = async (p: Page, url: string) => {
   await p.evaluate((u) => localStorage.setItem("srr-sync-url", u), url)
   await p.reload({ waitUntil: "load" })
}

describe("browser: cross-device profile sync", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({ "/wire.xml": rssFeed("Wire", wire) })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "Wire", "-u", `${feeds.url}/wire.xml`)
      await srr(packsDir, "art", "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("device A's read pushes the profile; device B's boot pull adopts it", async () => {
      const endpoint = `${baseUrl}sync/cross-device`

      // Device A: enable sync, read the NEWEST article — recordSeen raises the
      // feed's frontier to chron 2, pushSoon debounces (5s) into GET(404)+PUT.
      const [a, closeA] = await openCtx(browser, baseUrl, waitList)
      await enableSync(a, endpoint)
      await waitList(a) // nothing read yet — the pull can't empty A's list
      await clickRow(a, "wire title 2")
      await waitReader(a)

      // The endpoint (polled from Node — the same origin the page PUT to)
      // eventually holds the v2 blob with A's seen frontier and its st stamp.
      // Poll for the CONTENT, not the first 200: an earlier cycle may have
      // seeded the endpoint before the read's debounced push lands.
      let blob: ProfileBlob | null = null
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
         const res = await fetch(endpoint)
         if (res.ok) {
            const got = (await res.json()) as ProfileBlob
            if (got.seen?.["feed:0"] === 2) {
               blob = got
               break
            }
         }
         await new Promise((r) => setTimeout(r, 500))
      }
      await closeA()
      expect(blob, "device A's read never reached the endpoint").not.toBeNull()
      expect(blob!.v).toBe(2)
      expect(blob!.st?.["feed:0"]).toBeGreaterThan(0)

      // Device B: a fresh profile sees everything unread (first boot seeds the
      // unread-only catch-up view — app.ts)…
      const [b, closeB] = await openCtx(browser, baseUrl, waitList)
      try {
         expect(await b.$$eval(".srr-list a.srr-row.srr-row-unread", (els) => els.length)).toBe(3)

         // …until the boot pull with the same endpoint merges A's frontier in:
         // the adopted seen map empties the catch-up view into the one reward
         // empty state — the read state really crossed devices.
         await enableSync(b, endpoint)
         await b.waitForFunction(() => JSON.parse(localStorage.getItem("srr-seen") ?? "{}")["feed:0"] === 2)
         await b.waitForFunction(() =>
            document.querySelector(".srr-list-empty.srr-caughtup")?.textContent?.includes("All caught up"),
         )
      } finally {
         await closeB()
      }
   }, 90_000)

   // Waits for the endpoint blob (polled from Node) to carry the wanted
   // "feed:0" frontier — pushes are debounced, so content must be polled for.
   const waitBlob = async (endpoint: string, want: number): Promise<ProfileBlob> => {
      const deadline = Date.now() + 30_000
      for (;;) {
         const res = await fetch(endpoint)
         if (res.ok) {
            const got = (await res.json()) as ProfileBlob
            if (got.seen?.["feed:0"] === want) return got
         }
         if (Date.now() > deadline) throw new Error(`endpoint never reached seen[feed:0]=${want}`)
         await new Promise((r) => setTimeout(r, 500))
      }
   }

   it("an explicit rewind propagates: device B un-reads what device A rewound", async () => {
      const endpoint = `${baseUrl}sync/rewind`

      // Device A reads everything (newest row → frontier 2) and pushes.
      const [a, closeA] = await openCtx(browser, baseUrl, waitList)
      await enableSync(a, endpoint)
      await waitList(a)
      await clickRow(a, "wire title 2")
      await waitReader(a)
      await waitBlob(endpoint, 2)

      // Device B adopts: fully caught up.
      const [b1, closeB1] = await openCtx(browser, baseUrl, waitList)
      await enableSync(b1, endpoint)
      await b1.waitForFunction(() => JSON.parse(localStorage.getItem("srr-seen") ?? "{}")["feed:0"] === 2)
      await closeB1()

      // Device A rewinds — "Mark unread from here" on the open article lowers
      // the frontier to 1 with a FRESH per-key stamp (the ONE path that lowers).
      await a.click(".srr-next", { button: "right" })
      await a.waitForSelector(".srr-ctxmenu")
      await a.evaluate(() => {
         const btn = [...document.querySelectorAll(".srr-ctxmenu-item")].find(
            (e) => e.textContent === "Mark unread from here",
         )
         ;(btn as HTMLElement | undefined)?.click()
      })
      const rewound = await waitBlob(endpoint, 1)
      await closeA()
      expect(rewound.st?.["feed:0"]).toBeGreaterThan(0)

      // A RE-OPENED device B must adopt the LOWER frontier — the newer per-key
      // stamp wins in either direction, so the rewind survives instead of being
      // re-raised by B's max-merge — and its catch-up view shows the article again.
      const [b2, closeB2] = await openCtx(browser, baseUrl, waitList)
      try {
         await enableSync(b2, endpoint)
         await b2.waitForFunction(() => JSON.parse(localStorage.getItem("srr-seen") ?? "{}")["feed:0"] === 1)
         await b2.waitForFunction(() => {
            const rows = [...document.querySelectorAll(".srr-list a.srr-row.srr-row-unread")]
            return rows.length === 1 && rows[0].querySelector(".srr-row-title")?.textContent === "wire title 2"
         })
      } finally {
         await closeB2()
      }
   }, 120_000)

   it("a failing endpoint surfaces in the settings footer and leaves local state intact", async () => {
      // /sync/fail… always 500s (static-serve's injected failure).
      const [page, close] = await openCtx(browser, baseUrl, waitList)
      try {
         await enableSync(page, `${baseUrl}sync/fail-boot`)
         await waitList(page) // the failed pull never blocks or empties the list
         expect(await page.$$eval(".srr-list a.srr-row.srr-row-unread", (els) => els.length)).toBe(3)

         // The one place a sync failure reaches the user: the settings footer.
         await page.click(".srr-feed")
         await page.waitForSelector(".srr-ctxmenu-footer")
         await page.waitForFunction(() =>
            document.querySelector(".srr-ctxmenu-footer")?.textContent?.includes("Sync failed"),
         )
      } finally {
         await close()
      }
   }, 60_000)
})
