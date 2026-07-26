import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList } from "./helpers"

// Row swipe actions (RDR14) driven with REAL Chrome touch input: a one-finger
// horizontal drag on a list row — left toggles read, right toggles ★ Saved.
//
// Why this layer exists at all: the gesture arrives through a REGISTRATION
// (gestures.setRowSwipe, called by list.setup), and a registration is exactly
// what unit tests with a mocked module graph cannot vouch for — the pull step
// before this one shipped a silently shadowed `import * as refresh` that only
// the running callback exposed. Everything here therefore asserts the OUTCOME of
// a real drag: the frontier written to localStorage, the row's re-derived state,
// the saved set, and the fact that the swipe did not also open the reader.
//
// What still needs a device: the feel (trigger distance, the row tracking the
// thumb, the damping past the arm point) and any engine that synthesizes a click
// after a canceled touchmove sequence.
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const items = nItems(4, "swipe")

// A committed horizontal drag across `row`, in steps because Chrome coalesces
// touchmove (one big jump is not guaranteed to be delivered). dx < 0 swipes
// left, dx > 0 right; 110px clears the 64px trigger with room for the damping.
async function swipeRow(p: Page, rowIndex: number, dx: number): Promise<void> {
   const from = await p.evaluate((i) => {
      const r = document.querySelectorAll(".srr-list a.srr-row")[i].getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
   }, rowIndex)
   const touch = await p.touchscreen.touchStart(from.x, from.y)
   for (const step of [0.2, 0.5, 0.8, 1]) await touch.move(from.x + dx * step, from.y)
   await touch.end()
}

const $seen = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem("srr-seen") ?? "{}"))
const $saved = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem("srr-saved") ?? "[]"))
const $unread = (p: Page) =>
   p.$$eval(".srr-list a.srr-row", (els) => els.map((e) => e.classList.contains("srr-row-unread")))

describe("browser: row swipe actions", () => {
   let browser: Browser
   let feeds: FeedServer

   beforeAll(async () => {
      feeds = await feedServer({ "/swipe.xml": rssFeed("Swipe", items) })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "Swipe", "-u", `${feeds.url}/swipe.xml`)
      await srr(packsDir, "art", "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // One ordered flow rather than four independent cases: the read toggle's
   // reversibility is a SEQUENCE (mark read, then swipe back), and re-running the
   // boot + land-once anchor per assertion would cost more than it proves. The
   // refresh suite's publish→trigger→assert case sets the precedent.
   it("swiping a row acts on that row: read, back to unread, ★ saved — and never opens the reader", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         // Tall enough that a 4-row store never scrolls: a page with no scroll
         // reserve cannot drift off the top mid-gesture, and a vertical drag at
         // the top would otherwise engage the pull instead.
         await p.setViewport({ width: 500, height: 900, hasTouch: true })
         await p.goto(`${baseUrl}#`, { waitUntil: "load" })
         await waitList(p)
         // A fresh profile has read nothing, so every row is unread.
         expect(await $unread(p)).toEqual([true, true, true, true])
         expect(await $seen(p)).toEqual({})

         // ── ← on the second-newest row: mark read ──────────────────────────
         // The frontier is per FEED, so this reads that row AND the older ones
         // (the model has no per-article read bit — the swipe's own undo below is
         // what makes that recoverable).
         await swipeRow(p, 1, -110)
         await p.waitForFunction(() => document.querySelectorAll(".srr-list a.srr-row.srr-row-unread").length === 1, {
            timeout: 20_000,
         })
         expect(await $unread(p)).toEqual([true, false, false, false])
         // chron 2 is the second-newest of the four articles this store holds.
         expect(await $seen(p)).toEqual({ "feed:0": 2 })
         // Still on the list: the finger-lift must not also open the reader.
         expect(await p.evaluate(() => !(document.querySelector(".srr-list") as HTMLElement).hidden)).toBe(true)

         // ── ← on the same row again: the exact rewind (S57's snapshot) ──────
         // Not "lower to chron−1": the frontier goes back to never-seen, which is
         // where this device was before the swipe.
         await swipeRow(p, 1, -110)
         await p.waitForFunction(() => document.querySelectorAll(".srr-list a.srr-row.srr-row-unread").length === 4, {
            timeout: 20_000,
         })
         expect((await $seen(p))["feed:0"]).toBe(-1) // the stored never-seen equivalent

         // ── → on the newest row: ★ Saved, in place ─────────────────────────
         await swipeRow(p, 0, 110)
         await p.waitForFunction(() => !!document.querySelector(".srr-list a.srr-row.srr-row-saved"), {
            timeout: 20_000,
         })
         expect(await $saved(p)).toEqual([3])
         expect(await p.$eval(".srr-list a.srr-row .srr-row-star", (e) => e.getAttribute("aria-pressed"))).toBe("true")
         expect(await p.evaluate(() => !(document.querySelector(".srr-list") as HTMLElement).hidden)).toBe(true)

         // ── a VERTICAL drag on a row is a scroll, never a row action ────────
         // The other half of the axis lock, and the half a mocked machine cannot
         // prove: real Chrome delivers its own coalesced move stream here.
         const seenBefore = await $seen(p)
         const savedBefore = await $saved(p)
         const from = await p.evaluate(() => {
            const r = document.querySelectorAll(".srr-list a.srr-row")[2].getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
         })
         const touch = await p.touchscreen.touchStart(from.x, from.y)
         for (const dy of [30, 60, 90]) await touch.move(from.x + 12, from.y - dy) // up, off the pull's axis
         await touch.end()
         expect(await $seen(p)).toEqual(seenBefore)
         expect(await $saved(p)).toEqual(savedBefore)

         // ── a plain TAP still opens the reader ─────────────────────────────
         // The swipe's click guard is spent per gesture, so it can never latch
         // the list's own row taps off.
         const tap = await p.evaluate(() => {
            const r = document.querySelectorAll(".srr-list a.srr-row")[0].getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
         })
         await p.touchscreen.tap(tap.x, tap.y)
         await p.waitForFunction(() => !!location.hash.match(/^#\d/), { timeout: 20_000 })
      } finally {
         await ctx.close()
      }
   })
})
