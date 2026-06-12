import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDX_PACK_SIZE, SEARCH_BLOOM_BYTES, SEARCH_BLOOM_K, SEARCH_GRAM } from "./format.gen"

// search.ts holds lazy fetch slots (summary/latest/shard LRU) as module
// state, so every test gets a fresh instance via resetModules + dynamic
// import (the dropdown.test.ts pattern).
const mockData = vi.hoisted(() => ({
   db: {} as Record<string, unknown>,
   fetchPackBytes: vi.fn<(path: string, isLatest: boolean) => Promise<ArrayBuffer>>(),
}))
vi.mock("./data", () => mockData)

type SearchMod = typeof import("./search")
let search: SearchMod

// In-memory store served by the fetchPackBytes mock: path → decompressed
// bytes (the real fetchPackBytes gunzips before returning).
let store: Record<string, Uint8Array>

function entryBytes(titles: (string | undefined)[], chanId = 1): Uint8Array {
   const lines = titles.map((t) => JSON.stringify(t === undefined ? { s: chanId, w: 1000 } : { s: chanId, w: 1000, t }))
   return new TextEncoder().encode(lines.join("\n") + "\n")
}

// Builds a bloom the way the backend does, via the module's own primitives —
// true Go↔TS parity is the e2e contract test's job; this pins the TS side's
// internal consistency (probe math, masking, gram extraction).
function bloomOf(titles: (string | undefined)[]): Uint8Array {
   const bloom = new Uint8Array(SEARCH_BLOOM_BYTES)
   for (const t of titles) {
      for (const word of search.fold(t ?? "").split(" ")) {
         const runes = [...word]
         for (let i = 0; i + SEARCH_GRAM <= runes.length; i++) {
            for (const bit of search.bloomBits(runes.slice(i, i + SEARCH_GRAM).join(""))) {
               bloom[bit >> 3] |= 1 << (bit & 7)
            }
         }
      }
   }
   return bloom
}

function concat(...parts: Uint8Array[]): Uint8Array {
   const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
   let off = 0
   for (const p of parts) {
      out.set(p, off)
      off += p.length
   }
   return out
}

async function collect(gen: AsyncGenerator<import("./search").ISearchHit[]>) {
   const out: import("./search").ISearchHit[][] = []
   for await (const batch of gen) out.push(batch)
   return out
}

beforeEach(async () => {
   vi.resetModules()
   search = await import("./search")
   store = {}
   mockData.fetchPackBytes.mockReset()
   mockData.fetchPackBytes.mockImplementation(async (path: string) => {
      const bytes = store[path]
      if (!bytes) throw new Error(`pack fetch failed: 404 ${path}`)
      // Fresh copy so byteOffset is 0 and tests can't share buffers.
      return bytes.slice().buffer
   })
})

describe("fold", () => {
   // The same vector table as backend TestFoldSearchText — the two
   // implementations are a byte-for-byte contract.
   it.each([
      ["", ""],
      ["Hello, World!", "hello world"],
      ["  --foo__bar  42  ", "foo bar 42"],
      ["don't", "don t"],
      ["Café Éclair", "cafe eclair"],
      ["éclair", "eclair"],
      ["İstanbul", "istanbul"],
      ["STRAẞE", "straße"],
      ["ΓΛΩΣΣΑΣ", "γλωσσασ"],
      ["γλώσσας", "γλωσσασ"],
      ["日本語のニュース", "日本語のニュース"],
      ["...a...", "a"],
   ])("fold(%j) = %j", (input, want) => {
      expect(search.fold(input)).toBe(want)
   })
})

describe("bloomBits", () => {
   it("matches the backend's probe vectors (cross-language parity pin)", () => {
      // The same literals are asserted against the Go bloomBits in
      // backend/db_search_test.go TestBloomBitsVectors.
      expect(search.bloomBits("abc")).toEqual([87883, 63844, 39805, 15766])
      expect(search.bloomBits("ukr")).toEqual([66889, 37986, 9083, 242324])
      expect(search.bloomBits("日本語")).toEqual([61319, 250428, 177393, 104358])
      expect(search.bloomBits("niñ")).toEqual([108032, 123835, 139638, 155441])
      expect(search.bloomBits("42a")).toEqual([230950, 126783, 22616, 180593])
   })

   it("derives SEARCH_BLOOM_K deterministic in-range indices", () => {
      const bits = search.bloomBits("abc")
      expect(bits).toHaveLength(SEARCH_BLOOM_K)
      expect(search.bloomBits("abc")).toEqual(bits)
      for (const b of bits) {
         expect(b).toBeGreaterThanOrEqual(0)
         expect(b).toBeLessThan(SEARCH_BLOOM_BYTES * 8)
         expect(Number.isInteger(b)).toBe(true)
      }
      expect(search.bloomBits("abd")).not.toEqual(bits)
   })
})

describe("available", () => {
   it("gates on srch == numFinalized with the srcht small-store leg", () => {
      mockData.db = { total_art: 0 }
      expect(search.available()).toBe(false)
      // Small store (no finalized packs), search-aware backend.
      mockData.db = { total_art: 10, srcht: 10 }
      expect(search.available()).toBe(true)
      // Small store, pre-search backend: both fields absent.
      mockData.db = { total_art: 10 }
      expect(search.available()).toBe(false)
      // Finalized coverage complete / lagging.
      mockData.db = { total_art: IDX_PACK_SIZE + 1, srch: 1, srcht: 1 }
      expect(search.available()).toBe(true)
      mockData.db = { total_art: 2 * IDX_PACK_SIZE + 1, srch: 1, srcht: 1 }
      expect(search.available()).toBe(false)
   })
})

describe("shortQuery", () => {
   it("is true only when no folded word reaches SEARCH_GRAM runes", () => {
      expect(search.shortQuery("ab")).toBe(true)
      expect(search.shortQuery("ab cd")).toBe(true)
      expect(search.shortQuery("abc")).toBe(false)
      expect(search.shortQuery("ab cde")).toBe(false)
      expect(search.shortQuery("日本")).toBe(true)
      expect(search.shortQuery("日本語")).toBe(false)
      expect(search.shortQuery("  ")).toBe(true)
   })
})

describe("search", () => {
   // Two finalized shards + latest tail. Shards hold 3 entries each — the
   // reader never validates shard length, chron math comes from
   // IDX_PACK_SIZE bases alone.
   const shard0 = ["Alpha ancient", "Café Niño", "unrelated thing"]
   const shard1 = ["Alpha middle", "Boring row", undefined]
   const latest = ["Alpha latest", "Final entry"]

   beforeEach(() => {
      mockData.db = { total_art: 2 * IDX_PACK_SIZE + latest.length, seq: 7, srch: 2, srcht: latest.length }
      store["search/0.gz"] = concat(bloomOf(shard0), entryBytes(shard0))
      store["search/1.gz"] = concat(bloomOf(shard1), entryBytes(shard1))
      store["search/L7.gz"] = entryBytes(latest)
      store["search/s2.gz"] = concat(bloomOf(shard0), bloomOf(shard1))
   })

   it("yields newest-first batches with shard-based chron addressing", async () => {
      const batches = await collect(search.search("alpha"))
      expect(batches.map((b) => b.map((h) => h.chron))).toEqual([
         [2 * IDX_PACK_SIZE], // latest tail
         [IDX_PACK_SIZE], // shard 1
         [0], // shard 0
      ])
      expect(batches[0][0]).toMatchObject({ t: "Alpha latest", s: 1, w: 1000 })
   })

   it("ANDs every query word", async () => {
      const batches = await collect(search.search("alpha middle"))
      expect(batches.flat().map((h) => h.t)).toEqual(["Alpha middle"])
   })

   it("matches across folding (case, diacritics)", async () => {
      const batches = await collect(search.search("CAFE nino"))
      expect(batches.flat().map((h) => h.chron)).toEqual([1])
   })

   it("prunes shards via the summary blooms without fetching them", async () => {
      const batches = await collect(search.search("zzzqqq"))
      expect(batches).toEqual([])
      const fetched = mockData.fetchPackBytes.mock.calls.map((c) => c[0])
      expect(fetched).not.toContain("search/0.gz")
      expect(fetched).not.toContain("search/1.gz")
   })

   it("scans only the latest tail for short queries", async () => {
      // "al" substring-matches both tail titles ("Alpha…", "Final…"), newest first.
      const batches = await collect(search.search("al"))
      expect(batches.flat().map((h) => h.t)).toEqual(["Final entry", "Alpha latest"])
      const fetched = mockData.fetchPackBytes.mock.calls.map((c) => c[0])
      expect(fetched).toEqual(["search/L7.gz"])
   })

   it("degrades to finalized shards when the latest tail is missing", async () => {
      delete store["search/L7.gz"]
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const batches = await collect(search.search("alpha"))
      expect(batches.map((b) => b.map((h) => h.chron))).toEqual([[IDX_PACK_SIZE], [0]])
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
   })

   it("rejects when the summary is missing (caller surfaces it)", async () => {
      delete store["search/s2.gz"]
      await expect(collect(search.search("alpha"))).rejects.toThrow()
   })

   it("fetches each shard and the summary once across queries", async () => {
      await collect(search.search("alpha"))
      await collect(search.search("alpha"))
      const fetched = mockData.fetchPackBytes.mock.calls.map((c) => c[0])
      expect(fetched.filter((p) => p === "search/s2.gz")).toHaveLength(1)
      expect(fetched.filter((p) => p === "search/0.gz")).toHaveLength(1)
   })

   it("treats untitled entries as unmatchable", async () => {
      const batches = await collect(search.search("boring"))
      expect(batches.flat().map((h) => h.chron)).toEqual([IDX_PACK_SIZE + 1])
   })
})
