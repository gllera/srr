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

   // A 380px pane beside a 680px measure on a 2560px monitor leaves ~750px of
   // nothing on BOTH sides of the text: the column centres in what the pane
   // leaves, so the emptier the remainder, the further the text drifts from the
   // pane. The ceiling therefore grows with the viewport — and the fraction is
   // chosen so it lands exactly on the old constant at 1600, which is why no
   // width at or below that moves.
   it("lets the ceiling grow on a wide monitor, without moving any narrower one", async () => {
      const pane = await import("./pane")
      // The seam: 35% of 1600 IS 560, so the two rules agree here to the pixel.
      expect(pane.clampPaneW(9000, 1600)).toBe(pane.PANE_MAX_W)
      // Below it the old constant still floors the ceiling — 35% of 1200 is 420,
      // which must NOT become the max.
      expect(pane.clampPaneW(9000, 1200)).toBe(pane.PANE_MAX_W)
      // Above it the pane may genuinely grow.
      expect(pane.clampPaneW(9000, 2560)).toBe(896)
      // …but not without end: a 4K monitor stops at the absolute ceiling rather
      // than handing over 1344px of pane.
      expect(pane.clampPaneW(9000, 3840)).toBe(pane.PANE_MAX_CEIL)
   })

   it("re-clamps a wide-monitor width down on a narrower screen", async () => {
      const pane = await import("./pane")
      localStorage.setItem(PANE_WIDTH_KEY, "896")
      expect(pane.storedPaneW(2560)).toBe(896)
      // The same stored preference on a 1600 laptop is over that screen's
      // ceiling, and READ-clamping is what stops it leaking across machines.
      expect(pane.storedPaneW(1600)).toBe(pane.PANE_MAX_W)
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

   it("initPane restores, and steps the width from the keyboard", async () => {
      document.body.innerHTML = `<div class="srr-pane-grip"></div>`
      document.body.classList.add("srr-split")
      const settled: number[] = []
      const pane = await import("./pane")
      pane.initPane({ onSettle: () => settled.push(1) })
      expect(openW()).toBe("380px")

      const grip = document.querySelector(".srr-pane-grip")!
      const press = (key: string, shiftKey = false) =>
         grip.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }))

      press("ArrowRight")
      expect(openW()).toBe("396px")
      press("ArrowLeft", true)
      expect(openW()).toBe("332px")
      press("Home")
      expect(openW()).toBe(`${pane.PANE_MIN_W}px`)
      press("End")
      expect(openW()).toBe("560px")
      press("Enter")
      expect(pane.isPaneHidden()).toBe(true)
      // Every committed step asks for one re-layout.
      expect(settled.length).toBe(5)
   })

   it("publishes the grip's range and position for assistive tech", async () => {
      document.body.innerHTML = `<div class="srr-pane-grip"></div>`
      document.body.classList.add("srr-split")
      const pane = await import("./pane")
      pane.initPane({ onSettle: () => {} })
      const grip = document.querySelector(".srr-pane-grip")!
      expect(grip.getAttribute("aria-valuemin")).toBe(String(pane.PANE_MIN_W))
      expect(grip.getAttribute("aria-valuemax")).toBe("560")
      expect(grip.getAttribute("aria-valuenow")).toBe(String(pane.PANE_DEFAULT_W))
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
      expect(grip.getAttribute("aria-valuenow")).toBe("396")
   })

   // The grip reads what is ON SCREEN, never what is in storage. With storage
   // blocked (private mode, quota) lsSet silently no-ops while the LAYOUT still
   // applies, so a storage-sourced aria-valuenow announces 380 at a pane the eye
   // sees at 412 — and a storage-sourced step never accumulates either. The
   // SECOND press is what separates the two readings: from storage every press
   // restates 396, from the applied property they add up.
   it("steps and announces the width it applied, not the width it failed to store", async () => {
      document.body.innerHTML = `<div class="srr-pane-grip"></div>`
      document.body.classList.add("srr-split")
      const pane = await import("./pane")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
         throw new Error("quota")
      })
      pane.initPane({ onSettle: () => {} })
      const grip = document.querySelector(".srr-pane-grip")!
      const press = () =>
         grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
      press()
      expect(openW()).toBe("396px")
      expect(grip.getAttribute("aria-valuenow")).toBe("396")
      press()
      expect(openW()).toBe("412px")
      expect(grip.getAttribute("aria-valuenow")).toBe("412")
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe(null)
   })

   // The button ships three assertions in index.html — an accessible name, an
   // aria-expanded and an aria-keyshortcuts — and every one of them is a claim
   // nothing kept true until something synced it. The NAME is the half that
   // cannot be read off the class: it has to say what the press will do ("Hide
   // list" over a pane that is there), which is the opposite of the state.
   it("keeps the toggle button's label, title and aria-expanded in step", async () => {
      document.body.innerHTML = `
         <div class="srr-pane-grip"></div>
         <button class="srr-pane-toggle" aria-expanded="true"></button>`
      document.body.classList.add("srr-split")
      const settled: number[] = []
      const pane = await import("./pane")
      pane.initPane({ onSettle: () => settled.push(1) })
      const btn = document.querySelector(".srr-pane-toggle") as HTMLButtonElement

      expect(btn.getAttribute("aria-expanded")).toBe("true")
      expect(btn.getAttribute("aria-label")).toBe("Hide list")
      expect(btn.title).toBe("Hide list (L)")

      btn.click()
      expect(pane.isPaneHidden()).toBe(true)
      expect(btn.getAttribute("aria-expanded")).toBe("false")
      expect(btn.getAttribute("aria-label")).toBe("Show list")
      expect(btn.title).toBe("Show list (L)")
      // A press is a committed gesture: it persists, and it asks for the one
      // re-layout the grip's own Enter asks for.
      expect(localStorage.getItem(PANE_HIDDEN_KEY)).toBe("1")
      expect(settled.length).toBe(1)

      btn.click()
      expect(pane.isPaneHidden()).toBe(false)
      expect(btn.getAttribute("aria-expanded")).toBe("true")
      expect(btn.getAttribute("aria-label")).toBe("Hide list")
      expect(settled.length).toBe(2)
   })

   // initPane restores BEFORE anything else, and restore reaches the same sync —
   // so the cached ref has to be in place before that call. Cache it after and a
   // reload into a hidden pane paints a button that still says "Hide list".
   it("syncs the toggle when the state is restored from storage", async () => {
      localStorage.setItem(PANE_HIDDEN_KEY, "1")
      document.body.innerHTML = `<button class="srr-pane-toggle" aria-expanded="true"></button>`
      document.body.classList.add("srr-split")
      const pane = await import("./pane")
      pane.initPane({ onSettle: () => {} })
      const btn = document.querySelector(".srr-pane-toggle")!
      expect(btn.getAttribute("aria-expanded")).toBe("false")
      expect(btn.getAttribute("aria-label")).toBe("Show list")
   })

   // The path no press covers. applyDragWidth's collapse branch calls the class
   // toggle DIRECTLY — it has to, because a mid-drag frame must not touch
   // storage — so a sync wired into the committed setter alone leaves the button
   // announcing "Hide list" over a pane the drag has just taken off screen.
   it("syncs the toggle from a drag that collapses the pane", async () => {
      document.body.innerHTML = `
         <div class="srr-pane-grip"></div>
         <button class="srr-pane-toggle" aria-expanded="true"></button>`
      document.body.classList.add("srr-split")
      const pane = await import("./pane")
      pane.initPane({ onSettle: () => {} })
      const btn = document.querySelector(".srr-pane-toggle")!

      pane.applyDragWidth(pane.PANE_COLLAPSE_W - 1, 1600)
      expect(pane.isPaneHidden()).toBe(true)
      expect(btn.getAttribute("aria-expanded")).toBe("false")
      expect(btn.getAttribute("aria-label")).toBe("Show list")
      // …and dragging back out re-opens it: the same path, the other direction.
      pane.applyDragWidth(400, 1600)
      expect(btn.getAttribute("aria-expanded")).toBe("true")
      expect(btn.getAttribute("aria-label")).toBe("Hide list")
   })

   // A reset needs a gesture a drag cannot reach, and double-click is the one
   // every splitter in every OS uses. It is also the only path back to the
   // default, so nothing else would notice it drifting.
   it("double-click resets to the default width, persists it, and settles once", async () => {
      document.body.innerHTML = `<div class="srr-pane-grip"></div>`
      document.body.classList.add("srr-split")
      const settled: number[] = []
      const pane = await import("./pane")
      pane.initPane({ onSettle: () => settled.push(1) })
      const grip = document.querySelector(".srr-pane-grip")!
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }))
      expect(openW()).toBe("560px")
      settled.length = 0

      grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
      expect(openW()).toBe(`${pane.PANE_DEFAULT_W}px`)
      expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe(String(pane.PANE_DEFAULT_W))
      expect(settled.length).toBe(1)
   })
})
