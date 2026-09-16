import { describe, expect, it } from "vitest"

import { bitAt, emptyPlane, nextSet, parseWatchPlane, popcountRange, prevSet, WATCH_DOC_VERSION } from "./watch-plane"
import { b64, bytesOf } from "./watch-plane.testfixtures"

describe("parseWatchPlane", () => {
   it("decodes each rule's base64 plane LSB-first and caches its popcount", () => {
      const p = parseWatchPlane({ v: 1, base: 50000, n: 20, bits: { hot: b64(bytesOf(20, [0, 9, 19])) } }, 50000)
      expect([p.base, p.n]).toEqual([50000, 20])
      const hot = p.bits.get("hot")!
      expect([bitAt(hot, 0), bitAt(hot, 1), bitAt(hot, 9), bitAt(hot, 19)]).toEqual([true, false, true, true])
      expect(p.pop.get("hot")).toBe(3)
      expect(p.bits.has("cold")).toBe(false)
   })

   it("reads byte 0's SECOND bit as chron base+1", () => {
      const p = parseWatchPlane({ v: 1, base: 0, n: 8, bits: { r: btoa(String.fromCharCode(0b00000010)) } }, 0)
      expect(nextSet(p.bits.get("r")!, 0, 8)).toBe(1)
   })

   it("an object with no hits carries no planes", () => {
      expect(parseWatchPlane({ v: 1, base: 0, n: 5 }, 0).bits.size).toBe(0)
   })

   it("refuses an unknown version, a foreign region, or a non-object", () => {
      expect(() => parseWatchPlane({ v: 2, base: 0, n: 1 }, 0)).toThrow("unsupported version 2")
      expect(() => parseWatchPlane({ v: 1, base: 50000, n: 1 }, 0)).toThrow("expected 0")
      expect(() => parseWatchPlane(null, 0)).toThrow("not an object")
   })

   it("emptyPlane is an all-zero region, and the version matches the writer's", () => {
      const p = emptyPlane(100000, 7)
      expect([p.base, p.n, p.bits.size]).toEqual([100000, 7, 0])
      expect(WATCH_DOC_VERSION).toBe(1) // backend/watch.go watchDocVersion
   })
})

describe("bit scans", () => {
   const plane = bytesOf(40, [3, 17, 18, 39])

   it("nextSet finds the first set bit in [from, end), skipping empty bytes", () => {
      expect(nextSet(plane, 0, 40)).toBe(3)
      expect(nextSet(plane, 4, 40)).toBe(17)
      expect(nextSet(plane, 19, 40)).toBe(39)
      expect(nextSet(plane, 19, 39)).toBe(-1)
      expect(nextSet(plane, -5, 4)).toBe(3)
   })

   it("prevSet finds the last set bit in [lo, from]", () => {
      expect(prevSet(plane, 39, 0)).toBe(39)
      expect(prevSet(plane, 38, 0)).toBe(18)
      expect(prevSet(plane, 16, 0)).toBe(3)
      expect(prevSet(plane, 16, 4)).toBe(-1)
      expect(prevSet(plane, 2, 0)).toBe(-1)
   })

   it("popcountRange counts [lo, hi)", () => {
      expect(popcountRange(plane, 0, 40)).toBe(4)
      expect(popcountRange(plane, 4, 39)).toBe(2)
      expect(popcountRange(plane, 18, 19)).toBe(1)
      expect(popcountRange(plane, 18, 18)).toBe(0) // an empty range, even ON a set bit
   })

   it("reads past the plane's bytes as zeros", () => {
      expect(bitAt(plane, 400)).toBe(false)
      expect(nextSet(plane, 36, 400)).toBe(39)
   })
})
