import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"
import axe from "axe-core"

import { feedServer, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { clearDir, launchBrowser, open as openCtx, waitList, waitReader } from "./helpers"

// Automated a11y (axe-core) over the REAL built SPA — the regression net the
// hand-maintained ARIA never had. The reader's roles, `aria-pressed` toggles,
// `aria-keyshortcuts` and focus traps are all written by hand across app.ts /
// picker.ts / dropdown.ts / list.ts, and nothing failed when one of them
// regressed.
//
// Covers the four surfaces frontend/CLAUDE.md describes — the two views (list,
// reader) and the two popups over the list (filter picker, settings menu).
// The popups matter most: they own the focus traps and nearly every
// `aria-pressed` in the app, so they are where a hand-edited ARIA attribute
// breaks first.
//
// axe runs against the whole document rather than the surface's own subtree,
// deliberately: with a popup up, what a screen reader meets is the popup AND
// whatever the app left exposed behind it, and a subtree scan would hide
// exactly that class of bug (a missing `aria-hidden`, a duplicate id across
// overlay and list).
//
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

declare global {
   interface Window {
      axe: typeof axe
   }
}

// Impacts that FAIL. axe's minor/moderate findings here are advisory for an app
// of this shape — `region` (the toolbar's popups render outside a landmark) and
// `page-has-heading-one` (the reader's <h1> IS the article title, so the list
// legitimately has none) — and gating on them would bury a real serious/critical
// regression in permanent noise.
const BLOCKING: ReadonlySet<string> = new Set(["serious", "critical"])

// Rules NOT enforced, each with the reason. Anything added here must name the
// rule, why it cannot be fixed in place, and what would fix it — an unexplained
// entry silently lowers the bar for every future change.
const DEFERRED: Record<string, string> = {
   // Every instance traces to two DELIBERATE design decisions in tokens.css,
   // neither of which a test may quietly overrule:
   //
   //  1. `--muted: #8a8780` (3.42:1 on --bg) is documented in tokens.css as
   //     "metadata / chrome only — intentionally below AA for body text", with
   //     `--fg-2` as the >=4.5:1 sibling for anything that IS body text. It
   //     carries the datelines, ages, day dividers, unread counts and status
   //     footer.
   //  2. The per-source OKLCH ramp and --accent render on 13%-tint backgrounds
   //     mixed from the SAME hue (.srr-row-current, .srr-scope-chip), landing at
   //     3.8-4.2:1. The ramp is deliberately uniform ("every slot shares one
   //     lightness + chroma", tokens.css), so clearing it means re-tuning all 8
   //     hues darker — a design-system change, not a test fix.
   //
   // Not a blanket shrug: the app already ships an @media (prefers-contrast:
   // more) accommodation that raises --muted to #555, and under it these
   // surfaces measure clean except the ramp/accent tints above (verified with
   // CDP Emulation.setEmulatedMedia while writing this suite). Removing this
   // entry is a tokens.css decision — start by giving --accent and the source
   // ramp high-contrast values in that media block.
   "color-contrast": "deliberate tokens.css contrast choices — see the comment above",
}

const item = (prefix: string, i: number, startIdx: number, content: string): FeedItem => ({
   title: `${prefix} title ${i}`,
   link: `http://example.com/${prefix}/${i}`,
   guid: `${prefix}-${i}`,
   pubDate: pubDate(startIdx + i),
   content,
})

// Real prose shapes, so the reader audit sees the elements the sanitizer
// actually emits (headings, lists, quotes, code, an inline link) rather than
// the one-line filler the sibling suites use.
const prose =
   `<p>Lead paragraph with an <a href="http://example.com/deep">inline link</a> and <b>bold</b> text.</p>` +
   `<h2>A subheading</h2>` +
   `<ul><li>first</li><li>second</li></ul>` +
   `<blockquote><p>A pull quote.</p></blockquote>` +
   `<pre><code>const x = 1</code></pre>`

const news = [item("news", 0, 0, prose), item("news", 1, 1, prose)]
const sport = [item("sport", 0, 10, prose), item("sport", 1, 11, prose)]

// axe.source is the whole library as a string — inject it once per page, then
// drive it in-page.
async function runAxe(page: Page): Promise<axe.Result[]> {
   if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.evaluate(axe.source)
   const res = (await page.evaluate(async () =>
      window.axe.run(document, { resultTypes: ["violations"] }),
   )) as axe.AxeResults
   return res.violations
}

// One readable line per violation — rule id, impact, what it means, and the
// offending node targets. A bare "expected 3 to be 0" tells a CI reader nothing.
const MAX_NODES = 6
const summarize = (v: axe.Result): string => {
   const shown = v.nodes.slice(0, MAX_NODES).map((n) => n.target.join(" "))
   const more = v.nodes.length > MAX_NODES ? ` (+${v.nodes.length - MAX_NODES} more)` : ""
   return `[${v.impact}] ${v.id}: ${v.help} → ${shown.join(" | ")}${more} — ${v.helpUrl}`
}

async function audit(page: Page, surface: string) {
   const blocking = (await runAxe(page)).filter((v) => v.impact && BLOCKING.has(v.impact) && !(v.id in DEFERRED))
   expect(
      blocking.map(summarize),
      `${surface}: axe found blocking a11y violations (impact serious/critical; ` +
         `deferred rules: ${Object.keys(DEFERRED).join(", ")})`,
   ).toEqual([])
}

const waitPicker = (p: Page) =>
   p.waitForFunction(() => {
      const el = document.querySelector(".srr-picker") as HTMLElement | null
      return !!el && !el.hidden
   })

// .srr-content fades in over 0.25s on every navigation. axe samples COMPUTED
// colors, so scanning mid-transition reads the prose at partial opacity and
// reports the whole article as ~1.2:1 contrast — a pure test artifact. Settle
// the fade before auditing the reader.
const waitContentSettled = (p: Page) =>
   p.waitForFunction(() => {
      const el = document.querySelector(".srr-content")
      return !!el && getComputedStyle(el).opacity === "1"
   })

describe("browser: a11y (axe-core)", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", news),
         "/sport.xml": rssFeed("Sport", sport),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-g", "world", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "feed", "add", "-t", "Sport", "-u", `${feeds.url}/sport.xml`)
      await srr(packsDir, "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   const open = () => openCtx(browser, baseUrl, waitList)

   it("the list surface has no serious/critical violations", async () => {
      const [page, close] = await open()
      try {
         await audit(page, "list")
      } finally {
         await close()
      }
   })

   it("the reader surface has no serious/critical violations", async () => {
      const [page, close] = await open()
      try {
         await page.evaluate(() => (document.querySelector(".srr-list a.srr-row") as HTMLElement | null)?.click())
         await waitReader(page)
         await waitContentSettled(page)
         await audit(page, "reader")
      } finally {
         await close()
      }
   })

   it("the filter-picker overlay has no serious/critical violations", async () => {
      const [page, close] = await open()
      try {
         await page.click(".srr-filter")
         await waitPicker(page)
         // Info mode swaps every row's role/handler, so audit it too — same
         // overlay, different a11y surface.
         await audit(page, "filter picker")
         await page.click(".srr-picker-info")
         await page.waitForFunction(
            () => document.querySelector(".srr-picker-info")?.getAttribute("aria-pressed") === "true",
         )
         await audit(page, "filter picker (info mode)")
      } finally {
         await close()
      }
   })

   it("the settings menu has no serious/critical violations", async () => {
      const [page, close] = await open()
      try {
         await page.click(".srr-feed")
         await page.waitForSelector(".srr-ctxmenu")
         await audit(page, "settings menu")
      } finally {
         await close()
      }
   })

   // RDR10 — the shortcuts card is a modal built entirely in JS (no index.html
   // skeleton to eyeball), so its roles/name have no other reviewer.
   it("the keyboard-shortcuts card has no serious/critical violations", async () => {
      const [page, close] = await open()
      try {
         await page.keyboard.press("?")
         await page.waitForSelector(".srr-keys-dialog.srr-open")
         await audit(page, "shortcuts card")
      } finally {
         await close()
      }
   })
})
