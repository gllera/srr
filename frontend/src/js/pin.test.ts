import { describe, it, expect, beforeEach } from "vitest"

// pin.ts is a pure localStorage module — no module-level side effects
// that require resetting, so a normal import is fine.
import { pinFilter, unpinFilter, isPinned, listPins, PINS_KEY } from "./pin"

beforeEach(() => {
   localStorage.clear()
})

describe("pin registry", () => {
   it("isPinned returns false when nothing is stored", () => {
      expect(isPinned("all")).toBe(false)
   })

   it("pinFilter/isPinned round-trip", () => {
      pinFilter("all", ["meta/0.gz", "data/1.gz"])
      expect(isPinned("all")).toBe(true)
   })

   it("unpinFilter removes a specific key", () => {
      pinFilter("all", ["meta/0.gz"])
      pinFilter("feed:3", ["data/1.gz"])
      unpinFilter("all")
      expect(isPinned("all")).toBe(false)
      expect(isPinned("feed:3")).toBe(true)
   })

   it("listPins returns all pinned entries", () => {
      const names1 = ["meta/0.gz", "data/1.gz"]
      const names2 = ["meta/0.gz"]
      pinFilter("all", names1)
      pinFilter("feed:3", names2)
      const pins = listPins()
      expect(pins.size).toBe(2)
      expect(pins.get("all")!.names).toEqual(names1)
      expect(pins.get("feed:3")!.names).toEqual(names2)
      expect(typeof pins.get("all")!.ts).toBe("number")
   })

   it("listPins returns empty map when nothing stored", () => {
      expect(listPins().size).toBe(0)
   })

   it("pinFilter overwrites an existing key", () => {
      pinFilter("all", ["meta/0.gz"])
      pinFilter("all", ["data/1.gz", "data/2.gz"])
      const pins = listPins()
      expect(pins.get("all")!.names).toEqual(["data/1.gz", "data/2.gz"])
   })

   it("PINS_KEY constant matches the stored key", () => {
      expect(PINS_KEY).toBe("srr-pins")
      pinFilter("x", ["a"])
      expect(localStorage.getItem("srr-pins")).not.toBeNull()
   })

   it("listPins is tolerant of junk JSON", () => {
      localStorage.setItem("srr-pins", "NOT JSON {{{")
      expect(listPins().size).toBe(0)
   })

   it("listPins is tolerant of non-object stored value", () => {
      localStorage.setItem("srr-pins", "42")
      expect(listPins().size).toBe(0)
   })

   it("listPins skips malformed entries", () => {
      // A partially malformed registry: only 'good' entry should survive
      const raw = JSON.stringify({ good: { names: ["meta/0.gz"], ts: 123 }, bad: "not-an-object" })
      localStorage.setItem("srr-pins", raw)
      const pins = listPins()
      expect(pins.size).toBe(1)
      expect(pins.has("good")).toBe(true)
   })
})
