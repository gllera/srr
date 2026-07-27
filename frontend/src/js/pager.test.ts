import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// pager.ts owns the DOM half of the reader pager: the lazily built preview PAGE
// (a real .srr-reader subtree in a fixed clip box), the drag transforms on the
// reader <article>, and the commit call. The geometry (axis lock, thresholds) is
// gestures.ts's and is tested there — here the registered spec is driven
// directly. What the preview RENDERS into those nodes is article-view.ts's and
// is tested there; this suite owns the surface's lifecycle.

const mocks = vi.hoisted(() => ({
   setPager: vi.fn(),
   currentChron: vi.fn(() => 2),
   neighborOlder: vi.fn(async () => 1),
   neighborNewer: vi.fn(async () => 3),
   loadMeta: vi.fn(async () => ({ f: 4, w: 1_700_000_000, t: "Neighbor title" })),
   loadArticle: vi.fn(async () => ({ f: 4, a: 1_700_000_000, t: "Neighbor title", c: "<p>body</p>" })),
   feedTitle: vi.fn(() => "Feed A"),
   db: { feeds: {} as Record<number, unknown> },
   activeStore: vi.fn(() => ({ base: new URL("https://cdn.example/") })),
}))
vi.mock("./gestures", () => ({ setPager: mocks.setPager }))
vi.mock("./nav", () => ({
   currentChron: mocks.currentChron,
   neighborOlder: mocks.neighborOlder,
   neighborNewer: mocks.neighborNewer,
}))
// article-view.ts imports ./data too, so this one mock serves both modules.
vi.mock("./data", () => ({
   loadMeta: mocks.loadMeta,
   loadArticle: mocks.loadArticle,
   feedTitle: mocks.feedTitle,
   db: mocks.db,
   activeStore: mocks.activeStore,
}))

import type { Pager } from "./gestures"

let pager: typeof import("./pager")
let spec: Pager
let commit: ReturnType<typeof vi.fn>
let abandon: ReturnType<typeof vi.fn>
// The REAL reader — a direct child of body. The preview page carries a second
// .srr-reader (that is the point of the design), so this must not be a bare
// document-wide query.
const article = () => document.querySelector("body > .srr-reader") as HTMLElement
const page = () => document.querySelector(".srr-pager-page") as HTMLElement | null
const nextBtn = () => document.querySelector(".srr-next") as HTMLButtonElement
const flush = () => new Promise((r) => setTimeout(r))
// Long enough to outlast ANY settle. The settle is velocity-carried now — 120ms
// at the flick floor up to 260ms at the considered-release ceiling — and its
// teardown timer sits SETTLE_CLOSE_PAD_MS (50ms) past that, so the worst case is
// 310ms and this clears it with room. Cases that want to pin an exact duration
// do it on the transition string; this is only ever "wait for it to be over".
const PAST_SETTLE_MS = 400
// The settle is closed by a timer a hair past the transition, not transitionend
// (jsdom never fires it) — so waiting for the surface to go means waiting that out.
const settle = () => new Promise((r) => setTimeout(r, PAST_SETTLE_MS))
// Drain the microtask queue WITHOUT letting a macrotask run. `flush`/`settle`
// both yield to the timer queue, which is exactly what an atomicity assertion
// must not do: work deferred by a setTimeout(…, 0) would have happened by then
// and the test would pass on code that blinks.
const microtasks = async () => {
   for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(async () => {
   vi.useRealTimers()
   vi.clearAllMocks()
   vi.resetModules()
   // els.ts resolves refs at module load — seed the skeleton first (the
   // dropdown.test.ts precedent).
   document.body.innerHTML =
      `<article class="srr-reader"></article>` + `<button class="srr-prev"></button><button class="srr-next"></button>`
   commit = vi.fn(async () => true)
   abandon = vi.fn()
   pager = await import("./pager")
   pager.setup({ commit, abandon })
   spec = mocks.setPager.mock.calls.at(-1)![1] as Pager
})

// The reduced-motion case patches window.matchMedia. Restore it after EVERY
// test rather than relying on that case being last: a leaked patch would run
// every later case under "reduced motion always on" — settling instantly, so
// the settle-timer cases below would pass for the wrong reason with no clue why.
// jsdom defines matchMedia on the prototype, so there is usually no own
// descriptor to put back and deleting the patch is what restores it.
const realMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia")
afterEach(() => {
   if (realMatchMedia) Object.defineProperty(window, "matchMedia", realMatchMedia)
   else Reflect.deleteProperty(window, "matchMedia")
})

describe("engage", () => {
   it("registers on the reader surface", () => {
      expect(mocks.setPager.mock.calls.at(-1)![0]).toBe(article())
   })

   it("pages toward a live neighbor, resists toward a dead one", () => {
      expect(spec.engage("next")).toBe("page")
      nextBtn().disabled = true
      expect(spec.engage("next")).toBe("resist")
   })
})

describe("page mode visuals", () => {
   it("tracks the article and slides the page in from the correct edge", () => {
      spec.engage("next")
      spec.move(-80)
      expect(article().style.transform).toBe("translateX(-80px)")
      expect(page()!.classList.contains("srr-pager-show")).toBe(true)
      expect(page()!.style.transform).toBe("translateX(calc(100% + -80px))")
   })

   it("clamps travel against the engaged direction to zero", () => {
      spec.engage("next")
      spec.move(60) // wrong-direction travel
      expect(article().style.transform).toBe("translateX(0px)")
   })

   it("fills the page from the neighbor's meta card, then its article", async () => {
      spec.engage("next")
      await flush()
      expect(mocks.neighborNewer).toHaveBeenCalledWith(2)
      expect(mocks.loadMeta).toHaveBeenCalledWith(3)
      expect(mocks.loadArticle).toHaveBeenCalledWith(3)
      expect(page()!.querySelector(".srr-title")!.textContent).toBe("Neighbor title")
      expect(page()!.querySelector(".srr-source")!.textContent).toBe("Feed A")
      expect((page()!.querySelector(".srr-reader") as HTMLElement).dataset.src).toBeDefined()
   })

   it("a cancelled drag orphans its in-flight fill (freshness token)", async () => {
      let release!: (v: { f: number; w: number; t: string }) => void
      mocks.loadMeta.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      spec.cancel()
      release({ f: 1, w: 1, t: "stale" })
      await flush()
      expect(document.querySelector(".srr-title")?.textContent ?? "").toBe("")
   })
})

describe("preview page surface", () => {
   it("builds a real .srr-reader subtree inside the clip box", async () => {
      spec.engage("next")
      await flush()
      const box = page()
      expect(box).not.toBeNull()
      expect(box!.querySelector(".srr-reader")).not.toBeNull()
      expect(box!.querySelector(".srr-content")).not.toBeNull()
      expect(box!.querySelector(".srr-title")).not.toBeNull()
   })

   it("is aria-hidden — it previews, the committed article announces itself", async () => {
      spec.engage("next")
      await flush()
      expect(page()!.getAttribute("aria-hidden")).toBe("true")
   })

   it("tears the surface down on a snap-back", async () => {
      spec.engage("next")
      await flush()
      spec.end(10, false, 0.1)
      await settle()
      expect(page()).toBeNull()
   })

   it("tears the surface down on a cancel", async () => {
      spec.engage("next")
      await flush()
      spec.cancel()
      await settle()
      expect(page()).toBeNull()
   })

   it("tears the surface down when the pager is re-registered", async () => {
      spec.engage("next")
      await flush()
      pager.setup({ commit, abandon })
      expect(page()).toBeNull()
   })
})

describe("resist mode", () => {
   it("damps and caps the drag and never builds a page", () => {
      nextBtn().disabled = true
      spec.engage("next")
      spec.move(-400)
      expect(article().style.transform).toBe("translateX(-64px)") // 400×0.3 capped at 64
      expect(page()).toBeNull()
   })
})

// gestures.ts re-invokes engage() MID-DRAG when the finger crosses back through
// the origin — no intervening end/cancel — so engage is re-entrant within one
// gesture and everything the previous side left on the surface is stale. The
// dead-edge reversal is the case that bites: resist mode's move() returns before
// it touches the box, so nothing else on that path would ever take the preview
// down. Reachable in normal use at any list/filter boundary — sit on the newest
// article, peek prev, reverse.
describe("mid-gesture reversal", () => {
   it("takes the preview down when the reversal lands on a dead edge", async () => {
      nextBtn().disabled = true // the scene: newest article, next is the wall
      spec.engage("prev")
      await flush()
      spec.move(80)
      const peeked = page()!
      expect(peeked.classList.contains("srr-pager-show")).toBe(true)
      expect(peeked.querySelector(".srr-title")!.textContent).toBe("Neighbor title")
      const peekTransform = peeked.style.transform

      // The finger crosses back through the origin: gestures re-engages the
      // other side, which here is the dead one.
      expect(spec.engage("next")).toBe("resist")
      expect(page()!.classList.contains("srr-pager-show")).toBe(false)

      // ...and the resist drag that follows must not resurrect it.
      spec.move(-40)
      expect(page()!.classList.contains("srr-pager-show")).toBe(false)

      spec.end(-40, false, -0.2)
      // No wrong-axis slide: settleBack must not have written the NEW side's
      // exit transform onto a box still holding the PREVIOUS side's content —
      // that is stale content sweeping the wrong way across the viewport.
      expect(page()!.style.transform).toBe(peekTransform)
      await settle()
      expect(page()).toBeNull() // teardown still runs on the settle
      expect(article().style.transform).toBe("")
   })

   it("orphans the previous side's in-flight fill", async () => {
      nextBtn().disabled = true
      let release!: (a: { f: number; a: number; t: string; c: string }) => void
      mocks.loadArticle.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("prev")
      await flush()
      spec.move(80)
      // The meta card landed (masthead + skeleton); the article has not.
      expect(page()!.querySelector(".srr-pager-skeleton")).not.toBeNull()

      spec.engage("next") // reversal onto the dead edge
      release({ f: 4, a: 1, t: "Stale", c: "<p>stale body</p>" })
      await flush()
      // The fill belonged to the side we left. Painting it now would put the
      // OTHER neighbour's article in a page this gesture no longer wants.
      expect(page()!.querySelector(".srr-content p")).toBeNull()
      expect(page()!.querySelector(".srr-pager-skeleton")).not.toBeNull()
   })
})

// Every branch above is the "next" half of a ternary. The prev half is its
// mirror and is currently correct — these cover it so a future transposition
// slip in one of those ternaries can't ship green.
describe("prev direction (the mirrored branches)", () => {
   it("tracks rightward travel and slides the page in from the left edge", () => {
      spec.engage("prev")
      spec.move(80)
      expect(article().style.transform).toBe("translateX(80px)")
      expect(page()!.style.transform).toBe("translateX(calc(-100% + 80px))")
      spec.move(-60) // wrong-direction travel, mirrored
      expect(article().style.transform).toBe("translateX(0px)")
   })

   it("probes the OLDER neighbor for the page fill", async () => {
      spec.engage("prev")
      await flush()
      expect(mocks.neighborOlder).toHaveBeenCalledWith(2)
      expect(mocks.neighborNewer).not.toHaveBeenCalled()
      expect(mocks.loadMeta).toHaveBeenCalledWith(1)
   })

   it("commits outward to the right, then rests", async () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("prev")
      spec.move(300)
      spec.end(300, true, 0.4)
      expect(commit).toHaveBeenCalledWith("prev")
      // Mid-flight: the outgoing article leaves toward the right, page to centre.
      expect(article().style.transform).toBe("translateX(100%)")
      expect(page()!.style.transform).toBe("translateX(0)")
      release(true)
      await flush()
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
   })

   it("snaps back toward the left edge it came from", async () => {
      vi.useFakeTimers()
      spec.engage("prev")
      spec.move(80)
      spec.end(80, false, 0.1)
      expect(page()!.style.transform).toBe("translateX(-100%)")
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
   })
})

describe("commit", () => {
   it("a committed release calls deps.commit with the side and rests on success", async () => {
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true, -0.4)
      expect(commit).toHaveBeenCalledWith("next")
      await flush()
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
   })

   it("a refused commit (busy/failed nav) snaps back", async () => {
      commit.mockResolvedValueOnce(false)
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true, -0.4)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
   })

   it("an uncommitted release never calls deps.commit", async () => {
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-80)
      spec.end(-80, false, -0.1)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(commit).not.toHaveBeenCalled()
      expect(article().style.transform).toBe("")
   })

   it("a REJECTED commit (cold pack, offline) still settles back to rest", async () => {
      commit.mockRejectedValueOnce(new Error("cold pack"))
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true, -0.4)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      // guard() owns the error popup; the page's job is to not leave itself over
      // a half-slid surface.
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
   })

   it("a STALLED commit gives the surface back before the mutex can be reclaimed", async () => {
      vi.useFakeTimers()
      // A step whose fetch chain wedges — the real shape of the hazard, not a
      // slow-but-settling one. The article is parked fully off-screen while we
      // wait, and rest()/settleBack() are its only writers, so a reader repaint
      // in this window (app.ts's guard() reclaims a mutex held past 60s and
      // renders through it) would paint into an invisible surface.
      commit.mockReturnValueOnce(new Promise(() => {}))
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true, -0.4)
      expect(article().style.transform).toBe("translateX(-100%)")
      // Past the pager's watchdog, still far short of BUSY_STUCK_MS.
      await vi.advanceTimersByTimeAsync(15_000 + PAST_SETTLE_MS)
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
      // ...and the pager is usable again rather than skip-locked behind a
      // commit that is never coming back.
      expect(spec.engage("next")).toBe("page")
      // The step is STILL in flight, so app.ts's finally has not cleared the
      // "slide" it armed before awaiting. settleBack just undid that slide, so
      // the render whenever the step lands would consume the flag, suppress the
      // fade, and swap with no transition at all. Handing it back is what makes
      // the late arrival fade in like any keyboard step.
      expect(abandon).toHaveBeenCalledTimes(1)
   })

   // The other half of that distinction: a step that ANSWERS false has settled,
   // so app.ts's finally already ran and the flag is clear. Abandoning there
   // would be a second clear of something nobody armed — harmless today, but it
   // would make the signal mean "snapped back" instead of "still in flight", and
   // the next reader of this code would wire it to the wrong thing.
   it("a commit that answers false has settled — nothing to abandon", async () => {
      vi.useFakeTimers()
      commit.mockResolvedValueOnce(false)
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true, -0.4)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(article().style.transform).toBe("")
      expect(abandon).not.toHaveBeenCalled()
   })

   it("a successful commit never abandons its own slide", async () => {
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true, -0.4)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(abandon).not.toHaveBeenCalled()
   })

   it("a drag arriving mid-commit is skipped", () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      spec.end(-300, true, -0.4)
      expect(spec.engage("next")).toBe("skip")
      release(true)
   })
})

// The handoff is the whole point of the carousel: the preview is opaque and
// covers the viewport, so the guarded step may render and scroll underneath it
// with nothing visible happening — and the cover comes off only once there is
// something identical behind it.
describe("commit handoff", () => {
   it("keeps the preview covering the viewport until the step resolves", async () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      await flush()
      spec.end(-200, true, -0.4)
      await flush()
      // Mid-commit: the page is still up, so there is no blank window.
      const box = page()
      expect(box).not.toBeNull()
      expect(box!.classList.contains("srr-pager-show")).toBe(true)
      release(true)
      await settle()
      expect(page()).toBeNull()
   })

   it("removes the preview and clears the article transform together", async () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      await flush()
      spec.end(-200, true, -0.4)
      await flush()
      release(true)
      // Microtasks ONLY. rest() runs in the continuation of the awaited step, so
      // BOTH halves of the handoff have to be observable before the next
      // macrotask gets a turn. Deferring the teardown by even one task leaves a
      // frame with the transform cleared and the cover still on — the blink this
      // test exists to forbid — and a settle()-style wait would hide it.
      await microtasks()
      expect(article().style.transform).toBe("")
      expect(page()).toBeNull()
   })

   it("still snaps back and tears down when the step reports no movement", async () => {
      commit.mockResolvedValueOnce(false)
      spec.engage("next")
      await flush()
      spec.end(-200, true, -0.4)
      await settle()
      expect(page()).toBeNull()
      expect(article().style.transform).toBe("")
      expect(abandon).not.toHaveBeenCalled()
   })

   it("tears the page down when the watchdog gives up on a stalled step", async () => {
      vi.useFakeTimers()
      commit.mockReturnValueOnce(new Promise(() => {})) // never settles
      spec.engage("next")
      await vi.advanceTimersByTimeAsync(0)
      spec.end(-200, true, -0.4)
      await vi.advanceTimersByTimeAsync(15_000 + PAST_SETTLE_MS)
      expect(abandon).toHaveBeenCalledTimes(1)
      expect(page()).toBeNull()
      vi.useRealTimers()
   })
})

// prefetch.ts normally has the neighbour warm, so the article resolves in the
// same tick as the meta card and the skeleton is never seen. These are the
// uncommon paths — a deep link, a filter change, an evicted cache entry — where
// the page must still appear at once rather than sit empty.
describe("cold neighbour", () => {
   it("shows the masthead and a skeleton before the article resolves", async () => {
      let release!: (a: { f: number; a: number; t: string; c: string }) => void
      mocks.loadArticle.mockReturnValueOnce(new Promise((r) => (release = r)))
      mocks.loadMeta.mockResolvedValueOnce({ f: 7, w: 1000, t: "Cold headline" })
      spec.engage("next")
      await flush()
      const box = page()!
      expect(box.querySelector(".srr-title")!.textContent).toBe("Cold headline")
      expect(box.querySelector(".srr-pager-skeleton")).not.toBeNull()
      release({ f: 7, a: 1, t: "Cold headline", c: "<p>body</p>" })
      await flush()
      expect(box.querySelector(".srr-pager-skeleton")).toBeNull()
      expect(box.querySelector(".srr-content p")!.textContent).toBe("body")
   })

   it("does not paint a late article over a newer drag", async () => {
      let release!: (a: { f: number; a: number; t: string; c: string }) => void
      mocks.loadArticle.mockReturnValueOnce(new Promise((r) => (release = r)))
      mocks.loadMeta.mockResolvedValueOnce({ f: 7, w: 1000, t: "Stale" })
      spec.engage("next")
      await flush()
      spec.cancel()
      await settle()
      release({ f: 7, a: 1, t: "Stale", c: "<p>stale body</p>" })
      await flush()
      expect(page()).toBeNull()
   })
})

describe("gesture handoff", () => {
   it("a settle armed by the previous drag never fires into the next one", async () => {
      vi.useFakeTimers()
      // Drag A releases short of the threshold, slowly — 80px at the 0.1px/ms
      // velocity floor clamps to the 260ms ceiling, so a 310ms settle is armed.
      spec.engage("next")
      spec.move(-80)
      spec.end(-80, false, -0.1)
      await vi.advanceTimersByTimeAsync(100)
      // Drag B starts while that settle is still pending.
      spec.engage("next")
      spec.move(-120)
      // Past drag A's deadline: its rest() must not clear drag B's tracking (or,
      // had B committed, snap the article back mid slide-out) — and above all
      // must not tear down the page drag B is peeking into.
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(article().style.transform).toBe("translateX(-120px)")
      expect(page()!.classList.contains("srr-pager-show")).toBe(true)
   })
})

// The settle CARRIES the release velocity: how long the remaining travel takes
// is decided by how fast the finger was still moving when it left the glass. One
// fixed duration made a hard flick decelerate exactly like a slow deliberate
// lift, which is the rubbery tell this replaced — so these pin the arithmetic at
// both bounds AND between them, since a fit that only ever reports a bound is
// indistinguishable from two constants.
describe("settle duration", () => {
   const EASE = "cubic-bezier(0.2, 0, 0, 1)"
   // The commit settle measures what is LEFT of a full surface width, so the
   // surface needs one — jsdom reports offsetWidth 0 for every element.
   const setSurfaceWidth = (px: number) =>
      Object.defineProperty(article(), "offsetWidth", { value: px, configurable: true })

   it("a hard flick commits at the floor", async () => {
      setSurfaceWidth(400)
      spec.engage("next")
      await flush()
      spec.move(-200)
      // 200px still to travel at 4px/ms = 50ms — under the 120ms floor, which is
      // there because a page turn that lands in one frame reads as a glitch.
      spec.end(-200, true, -4)
      expect(article().style.transition).toBe(`transform 120ms ${EASE}`)
      expect(page()!.style.transition).toBe(`transform 120ms ${EASE}`)
      await flush()
   })

   it("a slow release commits at the ceiling", async () => {
      setSurfaceWidth(400)
      spec.engage("next")
      await flush()
      spec.move(-200)
      // 200px at the 0.1px/ms velocity floor = 2000ms, clamped to 260ms.
      spec.end(-200, true, -0.05)
      expect(article().style.transition).toBe(`transform 260ms ${EASE}`)
      await flush()
   })

   it("scales with the remaining travel between the two bounds", async () => {
      setSurfaceWidth(400)
      spec.engage("next")
      await flush()
      spec.move(-100)
      // 300px left at 2px/ms = 150ms — inside the clamp, so what shows here is
      // the division itself rather than either bound.
      spec.end(-100, true, -2)
      expect(article().style.transition).toBe(`transform 150ms ${EASE}`)
      await flush()
   })

   it("a snap-back carries the velocity too, over the distance back to origin", async () => {
      spec.engage("next")
      await flush()
      spec.move(-100)
      // Snapping back, so the travel is the offset reached: 100px at 0.4px/ms.
      spec.end(-100, false, -0.4)
      expect(article().style.transition).toBe(`transform 250ms ${EASE}`)
      expect(page()!.style.transition).toBe(`transform 250ms ${EASE}`)
   })

   it("measures a dead-edge resist settle from its own damped offset", async () => {
      nextBtn().disabled = true
      spec.engage("next")
      spec.move(-400) // damped to -64px, RESIST_MAX
      // lastDx is the RAW offset the finger reached, recorded above the branch
      // split so the resist path is measured at all: 400px at 2.5px/ms = 160ms.
      spec.end(-400, false, -2.5)
      expect(article().style.transition).toBe(`transform 160ms ${EASE}`)
   })

   it("a dead-stop release settles at the ceiling rather than never", async () => {
      vi.useFakeTimers()
      spec.engage("next")
      await vi.advanceTimersByTimeAsync(0)
      spec.move(-100)
      // The 0.1px/ms floor's reason for existing: unfloored, 100/0 is Infinity —
      // a transition that never ends with `settleTimer` armed at Infinity, so the
      // opaque preview would stay parked over the reader for good.
      spec.end(-100, false, 0)
      expect(article().style.transition).toBe(`transform 260ms ${EASE}`)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS)
      expect(page()).toBeNull()
   })

   it("closes the settle a pad past the COMPUTED duration, not a constant", async () => {
      vi.useFakeTimers()
      spec.engage("next")
      await vi.advanceTimersByTimeAsync(0)
      spec.move(-100)
      spec.end(-100, false, -2) // 50ms → floored to 120ms, so teardown at 170ms
      expect(article().style.transition).toBe(`transform 120ms ${EASE}`)
      await vi.advanceTimersByTimeAsync(169)
      expect(page()).not.toBeNull()
      await vi.advanceTimersByTimeAsync(2)
      expect(page()).toBeNull()
   })

   it("reduced motion writes no duration at all — nothing moves after the lift", async () => {
      vi.useFakeTimers()
      const mm = vi.fn(() => ({ matches: true }) as MediaQueryList)
      Object.defineProperty(window, "matchMedia", { value: mm, configurable: true })
      setSurfaceWidth(400)
      // Held mid-flight, so what is asserted is what commitStep WROTE rather
      // than what rest() cleared on the way out.
      commit.mockReturnValueOnce(new Promise(() => {}))
      spec.engage("next")
      await vi.advanceTimersByTimeAsync(0)
      spec.move(-200)
      spec.end(-200, true, -1)
      // move() leaves "none" behind; what must never appear is a timed
      // transition. The drag tracked the finger (direct manipulation), but
      // nothing may move on its own once the finger is gone.
      expect(article().style.transition).not.toMatch(/ms/)
      expect(page()!.style.transition).not.toMatch(/ms/)
   })
})

describe("reduced motion", () => {
   it("settles instantly — no transition style is left behind", () => {
      const mm = vi.fn(() => ({ matches: true }) as MediaQueryList)
      Object.defineProperty(window, "matchMedia", { value: mm, configurable: true })
      spec.engage("next")
      spec.move(-80)
      spec.end(-80, false, -0.1)
      expect(article().style.transform).toBe("")
      expect(article().style.transition).toBe("")
      // Instant settle is still a settle: the cover comes off in the same act.
      expect(page()).toBeNull()
   })
})
