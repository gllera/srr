// pane.test.ts — the module writes a custom property on <html> and a class on
// <body>, so each test gets a fresh instance via resetModules + dynamic import
// (the split.test.ts idiom).
import { describe, it, expect, beforeEach, vi } from "vitest"

import { PANE_HIDDEN_KEY, PANE_WIDTH_KEY } from "./keys"

const openW = () => document.documentElement.style.getPropertyValue("--split-pane-open-w")

describe("pane", () => {
   beforeEach(() => {
      // The throwing-storage case spies on Storage.prototype; restore before the
      // next test so a reordering can't leave every later write silently dead.
      vi.restoreAllMocks()
      vi.resetModules()
      localStorage.clear()
      document.body.className = ""
      document.documentElement.removeAttribute("style")
      vi.stubGlobal("innerWidth", 1600)
   })

   it("clamps to the floor and the ceiling", async () => {
      const pane = await import("./pane")
      expect(pane.clampPaneW(120, 1600)).toBe(pane.PANE_MIN_W)
      expect(pane.clampPaneW(9000, 1600)).toBe(560)
      expect(pane.clampPaneW(420, 1600)).toBe(420)
   })

   it("caps the ceiling at half the viewport on a narrow window", async () => {
      const pane = await import("./pane")
      // 50% of 1000 = 500, under the 560 absolute cap.
      expect(pane.clampPaneW(9000, 1000)).toBe(500)
      // …but the floor always wins: a viewport so narrow that half of it is
      // under the minimum must not produce a max BELOW the min.
      expect(pane.clampPaneW(9000, 400)).toBe(pane.PANE_MIN_W)
   })

   // Math.min/max propagate NaN, so an unguarded clamp hands setPaneW a NaN and
   // the property becomes the invalid string "NaNpx" — the pane snapping back to
   // the token default mid-drag rather than stopping at its floor.
   it("is total over a NaN width or viewport", async () => {
      const pane = await import("./pane")
      expect(pane.clampPaneW(NaN, 1600)).toBe(pane.PANE_DEFAULT_W)
      expect(pane.clampPaneW(420, NaN)).toBe(420)
      pane.applyDragWidth(NaN, 1600, { persist: true })
      expect(openW()).toBe(`${pane.PANE_DEFAULT_W}px`)
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe(String(pane.PANE_DEFAULT_W))
   })

   it("defaults with nothing stored, and re-clamps a width stored on a wider screen", async () => {
      const pane = await import("./pane")
      expect(pane.storedPaneW(1600)).toBe(pane.PANE_DEFAULT_W)
      localStorage.setItem(PANE_WIDTH_KEY, "540")
      expect(pane.storedPaneW(1600)).toBe(540)
      // Same stored value, now on a 1000px laptop: half the viewport is 500.
      expect(pane.storedPaneW(1000)).toBe(500)
   })

   it("ignores a non-numeric stored width rather than producing NaN", async () => {
      const pane = await import("./pane")
      localStorage.setItem(PANE_WIDTH_KEY, "wide")
      expect(pane.storedPaneW(1600)).toBe(pane.PANE_DEFAULT_W)
   })

   it("writes the open width onto <html> and persists only when asked", async () => {
      const pane = await import("./pane")
      pane.setPaneW(420, { persist: false })
      expect(openW()).toBe("420px")
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe(null)
      pane.setPaneW(430, { persist: true })
      expect(openW()).toBe("430px")
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe("430")
   })

   it("toggles hidden as a body class plus a stored flag", async () => {
      const pane = await import("./pane")
      expect(pane.isPaneHidden()).toBe(false)
      pane.setPaneHidden(true)
      expect(document.body.classList.contains("srr-pane-hidden")).toBe(true)
      expect(localStorage.getItem(PANE_HIDDEN_KEY)).toBe("1")
      pane.setPaneHidden(false)
      expect(document.body.classList.contains("srr-pane-hidden")).toBe(false)
      expect(localStorage.getItem(PANE_HIDDEN_KEY)).toBe(null)
   })

   it("togglePane flips, and honours an explicit force in both directions", async () => {
      const pane = await import("./pane")
      pane.togglePane()
      expect(pane.isPaneHidden()).toBe(true)
      pane.togglePane(true) // force-hidden while already hidden: a no-op
      expect(pane.isPaneHidden()).toBe(true)
      pane.togglePane(false)
      expect(pane.isPaneHidden()).toBe(false)
   })

   it("restores the stored width AND the stored hidden flag", async () => {
      localStorage.setItem(PANE_WIDTH_KEY, "500")
      localStorage.setItem(PANE_HIDDEN_KEY, "1")
      const pane = await import("./pane")
      pane.restorePane()
      expect(openW()).toBe("500px")
      expect(pane.isPaneHidden()).toBe(true)
   })

   // Restore is a READ. A boot that wrote back what it just read would turn the
   // module's own defaults into stored preferences the user never expressed —
   // and would then survive a later change to PANE_DEFAULT_W.
   it("restores defaults from an empty store without writing anything back", async () => {
      const pane = await import("./pane")
      // Counted, not just end-state asserted: a redundant removeItem on an
      // already-absent key leaves storage looking exactly like no write at all.
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")
      pane.restorePane()
      expect(openW()).toBe(`${pane.PANE_DEFAULT_W}px`)
      expect(pane.isPaneHidden()).toBe(false)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
   })

   it("a drag below the collapse threshold hides instead of clamping", async () => {
      const pane = await import("./pane")
      // 230 is under PANE_COLLAPSE_W (240) — collapse, and do NOT overwrite the
      // stored width, so re-opening restores the last real one.
      localStorage.setItem(PANE_WIDTH_KEY, "430")
      pane.applyDragWidth(230, 1600, { persist: true })
      expect(pane.isPaneHidden()).toBe(true)
      expect(localStorage.getItem(PANE_HIDDEN_KEY)).toBe("1")
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe("430")
      // Anything at or above the threshold is a normal (clamped) resize.
      pane.applyDragWidth(260, 1600, { persist: true })
      expect(pane.isPaneHidden()).toBe(false)
      expect(localStorage.getItem(PANE_HIDDEN_KEY)).toBe(null)
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe(String(pane.PANE_MIN_W))
   })

   // The threshold is the first width that means "let go of the pane", not the
   // last that doesn't — so `<` and `<=` are different features, and only a
   // probe AT the boundary can tell them apart.
   it("treats exactly PANE_COLLAPSE_W as a resize, not a collapse", async () => {
      const pane = await import("./pane")
      pane.applyDragWidth(pane.PANE_COLLAPSE_W, 1600, { persist: true })
      expect(pane.isPaneHidden()).toBe(false)
      expect(openW()).toBe(`${pane.PANE_MIN_W}px`)
      // One pixel under it is the collapse.
      pane.applyDragWidth(pane.PANE_COLLAPSE_W - 1, 1600, { persist: true })
      expect(pane.isPaneHidden()).toBe(true)
   })

   // A drag drives this once per animation frame. If the visibility half ignored
   // `persist` it would hit localStorage on every one of those frames — the
   // write spam the flag exists to prevent. End-state assertions cannot see a
   // redundant write, so count the calls.
   it("makes zero storage writes on an unpersisted drag, in BOTH branches", async () => {
      const pane = await import("./pane")
      localStorage.setItem(PANE_WIDTH_KEY, "430")
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      // A frame above the threshold: the width applies, nothing is stored.
      pane.applyDragWidth(420, 1600)
      expect(openW()).toBe("420px")
      expect(pane.isPaneHidden()).toBe(false)
      // A frame after the pointer crosses the collapse line: the class applies.
      pane.applyDragWidth(200, 1600)
      expect(pane.isPaneHidden()).toBe(true)
      // …and back out again, the other direction of the same branch.
      pane.applyDragWidth(300, 1600)
      expect(pane.isPaneHidden()).toBe(false)

      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe("430")
   })

   it("survives a localStorage that throws", async () => {
      const pane = await import("./pane")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
         throw new Error("quota")
      })
      expect(() => pane.setPaneW(400, { persist: true })).not.toThrow()
      expect(openW()).toBe("400px")
   })

   it("survives a localStorage that throws on READ too", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
         throw new Error("blocked")
      })
      const pane = await import("./pane")
      expect(pane.storedPaneW(1600)).toBe(pane.PANE_DEFAULT_W)
      expect(() => pane.restorePane()).not.toThrow()
      expect(openW()).toBe(`${pane.PANE_DEFAULT_W}px`)
   })
})
