import { describe, it, expect, vi, beforeEach } from "vitest"

// Two halves, both driven in jsdom: the scroll-linked toolbar hide/show +
// resetScroll, and the touch state machine (one-finger swipe = prev/next,
// two-finger vertical = cycle filter, pinch discrimination, finger-lift re-seed,
// touchcancel). jsdom has no real Touch dispatch, but the handlers only read
// plain {clientX,clientY} off e.touches/e.changedTouches and never test
// `instanceof TouchEvent`, so a synthesized Event with those props defined
// drives the whole machine here — no browser needed.

const dropdown = vi.hoisted(() => ({ closeAllDropdowns: vi.fn() }))
vi.mock("./dropdown", () => dropdown)

import { setupGestures, type Gestures } from "./gestures"

const setScrollY = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true })
// jsdom has no layout, so the scroll handler's at-bottom check needs explicit
// page dimensions: a viewport and a content height. Default to a tall page so
// the hide/show tests are nowhere near the bottom.
const setInnerHeight = (h: number) => Object.defineProperty(window, "innerHeight", { value: h, configurable: true })
const setScrollHeight = (h: number) =>
   Object.defineProperty(document.documentElement, "scrollHeight", { value: h, configurable: true })
const scroll = () => window.dispatchEvent(new Event("scroll"))

let toolbar: HTMLElement
let g: Gestures
let goPrev: ReturnType<typeof vi.fn>
let goNext: ReturnType<typeof vi.fn>
let onCycle: ReturnType<typeof vi.fn>

function mount(): void {
   document.body.innerHTML = `<nav class="srr-toolbar"></nav>`
   toolbar = document.querySelector(".srr-toolbar")!
   goPrev = vi.fn()
   goNext = vi.fn()
   onCycle = vi.fn()
   g = setupGestures({ toolbar, goPrev, goNext, onCycle })
}

beforeEach(() => {
   dropdown.closeAllDropdowns.mockClear()
   setScrollY(0)
   setInnerHeight(800)
   setScrollHeight(4000) // a tall page: the hide/show tests are far from the bottom
   mount()
})

describe("scroll-driven toolbar hide/show", () => {
   const slid = () => toolbar.classList.contains("srr-toolbar-slide")

   it("hides the toolbar on a downward scroll past 50px and closes any open dropdown", () => {
      setScrollY(120)
      scroll()
      expect(slid()).toBe(true)
      expect(dropdown.closeAllDropdowns).toHaveBeenCalled()
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
function dispatchTouch(type: string, touches: Pt[], changed: Pt[] = touches): Event {
   const e = new Event(type, { bubbles: true, cancelable: true })
   Object.defineProperty(e, "touches", { value: touches, configurable: true })
   Object.defineProperty(e, "changedTouches", { value: changed, configurable: true })
   document.dispatchEvent(e)
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
