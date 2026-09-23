import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, wavBytes, type FeedItem } from "../fixtures"
import { clearDir, clickRow, open as openCtx, waitList, waitTitle } from "./helpers"

// The mini-player's ONE mechanism (RDR16), in a real browser with real decoded
// audio: RELOCATION, NOT RECONSTRUCTION. Stepping to another article calls
// `el.content.replaceChildren`, which would destroy a playing <audio>; player.ts
// instead MOVES the live element into the bar with a single appendChild (an
// atomic remove+insert the spec's "removed from a Document" steps let through)
// and swaps it back with replaceWith on return. Same node, same buffer, no
// re-buffer gap.
//
// Why this layer: jsdom implements neither play() nor pause() — the unit suite
// redefines `paused` as a plain property — so nothing there can distinguish a
// relocation from a handoff that rebuilds the element and restarts the load.
// Everything below therefore asserts the OUTCOME of a real navigation on a real
// media element: node IDENTITY across the move (a dataset marker set before
// navigating — the handle survives, a rebuilt element would not), `paused` still
// false, a currentTime that did not reset, and a clock still ticking after.
//
// Never an exact time value: the assertion is always "strictly greater than the
// previous sample", which is what makes it a playback test rather than a flaky
// stopwatch.
// Own beforeAll clears + rebuilds the shared packsDir (browser files run
// serially — vitest.browser.config fileParallelism:false).

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const EPISODE = "the episode"
const NEWER = "newer story"
const QUEUED = "queued episode"
const SHORT = "short episode"

// The marker that proves node identity across both moves. It is a `data-`
// attribute on the element itself, so it travels with the node and cannot be
// reproduced by any code path that builds a fresh <audio>.
const PROBE = "audio[data-probe='rdr16']"

// This suite's own browser, deliberately NOT helpers.launchBrowser: headless
// Chrome refuses play() without a user gesture, and adding the override to the
// shared launcher would hand every other suite an autoplay policy it does not
// model. The other two flags are the shared launcher's, unchanged.
const launchAudioBrowser = () =>
   puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
   })

interface Probe {
   time: number
   paused: boolean
   inContent: boolean
   inBar: boolean
   controls: boolean
   barShown: boolean
   readyState: number
   networkState: number
}

// One read of everything the mechanism is supposed to preserve. `inContent` /
// `inBar` are asked of the MARKED node, so "it is in the bar" and "it is the
// same element" are the same question.
const probe = (p: Page): Promise<Probe | null> =>
   p.evaluate((sel) => {
      const a = document.querySelector(sel) as HTMLAudioElement | null
      if (!a) return null
      return {
         time: a.currentTime,
         paused: a.paused,
         inContent: !!document.querySelector(`.srr-content ${sel}`),
         inBar: !!document.querySelector(`.srr-player-media ${sel}`),
         controls: a.hasAttribute("controls"),
         barShown: !(document.querySelector(".srr-player") as HTMLElement).hidden,
         readyState: a.readyState,
         networkState: a.networkState,
      }
   }, PROBE)

// Poll (≈300 ms grain) until the clock passes `from`, and answer with where it
// got to. A timeout here IS the failure: playback stopped.
async function waitAdvanced(p: Page, from: number, label: string): Promise<number> {
   const handle = await p.waitForFunction(
      (sel, t0) => {
         const a = document.querySelector(sel) as HTMLAudioElement | null
         return a && a.currentTime > t0 ? a.currentTime : false
      },
      { timeout: 20000, polling: 300 },
      PROBE,
      from,
   )
   const t = (await handle.jsonValue()) as number
   await handle.dispose()
   expect(t, `${label}: clock did not advance past ${from}`).toBeGreaterThan(from)
   return t
}

// Wait (briefly) for the marked node to land under `host`. Swallows the timeout
// on purpose: "it never got there" is a real outcome the caller asserts with a
// legible message, not an exception from a helper. Both legs settle first so a
// relocation that is merely LATE fails on the mechanism (did playback survive?)
// instead of on a race with the assertion.
const settleUnder = (p: Page, host: string) =>
   p
      .waitForFunction((sel) => !!document.querySelector(sel), { timeout: 3000 }, `${host} ${PROBE}`)
      .catch(() => undefined)

// Open an article and tap its episode's queue chip. Into an idle player that
// FIRST add plays it at once — the chip tap is the user gesture — so this waits
// for the in-content clock to move, with no play() call anywhere.
async function startFromChip(page: Page, title: string): Promise<void> {
   await clickRow(page, title)
   await waitTitle(page, title)
   await page.waitForFunction(() => !!document.querySelector(".srr-content .srr-queue-chip"), { timeout: 20000 })
   await page.click(".srr-content .srr-queue-chip")
   await page.waitForFunction(
      () => (document.querySelector(".srr-content audio") as HTMLAudioElement).currentTime > 0,
      { timeout: 20000, polling: 300 },
   )
}

// Turn a bare play() rejection into something actionable: what the element
// resolved its src to, and what that URL answers.
const srcDiagnosis = (p: Page, err: string): Promise<string> =>
   p.evaluate(async (e) => {
      const a = document.querySelector("audio[data-probe='rdr16']") as HTMLAudioElement | null
      if (!a) return `${e} (no <audio> in the article at all)`
      const answer = await fetch(a.src).then(
         async (r) => `${r.status} ${r.headers.get("content-type")} ${(await r.arrayBuffer()).byteLength}b`,
         (x: unknown) => String(x),
      )
      return `${e} — src=${a.src} answers ${answer}`
   }, err)

describe("browser: mini-player relocation keeps real audio playing", () => {
   let browser: Browser
   let feeds: FeedServer

   beforeAll(async () => {
      clearDir(packsDir)
      // Route table first, so the item bodies can point at the live port. The
      // audio is served BY THE FEED SERVER, at an absolute URL with a real
      // audio/wav type — which is what a podcast enclosure actually is (and
      // what `#enclosure` writes). A store-relative path is not an option here:
      // the backend resolves relative content URLs against the item's own link
      // while ingesting, long before the reader's PACK_BASE ever sees them.
      // brief.wav really is 4 seconds long: the queue test plays it to its END
      // (the server answers no Range requests, so a seek-near-the-end shortcut
      // silently clamps to the buffered edge and the episode never ends).
      feeds = await feedServer({
         "/tick.wav": { body: wavBytes(120), type: "audio/wav" },
         "/tock.wav": { body: wavBytes(120), type: "audio/wav" },
         "/brief.wav": { body: wavBytes(4), type: "audio/wav" },
      })

      const items: FeedItem[] = [
         {
            title: "older story",
            link: "http://example.com/p/0",
            guid: "p-0",
            pubDate: pubDate(0),
            content: "<p>a</p>",
         },
         {
            // #enclosure injects exactly this shape for a podcast item.
            title: EPISODE,
            link: "http://example.com/p/1",
            guid: "p-1",
            pubDate: pubDate(1),
            content: `<p>show notes</p><audio src="${feeds.url}/tick.wav" controls></audio>`,
         },
         { title: NEWER, link: "http://example.com/p/2", guid: "p-2", pubDate: pubDate(2), content: "<p>c</p>" },
         {
            title: QUEUED,
            link: "http://example.com/p/3",
            guid: "p-3",
            pubDate: pubDate(3),
            content: `<p>up next notes</p><audio src="${feeds.url}/tock.wav" controls></audio>`,
         },
         {
            title: SHORT,
            link: "http://example.com/p/4",
            guid: "p-4",
            pubDate: pubDate(4),
            content: `<p>a four-second dispatch</p><audio src="${feeds.url}/brief.wav" controls></audio>`,
         },
      ]
      feeds.set("/pod.xml", rssFeed("Pod", items))

      await srr(packsDir, "feed", "add", "-t", "Pod", "-u", `${feeds.url}/pod.xml`)
      await srr(packsDir, "fetch")
      browser = await launchAudioBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   // ONE ordered `it`: survival is a sequence — play, step away, step back — and
   // each step's assertions are only meaningful given the previous one's state
   // (swipe.e2e.test.ts sets the precedent).
   it("plays, survives a step to the next article inside the bar, and comes home still playing", async () => {
      const [page, close] = await openCtx(browser, baseUrl, waitList)
      try {
         await clickRow(page, EPISODE)
         await waitTitle(page, EPISODE)
         await page.waitForFunction(() => !!document.querySelector(".srr-content audio"), { timeout: 20000 })

         // ── play the in-content element ────────────────────────────────────
         // The marker goes on BEFORE anything moves: from here on, every
         // assertion below is about THIS node.
         const err = await page.evaluate(async () => {
            const a = document.querySelector(".srr-content audio") as HTMLAudioElement
            a.dataset.probe = "rdr16"
            // The player takes only what is queued: queue it through its chip.
            ;(a.nextElementSibling as HTMLButtonElement).click()
            try {
               await a.play()
               return ""
            } catch (e) {
               return String(e)
            }
         })
         // A refusal here is the one failure mode with no useful default
         // message ("no supported source was found" says nothing about WHY), so
         // report the URL the element actually resolved and what that URL
         // answers — the two things that distinguish a broken fixture from a
         // broken browser. It caught the first cut of this suite: the backend
         // absolutizes relative content URLs against the ITEM LINK during
         // ingest, so a store-relative src reached the reader as
         // http://example.com/… and 404'd.
         expect(err ? await srcDiagnosis(page, err) : "", "play() was refused").toBe("")

         const started = await probe(page)
         expect(started?.inContent).toBe(true)
         expect(started?.paused).toBe(false)
         // Real decoding, not a synthetic event: the element has metadata and is
         // sourcing bytes. (A `play` Event dispatched by hand would satisfy the
         // claim path and prove nothing about playback.)
         expect(started!.readyState).toBeGreaterThanOrEqual(1)
         const t0 = await waitAdvanced(page, 0, "in content")

         // ── next: the relocation ───────────────────────────────────────────
         const before = (await probe(page))!.time
         await page.keyboard.press("ArrowRight")
         await waitTitle(page, NEWER)
         await settleUnder(page, ".srr-player-media")

         const moved = await probe(page)
         // The marked node still exists — it was MOVED, not destroyed and
         // rebuilt — and it now sits in the player's host, out of the article.
         expect(moved, "the marked <audio> is gone: relocation did not happen").not.toBeNull()
         expect(moved!.inBar).toBe(true)
         expect(moved!.inContent).toBe(false)
         // The whole point of the feature.
         expect(moved!.paused, "playback stopped across the move").toBe(false)
         // Not reset to 0, and not rewound: the same buffer kept running.
         expect(moved!.time).toBeGreaterThanOrEqual(before)
         expect(moved!.time).toBeGreaterThan(0)
         expect(moved!.readyState).toBeGreaterThanOrEqual(1)
         // Custom chrome drives it in the bar, and the bar is up because its
         // article is no longer rendered.
         expect(moved!.controls).toBe(false)
         expect(moved!.barShown).toBe(true)
         // The queue is empty here, so » must not PAINT (it keeps its slot so
         // play stays centred). The `hidden` property alone cannot prove that:
         // the author `display: inline-flex` on `.srr-player-controls button`
         // beats the UA sheet's [hidden] rule, so styles.css restates it — and
         // only a computed-style read can see whether the restatement holds.
         // The Up next list says how to add instead of listing nothing.
         const chrome = await page.evaluate(() => ({
            next: getComputedStyle(document.querySelector(".srr-player-next")!).visibility,
            empty: getComputedStyle(document.querySelector(".srr-player-empty")!).display,
            count: document.querySelector(".srr-player-count")?.textContent,
         }))
         expect(chrome, "an empty queue paints playlist chrome").toEqual({ next: "hidden", empty: "block", count: "" })
         // And it is still PLAYING, not merely un-paused.
         const t1 = await waitAdvanced(page, Math.max(t0, moved!.time), "in the bar")

         // ── prev: the rehome ───────────────────────────────────────────────
         await page.keyboard.press("ArrowLeft")
         await waitTitle(page, EPISODE)
         await settleUnder(page, ".srr-content")

         const home = await probe(page)
         expect(home, "the marked <audio> did not come home").not.toBeNull()
         expect(home!.inContent).toBe(true)
         expect(home!.inBar).toBe(false)
         expect(home!.paused, "playback stopped on the way home").toBe(false)
         expect(home!.time).toBeGreaterThanOrEqual(t1)
         // fmt.ts force-sets `controls` on in-content audio; adopt dropped it for
         // the bar and rehome must put it back, or the article renders a player
         // with no way to touch it.
         expect(home!.controls).toBe(true)
         await waitAdvanced(page, home!.time, "back in content")
      } finally {
         await close()
      }
   })

   // The playlist's one mechanism jsdom cannot prove: a REAL `ended` event
   // driving a play() with no user gesture anywhere near it — the auto-advance.
   // The unit suite dispatches synthetic ended/play; only a real browser can
   // show the engine actually starts the next episode's clock.
   it("queues another article's episode via its chip and auto-advances into it on ended", async () => {
      const [page, close] = await openCtx(browser, baseUrl, waitList)
      try {
         // ── the FIRST add plays: SHORT's chip starts it, no play() call ────
         await startFromChip(page, SHORT)
         // Paused so the queue can be built before its four seconds run out.
         await page.evaluate(() => (document.querySelector(".srr-content audio") as HTMLAudioElement).pause())

         // ── queue the OTHER article's episode behind it ────────────────────
         await page.keyboard.press("Escape")
         await waitList(page)
         await clickRow(page, QUEUED)
         await waitTitle(page, QUEUED)
         await page.waitForFunction(() => !!document.querySelector(".srr-content .srr-queue-chip"), { timeout: 20000 })
         await page.click(".srr-content .srr-queue-chip")
         // Only queued (something is claimed): SHORT held in the bar, counting 1.
         const queued = await page.evaluate(() => ({
            barShown: !(document.querySelector(".srr-player") as HTMLElement).hidden,
            count: document.querySelector(".srr-player-count")?.textContent,
            pressed: document.querySelector(".srr-content .srr-queue-chip")?.getAttribute("aria-pressed"),
            contentPaused: (document.querySelector(".srr-content audio") as HTMLAudioElement).paused,
         }))
         expect(queued.barShown).toBe(true)
         expect(queued.count).toBe("1")
         expect(queued.pressed).toBe("true")
         expect(queued.contentPaused).toBe(true)

         // ── back to SHORT and let it genuinely END ─────────────────────────
         // No seek shortcut: the feed server answers no Range requests, so a
         // near-the-end seek clamps to the buffered edge and never ends. Four
         // real seconds of playback is what makes the `ended` the browser's own.
         await page.keyboard.press("Escape")
         await waitList(page)
         await clickRow(page, SHORT)
         await waitTitle(page, SHORT)
         await page.waitForFunction(() => !!document.querySelector(".srr-content audio"), { timeout: 20000 })
         const err = await page.evaluate(async () => {
            const a = document.querySelector(".srr-content audio") as HTMLAudioElement
            try {
               await a.play()
               return ""
            } catch (e) {
               return String(e)
            }
         })
         expect(err, "play() was refused").toBe("")

         // ── the advance: the queued episode starts in the bar, unaided ─────
         const handle = await page
            .waitForFunction(
               () => {
                  const a = document.querySelector(".srr-player-media audio") as HTMLAudioElement | null
                  return a && !a.paused && a.src.includes("tock.wav") && a.currentTime > 0 ? a.currentTime : false
               },
               { timeout: 20000, polling: 300 },
            )
            .catch(async (e: unknown) => {
               // The advance never came: report each link of the chain — did the
               // first episode actually END, and what does the bar hold?
               const diag = await page.evaluate(() => {
                  const c = document.querySelector(".srr-content audio") as HTMLAudioElement | null
                  const b = document.querySelector(".srr-player-media audio") as HTMLAudioElement | null
                  const fmt = (a: HTMLAudioElement | null) =>
                     a
                        ? `t=${a.currentTime.toFixed(1)}/${a.duration.toFixed(1)} paused=${a.paused} ended=${a.ended} net=${a.networkState} err=${a.error?.code ?? "-"} src=${a.src.split("/").pop()}`
                        : "none"
                  return `content[${fmt(c)}] bar[${fmt(b)}] count=${document.querySelector(".srr-player-count")?.textContent}`
               })
               throw new Error(`${String(e)} — ${diag}`)
            })
         const t0 = (await handle.jsonValue()) as number
         await handle.dispose()
         const after = await page.evaluate(() => ({
            name: document.querySelector(".srr-player-name")?.textContent,
            barShown: !(document.querySelector(".srr-player") as HTMLElement).hidden,
            count: document.querySelector(".srr-player-count")?.textContent,
         }))
         expect(after.name).toBe(QUEUED)
         expect(after.barShown).toBe(true)
         expect(after.count).toBe("") // drained
         // Still ADVANCING, not merely unpaused — the clock keeps moving.
         await page.waitForFunction(
            (t) => (document.querySelector(".srr-player-media audio") as HTMLAudioElement).currentTime > t,
            { timeout: 20000, polling: 300 },
            t0,
         )
      } finally {
         await close()
      }
   })

   // Pure layout — jsdom has none, hence this layer. The FULL player (the
   // unfolded state) at desktop and phone widths: the transport holds one row
   // around the play button, the scrubber spans the sheet (✕ floats in the
   // corner instead of taking a column), both clocks show, the Up next list is
   // listed without any tap, and the whole sheet stays on screen.
   it("lays the full player out at desktop and phone widths, queue listed", async () => {
      const [page, close] = await openCtx(browser, baseUrl, waitList)
      try {
         // An episode claimed (SHORT, adopted into the player) with another
         // queued behind it — the fullest the sheet gets.
         await startFromChip(page, SHORT)
         await page.evaluate(() => (document.querySelector(".srr-content audio") as HTMLAudioElement).pause())
         await page.keyboard.press("Escape")
         await waitList(page)
         await clickRow(page, QUEUED)
         await waitTitle(page, QUEUED)
         await page.waitForFunction(() => !!document.querySelector(".srr-content .srr-queue-chip"), {
            timeout: 20000,
         })
         await page.click(".srr-content .srr-queue-chip")
         // Folded by default: only the corner button paints.
         const folded = await page.evaluate(() => ({
            sheet: getComputedStyle(document.querySelector(".srr-player")!).visibility,
            fab: getComputedStyle(document.querySelector(".srr-player-fab")!).visibility,
         }))
         expect(folded).toEqual({ sheet: "hidden", fab: "visible" })
         await page.click(".srr-player-fab")

         const layout = () =>
            page.evaluate(() => {
               const bar = document.querySelector(".srr-player") as HTMLElement
               const keys = [...bar.querySelectorAll<HTMLElement>(".srr-player-controls button")]
               const seek = bar.querySelector(".srr-player-seek") as HTMLElement
               const body = bar.querySelector(".srr-player-body") as HTMLElement
               const shown = (sel: string) => getComputedStyle(bar.querySelector(sel)!).display !== "none"
               return {
                  visible: getComputedStyle(bar).visibility,
                  // Vertical CENTRES (play is taller than its neighbours, so
                  // tops differ by design), from offsetTop rather than a rect:
                  // the count PULSES when the queue grows (a scale keyframe),
                  // and a rect read mid-pop sits a pixel off.
                  keyRows: new Set(keys.map((b) => Math.round(b.offsetTop + b.offsetHeight / 2))).size,
                  seekFull: seek.offsetWidth >= body.offsetWidth - 1,
                  time: shown(".srr-player-time"),
                  duration: shown(".srr-player-duration"),
                  rows: bar.querySelectorAll(".srr-player-list .srr-player-row").length,
                  count: bar.querySelector(".srr-player-count")?.textContent,
                  top: bar.getBoundingClientRect().top,
               }
            })
         // Fill the clocks (a paused-early episode may not know its length yet).
         await page.evaluate(() => {
            ;(document.querySelector(".srr-player-time") as HTMLElement).textContent = "1:00"
            ;(document.querySelector(".srr-player-duration") as HTMLElement).textContent = "2:00"
         })

         for (const vp of [null, { width: 390, height: 844 }]) {
            if (vp) await page.setViewport(vp)
            const l = await layout()
            const at = vp ? "phone" : "desktop"
            expect(l.visible, `unfolded at ${at}`).toBe("visible")
            expect(l.keyRows, `transport wrapped at ${at}`).toBe(1)
            expect(l.seekFull, `scrubber short of the sheet at ${at}`).toBe(true)
            expect(l.time && l.duration, `a clock hidden at ${at}`).toBe(true)
            expect(l.rows, `Up next not listed at ${at}`).toBe(1)
            expect(l.count).toBe("1")
            expect(l.top, `sheet ran off the top at ${at}`).toBeGreaterThanOrEqual(0)
         }

         // A video gets a real frame the sheet's width; audio none. Width, not
         // display, decides it: the element must stay rendered for playback to
         // survive, the base .srr-player-media rule's argument.
         const frame = await page.evaluate(() => {
            const bar = document.querySelector(".srr-player") as HTMLElement
            const host = bar.querySelector(".srr-player-media") as HTMLElement
            const audio = host.offsetWidth
            bar.dataset.kind = "video"
            return {
               audio,
               video: host.offsetWidth,
               sheet: (bar.querySelector(".srr-player-body") as HTMLElement).offsetWidth,
            }
         })
         expect(frame.audio, "an audio episode reserves no frame").toBe(0)
         expect(frame.video, "a video episode gets the full-width frame").toBe(frame.sheet)
      } finally {
         await close()
      }
   })
})
