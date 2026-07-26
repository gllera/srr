import { describe, it, expect, vi, beforeEach } from "vitest"

// Two halves, both driven in jsdom: the scroll-linked toolbar hide/show +
// resetScroll, and the touch state machine (one-finger swipe = prev/next,
// two-finger vertical = cycle filter, pinch discrimination, finger-lift re-seed,
// touchcancel). jsdom has no real Touch dispatch, but the handlers only read
// plain {clientX,clientY} off e.touches/e.changedTouches and never test
// `instanceof TouchEvent`, so a synthesized Event with those props defined
// drives the whole machine here — no browser needed.

import { ROW_SWIPE_TRIGGER, setPullRefresh, setRowSwipe, setupGestures, type Gestures } from "./gestures"

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
let goPrev: ReturnType<typeof vi.fn>
let goNext: ReturnType<typeof vi.fn>
let onCycle: ReturnType<typeof vi.fn>
let pullRun: ReturnType<typeof vi.fn>
let rowMove: ReturnType<typeof vi.fn>
let rowAct: ReturnType<typeof vi.fn>

function mount(): void {
   // body's own class list survives an innerHTML reset (only its children are
   // replaced), so it's cleared explicitly to keep srr-toolbar-hidden from
   // leaking a stale value across tests.
   document.body.className = ""
   document.body.innerHTML =
      `<nav class="srr-toolbar"></nav>` +
      `<div class="srr-list"><a class="srr-row"><span class="srr-row-title">t</span></a></div>` +
      `<div class="srr-player"></div>`
   toolbar = document.querySelector(".srr-toolbar")!
   listEl = document.querySelector(".srr-list")!
   rowA = document.querySelector("a.srr-row")!
   goPrev = vi.fn()
   goNext = vi.fn()
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
   g = setupGestures({ toolbar, goPrev, goNext, onCycle })
}

beforeEach(() => {
   setScrollY(0)
   setInnerHeight(800)
   setScrollHeight(4000) // a tall page: the hide/show tests are far from the bottom
   mount()
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

describe("one-finger swipe", () => {
   it("a left swipe (finger moves left) steps to the next article", () => {
      start([{ clientX: 200, clientY: 300 }])
      end([], [{ clientX: 100, clientY: 300 }]) // dx = -100
      expect(goNext).toHaveBeenCalledTimes(1)
      expect(goPrev).not.toHaveBeenCalled()
   })

   it("a right swipe steps to the previous article", () => {
      start([{ clientX: 100, clientY: 300 }])
      end([], [{ clientX: 200, clientY: 300 }]) // dx = +100
      expect(goPrev).toHaveBeenCalledTimes(1)
      expect(goNext).not.toHaveBeenCalled()
   })

   it("ignores a sub-threshold horizontal move (<50px)", () => {
      start([{ clientX: 100, clientY: 300 }])
      end([], [{ clientX: 135, clientY: 300 }]) // dx = 35
      expect(goPrev).not.toHaveBeenCalled()
      expect(goNext).not.toHaveBeenCalled()
   })

   it("ignores a vertical-dominant move even past the threshold (|dy| > |dx|)", () => {
      start([{ clientX: 100, clientY: 300 }])
      end([], [{ clientX: 170, clientY: 420 }]) // dx=70, dy=120
      expect(goPrev).not.toHaveBeenCalled()
      expect(goNext).not.toHaveBeenCalled()
   })

   it("does not fire off a stale start after a 3+-finger touch", () => {
      // 3 fingers = not a gesture we handle (mode → none); the lift must not read
      // a stale touchStartX and fire a spurious prev/next.
      start([
         { clientX: 100, clientY: 300 },
         { clientX: 200, clientY: 300 },
         { clientX: 300, clientY: 300 },
      ])
      end([], [{ clientX: 400, clientY: 300 }]) // would be a big swipe, but ignored
      expect(goPrev).not.toHaveBeenCalled()
      expect(goNext).not.toHaveBeenCalled()
   })

   it("resets on touchcancel so the following lift is inert", () => {
      start([{ clientX: 100, clientY: 300 }])
      dispatchTouch("touchcancel", [])
      end([], [{ clientX: 220, clientY: 300 }]) // dx=+120, but cancelled
      expect(goPrev).not.toHaveBeenCalled()
      expect(goNext).not.toHaveBeenCalled()
   })
})

// RDR16: the player bar's seek control is a horizontal drag identical in
// shape to a swipe, and the document handlers above have no target
// filtering — without the guard, scrubbing would fire prev/next instead of
// seeking. `.srr-player` stops the touchstart from ever reaching them.
describe("player gesture guard (RDR16)", () => {
   it("a touchstart inside .srr-player stops an otherwise-qualifying swipe from firing", () => {
      const player = document.querySelector(".srr-player")!
      dispatchTouch("touchstart", [{ clientX: 200, clientY: 300 }], undefined, player)
      end([], [{ clientX: 100, clientY: 300 }]) // dx = -100, would be goNext anywhere else
      expect(goNext).not.toHaveBeenCalled()
      expect(goPrev).not.toHaveBeenCalled()
   })

   it("an identical swipe starting outside .srr-player still navigates", () => {
      start([{ clientX: 200, clientY: 300 }])
      end([], [{ clientX: 100, clientY: 300 }]) // dx = -100
      expect(goNext).toHaveBeenCalledTimes(1)
      expect(goPrev).not.toHaveBeenCalled()
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

   it("re-seeds a single swipe when one finger lifts before the other", () => {
      twoStart()
      // one finger lifts, one remains at x=100 → re-seed as a fresh single swipe
      end([{ clientX: 100, clientY: 300 }], [{ clientX: 200, clientY: 300 }])
      // the remaining finger swipes right and lifts
      end([], [{ clientX: 200, clientY: 300 }]) // dx = +100 from the re-seeded start
      expect(goPrev).toHaveBeenCalledTimes(1)
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

   it("axis lock: an engaged pull never also fires the horizontal swipe", () => {
      const t = on(listEl)
      t.start(100)
      t.move(200) // vertical: the pull takes the gesture
      t.end(200, 280) // dx=+130 > |dy|=100 — a committed right swipe, but for the lock
      expect(pullRun).toHaveBeenCalledTimes(1)
      expect(goPrev).not.toHaveBeenCalled()
      expect(goNext).not.toHaveBeenCalled()
   })

   it("axis lock: a horizontal swipe keeps the gesture even if it later drifts down", () => {
      const t = on(listEl)
      t.start(100)
      t.move(104, 230) // dx=80 dominates → the swipe owns it from here
      t.move(220, 230) // a later downward drift must not start a pull
      t.end(110, 240) // dx=+90, |dy|=10 → the swipe still lands
      expect(pullRun).not.toHaveBeenCalled()
      expect(goPrev).toHaveBeenCalledTimes(1)
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

   it("axis lock: an engaged row swipe never also steps the reader", () => {
      swipe(-(ROW_SWIPE_TRIGGER + 60)) // well past the reader's own 50px threshold
      expect(rowAct).toHaveBeenCalledWith(rowA, -1)
      expect(goNext).not.toHaveBeenCalled()
      expect(goPrev).not.toHaveBeenCalled()
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
