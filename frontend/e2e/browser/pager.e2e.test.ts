import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, waitList, waitReader, waitTitle } from "./helpers"

// Reader swipe pager (spec 2026-07-27-reader-pager-carousel-design.md) driven
// with REAL Chrome touch input. The unit layers prove the geometry
// (gestures.test.ts) and the preview page (pager.test.ts) in isolation; what only
// this layer can vouch for is the REGISTRATION (pager.setup → gestures.setPager →
// app.pagerCommit → the nav guard) and real coalesced touch streams — the same
// argument as swipe.e2e.test.ts, which caught a silently shadowed import that
// only the running callback exposed.
//
// The second `it` is the guard on the constraint the carousel RENEGOTIATED. The
// masthead-only pane it replaced previewed no content precisely because
// reader.ts's media harvest/restore and player.ts's adoptFromContent/rehomeInto
// pair playback state to elements BY INDEX over querySelectorAll("audio,video"),
// and player.ts claims playback from ONE capture-phase `play` listener on the
// document — so a duplicate <audio>/<video> in a second surface corrupts the
// mini-player. The carousel previews real content and leans entirely on
// article-view.ts's makeMediaInert to hold that line. jsdom implements neither
// play() nor pause() (the unit suite redefines `paused` as a plain property), so
// no other layer can tell an inert stub from a live duplicate, nor a rehomed node
// from a rebuilt one. That is why this case exists here and only here.
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

// The podcast-carrying article and its NEWER neighbour (nItems publishes
// ascending, so item i+1 is newer than item i). The media guard opens the
// podcast, steps to the neighbour — which adopts the live element into the bar —
// and then drags BACK toward the article that owns it: the exact case that would
// build a ghost duplicate of a node currently living in .srr-player-media.
const PODCAST = "pager title 1"
const NEIGHBOR = "pager title 2"

// A real, decodable RIFF/WAVE file: 8 kHz mono 8-bit PCM, a quiet 220 Hz tone,
// long enough (2 min) that no amount of CI slowness lets it END mid-test (which
// would release the player's claim for legitimate reasons and read as a failure
// of the thing under test). Byte-for-byte player.e2e.test.ts's synthesiser —
// duplicated rather than imported because a test file is not a module other
// suites should reach into, and `e2e/fixtures.ts` (its natural shared home) is
// outside this change's blast radius. Hoisting it there is the follow-up.
function wavBytes(seconds: number, rate = 8000): Buffer {
   const samples = seconds * rate
   const buf = Buffer.alloc(44 + samples)
   buf.write("RIFF", 0)
   buf.writeUInt32LE(36 + samples, 4)
   buf.write("WAVE", 8)
   buf.write("fmt ", 12)
   buf.writeUInt32LE(16, 16) // fmt chunk size
   buf.writeUInt16LE(1, 20) // PCM
   buf.writeUInt16LE(1, 22) // mono
   buf.writeUInt32LE(rate, 24) // sample rate
   buf.writeUInt32LE(rate, 28) // byte rate (mono, 8-bit ⇒ = sample rate)
   buf.writeUInt16LE(1, 32) // block align
   buf.writeUInt16LE(8, 34) // bits per sample
   buf.write("data", 36)
   buf.writeUInt32LE(samples, 40)
   for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 220 * i) / rate))
   return buf
}

// This suite launches its OWN Chromium rather than helpers.launchBrowser:
// headless Chrome refuses play() without a user gesture, and the media guard has
// to start real playback. The flag rides beside the shared launcher's two
// (player.e2e.test.ts's recipe and its argument) instead of going INTO the shared
// launcher, which would hand every other suite an autoplay policy it does not
// model. It cannot disturb the gesture cases above it either: it only permits a
// play() something asked for, and nothing in this fixture carries `autoplay`.
const launchAudioBrowser = () =>
   puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
   })

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
   // The neighbour preview PAGE is on screen — "page" mode only. Asked as the
   // compound `.srr-pager-page.srr-pager-show` on purpose: engage() builds the
   // box before the first move paints it, so the bare class would answer true for
   // a page that was never actually revealed.
   page: boolean
}

// The press-and-drag half of a gesture: origin resolution, the stepped moves,
// and NO lift. `dragReader` lifts straight away and reports the peek; the media
// guard holds the finger down so it can inspect the preview while it is on
// screen, which is the whole point of splitting this out.
//
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
async function holdDrag(p: Page, dx: number, opts: { from?: string; slow?: boolean } = {}): Promise<TouchHandle> {
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
   return touch
}

// Puppeteer's own handle type, derived rather than imported so this stays pinned
// to whatever `touchStart` actually returns in the installed version.
type TouchHandle = Awaited<ReturnType<Page["touchscreen"]["touchStart"]>>

// What the drag looks like at full extension — read after the last move and
// BEFORE the lift.
const peekDrag = (p: Page): Promise<DragPeek> =>
   p.evaluate(() => {
      const t = (document.querySelector(".srr-reader") as HTMLElement).style.transform
      return {
         tx: Number(/translateX\((-?[\d.]+)px\)/.exec(t)?.[1] ?? 0),
         page: !!document.querySelector(".srr-pager-page.srr-pager-show"),
      }
   })

// Press, drag, peek, lift — the whole gesture, for the cases that only care about
// what it left behind.
async function dragReader(p: Page, dx: number, opts: { from?: string; slow?: boolean } = {}): Promise<DragPeek> {
   const touch = await holdDrag(p, dx, opts)
   const peek = await peekDrag(p)
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

// A fresh incognito context on a TOUCH viewport, parked on the list. Not
// helpers.open(): the viewport has to carry `hasTouch` before the load, or
// nothing here can dispatch a touch at all.
async function openTouchPage(browser: Browser): Promise<[Page, () => Promise<void>]> {
   const ctx = await browser.createBrowserContext()
   const p = await ctx.newPage()
   await p.setViewport({ width: 500, height: 900, hasTouch: true })
   await p.goto(`${baseUrl}#`, { waitUntil: "load" })
   await waitList(p)
   return [p, () => ctx.close()]
}

// Open a list row BY TITLE (rows are newest-first, so an index would encode the
// fixture's ordering into every call site).
const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

describe("browser: reader swipe pager", () => {
   let browser: Browser
   let feeds: FeedServer

   beforeAll(async () => {
      // Route table first, so the podcast item's body can point at the live port
      // (player.e2e.test.ts's ordering, and for its reason: the backend resolves
      // relative content URLs against the ITEM LINK during ingest, so a
      // store-relative src would reach the reader as http://example.com/… and
      // 404). Every article carries a wide <pre> (`overflow-x: auto` in
      // styles.css, so it really scrolls) after its prose, so the scrollable-veto
      // stop can start its drag inside one without caring which chron it landed
      // on; ONE of them additionally carries a podcast-shaped <audio controls>,
      // the shape #enclosure injects.
      feeds = await feedServer({ "/tick.wav": { body: wavBytes(120), type: "audio/wav" } })
      const items = nItems(4, "pager").map((it) => ({
         ...it,
         content:
            it.content +
            (it.title === PODCAST ? `<audio src="${feeds.url}/tick.wav" controls></audio>` : "") +
            `<pre>${"wide-content ".repeat(300)}</pre>`,
      }))
      feeds.set("/pager.xml", rssFeed("Pager", items))
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "Pager", "-u", `${feeds.url}/pager.xml`)
      await srr(packsDir, "fetch")
      browser = await launchAudioBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // One ordered flow (the swipe.e2e precedent): commit, snap-back, dead edge
   // and the scrollable veto are stops on one journey through the same reader.
   it("a committed drag pages, a short one snaps back, a dead edge resists, a wide <pre> scrolls", async () => {
      const [p, close] = await openTouchPage(browser)
      try {
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

         // The commit bar is a FIFTH of the SURFACE's own width (gestures.ts
         // PAGE_COMMIT_FRACTION, 0.20 since the carousel retuned it from 0.25 —
         // a quarter of a 390px phone is a long pull for a thumb pivoting from
         // the edge), and gestures reads `pagerSurface.clientWidth`, NOT the
         // viewport: at this 500px viewport the reader <article> measures 476, so
         // the bar is ~95px rather than the 100px a viewport-based reading would
         // give. Pin that both drags below straddle it with room, so a layout or
         // fraction change that moved it under 80 or over 300 fails here instead
         // of quietly voiding a stop.
         const commitPx = await p.evaluate(
            () => (document.querySelector(".srr-reader") as HTMLElement).clientWidth * 0.2,
         )
         expect(commitPx).toBeGreaterThan(88) // 80px must stay short of it
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
         expect(dead.page).toBe(false) // nothing to preview at a dead edge
         await new Promise((r) => setTimeout(r, 400)) // let any wrong commit land
         expect(await $hash(p)).toBe(startHash)
         expect(await $title(p)).toBe(startTitle)

         // ── committed rightward (prev) drag: 300px, well past the ~119px bar ──
         const paged = await dragReader(p, 300)
         expect(paged.tx).toBeGreaterThan(240) // tracks the finger 1:1, undamped
         expect(paged.page).toBe(true) // the neighbor preview page slid in
         await p.waitForFunction((h) => location.hash !== h, { timeout: 20_000 }, startHash)
         await waitSettled(p)
         // …and it is REMOVED on settle, not merely un-shown (pager.ts
         // teardownPage, called from every exit path). A leaked page is an opaque
         // full-viewport element sitting over the reader — the highest-severity
         // failure this design can have — so "gone from the DOM" is the assertion,
         // not "hidden".
         expect(await p.$(".srr-pager-page")).toBeNull()
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
         expect(vetoed.page).toBe(false)
         await new Promise((r) => setTimeout(r, 400))
         expect(await $hash(p)).toBe(prevHash)
      } finally {
         await close()
      }
   })

   // The FEB2 regression guard (spec §7) — see the file header for why it can
   // only live at this layer. One ordered flow, like the case above and like
   // player.e2e.test.ts: "a playing element survived" is a sequence (play → step
   // away → drag back → commit), and each stop's assertions are only meaningful
   // given the previous one's state.
   it("previews a playing episode's article with inert stubs and rehomes the live node on commit", async () => {
      const [p, close] = await openTouchPage(browser)
      try {
         await clickRow(p, PODCAST)
         await waitTitle(p, PODCAST)
         await p.waitForFunction(() => !!document.querySelector(".srr-content audio"), { timeout: 20_000 })

         // ── play the in-content element ────────────────────────────────────
         // The marker goes on BEFORE anything moves, and it is an expando JS
         // PROPERTY rather than a data- attribute: attributes survive a
         // cloneNode, so a "restore" that copied the element would still carry
         // one and pass. A property is carried by the node and by nothing else,
         // which is exactly the claim under test — the same node kept playing.
         const err = await p.evaluate(async () => {
            const a = document.querySelector(".srr-content audio") as HTMLAudioElement
            ;(a as unknown as Record<string, unknown>).__srrLive = true
            try {
               await a.play()
               return ""
            } catch (e) {
               return String(e)
            }
         })
         expect(err, "play() was refused").toBe("")
         // Real decoding, not a synthetic event: a `play` Event dispatched by
         // hand would satisfy player.ts's claim path and prove nothing.
         await p.waitForFunction(
            () => {
               const a = document.querySelector("audio") as HTMLAudioElement | null
               return !!a && !a.paused && a.currentTime > 0
            },
            { timeout: 20_000, polling: 300 },
         )

         // ── step to the newer neighbour: the element is adopted into the bar ─
         await p.keyboard.press("ArrowRight")
         await waitTitle(p, NEIGHBOR)
         await p.waitForFunction(() => !!document.querySelector(".srr-player-media audio"), { timeout: 20_000 })
         const before = await p.evaluate(() => (document.querySelector("audio") as HTMLAudioElement).currentTime)

         // ── hold a rightward (prev) drag back toward the owning article ─────
         // Held, not lifted: the preview is only inspectable while the finger is
         // down. Waiting for `srr-pager-filled` is what makes the assertion
         // non-vacuous — the class is pager.ts's "the real content landed", and
         // without it a slow loadArticle would leave the skeleton on screen and
         // "no <audio> in the preview" would be trivially true.
         const touch = await holdDrag(p, 300)
         await p.waitForFunction(() => !!document.querySelector(".srr-pager-page.srr-pager-filled"), {
            timeout: 20_000,
         })
         const mid = await p.evaluate(() => {
            const a = document.querySelector("audio") as HTMLAudioElement | null
            return {
               audios: document.querySelectorAll("audio").length,
               inPreview: document.querySelectorAll(".srr-pager-page audio, .srr-pager-page video").length,
               inBar: !!document.querySelector(".srr-player-media audio"),
               stubs: document.querySelectorAll(".srr-pager-page .srr-media-stub").length,
               live: !!(a as unknown as Record<string, unknown> | null)?.__srrLive,
               paused: a ? a.paused : true,
            }
         })
         // THE assertion this whole case exists for: one <audio> in the document,
         // and it is the live one in the bar. Two would mean the preview built a
         // duplicate — shifting player.ts's index pairing and putting a second
         // claimant under its document-level `play` listener.
         expect(mid.audios, "a duplicate <audio> appeared in the preview").toBe(1)
         expect(mid.inPreview).toBe(0)
         expect(mid.inBar).toBe(true)
         expect(mid.live).toBe(true)
         expect(mid.paused, "playback stopped mid-drag").toBe(false)
         // The article carries exactly one <audio>, so the preview must show
         // exactly one stub: the media is REPLACED in place, not dropped (a
         // dropped element would reflow the body at the moment of the handoff).
         expect(mid.stubs).toBe(1)

         // ── commit: the live node is REHOMED, not rebuilt ───────────────────
         await touch.end()
         await waitTitle(p, PODCAST)
         await p.waitForFunction(() => !document.querySelector(".srr-pager-page"), { timeout: 20_000 })
         const after = await p.evaluate(() => {
            const a = document.querySelector(".srr-content audio") as HTMLAudioElement | null
            return {
               audios: document.querySelectorAll("audio").length,
               inContent: !!a,
               live: !!(a as unknown as Record<string, unknown> | null)?.__srrLive,
               paused: a ? a.paused : true,
               t: a ? a.currentTime : 0,
            }
         })
         expect(after.audios).toBe(1)
         expect(after.inContent).toBe(true)
         expect(after.live, "the <audio> was rebuilt, not rehomed").toBe(true)
         expect(after.paused, "playback stopped across the page turn").toBe(false)
         // Not rewound: the same buffer kept running through the whole turn.
         expect(after.t).toBeGreaterThanOrEqual(before)
         // And still PLAYING, not merely un-paused — never an exact time value,
         // which would be a flaky stopwatch rather than a playback test.
         await p.waitForFunction(
            (t0) => (document.querySelector(".srr-content audio") as HTMLAudioElement).currentTime > t0,
            { timeout: 20_000, polling: 300 },
            after.t,
         )
      } finally {
         await close()
      }
   })
})
