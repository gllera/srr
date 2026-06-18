import { describe, it, expect, vi, beforeEach } from "vitest"

// The touch state machine (one-finger swipe / two-finger cycle) needs real
// Touch dispatch and is left to the e2e-browser layer (Puppeteer CDP). Here we
// cover the jsdom-feasible half: the scroll-driven toolbar hide/show and the
// resetScroll re-baseline.

const dropdown = vi.hoisted(() => ({ closeAllDropdowns: vi.fn() }))
vi.mock("./dropdown", () => dropdown)
vi.mock("./nav", () => ({ left: vi.fn(), right: vi.fn() }))

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
   document.body.innerHTML = `<nav class="srr-toolbar"></nav>
      <button class="srr-prev"></button><button class="srr-next"></button>`
   toolbar = document.querySelector(".srr-toolbar")!
   g = setupGestures({
      prev: document.querySelector(".srr-prev")!,
      next: document.querySelector(".srr-next")!,
      toolbar,
      guard: vi.fn(),
      edgeBump: vi.fn(),
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

   it("reveals the toolbar at the bottom even though we got there scrolling down", () => {
      setScrollY(200)
      scroll()
      expect(slid()).toBe(true) // hidden on the way down
      // Keep scrolling down, this time landing at the very bottom (scrollY +
      // innerHeight === scrollHeight). Still a downward scroll, but it reveals.
      setScrollHeight(800 + 1000) // innerHeight + 1000
      setScrollY(1000)
      scroll()
      expect(slid()).toBe(false)
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
