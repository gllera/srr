import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DEFAULTS, SIZES, applyPrefs, initReading, readPrefs, setPrefs, stepSize } from "./reading"

const root = document.documentElement
const prop = (p: string) => root.style.getPropertyValue(p)

describe("reading preferences", () => {
   beforeEach(() => {
      localStorage.clear()
      root.removeAttribute("style")
   })
   afterEach(() => {
      localStorage.clear()
      root.removeAttribute("style")
   })

   it("reads the defaults when nothing is stored", () => {
      expect(readPrefs()).toEqual(DEFAULTS)
   })

   it("reads a corrupt or partial blob tolerantly, field by field", () => {
      localStorage.setItem("srr-reading", "{not json")
      expect(readPrefs()).toEqual(DEFAULTS)
      localStorage.setItem("srr-reading", JSON.stringify({ size: 99, width: "huge", leading: "relaxed", font: 3 }))
      expect(readPrefs()).toEqual({ ...DEFAULTS, size: SIZES.length - 1, leading: "relaxed" })
      localStorage.setItem("srr-reading", JSON.stringify({ size: 1.5, width: "toString" }))
      expect(readPrefs()).toEqual(DEFAULTS) // non-integer size; an inherited key is no option
   })

   it("the defaults write NO properties, so tokens.css stays the one place they are spelled", () => {
      applyPrefs({ ...DEFAULTS })
      expect(root.getAttribute("style") ?? "").toBe("")
   })

   it("writes each non-default choice as its custom property", () => {
      applyPrefs({ size: 0, width: "wide", leading: "compact", font: "serif" })
      expect(prop("--prose-size")).toBe(`${SIZES[0]}rem`)
      expect(prop("--column-w")).toBe("820px")
      expect(prop("--prose-leading")).toBe("1.5")
      expect(prop("--prose-font")).toBe("var(--font-serif)")
      // …and returning a choice to its default removes that property again.
      applyPrefs({ ...DEFAULTS, font: "serif" })
      expect(prop("--column-w")).toBe("")
      expect(prop("--prose-font")).toBe("var(--font-serif)")
   })

   it("persists a non-default state and removes the key for the all-default one", () => {
      setPrefs({ ...DEFAULTS, width: "narrow" })
      expect(JSON.parse(localStorage.getItem("srr-reading")!)).toMatchObject({ width: "narrow" })
      setPrefs({ ...DEFAULTS })
      expect(localStorage.getItem("srr-reading")).toBeNull()
   })

   it("stepSize walks the scale and stops at both ends", () => {
      expect(stepSize(1)).toBe(true)
      expect(readPrefs().size).toBe(DEFAULTS.size + 1)
      while (stepSize(1));
      expect(readPrefs().size).toBe(SIZES.length - 1)
      expect(stepSize(1)).toBe(false)
      while (stepSize(-1));
      expect(readPrefs().size).toBe(0)
      expect(prop("--prose-size")).toBe(`${SIZES[0]}rem`)
   })

   it("initReading applies what is stored", () => {
      localStorage.setItem("srr-reading", JSON.stringify({ ...DEFAULTS, leading: "relaxed" }))
      initReading()
      expect(prop("--prose-leading")).toBe("1.85")
   })
})
