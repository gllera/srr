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

   it("places the tail at the position after the last run", () => {
      const list = expandSeries({ b: 1, r: [[1, 2]], t: "data/L4.gz" }, "data")
      expect(list.tail).toBe(3)
      expect(list.keys[list.tail]).toBe("data/L4.gz")
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
            idx: { r: [[0, 2]], t: "idx/L9.gz" },
            data: { b: 1, r: [[1, 1]], t: "data/L9.gz" },
            meta: { r: [[0, 4]], t: "meta/L9.gz" },
            deltas: ["data/d10.gz", "data/d11.gz"],
            seen: "seen.1.gz",
            hsum: { key: "idx/h2.gz", covers: 2 },
            ssum: { key: "meta/s4.gz", covers: 4 },
         }),
      )
      expect(n.idx).toEqual({ keys: ["idx/0.gz", "idx/1.gz", "idx/L9.gz"], tail: 2 })
      expect(n.data).toEqual({ keys: ["", "data/1.gz", "data/L9.gz"], tail: 2 })
      expect(n.meta.tail).toBe(4)
      expect(n.deltas).toEqual(["data/d10.gz", "data/d11.gz"])
      expect(n.hsum).toEqual({ key: "idx/h2.gz", covers: 2 })
      expect(n.ssum).toEqual({ key: "meta/s4.gz", covers: 4 })
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
      const n = manifestNames(manifest({ deltas: ["data/d3.gz"], seen: "seen.0.gz" }))
      expect(n.deltas).toEqual(["data/d3.gz"])
      // "seen" and "deltas" must not have leaked into a series list.
      expect(n.idx.keys).toEqual([])
   })

   it("rejects a manifest with no names object", () => {
      expect(() => manifestNames({ ...manifest({}), names: undefined as unknown as Record<string, unknown> })).toThrow(
         /no names object/,
      )
   })
})

describe("legacyNames ↔ manifestNames parity", () => {
   // The S32 writer publishes BOTH shapes for the same store state. These are
   // the manifests it produced for the two layouts that matter, verified
   // against real `srr` output.

   it("an all-delta store (no consolidated tail) resolves identically", () => {
      const legacy = legacyNames({ total_art: 2, seq: 1, nd: 1, na: 2, next_pid: 0 })
      const fromManifest = manifestNames(
         manifest({ data: { b: 1 }, idx: {}, meta: {}, deltas: ["data/d1.gz"], seen: "seen.1.gz" }),
      )
      expect(fromManifest).toEqual(legacy)
      // No tail was ever consolidated, so no series names one.
      expect(legacy.idx.tail).toBe(-1)
      expect(legacy.data.tail).toBe(-1)
      expect(legacy.meta.tail).toBe(-1)
      expect(legacy.deltas).toEqual(["data/d1.gz"])
   })

   it("a consolidated store resolves identically", () => {
      const legacy = legacyNames({ total_art: 2, seq: 1, nd: 0, na: 0, next_pid: 1 })
      const fromManifest = manifestNames(
         manifest({
            data: { b: 1, t: "data/L1.gz" },
            idx: { t: "idx/L1.gz" },
            meta: { t: "meta/L1.gz" },
            seen: "seen.1.gz",
         }),
      )
      expect(fromManifest).toEqual(legacy)
      expect(legacy.data.tail).toBe(1) // == next_pid
      expect(legacy.idx.tail).toBe(0) // == numFinalizedIdx
      expect(legacy.meta.tail).toBe(0) // == mp
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
