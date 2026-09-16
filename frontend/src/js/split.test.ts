// split.test.ts — the module holds a matchMedia subscription, so each test gets
// a fresh instance via resetModules + dynamic import (the dropdown.test.ts idiom).
// initSplit writes model.split; layout.ts's effect is what stamps the class. All
// three modules come from ONE post-reset registry (the model-instance trap).
import { describe, it, expect, beforeEach, vi } from "vitest"

type MQLListener = (e: { matches: boolean }) => void

async function load() {
   const split = await import("./split")
   const model = await import("./model")
   const { initLayout } = await import("./layout")
   const start = () => {
      split.initSplit()
      initLayout({ listView: document.createElement("div"), article: document.createElement("article") })
   }
   return { split, model, start }
}

describe("split", () => {
   let matches: boolean
   let printing: boolean
   let fire: MQLListener | null

   beforeEach(() => {
      vi.resetModules()
      document.body.className = ""
      matches = false
      fire = null
      printing = false
      vi.stubGlobal("matchMedia", (query: string) => {
         // Two queries: the breakpoint the module owns, and the print probe the
         // crossing handler consults (Chrome re-evaluates width queries against
         // the page box while printing).
         if (query === "print") return { matches: printing, addEventListener: () => {} }
         expect(query).toBe("(min-width: 1000px)")
         return {
            matches,
            addEventListener: (_: string, fn: MQLListener) => {
               fire = fn
            },
         }
      })
   })

   it("writes model.split at init, and the layout effect stamps body.srr-split", async () => {
      matches = true
      const { split, model, start } = await load()
      start()
      expect(model.split()).toBe(true)
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(split.isSplit()).toBe(true)
   })

   it("stays narrow when the query does not match", async () => {
      const { split, model, start } = await load()
      start()
      expect(model.split()).toBe(false)
      expect(split.isSplit()).toBe(false)
   })

   it("does not stamp the class itself — that is layout.ts's", async () => {
      matches = true
      const split = await import("./split")
      split.initSplit()
      expect(document.body.classList.contains("srr-split")).toBe(false)
   })

   it("writes the model before notifying listeners, so a listener reads a settled layout", async () => {
      matches = true
      const { split, model, start } = await load()
      start()
      const seen: Array<[boolean, boolean]> = []
      split.onSplitChange((on) => seen.push([on, split.isSplit()]))
      fire!({ matches: false })
      expect(model.split()).toBe(false)
      expect(seen).toEqual([[false, false]])
      fire!({ matches: true })
      expect(model.split()).toBe(true)
      expect(seen).toEqual([
         [false, false],
         [true, true],
      ])
   })

   // Ctrl-P makes Chrome evaluate the width query against the PAGE BOX, firing a
   // crossing and its undo for a window that never changed size. The class still
   // follows the media — the single-surface layout is the better one to print —
   // but the model, and so every layout effect, must not churn twice per print.
   it("toggles the class alone while printing: the model and the listeners stay put", async () => {
      matches = true
      const { split, model, start } = await load()
      start()
      const seen: boolean[] = []
      split.onSplitChange((on) => seen.push(on))
      printing = true
      fire!({ matches: false })
      expect(document.body.classList.contains("srr-split")).toBe(false)
      expect(model.split()).toBe(true)
      expect(seen).toEqual([])

      // The override must survive a layout write it never asked for:
      // layout.ts's effect reruns on ANY of its five inputs, not just split,
      // and must not re-stamp the class from the (unmoved) screen-truth
      // model.split while the print override is still active.
      model.focus.set("reader")
      expect(document.body.classList.contains("srr-split")).toBe(false)

      fire!({ matches: true })
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(model.split()).toBe(true)
      expect(seen).toEqual([])
   })

   // A resize during the print-preview dialog can re-fire the crossing more
   // than once before the real undo — the override must not depend on the
   // nominal "crossing, then undo" pair to stay engaged.
   it("survives a same-direction crossing repeated without an intervening undo", async () => {
      matches = true
      const { model, start } = await load()
      start()
      printing = true
      fire!({ matches: false })
      expect(document.body.classList.contains("srr-split")).toBe(false)
      expect(model.printOverride()).toBe(true)

      fire!({ matches: false }) // repeats — no undo happened yet
      expect(document.body.classList.contains("srr-split")).toBe(false)
      expect(model.printOverride()).toBe(true) // still engaged, not flipped off

      model.focus.set("reader") // an unrelated layout write, mid-print
      expect(document.body.classList.contains("srr-split")).toBe(false) // still holds

      fire!({ matches: true }) // the eventual real undo
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(model.printOverride()).toBe(false)
   })

   // Chrome's REAL order, measured with a headless print-to-PDF: beforeprint, the
   // crossing (print matches), afterprint, and only THEN the undo — delivered with
   // print media no longer matching. The undo must still hand the class back.
   it("restores the class when the undo arrives after print media stopped matching", async () => {
      matches = true
      const { split, model, start } = await load()
      start()
      const seen: boolean[] = []
      split.onSplitChange((on) => seen.push(on))
      printing = true
      fire!({ matches: false })
      expect(document.body.classList.contains("srr-split")).toBe(false)
      printing = false
      window.dispatchEvent(new Event("afterprint"))
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(model.printOverride()).toBe(false)
      fire!({ matches: true }) // the late undo: nothing moved on screen
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(seen).toEqual([]) // no crossing reached the app
      model.focus.set("reader") // the layout effect owns the class again
      expect(document.body.classList.contains("srr-split")).toBe(true)
   })

   it("a late undo with no afterprint still restores the class", async () => {
      matches = true
      const { split, model, start } = await load()
      start()
      const seen: boolean[] = []
      split.onSplitChange((on) => seen.push(on))
      printing = true
      fire!({ matches: false })
      printing = false
      fire!({ matches: true })
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(model.printOverride()).toBe(false)
      expect(seen).toEqual([])
   })

   it("is a silent no-op without matchMedia (old jsdom)", async () => {
      vi.unstubAllGlobals()
      // @ts-expect-error simulate an environment without matchMedia
      delete globalThis.matchMedia
      const { split, model, start } = await load()
      start()
      expect(model.split()).toBe(false)
      expect(split.isSplit()).toBe(false)
   })

   // The unit suites that drive split stamp the class by hand before booting
   // (plan deviation D5); the model must agree, or the effect would un-stamp it.
   it("seeds model.split from a host-stamped class without matchMedia", async () => {
      vi.unstubAllGlobals()
      // @ts-expect-error simulate an environment without matchMedia
      delete globalThis.matchMedia
      document.body.classList.add("srr-split")
      const { model, start } = await load()
      start()
      expect(model.split()).toBe(true)
      expect(document.body.classList.contains("srr-split")).toBe(true)
   })
})
