import { describe, it, expect, vi, beforeEach } from "vitest"

// The touch state machine (one-finger swipe / two-finger cycle) needs real
// Touch dispatch and is left to the e2e-browser layer (Puppeteer CDP). Here we
// cover the jsdom-feasible half: the scroll-driven toolbar hide/show and the
// resetScroll re-baseline.

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

function mount(): void {
   document.body.innerHTML = `<nav class="srr-toolbar"></nav>`
   toolbar = document.querySelector(".srr-toolbar")!
   g = setupGestures({
      toolbar,
      goPrev: vi.fn(),
      goNext: vi.fn(),
      onCycle: vi.fn(),
   })
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
