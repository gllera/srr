import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList, waitReader } from "./helpers"

// Reader swipe pager (spec 2026-07-27) driven with REAL Chrome touch input.
// The unit layers prove the geometry (gestures.test.ts) and the pane (pager.test.ts)
// in isolation; what only this layer can vouch for is the REGISTRATION
// (pager.setup → gestures.setPager → app.pagerCommit → the nav guard) and real
// coalesced touch streams — the same argument as swipe.e2e.test.ts, which caught
// a silently shadowed import that only the running callback exposed.
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// Every article carries a wide <pre> (`overflow-x: auto` in styles.css, so it
// really scrolls) after its prose, so the scrollable-veto stop can start its
// drag inside one without caring which chron it landed on.
const items = nItems(4, "pager").map((it) => ({
   ...it,
   content: it.content + `<pre>${"wide-content ".repeat(300)}</pre>`,
}))

// What the drag looked like at full extension, sampled after the last move and
// BEFORE the lift. This is what separates the three engage outcomes from each
// other, and it is why the negative stops below are not vacuous: at a dead edge
// nav would refuse to move anyway, so "the hash didn't change" alone would pass
// just as well with the resistance deleted.
interface DragPeek {
   // The reader <article>'s inline translateX: 1:1 with the finger in "page"
   // mode, damped to ±64px in "resist" mode, absent (0) when the pager declined
   // the gesture outright.
   tx: number
   // A neighbor preview pane is on screen — "page" mode only.
   pane: boolean
}

// A horizontal drag on the reader, in steps because Chrome coalesces touchmove.
//
// `from` picks the drag ORIGIN — the article prose by default, the wide <pre>
// for the veto case — and the origin is the whole eligibility story (gestures.ts
// reads the touch's target), so this verifies with elementFromPoint that the
// point really landed where the caller meant. A prose drag that silently started
// inside the <pre> would be vetoed and assert nothing; a "veto" drag that missed
// the <pre> would page and assert nothing. Both are the classic vacuous pass.
//
// The whole path is kept inside the viewport: Chrome does not deliver a touch
// point outside it, so a drag that walked off the edge would lose its later
// moves and read as a shorter one.
//
// `slow` spaces the steps so the LAST segment's velocity is far under
// gestures.ts's PAGE_FLICK_VX (0.5 px/ms) — without it four back-to-back CDP
// moves land within a few ms of each other and even an 80px drag reads as a
// flick, which commits regardless of distance.
async function dragReader(p: Page, dx: number, opts: { from?: string; slow?: boolean } = {}): Promise<DragPeek> {
   const sel = opts.from ?? ".srr-content"
   const wantPre = sel.includes("pre")
   const at = await p.evaluate(
      (s, d, pre) => {
         const e = document.querySelector(s)
         if (!e) throw new Error(`drag origin: no ${s}`)
         const r = e.getBoundingClientRect()
         const W = window.innerWidth
         const lo = Math.max(r.left + 8, d > 0 ? 8 : 8 - d)
         const hi = Math.min(r.right - 8, d < 0 ? W - 8 : W - 8 - d)
         if (lo > hi) throw new Error(`drag origin: dx=${d} does not fit on screen inside ${s}`)
         const x = Math.round((lo + hi) / 2)
         const y = Math.round(r.top + 10)
         const hit = document.elementFromPoint(x, y)
         if (!hit?.closest(s)) throw new Error(`drag origin: (${x},${y}) is not inside ${s}`)
         if (!!hit.closest("pre") !== pre) throw new Error(`drag origin: (${x},${y}) inside-a-<pre> is not ${pre}`)
         return { x, y }
      },
      sel,
      dx,
      wantPre,
   )
   const touch = await p.touchscreen.touchStart(at.x, at.y)
   for (const s of [0.2, 0.5, 0.8, 1]) {
      if (opts.slow) await new Promise((r) => setTimeout(r, 150))
      await touch.move(at.x + dx * s, at.y)
   }
   const peek = await p.evaluate(() => {
      const t = (document.querySelector(".srr-reader") as HTMLElement).style.transform
      return {
         tx: Number(/translateX\((-?[\d.]+)px\)/.exec(t)?.[1] ?? 0),
         pane: !!document.querySelector(".srr-pager-pane.srr-pager-show"),
      }
   })
   await touch.end()
   return peek
}

const $hash = (p: Page) => p.evaluate(() => location.hash)
const $title = (p: Page) => p.$eval(".srr-title", (e) => e.textContent)
// The reader's inline drag transform is cleared by pager.ts's rest(), so this is
// "the gesture is fully over" — and the next drag then measures a rect that is
// back where the layout put it.
const waitSettled = (p: Page) =>
   p.waitForFunction(() => !(document.querySelector(".srr-reader") as HTMLElement).style.transform, { timeout: 20_000 })

describe("browser: reader swipe pager", () => {
   let browser: Browser
   let feeds: FeedServer

   beforeAll(async () => {
      feeds = await feedServer({ "/pager.xml": rssFeed("Pager", items) })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "Pager", "-u", `${feeds.url}/pager.xml`)
      await srr(packsDir, "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // One ordered flow (the swipe.e2e precedent): commit, snap-back, dead edge
   // and the scrollable veto are stops on one journey through the same reader.
   it("a committed drag pages, a short one snaps back, a dead edge resists, a wide <pre> scrolls", async () => {
      const ctx = await browser.createBrowserContext()
      try {
         const p = await ctx.newPage()
         await p.setViewport({ width: 500, height: 900, hasTouch: true })
         await p.goto(`${baseUrl}#`, { waitUntil: "load" })
         await waitList(p)

         // Open the newest article (rows are newest-first) from the list.
         await p.click(".srr-list a.srr-row")
         await waitReader(p)
         // showList() disables BOTH buttons, so "next disabled" alone would pass
         // before the neighbor probes have answered. prev-enabled AND
         // next-disabled is the settled newest-article state — and it is also the
         // direction mapping this suite rests on: gestures.ts reads dx > 0 as
         // "prev" and pager.ts's engage reads el.prev/el.next's disabled state,
         // so HERE a leftward drag is the dead edge and a rightward one pages.
         await p.waitForFunction(
            () => {
               const q = (s: string) => document.querySelector(s) as HTMLButtonElement
               return !q(".srr-prev").disabled && q(".srr-next").disabled
            },
            { timeout: 20_000 },
         )
         const startHash = await $hash(p)
         const startTitle = await $title(p)

         // The commit bar is a quarter of the SURFACE's own width — gestures.ts
         // reads `pagerSurface.clientWidth`, NOT the viewport — and at this 500px
         // viewport the reader <article> measures 476, so the bar is ~119px, not
         // the 125px a viewport-based reading would give. Pin that both drags
         // below straddle it with room, so a layout change that moved it under
         // 80 or over 300 fails here instead of quietly voiding a stop.
         const commitPx = await p.evaluate(() => (document.querySelector(".srr-reader") as HTMLElement).clientWidth / 4)
         expect(commitPx).toBeGreaterThan(96) // 80px must stay short of it
         expect(commitPx).toBeLessThan(240) // 300px must stay well past it

         // The surface's HEIGHT is a gesture concern too: gestures.ts engages
         // only on a touch that STARTS inside it, so an <article> sized to its
         // content would leave a short article a dead band underneath. Asserted
         // as the COMPUTED min-height rather than the measured box, which every
         // article in this fixture clears on its own (they each carry a 300-word
         // <pre>) and which would therefore pass with the rule deleted.
         const minH = await p.evaluate(() => {
            const v = getComputedStyle(document.querySelector(".srr-reader")!).minHeight
            return { px: parseFloat(v), vh: window.innerHeight }
         })
         expect(minH.px).toBeGreaterThan(minH.vh / 2)

         // ── dead edge: at the newest article, a leftward (next) drag resists ──
         // Deliberately the FAST drag: it lifts as a flick, the one input that
         // commits below the distance bar — and must still not, because engage()
         // answered "resist". The damped travel and the absent preview pane are
         // what actually distinguish that from "page" here: nav would refuse to
         // step past the newest article either way, so the unchanged hash below
         // is the outcome, not the mechanism.
         const dead = await dragReader(p, -300)
         expect(dead.tx).toBeLessThan(0) // toward the wall, and…
         expect(dead.tx).toBeGreaterThanOrEqual(-64) // …damped (pager.ts RESIST_MAX)
         expect(dead.pane).toBe(false) // nothing to preview at a dead edge
         await new Promise((r) => setTimeout(r, 400)) // let any wrong commit land
         expect(await $hash(p)).toBe(startHash)
         expect(await $title(p)).toBe(startTitle)

         // ── committed rightward (prev) drag: 300px, well past the ~119px bar ──
         const paged = await dragReader(p, 300)
         expect(paged.tx).toBeGreaterThan(240) // tracks the finger 1:1, undamped
         expect(paged.pane).toBe(true) // the neighbor preview slid in
         await p.waitForFunction((h) => location.hash !== h, { timeout: 20_000 }, startHash)
         await waitSettled(p)
         const prevHash = await $hash(p)
         expect(await $title(p)).not.toBe(startTitle)

         // ── short drag: 80px, short of the bar → snap back, no navigation ─────
         // `slow` is load-bearing: the flick test reads the LAST segment's
         // velocity, and a fast 80px drag commits on that alone.
         const short = await dragReader(p, 80, { slow: true })
         expect(short.tx).toBeCloseTo(80, 0) // it tracked — it just wasn't enough
         await new Promise((r) => setTimeout(r, 400))
         expect(await $hash(p)).toBe(prevHash)
         await waitSettled(p)

         // ── a drag starting inside the wide <pre> is that element's scroll ────
         // Leftward, and `next` is live here (there IS a newer article), so this
         // would page if the horizontal-scrollable veto were not doing the work.
         // The pager never engages at all, so the article never moves: that, not
         // just the unchanged hash, is what a deleted veto would break.
         const vetoed = await dragReader(p, -300, { from: ".srr-content pre" })
         expect(vetoed.tx).toBe(0)
         expect(vetoed.pane).toBe(false)
         await new Promise((r) => setTimeout(r, 400))
         expect(await $hash(p)).toBe(prevHash)
      } finally {
         await ctx.close()
      }
   })
})
