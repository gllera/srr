// Tests for SW route regexes that can't be unit-tested by importing sw.ts
// directly — sw.ts references `sw.registration.scope` at module load, which
// throws under jsdom.  Each pattern here MUST be kept in sync with the
// corresponding constant in src/sw.ts.
import { describe, it, expect } from "vitest"

// Mirror of sw.ts RE_ASSET — KEEP IN SYNC.
// contentHashKey(ext, sum) = "assets/<2hex>/<16hex><ext>" where ext may be
// "" (path.Ext returns "" when the filename has no dot, e.g. a URL-named
// download like "image?id=123" or a bare "#/photo" marker).
const RE_ASSET = /\/assets\/[0-9a-f]{2}\/[0-9a-f]{16}(?:\.\w+)?$/i

describe("RE_ASSET", () => {
   it("matches an extensioned asset key", () => {
      expect(RE_ASSET.test("https://cdn/srr/assets/ab/0123456789abcdef.jpg")).toBe(true)
   })

   it("matches an extensionless asset key (contract BUG 2)", () => {
      expect(RE_ASSET.test("https://cdn/srr/assets/ab/0123456789abcdef")).toBe(true)
   })

   it("matches case-insensitively", () => {
      expect(RE_ASSET.test("https://cdn/srr/assets/AB/0123456789ABCDEF.WEBP")).toBe(true)
   })

   it("rejects a key with wrong hex lengths", () => {
      expect(RE_ASSET.test("https://cdn/srr/assets/abc/0123456789abcdef.jpg")).toBe(false)
      expect(RE_ASSET.test("https://cdn/srr/assets/ab/0123456789abcde.jpg")).toBe(false)
   })

   it("rejects a non-asset path", () => {
      expect(RE_ASSET.test("https://cdn/srr/packs/db.gz")).toBe(false)
   })
})
