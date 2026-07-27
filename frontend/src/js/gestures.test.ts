import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Two halves, both driven in jsdom: the scroll-linked toolbar hide/show +
// resetScroll, and the touch state machine (its three single-finger clients —
// pull to refresh, row swipe, reader pager — plus two-finger vertical = cycle
// filter, pinch discrimination, finger-lift re-seed, touchcancel). jsdom has no
// real Touch dispatch, but the handlers only read
// plain {clientX,clientY} off e.touches/e.changedTouches and never test
// `instanceof TouchEvent`, so a synthesized Event with those props defined
// drives the whole machine here — no browser needed.

import type { Gestures } from "./gestures"

// ONE FRESH MODULE INSTANCE PER TEST (the list.test.ts / search.test.ts /
// dropdown.test.ts pattern). setupGestures registers document + window
// listeners and hands back no teardown, so every mount leaves its set live for
// the rest of the file. Sharing ONE module instance with them meant each
// dispatched event re-drove the same state machine once per accumulated
// listener set — which is not a theoretical worry: it MASKED a mutation check
// on this very suite, a whole-file run passing while the isolated `-t` run
// correctly failed. Resetting the module orphans the old listeners instead:
// they still fire, but against their own now-detached surfaces and the previous
// test's mocks, so they can neither engage nor touch what this test asserts on.
type G = typeof import("./gestures")
let ROW_SWIPE_TRIGGER: G["ROW_SWIPE_TRIGGER"]
let setPullRefresh: G["setPullRefresh"]
let setRowSwipe: G["setRowSwipe"]
let setPager: G["setPager"]
let setupGestures: G["setupGestures"]

const setScrollY = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true })
// jsdom has no layout, so the scroll handler's at-bottom check needs explicit
// page dimensions: a viewport and a content height. Default to a tall page so
// the hide/show tests are nowhere near the bottom.
const setInnerHeight = (h: number) => Object.defineProperty(window, "innerHeight", { value: h, configurable: true })
const setScrollHeight = (h: number) =>
   Object.defineProperty(document.documentElement, "scrollHeight", { value: h, configurable: true })
const scroll = () => window.dispatchEvent(new Event("scroll"))

let toolbar: HTMLElement
let listEl: HTMLElement
let rowA: HTMLElement
let g: Gestures
let onCycle: ReturnType<typeof vi.fn>
let pullRun: ReturnType<typeof vi.fn>
let rowMove: ReturnType<typeof vi.fn>
let rowAct: ReturnType<typeof vi.fn>
let readerEl: HTMLElement
let pagerEngage: ReturnType<typeof vi.fn>
let pagerMoveFn: ReturnType<typeof vi.fn>
let pagerEndFn: ReturnType<typeof vi.fn>
let pagerCancelFn: ReturnType<typeof vi.fn>

async function mount(): Promise<void> {
   vi.resetModules()
   const mod = await import("./gestures")
   ROW_SWIPE_TRIGGER = mod.ROW_SWIPE_TRIGGER
   setPullRefresh = mod.setPullRefresh
   setRowSwipe = mod.setRowSwipe
   setPager = mod.setPager
   setupGestures = mod.setupGestures
   // body's own class list survives an innerHTML reset (only its children are
   // replaced), so it's cleared explicitly to keep srr-toolbar-hidden from
   // leaking a stale value across tests.
   document.body.className = ""
   document.body.innerHTML =
      `<nav class="srr-toolbar"></nav>` +
      `<div class="srr-list"><a class="srr-row"><span class="srr-row-title">t</span></a></div>` +
      `<article class="srr-reader"><p class="srr-reader-p">body</p></article>` +
      `<div class="srr-player"></div>`
   toolbar = document.querySelector(".srr-toolbar")!
   listEl = document.querySelector(".srr-list")!
   rowA = document.querySelector("a.srr-row")!
   onCycle = vi.fn()
   pullRun = vi.fn(async () => "")
   rowMove = vi.fn()
   rowAct = vi.fn()
   // What list.setup does at boot: hand gestures the list container + the
   // refresh cycle a committed overscroll pull runs. Re-registering also resets
   // the module-level pull state, so tests don't leak into each other.
   setPullRefresh(listEl, pullRun)
   // The row actions ride the same surface; the spec is the list's half (row
   // resolution + affordance + action), which is what the mocks stand in for.
   setRowSwipe(listEl, {
      row: (t) => (t instanceof Element ? t.closest<HTMLElement>("a.srr-row") : null),
      move: rowMove,
      end: rowAct,
   })
   readerEl = document.querySelector(".srr-reader")!
   pagerEngage = vi.fn(() => "page" as const)
   pagerMoveFn = vi.fn()
   pagerEndFn = vi.fn()
   pagerCancelFn = vi.fn()
   // What pager.setup does at boot: hand gestures the reader surface + the
   // pane/commit spec. Re-registering also resets the module-level pager state.
   setPager(readerEl, { engage: pagerEngage, move: pagerMoveFn, end: pagerEndFn, cancel: pagerCancelFn })
   g = setupGestures({ toolbar, onCycle })
}

beforeEach(async () => {
   setScrollY(0)
   setInnerHeight(800)
   setScrollHeight(4000) // a tall page: the hide/show tests are far from the bottom
   await mount()
})

describe("scroll-driven toolbar hide/show", () => {
   const slid = () => toolbar.classList.contains("srr-toolbar-slide")

   it("hides the toolbar on a downward scroll past 50px", () => {
      setScrollY(120)
      scroll()
      expect(slid()).toBe(true)
   })

   it("does not hide within the top 50px (the toolbar stays put near the top)", () => {
      setScrollY(40)
      scroll()
      expect(slid()).toBe(false)
   })

   it("reveals the toolbar again when scrolling back up", () => {
      setScrollY(200)
      scroll()
      expect(slid()).toBe(true)
      setScrollY(120) // upward
      scroll()
      expect(slid()).toBe(false)
   })

   it("rises 1:1 with the scroll in the bottom zone, then drops the override on the way up", () => {
      setScrollHeight(2000)
      Object.defineProperty(toolbar, "offsetHeight", { value: 60, configurable: true })
      setScrollY(1100) // above the 60px bottom zone, scrolling down → hidden
      scroll()
      expect(slid()).toBe(true)
      // 30px from the bottom, still scrolling down → lifted 30px into view (no slide class).
      setScrollY(1170) // distFromBottom = 2000 - 1170 - 800 = 30
      scroll()
      expect(slid()).toBe(false)
      expect(toolbar.style.transform).toBe("translateY(30px)")
      // At the very bottom it's fully in place.
      setScrollY(1200) // distFromBottom = 0
      scroll()
      expect(toolbar.style.transform).toBe("translateY(0px)")
      // Scrolling back up drops the scroll-linked override and just shows it fixed.
      setScrollY(1180)
      scroll()
      expect(toolbar.style.transform).toBe("")
      expect(slid()).toBe(false)
   })

   it("toggles body.srr-toolbar-hidden in lockstep with the toolbar's own slide class (RDR16)", () => {
      const bodyHidden = () => document.body.classList.contains("srr-toolbar-hidden")
      expect(bodyHidden()).toBe(false)
      setScrollY(120)
      scroll()
      expect(slid()).toBe(true)
      expect(bodyHidden()).toBe(true)
      setScrollY(20) // scrolling back up reveals both
      scroll()
      expect(slid()).toBe(false)
      expect(bodyHidden()).toBe(false)
   })

   it("seats the bar when the scroll settles half-sunken mid-zone (no further scroll event)", () => {
      vi.useFakeTimers()
      try {
         setScrollHeight(2000)
         Object.defineProperty(toolbar, "offsetHeight", { value: 60, configurable: true })
         setScrollY(1170) // distFromBottom = 30 → parked half-sunken, scroll then stops
         scroll()
         expect(toolbar.style.transform).toBe("translateY(30px)")
         // The gesture stops mid-zone: no further scroll fires. A settle timer must
         // hand position back to the class-driven slide so it isn't left clipped.
         vi.advanceTimersByTime(150)
         expect(toolbar.style.transform).toBe("")
      } finally {
         vi.useRealTimers()
      }
   })
})

describe("resetScroll", () => {
   it("re-baselines so a programmatic jump reads no downward delta, and reveals a hidden toolbar", () => {
      setScrollY(300)
      scroll() // hidden
      expect(toolbar.classList.contains("srr-toolbar-slide")).toBe(true)
      setScrollY(600) // the programmatic jump lands lower in the document
      g.resetScroll()
      expect(toolbar.classList.contains("srr-toolbar-slide")).toBe(false) // revealed
      // The queued scroll event from the jump now reads zero delta → no re-hide.
      scroll()
      expect(toolbar.classList.contains("srr-toolbar-slide")).toBe(false)
   })
})

// The touch handlers live on `document` (scroll is on `window`). They read only
// `.length` and `[i].clientX/clientY` off `touches`/`changedTouches`, so a bare
// Event with those props defined drives them; `cancelable:true` lets us read
// preventDefault back off `defaultPrevented`.
type Pt = { clientX: number; clientY: number }
// `target` matters only to the pull, whose eligibility test is "did this touch
// start inside the list container?"; the swipe/cycle cases dispatch on document
// as before (and are therefore never eligible).
function dispatchTouch(type: string, touches: Pt[], changed: Pt[] = touches, target: EventTarget = document): Event {
   const e = new Event(type, { bubbles: true, cancelable: true })
   Object.defineProperty(e, "touches", { value: touches, configurable: true })
   Object.defineProperty(e, "changedTouches", { value: changed, configurable: true })
   target.dispatchEvent(e)
   return e
}
const start = (touches: Pt[]) => dispatchTouch("touchstart", touches)
const moveTo = (touches: Pt[]) => dispatchTouch("touchmove", touches)
// touchend: still-down fingers in `touches`, lifted ones in `changedTouches`
// (the swipe delta reads changedTouches[0]).
const end = (remaining: Pt[], lifted: Pt[]) => dispatchTouch("touchend", remaining, lifted)

// RDR16: a seek control is a horizontal drag identical in shape to a reader
// page turn, and the document handlers above have no target filtering — an
// in-content scrubber sits INSIDE the pager's own surface, so without the guard
// scrubbing pages the article instead of seeking.
describe("scrubber gesture guard (RDR16)", () => {
   // A drag that WOULD page the reader if it weren't declined: horizontal, past
   // the axis slop, starting on `target`. (The move is what makes these cases
   // load-bearing — the pager engages on the first move past the slop, not on
   // the lift, so a start+end pair alone would pass with no guard at all.)
   const dragFrom = (target: EventTarget) => {
      dispatchTouch("touchstart", [{ clientX: 200, clientY: 300 }], undefined, target)
      moveTo([{ clientX: 100, clientY: 300 }]) // dx = -100
      end([], [{ clientX: 100, clientY: 300 }])
   }

   // DOCUMENTATION, not regression coverage, and labelled as such so nobody
   // reads it as the latter: the bar is a SIBLING of .srr-reader (here and in
   // production), so pagerStart's own surface containment test already declines
   // it — deleting onScrubber entirely leaves this green (verified). It records
   // that the bar is exempt; the in-content cases below are what actually pin
   // the guard, and the generic outside-the-surface case is in the pager block.
   it("a touchstart inside .srr-player declines the gesture outright", () => {
      dragFrom(document.querySelector(".srr-player")!)
      expect(pagerEngage).not.toHaveBeenCalled()
      expect(pagerEndFn).not.toHaveBeenCalled()
   })

   // The half that was missing. The guard used to be a stopPropagation listener
   // bound to `.srr-player`, and its comment claimed it covered in-content media
   // too — it could not, because fmt.ts force-sets `controls` on content audio
   // (the #enclosure podcast case) and that element is in `.srr-content`, not in
   // the bar. Scrubbing a podcast inside the article navigated away from it.
   //
   // Native media controls are shadow DOM, so a touch on the scrubber retargets
   // to the <audio>/<video> host — which is exactly what these dispatch.
   for (const tag of ["audio", "video"]) {
      it(`a touchstart on an in-content <${tag}> scrubber does not page the reader`, () => {
         const content = document.createElement("div")
         content.className = "srr-content"
         const media = document.createElement(tag)
         content.appendChild(media)
         // Mounted INSIDE the reader, where `.srr-content` really lives: that is
         // what puts it in the pager's surface and makes onScrubber the only
         // thing standing between a scrub and a page turn.
         readerEl.appendChild(content)

         dragFrom(media)
         expect(pagerEngage).not.toHaveBeenCalled()
         expect(pagerEndFn).not.toHaveBeenCalled()
      })
   }

   it("an identical drag starting outside any scrubber still pages", () => {
      dragFrom(document.querySelector(".srr-reader-p")!)
      expect(pagerEngage).toHaveBeenCalledWith("next")
      expect(pagerEndFn).toHaveBeenCalledTimes(1)
   })
})

describe("two-finger vertical cycle", () => {
   // centroid y=300, inter-finger distance=100
   const twoStart = () =>
      start([
         { clientX: 100, clientY: 300 },
         { clientX: 200, clientY: 300 },
      ])

   it("an upward two-finger pan cycles to the previous lane and blocks native scroll", () => {
      twoStart()
      const m = moveTo([
         { clientX: 100, clientY: 240 },
         { clientX: 200, clientY: 240 },
      ]) // centroid ↑ to 240, distance unchanged → dy = -60
      expect(m.defaultPrevented).toBe(true) // a claimed pan preventDefaults
      end(
         [],
         [
            { clientX: 100, clientY: 240 },
            { clientX: 200, clientY: 240 },
         ],
      )
      expect(onCycle).toHaveBeenCalledTimes(1)
      expect(onCycle).toHaveBeenCalledWith(-1)
   })

   it("a downward two-finger pan cycles to the next lane", () => {
      twoStart()
      moveTo([
         { clientX: 100, clientY: 372 },
         { clientX: 200, clientY: 372 },
      ]) // dy = +72
      end(
         [],
         [
            { clientX: 100, clientY: 372 },
            { clientX: 200, clientY: 372 },
         ],
      )
      expect(onCycle).toHaveBeenCalledTimes(1)
      expect(onCycle).toHaveBeenCalledWith(1)
   })

   it("ignores a sub-threshold two-finger pan (<50px)", () => {
      twoStart()
      moveTo([
         { clientX: 100, clientY: 270 },
         { clientX: 200, clientY: 270 },
      ]) // dy = -30
      end(
         [],
         [
            { clientX: 100, clientY: 270 },
            { clientX: 200, clientY: 270 },
         ],
      )
      expect(onCycle).not.toHaveBeenCalled()
   })

   it("treats a distance change as a pinch-zoom: no cycle, native zoom left alone", () => {
      twoStart()
      const m = moveTo([
         { clientX: 60, clientY: 300 },
         { clientX: 280, clientY: 300 },
      ]) // distance 100 → 220, Δ=120 > 25 → pinch
      expect(m.defaultPrevented).toBe(false) // must NOT block the browser's zoom
      end(
         [],
         [
            { clientX: 60, clientY: 300 },
            { clientX: 280, clientY: 300 },
         ],
      )
      expect(onCycle).not.toHaveBeenCalled()
   })

   it("does not fire a stale cycle when one finger lifts before the other", () => {
      twoStart()
      // The pan MUST travel past the 50px cycle threshold first: with a
      // motionless gesture twoFingerDy stays 0 and the second lift could not
      // cycle whether the re-seed happened or not, which is exactly what made
      // an earlier cut of this case vacuous.
      moveTo([
         { clientX: 100, clientY: 372 },
         { clientX: 200, clientY: 372 },
      ]) // dy = +72, a pan that WOULD cycle if the second lift settled it
      // one finger lifts, one remains at x=100 → re-seeded as a fresh single
      // gesture, so the second lift is not read as the two-finger pan's end.
      end([{ clientX: 100, clientY: 372 }], [{ clientX: 200, clientY: 372 }])
      end([], [{ clientX: 200, clientY: 372 }])
      expect(onCycle).not.toHaveBeenCalled() // no stale cycle off the two-finger dy
   })
})

// Pull to refresh: a one-finger downward drag that STARTS inside the list
// container while the document is at the top. Everything here is the same
// synthesized-Event machinery as above, with the touch dispatched on the list
// element so `e.target` is inside the registered surface.
describe("pull to refresh", () => {
   const badge = () => document.querySelector<HTMLElement>(".srr-pull")
   const on = (el: EventTarget) => ({
      start: (y: number, x = 150) => dispatchTouch("touchstart", [{ clientX: x, clientY: y }], undefined, el),
      move: (y: number, x = 150) => dispatchTouch("touchmove", [{ clientX: x, clientY: y }], undefined, el),
      end: (y: number, x = 150) => dispatchTouch("touchend", [], [{ clientX: x, clientY: y }], el),
   })
   // The gesture as the finger performs it: down past the 72px trigger, release.
   const fullPull = (el: EventTarget = listEl) => {
      const t = on(el)
      t.start(100)
      t.move(120) // engages (past the 8px slop), still short of the trigger
      t.move(200) // 100px of travel → armed
      t.end(200)
   }

   it("runs one refresh cycle when the pull passes the threshold", () => {
      fullPull()
      expect(pullRun).toHaveBeenCalledTimes(1)
   })

   it("does nothing when the pull stops short of the threshold", () => {
      const t = on(listEl)
      t.start(100)
      t.move(140) // 40px — engaged, but never armed
      t.end(140)
      expect(pullRun).not.toHaveBeenCalled()
   })

   it("claims the gesture from the browser once engaged (no native pull-to-reload)", () => {
      const t = on(listEl)
      t.start(100)
      const m = t.move(200)
      expect(m.defaultPrevented).toBe(true)
   })

   it("stays out of an ordinary scroll: no preventDefault before it engages", () => {
      const t = on(listEl)
      t.start(100)
      const m = t.move(96) // 4px, inside the slop
      expect(m.defaultPrevented).toBe(false)
   })

   it("is inert away from the top of the list (that drag is a scroll)", () => {
      setScrollY(300)
      fullPull()
      expect(pullRun).not.toHaveBeenCalled()
      expect(badge()).toBeNull() // the affordance never even builds
   })

   it("is inert while the reader is up (the list container is hidden)", () => {
      listEl.hidden = true
      fullPull()
      expect(pullRun).not.toHaveBeenCalled()
   })

   it("is inert under an overlay — a touch starting outside the list surface", () => {
      // The filter picker and the image lightbox are separate elements laid OVER
      // the list; a touch inside one is not inside the registered surface, which
      // is how the pull honours the same exclusion as picker/lightbox.isOpen().
      const overlay = document.createElement("div")
      overlay.className = "srr-picker"
      document.body.appendChild(overlay)
      fullPull(overlay)
      expect(pullRun).not.toHaveBeenCalled()
   })

   // The PAGER half of this lock is not assertable from the list surface: the
   // reader is a sibling of the list, so pagerEligible is false from pagerStart
   // however the pull behaves — an `expect(pagerEndFn).not.toHaveBeenCalled()`
   // here passed even with touchend's consume checks removed outright
   // (verified), i.e. it read as coverage while testing nothing. What IS
   // load-bearing is the half below: a horizontal delta at the LIFT cannot take
   // the gesture back from a pull that already engaged.
   it("axis lock: a horizontal delta at the lift can't take an engaged pull away", () => {
      const t = on(listEl)
      t.start(100)
      t.move(200) // vertical: the pull takes the gesture
      t.end(200, 280) // dx=+130 > |dy|=100 — horizontal at the lift, but for the lock
      expect(pullRun).toHaveBeenCalledTimes(1)
   })

   it("axis lock: a horizontal drag vetoes the pull for good, even if it later drifts down", () => {
      const t = on(listEl)
      t.start(100)
      t.move(104, 230) // dx=80 dominates → the horizontal axis owns it from here
      t.move(220, 230) // a later downward drift must not start a pull
      t.end(110, 240) // dx=+90, |dy|=10
      expect(pullRun).not.toHaveBeenCalled()
   })

   it("a second finger hands the gesture to the two-finger machine", () => {
      const t = on(listEl)
      t.start(100)
      t.move(200) // armed
      start([
         { clientX: 100, clientY: 300 },
         { clientX: 200, clientY: 300 },
      ])
      end(
         [],
         [
            { clientX: 100, clientY: 300 },
            { clientX: 200, clientY: 300 },
         ],
      )
      expect(pullRun).not.toHaveBeenCalled()
   })

   it("touchcancel drops an engaged pull", () => {
      const t = on(listEl)
      t.start(100)
      t.move(200)
      dispatchTouch("touchcancel", [])
      t.end(200)
      expect(pullRun).not.toHaveBeenCalled()
   })

   it("re-anchors so a long scroll up doesn't arrive at the top pre-armed", () => {
      const t = on(listEl)
      setScrollY(400)
      t.start(600)
      t.move(400) // still scrolled: re-anchors, no pull
      setScrollY(0) // the list has reached its top mid-gesture
      t.move(420) // only 20px of travel counts from here
      t.end(420)
      expect(pullRun).not.toHaveBeenCalled()
   })

   it("arms, spins, then clears the affordance across the cycle", async () => {
      vi.useFakeTimers()
      try {
         let finish!: () => void
         pullRun.mockImplementation(() => new Promise<void>((r) => (finish = r)))
         const t = on(listEl)
         t.start(100)
         t.move(140)
         expect(badge()!.classList.contains("srr-pull-armed")).toBe(false)
         t.move(200)
         expect(badge()!.classList.contains("srr-pull-armed")).toBe(true)
         t.end(200)
         expect(badge()!.classList.contains("srr-pull-busy")).toBe(true)
         finish()
         // The cycle answers instantly here; the affordance still holds for its
         // minimum visible beat, then parks back off-screen.
         await vi.advanceTimersByTimeAsync(500)
         expect(badge()!.classList.contains("srr-pull-busy")).toBe(false)
         expect(badge()!.style.transform).toBe("")
      } finally {
         vi.useRealTimers()
      }
   })

   it("does not stack a second cycle while one is still running", async () => {
      vi.useFakeTimers()
      try {
         pullRun.mockImplementation(() => new Promise<void>(() => {})) // never settles
         fullPull()
         fullPull()
         expect(pullRun).toHaveBeenCalledTimes(1)
      } finally {
         vi.useRealTimers()
      }
   })
})

// Row swipe actions (RDR14): a one-finger HORIZONTAL drag that starts on a row
// of the registered surface. The mirror image of the pull above, so the cases
// mirror it too — commit, sub-threshold, the three faces of the axis lock, and
// every way a gesture can be taken away mid-drag.
describe("row swipe actions", () => {
   // A drag from (x0, y0) to (x1, y1) in one move, dispatched on `target` so the
   // spec's row resolution sees it.
   const on = (target: EventTarget = rowA) => ({
      start: (x: number, y = 300) => dispatchTouch("touchstart", [{ clientX: x, clientY: y }], undefined, target),
      move: (x: number, y = 300) => dispatchTouch("touchmove", [{ clientX: x, clientY: y }], undefined, target),
      end: (x: number, y = 300) => dispatchTouch("touchend", [], [{ clientX: x, clientY: y }], target),
   })
   // Past the trigger and released — the gesture as a thumb performs it.
   const swipe = (dx: number, target: EventTarget = rowA) => {
      const t = on(target)
      t.start(200)
      t.move(200 + Math.sign(dx) * 20) // engaged (past the slop), short of the trigger
      t.move(200 + dx)
      t.end(200 + dx)
   }

   it("a left swipe past the trigger commits with dir -1", () => {
      swipe(-(ROW_SWIPE_TRIGGER + 20))
      expect(rowAct).toHaveBeenCalledTimes(1)
      expect(rowAct).toHaveBeenCalledWith(rowA, -1)
   })

   it("a right swipe past the trigger commits with dir +1", () => {
      swipe(ROW_SWIPE_TRIGGER + 20)
      expect(rowAct).toHaveBeenCalledWith(rowA, 1)
   })

   it("retracts without committing when the swipe stops short of the trigger", () => {
      const t = on()
      t.start(200)
      t.move(240) // engaged, never armed
      t.end(240)
      expect(rowAct).toHaveBeenCalledWith(rowA, 0)
   })

   it("reports live progress and flips to armed at the trigger", () => {
      const t = on()
      t.start(200)
      t.move(230)
      expect(rowMove).toHaveBeenLastCalledWith(rowA, 30, false)
      t.move(200 + ROW_SWIPE_TRIGGER)
      expect(rowMove).toHaveBeenLastCalledWith(rowA, ROW_SWIPE_TRIGGER, true)
   })

   it("claims the gesture from the scroll once engaged", () => {
      const t = on()
      t.start(200)
      const m = t.move(240)
      expect(m.defaultPrevented).toBe(true)
   })

   it("stays out of an ordinary scroll: no preventDefault inside the slop", () => {
      const t = on()
      t.start(200)
      const m = t.move(204) // 4px, inside the shared axis slop
      expect(m.defaultPrevented).toBe(false)
      expect(rowMove).not.toHaveBeenCalled()
   })

   it("axis lock: a vertical-dominant drag never becomes a row swipe (the pull takes it)", () => {
      const t = on()
      t.start(200, 100)
      t.move(210, 200) // dy=100 dominates dx=10 → the row is vetoed for good
      t.move(320, 210) // a later horizontal drift must not revive it
      t.end(320, 210)
      expect(rowMove).not.toHaveBeenCalled()
      expect(rowAct).not.toHaveBeenCalled()
      expect(pullRun).toHaveBeenCalledTimes(1) // the same gesture WAS a pull
   })

   // Same note as the pull's lift case: the reader surface is unreachable from a
   // list row (the two containers are mutually exclusive siblings), so asserting
   // the pager stayed out of it would test nothing here. The row half is what
   // there is to pin — over a drag long enough to be the pager's own shape.
   it("axis lock: a long, pager-shaped horizontal drag still commits to the row", () => {
      swipe(-(ROW_SWIPE_TRIGGER + 60))
      expect(rowAct).toHaveBeenCalledWith(rowA, -1)
   })

   it("axis lock: an engaged row swipe never becomes a pull, even drifting down", () => {
      const t = on()
      t.start(200, 100)
      t.move(280, 104) // horizontal: the row owns it
      t.move(280, 260) // a later downward drift must not start a pull
      t.end(280, 260)
      expect(pullRun).not.toHaveBeenCalled()
      expect(rowAct).toHaveBeenCalledWith(rowA, 1)
   })

   it("is inert on a touch that starts off a row (the surface's own chrome)", () => {
      swipe(-(ROW_SWIPE_TRIGGER + 20), listEl) // the container, not a row
      expect(rowMove).not.toHaveBeenCalled()
      expect(rowAct).not.toHaveBeenCalled()
   })

   it("is inert while the reader is up (the list container is hidden)", () => {
      listEl.hidden = true
      swipe(-(ROW_SWIPE_TRIGGER + 20))
      expect(rowAct).not.toHaveBeenCalled()
   })

   it("is inert under an overlay — a touch starting outside the list surface", () => {
      // Same one-test gating as the pull: the picker and the lightbox are laid
      // OVER the list, so their rows-shaped content is not inside the surface.
      const overlay = document.createElement("div")
      overlay.className = "srr-picker"
      overlay.innerHTML = '<a class="srr-row"></a>'
      document.body.appendChild(overlay)
      swipe(-(ROW_SWIPE_TRIGGER + 20), overlay.querySelector("a")!)
      expect(rowAct).not.toHaveBeenCalled()
   })

   it("touchcancel retracts an engaged swipe and leaves the lift inert", () => {
      const t = on()
      t.start(200)
      t.move(280) // armed
      dispatchTouch("touchcancel", [])
      expect(rowAct).toHaveBeenCalledWith(rowA, 0) // retracted, not committed
      t.end(280)
      expect(rowAct).toHaveBeenCalledTimes(1)
   })

   it("a second finger hands the gesture to the two-finger machine", () => {
      const t = on()
      t.start(200)
      t.move(280) // armed
      start([
         { clientX: 100, clientY: 300 },
         { clientX: 200, clientY: 300 },
      ])
      expect(rowAct).toHaveBeenCalledWith(rowA, 0) // retracted when the finger landed
      end(
         [],
         [
            { clientX: 100, clientY: 300 },
            { clientX: 200, clientY: 300 },
         ],
      )
      expect(rowAct).toHaveBeenCalledTimes(1)
   })

   // touchstart's 3+-finger branch (mode = "none" plus the three cancels) lost
   // its only cover when the one-finger-swipe describe was deleted. This is the
   // two-finger case above pointed at that branch: it fails if the branch stops
   // retracting (rowAct never called with 0) AND if it stops parking the mode
   // (the lift would then commit the swipe as -1, a second rowAct call).
   it("a third finger drops the gesture entirely", () => {
      const t = on()
      t.start(200)
      t.move(280) // engaged
      start([
         { clientX: 100, clientY: 300 },
         { clientX: 200, clientY: 300 },
         { clientX: 300, clientY: 300 },
      ])
      expect(rowAct).toHaveBeenCalledWith(rowA, 0) // retracted when the third finger landed
      t.end(280)
      expect(rowAct).toHaveBeenCalledTimes(1) // and the lift commits nothing
   })

   it("re-registration retracts an engaged swipe (the rows it tracked are gone)", () => {
      const t = on()
      t.start(200)
      t.move(280)
      setRowSwipe(listEl, { row: () => null, move: rowMove, end: rowAct })
      expect(rowAct).toHaveBeenCalledWith(rowA, 0)
      t.end(280)
      expect(rowAct).toHaveBeenCalledTimes(1)
   })
})

describe("reader pager (geometry)", () => {
   const inReader = () => document.querySelector(".srr-reader-p")!
   const pStart = (x: number, y: number) =>
      dispatchTouch("touchstart", [{ clientX: x, clientY: y }], undefined, inReader())
   const pMove = (x: number, y: number, ms = 16) => {
      vi.advanceTimersByTime(ms)
      return moveTo([{ clientX: x, clientY: y }])
   }
   const pEnd = (x: number, y: number) => end([], [{ clientX: x, clientY: y }])

   beforeEach(() => {
      vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] })
   })
   afterEach(() => {
      vi.useRealTimers()
   })

   it("engages past the slop, reports the side, tracks moves, and owns the scroll", () => {
      pStart(200, 300)
      const e = pMove(150, 300) // dx=-50: leftward = next
      expect(pagerEngage).toHaveBeenCalledWith("next")
      expect(pagerMoveFn).toHaveBeenCalledWith(-50)
      expect(e.defaultPrevented).toBe(true)
      pMove(120, 300)
      expect(pagerMoveFn).toHaveBeenLastCalledWith(-80)
   })

   it("a rightward drag engages as prev", () => {
      pStart(100, 300)
      pMove(160, 300)
      expect(pagerEngage).toHaveBeenCalledWith("prev")
   })

   it("stays out of an ordinary scroll: no preventDefault inside the slop", () => {
      pStart(200, 300)
      const e = pMove(204, 300) // 4px, inside the shared axis slop
      expect(e.defaultPrevented).toBe(false)
      expect(pagerEngage).not.toHaveBeenCalled()
      expect(pagerMoveFn).not.toHaveBeenCalled()
   })

   it("a vertical-dominant move vetoes the pager for the gesture's life", () => {
      pStart(200, 300)
      pMove(205, 400) // dy dominant
      pMove(80, 400) // now horizontal — too late
      expect(pagerEngage).not.toHaveBeenCalled()
      expect(pagerMoveFn).not.toHaveBeenCalled()
   })

   it("commits at 25% of the viewport width", () => {
      // jsdom: surface clientWidth is 0, so the machine falls back to
      // window.innerWidth (1024 default) — threshold 256px.
      pStart(500, 300)
      for (const x of [440, 340, 240, 180]) pMove(x, 300)
      pEnd(180, 300) // dx=-320
      expect(pagerEndFn).toHaveBeenCalledWith(-320, true)
   })

   it("short of the threshold and slow: no commit", () => {
      pStart(500, 300)
      pMove(450, 300, 100)
      pMove(400, 300, 100) // 50px per 100ms = 0.5... keep below: see next move
      pMove(390, 300, 100) // last segment 10px/100ms = 0.1 px/ms
      pEnd(390, 300) // dx=-110 < 256, vx 0.1 < 0.5
      expect(pagerEndFn).toHaveBeenCalledWith(-110, false)
   })

   it("a flick commits below the distance threshold", () => {
      pStart(500, 300)
      pMove(470, 300, 16)
      pMove(420, 300, 16) // last segment 50px/16ms ≈ 3.1 px/ms
      pEnd(420, 300) // dx=-80 < 256 but flicked
      expect(pagerEndFn).toHaveBeenCalledWith(-80, true)
   })

   it("resist mode never commits, whatever the distance", () => {
      pagerEngage.mockReturnValue("resist")
      pStart(500, 300)
      for (const x of [400, 200, 60]) pMove(x, 300)
      pEnd(60, 300) // dx=-440
      expect(pagerEndFn).toHaveBeenCalledWith(-440, false)
   })

   it("skip declines the gesture: no further moves, no end", () => {
      pagerEngage.mockReturnValue("skip")
      pStart(500, 300)
      pMove(400, 300)
      pMove(300, 300)
      pEnd(300, 300)
      expect(pagerMoveFn).not.toHaveBeenCalled()
      expect(pagerEndFn).not.toHaveBeenCalled()
   })

   it("a drag that returns past its origin does not commit against the engaged side", () => {
      pStart(300, 300)
      pMove(240, 300) // engaged as next
      pMove(600, 300) // reversed: dx now +300
      pEnd(600, 300)
      expect(pagerEndFn).toHaveBeenCalledWith(300, false)
   })

   it("a second finger cancels an engaged drag", () => {
      pStart(300, 300)
      pMove(240, 300)
      dispatchTouch("touchstart", [
         { clientX: 240, clientY: 300 },
         { clientX: 400, clientY: 300 },
      ])
      expect(pagerCancelFn).toHaveBeenCalledTimes(1)
   })

   // The pager's half of that same 3+-finger branch — the cancel added for this
   // machine, which the row case above cannot speak for.
   it("a third finger cancels an engaged drag", () => {
      pStart(300, 300)
      pMove(240, 300)
      dispatchTouch("touchstart", [
         { clientX: 240, clientY: 300 },
         { clientX: 400, clientY: 300 },
         { clientX: 500, clientY: 300 },
      ])
      expect(pagerCancelFn).toHaveBeenCalledTimes(1)
   })

   it("touchcancel cancels an engaged drag", () => {
      pStart(300, 300)
      pMove(240, 300)
      dispatchTouch("touchcancel", [])
      expect(pagerCancelFn).toHaveBeenCalledTimes(1)
   })

   // The two-finger→one-finger re-seed, the pager's half of the case the pull
   // and the cycle each own above. It is deliberately dispatched ON the reader,
   // so containment is NOT what declines it: the touchend branch re-seeds the
   // surviving finger with a NULL target, and that is the whole reason a gesture
   // that began with two fingers can never become a page turn. Without it a
   // finger left over from a pinch-zoom would engage on its next move and page
   // the article out from under the zoom.
   it("a gesture that began with two fingers never becomes a pager drag", () => {
      dispatchTouch(
         "touchstart",
         [
            { clientX: 300, clientY: 300 },
            { clientX: 400, clientY: 300 },
         ],
         undefined,
         inReader(),
      )
      // One lifts, one stays down at x=300 → re-seeded as a fresh single gesture.
      // Dispatched on the reader too (not the `end` helper's document default),
      // so `e.target` IS inside the surface: the explicit null is then the only
      // thing declining, and swapping it for `e.target` fails this case.
      dispatchTouch("touchend", [{ clientX: 300, clientY: 300 }], [{ clientX: 400, clientY: 300 }], inReader())
      pMove(120, 300) // a drag that engages on its own from a real single start
      expect(pagerEngage).not.toHaveBeenCalled()
      expect(pagerMoveFn).not.toHaveBeenCalled()
   })

   it("a touch starting OUTSIDE the surface never engages (overlays are inert structurally)", () => {
      const overlay = document.createElement("div")
      document.body.appendChild(overlay)
      dispatchTouch("touchstart", [{ clientX: 500, clientY: 300 }], undefined, overlay)
      pMove(100, 300)
      pEnd(100, 300)
      expect(pagerEngage).not.toHaveBeenCalled()
   })

   it("a hidden surface never engages (the reader behind the list)", () => {
      readerEl.hidden = true
      pStart(500, 300)
      pMove(100, 300)
      expect(pagerEngage).not.toHaveBeenCalled()
   })

   it("a touch inside a horizontally scrollable element is that element's scroll", () => {
      const pre = document.createElement("pre")
      readerEl.appendChild(pre)
      Object.defineProperty(pre, "scrollWidth", { value: 900, configurable: true })
      Object.defineProperty(pre, "clientWidth", { value: 300, configurable: true })
      dispatchTouch("touchstart", [{ clientX: 500, clientY: 300 }], undefined, pre)
      pMove(100, 300)
      expect(pagerEngage).not.toHaveBeenCalled()
   })
})
