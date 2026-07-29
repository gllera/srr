import { describe, it, expect, vi } from "vitest"
import { windowScroller, elementScroller } from "./scroller"

describe("scroller", () => {
   it("windowScroller mirrors the window", () => {
      const sc = windowScroller()
      expect(sc.root()).toBeNull()
      expect(sc.viewportH()).toBeGreaterThan(0) // jsdom innerHeight (768)
      expect(sc.absTop(100)).toBe(100 + window.scrollY)
   })

   it("elementScroller reads and writes the host's scrollTop", () => {
      const host = document.createElement("div")
      const sc = elementScroller(host)
      sc.to(120)
      expect(host.scrollTop).toBe(120)
      expect(sc.y()).toBe(120)
      expect(sc.root()).toBe(host)
   })

   it("elementScroller.absTop converts a viewport rect to pane coordinates", () => {
      const host = document.createElement("div")
      host.scrollTop = 50
      vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect)
      const sc = elementScroller(host)
      // rectTop 110 in the viewport, pane top at 10, scrolled 50 → 150 absolute.
      expect(sc.absTop(110)).toBe(150)
   })

   it("elementScroller.viewportH falls back past a zero clientHeight (jsdom)", () => {
      const host = document.createElement("div")
      const sc = elementScroller(host)
      expect(sc.viewportH()).toBe(window.innerHeight || 900)
   })

   it("elementScroller.smoothTo degrades to an instant jump when scrollTo throws", () => {
      const host = document.createElement("div")
      host.scrollTo = () => {
         throw new Error("not implemented")
      }
      const sc = elementScroller(host)
      sc.smoothTo(80)
      expect(host.scrollTop).toBe(80)
   })
})
