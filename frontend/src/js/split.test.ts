// split.test.ts — the module holds a matchMedia subscription, so each test gets
// a fresh instance via resetModules + dynamic import (the dropdown.test.ts idiom).
import { describe, it, expect, beforeEach, vi } from "vitest"

type MQLListener = (e: { matches: boolean }) => void

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
         // Two queries now: the breakpoint the module owns, and the print probe
         // the crossing handler consults (Chrome re-evaluates width queries
         // against the page box while printing).
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

   it("stamps body.srr-split when the query matches at init", async () => {
      matches = true
      const split = await import("./split")
      split.initSplit()
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(split.isSplit()).toBe(true)
   })

   it("stays narrow when the query does not match", async () => {
      const split = await import("./split")
      split.initSplit()
      expect(split.isSplit()).toBe(false)
   })

   it("re-stamps and notifies listeners on a breakpoint crossing", async () => {
      matches = true
      const split = await import("./split")
      split.initSplit()
      const seen: boolean[] = []
      split.onSplitChange((on) => seen.push(on))
      fire!({ matches: false })
      expect(split.isSplit()).toBe(false)
      expect(seen).toEqual([false])
      fire!({ matches: true })
      expect(split.isSplit()).toBe(true)
      expect(seen).toEqual([false, true])
   })

   // Ctrl-P makes Chrome evaluate the width query against the PAGE BOX, firing a
   // crossing and its undo for a window that never changed size. The class still
   // follows the media — the single-surface layout is the better one to print —
   // but the app's JS layout state (the list's scroller, its built window) must
   // not churn twice per print.
   it("keeps the class in step but does not notify listeners while printing", async () => {
      matches = true
      const split = await import("./split")
      split.initSplit()
      const seen: boolean[] = []
      split.onSplitChange((on) => seen.push(on))
      printing = true
      fire!({ matches: false })
      expect(document.body.classList.contains("srr-split")).toBe(false)
      expect(seen).toEqual([])
      fire!({ matches: true })
      expect(document.body.classList.contains("srr-split")).toBe(true)
      expect(seen).toEqual([])
   })

   it("is a silent no-op without matchMedia (old jsdom)", async () => {
      vi.unstubAllGlobals()
      // @ts-expect-error simulate an environment without matchMedia
      delete globalThis.matchMedia
      const split = await import("./split")
      split.initSplit()
      expect(split.isSplit()).toBe(false)
   })
})
