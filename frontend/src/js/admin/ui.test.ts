// The admin console's first unit suite. overrideChip is the badge the feeds
// table and the preview dialog wear to say "this feed overrides its recipe", so
// it must enumerate the SAME axes feeds.ts's advValues() folds behind Advanced
// ({ingest, pipe, secrets}) — an axis missing here is saved config hiding
// silently, which is the one thing the Advanced summary chips exist to prevent.

import { describe, expect, it } from "vitest"
import { overrideChip } from "./ui"

// The chip is an element or the empty string; these read the rendered result.
const title = (f: Parameters<typeof overrideChip>[0]): string | null => {
   const out = overrideChip(f)
   return typeof out === "string" ? null : out.getAttribute("title")
}

describe("overrideChip", () => {
   it("renders nothing when the feed carries no feed-level override", () => {
      expect(overrideChip({})).toBe("")
      expect(overrideChip({ ingest: "", pipe: [], secrets: [] })).toBe("")
   })

   it("names each single axis in the tooltip", () => {
      expect(title({ ingest: "#feed" })).toBe("feed-level ingest override")
      expect(title({ pipe: ["#sanitize"] })).toBe("feed-level pipe override")
      // SEC5: a feed whose ONLY override is its secret grant still gets a badge.
      expect(title({ secrets: ["tg"] })).toBe("feed-level secrets override")
   })

   it("joins every set axis in declaration order", () => {
      expect(title({ ingest: "#feed", pipe: ["#sanitize"], secrets: ["tg"] })).toBe(
         "feed-level ingest + pipe + secrets override",
      )
      expect(title({ pipe: ["#sanitize"], secrets: ["tg"] })).toBe("feed-level pipe + secrets override")
   })

   it("renders the shared chip element", () => {
      const out = overrideChip({ secrets: ["tg"] })
      expect(out).toBeInstanceOf(HTMLElement)
      const chip = out as HTMLElement
      expect(chip.tagName).toBe("SPAN")
      expect(chip.className).toBe("chip recipe")
      expect(chip.textContent).toBe("override")
   })
})
