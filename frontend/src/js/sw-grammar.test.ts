import { describe, expect, it } from "vitest"

import { parsePackName, RE_ASSET, RE_DB, RE_SHELL_HASHED } from "./sw-grammar"

// The reader (service-worker) side of the write-once pack-name contract. The
// backend pins the writer side (store.PackSeries / packKeyRe); this mirrors that
// matrix so the two can't silently drift. sw.ts feeds parsePackName a path with
// the /packs/ prefix (what the fetch handler sees after the cdn-url base), so we
// do the same here.
const pack = (name: string) => parsePackName(`/packs/${name}`)

describe("parsePackName", () => {
   it("accepts each series' own kinds", () => {
      // Finalized (numeric) stems exist for every series.
      expect(pack("idx/0.gz")).toEqual({ series: "idx", kind: "", n: 0 })
      expect(pack("data/1.gz")).toEqual({ series: "data", kind: "", n: 1 })
      expect(pack("meta/2.gz")).toEqual({ series: "meta", kind: "", n: 2 })
      // Latest generation (L) on every series; kind is lowercased for keying.
      expect(pack("idx/L7.gz")).toEqual({ series: "idx", kind: "l", n: 7 })
      expect(pack("data/L7.gz")).toEqual({ series: "data", kind: "l", n: 7 })
      expect(pack("meta/L7.gz")).toEqual({ series: "meta", kind: "l", n: 7 })
      // Summaries: idx header (h) and meta bloom (s).
      expect(pack("idx/h2.gz")).toEqual({ series: "idx", kind: "h", n: 2 })
      expect(pack("meta/s4.gz")).toEqual({ series: "meta", kind: "s", n: 4 })
   })

   it("rejects a kind letter another series owns", () => {
      expect(pack("data/h3.gz")).toBeNull() // only idx owns h
      expect(pack("idx/s3.gz")).toBeNull() // only meta owns s
      expect(pack("meta/h3.gz")).toBeNull() // only idx owns h
   })

   it("rejects malformed stems and non-pack paths", () => {
      expect(pack("data/Lx7.gz")).toBeNull() // garbage between kind and number
      expect(pack("idx/L.gz")).toBeNull() // latest needs a generation number
      expect(pack("idx/0.txt")).toBeNull() // wrong extension
      expect(pack("nope/0.gz")).toBeNull() // unknown series
      expect(pack("db.gz")).toBeNull() // the mutable index is not a pack
   })
})

describe("RE_ASSET / RE_DB / RE_SHELL_HASHED", () => {
   it("matches content-hash asset keys under any cdn prefix", () => {
      expect(RE_ASSET.test("/packs/assets/ab/0123456789abcdef.webp")).toBe(true)
      expect(RE_ASSET.test("/srr/assets/ab/0123456789abcdef")).toBe(true) // extension optional
      expect(RE_ASSET.test("/packs/assets/ab/0123.webp")).toBe(false) // hash too short
      expect(RE_ASSET.test("/packs/data/1.gz")).toBe(false)
   })

   it("matches db.gz and Parcel-hashed bundles", () => {
      expect(RE_DB.test("/packs/db.gz")).toBe(true)
      expect(RE_DB.test("/packs/idx/0.gz")).toBe(false)
      expect(RE_SHELL_HASHED.test("/frontend.019034b2.js")).toBe(true)
      expect(RE_SHELL_HASHED.test("/frontend.css")).toBe(false)
   })
})
