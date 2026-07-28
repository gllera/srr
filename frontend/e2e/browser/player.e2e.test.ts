import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed, type FeedItem } from "../fixtures"
import { clearDir, open as openCtx, waitList, waitTitle } from "./helpers"

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

// A real, decodable RIFF/WAVE file: 8 kHz mono 8-bit PCM, a quiet 220 Hz tone.
// Synthesised rather than committed — a binary fixture in the repo would be
// bytes nobody can review. Long enough (2 min) that no amount of CI slowness
// lets the episode END mid-test, which would release the claim for real reasons.
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

const clickRow = (p: Page, title: string) =>
   p.evaluate((t) => {
      const row = [...document.querySelectorAll(".srr-list a.srr-row")].find(
         (e) => e.querySelector(".srr-row-title")?.textContent === t,
      )
      ;(row as HTMLElement | undefined)?.click()
   }, title)

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
         // The queue is empty here, so the playlist chrome must not PAINT. The
         // `hidden` property alone cannot prove that: the author-origin
         // `display: inline-flex` on `.srr-player-controls button` beats the UA
         // sheet's [hidden]{display:none} (the same cascade trap .srr-player
         // itself documents), so styles.css restates it per button — and only a
         // computed-style read can see whether the restatement holds.
         const chrome = await page.evaluate(() => ({
            next: getComputedStyle(document.querySelector(".srr-player-next")!).display,
            queue: getComputedStyle(document.querySelector(".srr-player-queue")!).display,
         }))
         expect(chrome, "an empty-queue bar paints playlist chrome").toEqual({ next: "none", queue: "none" })
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
         // ── queue the OTHER article's episode from its chip ────────────────
         await clickRow(page, QUEUED)
         await waitTitle(page, QUEUED)
         await page.waitForFunction(() => !!document.querySelector(".srr-content .srr-queue-chip"), { timeout: 20000 })
         await page.click(".srr-content .srr-queue-chip")
         // The READY bar: visible, counting 1, nothing claimed, nothing playing.
         const ready = await page.evaluate(() => ({
            barShown: !(document.querySelector(".srr-player") as HTMLElement).hidden,
            count: document.querySelector(".srr-player-queue")?.textContent,
            pressed: document.querySelector(".srr-queue-chip")?.getAttribute("aria-pressed"),
            held: !!document.querySelector(".srr-player-media audio"),
         }))
         expect(ready.barShown).toBe(true)
         expect(ready.count).toBe("≡ 1")
         expect(ready.pressed).toBe("true")
         expect(ready.held).toBe(false)

         // ── play the SHORT episode and let it genuinely END ────────────────
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
         await page.waitForFunction(
            () => (document.querySelector(".srr-content audio") as HTMLAudioElement).currentTime > 0,
            { timeout: 20000, polling: 300 },
         )

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
                  return `content[${fmt(c)}] bar[${fmt(b)}] count=${document.querySelector(".srr-player-queue")?.textContent}`
               })
               throw new Error(`${String(e)} — ${diag}`)
            })
         const t0 = (await handle.jsonValue()) as number
         await handle.dispose()
         const after = await page.evaluate(() => ({
            name: document.querySelector(".srr-player-name")?.textContent,
            barShown: !(document.querySelector(".srr-player") as HTMLElement).hidden,
            queueHidden: (document.querySelector(".srr-player-queue") as HTMLElement).hidden,
         }))
         expect(after.name).toBe(QUEUED)
         expect(after.barShown).toBe(true)
         expect(after.queueHidden).toBe(true) // drained
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

   // Pure layout, no audio — jsdom has none, hence this layer. The transport
   // must hold ONE row of keys at both widths: every fixed-bottom lane in
   // styles.css (.srr-snackbar, .srr-pin-progress, the container's 7.5rem
   // clearance) is stated against a ~4rem bar, so a wrapped transport doesn't
   // just look broken, it breaks that arithmetic. The READY bar (chip-queued
   // entry, nothing playing) shows the fullest chrome the bar ever carries.
   it("keeps the transport keys on one row at phone width with the queue chrome up", async () => {
      const [page, close] = await openCtx(browser, baseUrl, waitList)
      try {
         await clickRow(page, QUEUED)
         await waitTitle(page, QUEUED)
         await page.waitForFunction(() => !!document.querySelector(".srr-content .srr-queue-chip"), {
            timeout: 20000,
         })
         await page.click(".srr-content .srr-queue-chip")

         const layout = () =>
            page.evaluate(() => {
               const bar = document.querySelector(".srr-player") as HTMLElement
               const keys = [...bar.querySelectorAll<HTMLElement>(".srr-player-controls button")].filter(
                  (b) => getComputedStyle(b).display !== "none",
               )
               return {
                  barShown: !bar.hidden,
                  barHeight: bar.offsetHeight,
                  rows: new Set(keys.map((b) => Math.round(b.getBoundingClientRect().top))).size,
                  next: getComputedStyle(bar.querySelector(".srr-player-next")!).display !== "none",
                  queue: getComputedStyle(bar.querySelector(".srr-player-queue")!).display !== "none",
               }
            })

         // Desktop (the launcher's 800×600 default): the full seven keys on one
         // line, playlist chrome included.
         const wide = await layout()
         expect(wide.barShown).toBe(true)
         expect(wide.next).toBe(true)
         expect(wide.queue).toBe(true)
         expect(wide.rows, "desktop transport wrapped").toBe(1)

         // Phone: the ≤500px layout trades » away (the panel's per-row play
         // buttons, auto-advance and Media Session all cover "next") for a
         // track the six remaining keys genuinely fit on one line.
         await page.setViewport({ width: 390, height: 844 })
         const narrow = await layout()
         expect(narrow.queue, "the queue chip must survive the phone layout").toBe(true)
         expect(narrow.next, "» is traded away on the phone").toBe(false)
         expect(narrow.rows, "phone transport wrapped onto a second row").toBe(1)
         // ~4rem plus the hairline; anything near 90px is the wrapped bar.
         expect(narrow.barHeight, "the bar outgrew the ~4rem the lane offsets assume").toBeLessThanOrEqual(72)
      } finally {
         await close()
      }
   })
})
