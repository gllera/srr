import { describe, expect, it, vi } from "vitest"

// route.ts reads only data.activeStore().mid (the mount half of the token
// grammar, §6.3); a stub keeps this suite a pure test of the string grammar.
const store = vi.hoisted(() => ({ mid: "0" }))
vi.mock("./data", () => ({ activeStore: () => store }))

import { hashPos, parseHashTokens, tokensSuffix } from "./route"

// route.ts is the `#pos[!tokens]` grammar extracted from nav.ts (ENG3). nav's own
// suite drives the WRITE side (updateHash's pushState/replaceState strings) and
// parseHashMount's mount extraction through the nav facade; what had no direct
// coverage — and what app.ts's boot guard and route() classify on — is the split
// itself: hashPos and parseHashTokens. Those two are pinned here, plus the
// escape round-trip that makes a `+` inside a token survive the `+` separator.

describe("hashPos — the position half", () => {
   it("returns the whole hash when there is no ! segment", () => {
      expect(hashPos("12")).toBe("12")
      expect(hashPos("")).toBe("")
   })

   it("returns everything before the first !", () => {
      expect(hashPos("12!tech")).toBe("12")
      expect(hashPos("12!tech+5")).toBe("12")
      // A search token carries its own `!`-free colons, but a tag could hold a
      // second `!`: only the FIRST one splits.
      expect(hashPos("12!a!b")).toBe("12")
   })

   it("returns '' for a list hash (no position)", () => {
      expect(hashPos("!tech")).toBe("")
      expect(hashPos("!")).toBe("")
   })

   it("passes a foreign hash through verbatim, so the caller can reject it", () => {
      // app.ts's boot guard classifies through this: a non-integer position is a
      // hash SRR did not write (an OAuth fragment, an anchor link).
      expect(hashPos("access_token=abc")).toBe("access_token=abc")
      expect(Number.isFinite(Number(hashPos("section-2")))).toBe(false)
   })
})

describe("parseHashTokens — the token half", () => {
   it("is empty when there is no ! segment", () => {
      expect(parseHashTokens("12")).toEqual([])
      expect(parseHashTokens("")).toEqual([])
   })

   it("splits the ! segment on + and drops empty slots", () => {
      expect(parseHashTokens("12!tech")).toEqual(["tech"])
      expect(parseHashTokens("12!tech+5")).toEqual(["tech", "5"])
      expect(parseHashTokens("!5")).toEqual(["5"])
      expect(parseHashTokens("12!")).toEqual([])
      expect(parseHashTokens("12!tech++5")).toEqual(["tech", "5"])
   })

   it("decodes each token", () => {
      expect(parseHashTokens("12!%23news")).toEqual(["#news"])
      expect(parseHashTokens("12!q%3Aclimate")).toEqual(["q:climate"])
      // %2B decodes back to a literal + INSIDE a token — the escape that lets
      // `+` double as the separator.
      expect(parseHashTokens("12!q%3Ac%2B%2B")).toEqual(["q:c++"])
   })

   it("passes a malformed %-escape through verbatim rather than throwing", () => {
      // decodeURIComponent would throw here; navigation must not crash on a
      // hand-edited or truncated link.
      expect(parseHashTokens("12!%E0%A4%A")).toEqual(["%E0%A4%A"])
      expect(parseHashTokens("12!good+%ZZ")).toEqual(["good", "%ZZ"])
   })
})

describe("tokensSuffix ↔ parseHashTokens round-trip", () => {
   it("survives a literal + and the other separators in a token", () => {
      for (const token of ["q:c++", "a+b", "#tag", "tag with spaces", "q:100%"]) {
         expect(parseHashTokens("7" + tokensSuffix([token]))).toEqual([token])
      }
   })

   it("survives multiple tokens", () => {
      const tokens = ["tech", "q:a+b", "5"]
      expect(parseHashTokens("7" + tokensSuffix(tokens))).toEqual(tokens)
   })

   it("emits nothing for an empty token list ([ALL] on the home mount)", () => {
      expect(tokensSuffix([])).toBe("")
   })
})
