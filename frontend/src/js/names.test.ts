import { describe, expect, it } from "vitest"

import { expandSeries, keyAt, legacyNames, manifestNames, type IManifestWire } from "./names"

// The name resolver is the seam the manifest indirection hangs on
// (docs/MANIFEST-SPEC.md §4.5): both root shapes must resolve to the SAME
// key at the same position, or the reader would address one store's chrons
// through another store's names.

const manifest = (names: Record<string, unknown>, over: Partial<IManifestWire> = {}): IManifestWire => ({
   v: 2,
   m: 7,
   fetched_at: 100,
   total_art: 0,
   names,
   feeds: {},
   ...over,
})

describe("expandSeries", () => {
   it("expands a contiguous run from position 0", () => {
      expect(expandSeries({ r: [[0, 3]] }, "idx")).toEqual({
         keys: ["idx/0.gz", "idx/1.gz", "idx/2.gz"],
         tail: -1,
      })
   })

   it("pads the positions below the base (data/0 was never written)", () => {
      expect(expandSeries({ b: 1, r: [[1, 2]] }, "data")).toEqual({
         keys: ["", "data/1.gz", "data/2.gz"],
         tail: -1,
      })
   })

   it("places the tail at the position the manifest states", () => {
      const list = expandSeries({ b: 1, r: [[1, 3]], l: 3 }, "data")
      expect(list.tail).toBe(3)
      expect(list.keys[list.tail]).toBe("data/3.gz")
   })

   it("rejects a tail position the list does not name", () => {
      expect(() => expandSeries({ b: 1, r: [[1, 2]], l: 9 }, "data")).toThrow(/tail position 9/)
   })

   it("expands several runs in order (a rebuilt position keeps its slot)", () => {
      expect(
         expandSeries(
            {
               r: [
                  [0, 2],
                  [1900, 1],
               ],
            },
            "idx",
         ).keys,
      ).toEqual(["idx/0.gz", "idx/1.gz", "idx/1900.gz"])
   })

   it("an empty row is an empty series, not a crash", () => {
      expect(expandSeries({}, "meta")).toEqual({ keys: [], tail: -1 })
   })
})

describe("keyAt", () => {
   it("returns the listed key", () => {
      expect(keyAt({ keys: ["idx/0.gz"], tail: -1 }, 0, "idx pack 0")).toBe("idx/0.gz")
   })

   it("fails loudly on an unlisted position — there is no computed-name fallback", () => {
      expect(() => keyAt({ keys: ["idx/0.gz"], tail: -1 }, 1, "idx tail")).toThrow(/idx tail.*position 1/)
   })

   it("fails loudly on a base-padded slot", () => {
      expect(() => keyAt({ keys: ["", "data/1.gz"], tail: -1 }, 0, "data pack 0")).toThrow(/position 0/)
   })
})

describe("manifestNames", () => {
   it("reads series by name out of the flat map, plus the singletons", () => {
      const n = manifestNames(
         manifest({
            idx: { r: [[0, 3]], l: 2 },
            data: { b: 1, r: [[1, 2]], l: 2 },
            meta: { r: [[0, 5]], l: 4 },
            deltas: { s: "data", r: [10, 11] },
            seen: { s: "seen", stem: 1 },
            hsum: { s: "idx", stem: 8, covers: 2 },
            ssum: { s: "meta", stem: 9, covers: 4 },
         }),
      )
      expect(n.idx).toEqual({ keys: ["idx/0.gz", "idx/1.gz", "idx/2.gz"], tail: 2 })
      expect(n.data).toEqual({ keys: ["", "data/1.gz", "data/2.gz"], tail: 2 })
      expect(n.meta.tail).toBe(4)
      // Each singleton carries its OWN series, so nothing here hard-codes
      // which directory a summary or a delta segment lives in (§4.6).
      expect(n.deltas).toEqual(["data/10.gz", "data/11.gz"])
      expect(n.hsum).toEqual({ key: "idx/8.gz", covers: 2 })
      expect(n.ssum).toEqual({ key: "meta/9.gz", covers: 4 })
   })

   it("tolerates a series the manifest does not carry (ARC6: nothing assumes three)", () => {
      const n = manifestNames(manifest({ idx: { r: [[0, 1]] } }))
      expect(n.idx.keys).toEqual(["idx/0.gz"])
      expect(n.data).toEqual({ keys: [], tail: -1 })
      expect(n.meta).toEqual({ keys: [], tail: -1 })
      expect(n.deltas).toEqual([])
      expect(n.hsum).toBeNull()
      expect(n.ssum).toBeNull()
   })

   it("never mistakes a singleton key for a series", () => {
      const n = manifestNames(manifest({ deltas: { s: "data", r: [3] }, seen: { s: "seen", stem: 0 } }))
      expect(n.deltas).toEqual(["data/3.gz"])
      // "seen" and "deltas" must not have leaked into a series list.
      expect(n.idx.keys).toEqual([])
   })

   it("rejects a manifest with no names object", () => {
      expect(() => manifestNames({ ...manifest({}), names: undefined as unknown as Record<string, unknown> })).toThrow(
         /no names object/,
      )
   })
})

describe("legacyNames — the pre-cutover derivation", () => {
   // A store whose writer has not migrated it yet still carries the counters
   // its names were derived from. The reader keeps deriving them, and resolves
   // into the same StoreNames shape every fetch site indexes.

   it("an all-delta store names no tail", () => {
      const legacy = legacyNames({ total_art: 2, seq: 1, nd: 1, na: 2, next_pid: 0 })
      expect(legacy.idx.tail).toBe(-1)
      expect(legacy.data.tail).toBe(-1)
      expect(legacy.meta.tail).toBe(-1)
      expect(legacy.deltas).toEqual(["data/d1.gz"])
   })

   it("a consolidated store names one tail per series", () => {
      const legacy = legacyNames({ total_art: 2, seq: 1, nd: 0, na: 0, next_pid: 1 })
      expect(legacy.data.tail).toBe(1) // == next_pid
      expect(legacy.idx.tail).toBe(0) // == numFinalizedIdx
      expect(legacy.meta.tail).toBe(0) // == mp
      expect(legacy.idx.keys[legacy.idx.tail]).toBe("idx/L1.gz")
   })

   it("legacy tails sit at numFinalizedIdx / next_pid / mp", () => {
      const n = legacyNames({ total_art: 120_000, seq: 12, nd: 2, na: 30, next_pid: 5, hdrs: 2, mp: 23 })
      expect(n.idx.tail).toBe(2)
      expect(n.idx.keys[n.idx.tail]).toBe("idx/L10.gz")
      expect(n.data.tail).toBe(5)
      expect(n.data.keys[n.data.tail]).toBe("data/L10.gz")
      expect(n.meta.tail).toBe(23)
      expect(n.meta.keys[n.meta.tail]).toBe("meta/L10.gz")
      expect(n.deltas).toEqual(["data/d11.gz", "data/d12.gz"])
      expect(n.hsum).toEqual({ key: "idx/h2.gz", covers: 2 })
      expect(n.ssum).toEqual({ key: "meta/s23.gz", covers: 23 })
   })

   it("an empty store names nothing", () => {
      expect(legacyNames({ total_art: 0, seq: 0, next_pid: 1 })).toEqual({
         idx: { keys: [], tail: -1 },
         data: { keys: [""], tail: -1 },
         meta: { keys: [], tail: -1 },
         deltas: [],
         hsum: null,
         ssum: null,
      })
   })
})
