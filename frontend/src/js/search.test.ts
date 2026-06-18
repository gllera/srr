import { beforeEach, describe, expect, it, vi } from "vitest"

import { META_PACK_SIZE, SEARCH_BLOOM_BYTES, SEARCH_BLOOM_K, SEARCH_GRAM } from "./format.gen"

// search.ts holds lazy fetch slots (summary/latest/shard LRU) as module
// state, so every test gets a fresh instance via resetModules + dynamic
// import (the dropdown.test.ts pattern).
const mockData = vi.hoisted(() => {
   const data = {
      db: {} as Record<string, unknown>,
      fetchPackBytes: vi.fn<(path: string, isLatest: boolean) => Promise<ArrayBuffer>>(),
      // Same formula as the real data.ts export, driven by the mock db.
      numFinalizedMeta: () => {
         const total = (data.db.total_art as number) ?? 0
         return total > 0 ? Math.floor((total - 1) / META_PACK_SIZE) : 0
      },
      metaReady: () => {
         const total = (data.db.total_art as number) ?? 0
         if (total === 0) return false
         const mp = (data.db.mp as number) ?? 0
         return mp === data.numFinalizedMeta() && mp * META_PACK_SIZE + ((data.db.mt as number) ?? 0) === total
      },
      parseJsonl: <T>(buf: ArrayBuffer): T[] => {
         const text = new TextDecoder().decode(buf)
         const out: T[] = []
         for (const line of text.split("\n")) {
            if (line) out.push(JSON.parse(line) as T)
         }
         return out
      },
   }
   return data
})
vi.mock("./data", () => mockData)

type SearchMod = typeof import("./search")
let search: SearchMod

// In-memory store served by the fetchPackBytes mock: path → decompressed
// bytes (the real fetchPackBytes gunzips before returning).
let store: Record<string, Uint8Array>

function entryBytes(titles: (string | undefined)[], feedId = 1): Uint8Array {
   const lines = titles.map((t) => JSON.stringify(t === undefined ? { f: feedId, w: 1000 } : { f: feedId, w: 1000, t }))
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
      ["ﬁle", "ﬁle"], // NFD (not NFKD) leaves the ﬁ ligature intact
      ["foo😀bar", "foo bar"], // emoji is neither letter nor number → a separator
      ["́abc", "abc"], // an orphan combining mark (Mn) is stripped
      ["٤٢", "٤٢"], // Arabic-Indic digits are \p{N}, kept as a word
   ])("fold(%j) = %j", (input, want) => {
      expect(search.fold(input)).toBe(want)
   })
})

describe("bloomBits", () => {
   it("matches the backend's probe vectors (cross-language parity pin)", () => {
      // The same literals are asserted against the Go bloomBits in
      // backend/db_meta_test.go TestBloomBitsVectors.
      expect(search.bloomBits("abc")).toEqual([22347, 31076, 7037, 15766, 24495, 456, 9185])
      expect(search.bloomBits("ukr")).toEqual([1353, 5218, 9083, 12948, 16813, 20678, 24543])
      expect(search.bloomBits("日本語")).toEqual([28551, 21052, 13553, 6054, 31323, 23824, 16325])
      expect(search.bloomBits("niñ")).toEqual([9728, 25531, 8566, 24369, 7404, 23207, 6242])
      expect(search.bloomBits("42a")).toEqual([1574, 28479, 22616, 16753, 10890, 5027, 31932])
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
   it("gates on metaReady() (mp + mt fully cover the store)", () => {
      mockData.db = { total_art: 0 }
      expect(search.available()).toBe(false)
      // Small store (no finalized shards), meta-aware backend: mp=0, mt=total_art.
      mockData.db = { total_art: 10, mp: 0, mt: 10 }
      expect(search.available()).toBe(true)
      // Small store, pre-meta backend: both fields absent.
      mockData.db = { total_art: 10 }
      expect(search.available()).toBe(false)
      // Finalized coverage complete / lagging.
      mockData.db = { total_art: META_PACK_SIZE + 1, mp: 1, mt: 1 }
      expect(search.available()).toBe(true)
      mockData.db = { total_art: 2 * META_PACK_SIZE + 1, mp: 1, mt: 1 }
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
   // META_PACK_SIZE bases alone.
   const shard0 = ["Alpha ancient", "Café Niño", "unrelated thing"]
   const shard1 = ["Alpha middle", "Boring row", undefined]
   const latest = ["Alpha latest", "Final entry"]

   beforeEach(() => {
      mockData.db = { total_art: 2 * META_PACK_SIZE + latest.length, seq: 7, mp: 2, mt: latest.length }
      store["meta/0.gz"] = concat(bloomOf(shard0), entryBytes(shard0))
      store["meta/1.gz"] = concat(bloomOf(shard1), entryBytes(shard1))
      store["meta/L7.gz"] = entryBytes(latest)
      store["meta/s2.gz"] = concat(bloomOf(shard0), bloomOf(shard1))
   })

   it("yields newest-first batches with shard-based chron addressing", async () => {
      const batches = await collect(search.search("alpha"))
      expect(batches.map((b) => b.map((h) => h.chron))).toEqual([
         [2 * META_PACK_SIZE], // latest tail
         [META_PACK_SIZE], // shard 1
         [0], // shard 0
      ])
      expect(batches[0][0]).toMatchObject({ t: "Alpha latest", f: 1, w: 1000 })
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
      expect(fetched).not.toContain("meta/0.gz")
      expect(fetched).not.toContain("meta/1.gz")
   })

   it("scans only the latest tail for short queries", async () => {
      // "al" substring-matches both tail titles ("Alpha…", "Final…"), newest first.
      const batches = await collect(search.search("al"))
      expect(batches.flat().map((h) => h.t)).toEqual(["Final entry", "Alpha latest"])
      const fetched = mockData.fetchPackBytes.mock.calls.map((c) => c[0])
      expect(fetched).toEqual(["meta/L7.gz"])
   })

   it("degrades to finalized shards when the latest tail is missing", async () => {
      delete store["meta/L7.gz"]
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const batches = await collect(search.search("alpha"))
      expect(batches.map((b) => b.map((h) => h.chron))).toEqual([[META_PACK_SIZE], [0]])
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
   })

   it("rejects when the summary is missing (caller surfaces it)", async () => {
      delete store["meta/s2.gz"]
      await expect(collect(search.search("alpha"))).rejects.toThrow()
   })

   it("fetches each shard and the summary once across queries", async () => {
      await collect(search.search("alpha"))
      await collect(search.search("alpha"))
      const fetched = mockData.fetchPackBytes.mock.calls.map((c) => c[0])
      expect(fetched.filter((p) => p === "meta/s2.gz")).toHaveLength(1)
      expect(fetched.filter((p) => p === "meta/0.gz")).toHaveLength(1)
   })

   it("treats untitled entries as unmatchable", async () => {
      const batches = await collect(search.search("boring"))
      expect(batches.flat().map((h) => h.chron)).toEqual([META_PACK_SIZE + 1])
   })

   it("stops at limit, counting only hits accept keeps", async () => {
      // "alpha" matches one title in each shard; limit 2 never reaches shard 0.
      const capped = await collect(search.search("alpha", 2))
      expect(capped.flat().map((h) => h.chron)).toEqual([2 * META_PACK_SIZE, META_PACK_SIZE])
      // A rejected hit doesn't count against the limit: with the latest-tail
      // match filtered out, limit 1 still reaches shard 1.
      const accept = (_s: number, chron: number) => chron < 2 * META_PACK_SIZE
      const filtered = await collect(search.search("alpha", 1, accept))
      expect(filtered.flat().map((h) => h.chron)).toEqual([META_PACK_SIZE])
   })
})
