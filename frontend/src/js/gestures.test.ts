import { describe, it, expect, vi, beforeEach } from "vitest"

// The touch state machine (one-finger swipe / two-finger cycle) needs real
// Touch dispatch and is left to the e2e-browser layer (Puppeteer CDP). Here we
// cover the jsdom-feasible half: the scroll-driven toolbar hide/show, the
// resetScroll re-baseline, and the read-progress (--read) clamp.

const dropdown = vi.hoisted(() => ({ closeAllDropdowns: vi.fn() }))
vi.mock("./dropdown", () => dropdown)
vi.mock("./nav", () => ({ left: vi.fn(), right: vi.fn() }))

import { setupGestures, type Gestures } from "./gestures"

const setScrollY = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true })
const scroll = () => window.dispatchEvent(new Event("scroll"))

let toolbar: HTMLElement
let reader: HTMLElement
let g: Gestures

function mount(): void {
   document.body.innerHTML = `<nav class="srr-toolbar"></nav><article class="srr-reader"></article>
      <button class="srr-prev"></button><button class="srr-next"></button>`
   toolbar = document.querySelector(".srr-toolbar")!
   reader = document.querySelector(".srr-reader")!
   g = setupGestures({
      prev: document.querySelector(".srr-prev")!,
      next: document.querySelector(".srr-next")!,
      toolbar,
      reader,
      guard: vi.fn(),
      onCycle: vi.fn(),
   })
}

// Stub the reader's layout so updateReadProgress is deterministic.
const layout = (height: number, top: number, innerHeight = 800) => {
   Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true })
   reader.getBoundingClientRect = () => ({
      height,
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
   })
}

beforeEach(() => {
   dropdown.closeAllDropdowns.mockClear()
   setScrollY(0)
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

describe("read-progress (--read)", () => {
   const read = () => reader.style.getPropertyValue("--read")

   it("inks a short (unscrollable) article fully (--read = 1)", () => {
      layout(500, 0) // height < viewport → scrollable <= 10
      g.syncReadProgress()
      expect(read()).toBe("1")
   })

   it("sets the scrolled fraction for a long article", () => {
      layout(2000, -600) // scrollable = 1200; scrolled 600 past the top → 0.5
      g.syncReadProgress()
      expect(read()).toBe("0.5")
   })

   it("clamps the fraction to [0,1]", () => {
      layout(2000, -5000) // scrolled way past → clamps to 1
      g.syncReadProgress()
      expect(read()).toBe("1")
   })

   it("is a no-op on the list (hidden reader)", () => {
      reader.hidden = true
      g.syncReadProgress()
      expect(read()).toBe("") // --read never set
   })
})
