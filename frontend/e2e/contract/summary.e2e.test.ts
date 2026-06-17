import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
   FETCHED_AT_BLOCK,
   IDX_ENTRY_SIZE,
   IDX_HEADER_PREFIX,
   IDX_PACK_SIZE,
   IDX_STATE_SIZE,
} from "../../src/js/format.gen"
import { makeStore } from "../harness"
import { mountReader, type MountedReader } from "./mount"

// Lazy-idx contract: a synthetic store with two finalized idx packs
// (100,002 articles) drives the REAL reader through the summary fast path —
// boot fetches db.gz + idx/h2.gz + idx/L1.gz only, finalized packs load
// lazily on first touch, and header deltas skip packs without fetching.
// The writer side of idx/h<N>.gz is exercised at real scale by the backend
// Go tests (TestSyncIdxSummary*, TestInspectValidateSummary); hand-built
// bytes here keep this layer inside the `make verify` time budget.

interface Hdr {
   fetchedAtBase: number
   packIdBase: number
   packOffBase: number
   feedCounts: Record<number, number>
}

// numSlots a header carries: dense up to the highest feedCount key (+1), else 0.
function headerSlots(h: Hdr): number {
   const keys = Object.keys(h.feedCounts).map(Number)
   return keys.length > 0 ? Math.max(...keys) + 1 : 0
}

// Variable-length header: 3 state uint32s + numSlots uint32, then numSlots×4
// cumulative counts.
function headerBytes(h: Hdr): Uint8Array {
   const numSlots = headerSlots(h)
   const buf = new Uint8Array(IDX_HEADER_PREFIX + numSlots * 4)
   const view = new DataView(buf.buffer)
   view.setUint32(0, h.fetchedAtBase, true)
   view.setUint32(4, h.packIdBase, true)
   view.setUint32(8, h.packOffBase, true)
   view.setUint32(IDX_STATE_SIZE, numSlots, true)
   for (const [k, v] of Object.entries(h.feedCounts)) view.setUint32(IDX_HEADER_PREFIX + Number(k) * 4, v, true)
   return buf
}

// Entries: [feedId, deltaPackId, deltaFetchedAt][]; each entry is feed_id u16
// LE + packed u8.
function idxPack(h: Hdr, entries: [number, number, number][]): Uint8Array {
   const header = headerBytes(h)
   const buf = new Uint8Array(header.byteLength + entries.length * IDX_ENTRY_SIZE)
   buf.set(header)
   entries.forEach(([feedId, deltaPack, deltaFetched], i) => {
      const off = header.byteLength + i * IDX_ENTRY_SIZE
      buf[off] = feedId & 0xff
      buf[off + 1] = (feedId >> 8) & 0xff
      buf[off + 2] = (deltaPack << 7) | (deltaFetched & 0x7f)
   })
   return buf
}

function fill(feedId: number, first: [number, number, number]): [number, number, number][] {
   const out: [number, number, number][] = [first]
   for (let i = 1; i < IDX_PACK_SIZE; i++) out.push([feedId, 0, 0])
   return out
}

const FIRST_FETCHED = 1700000000

// Layout: pack 0 = 50k × feed 0 (fetchedAts 0, data pack 1) · pack 1 = 50k ×
// feed 1 (fetchedAts 10, data pack 2) · latest = 2 × feed 2 (fetchedAts 20,
// data pack 3 = data/L1.gz). hdrs=2 covers packs 0 and 1.
function buildStore(opts: { hdrs: boolean; summaryFile: boolean }): string {
   const dir = makeStore()
   mkdirSync(join(dir, "idx"))
   mkdirSync(join(dir, "data"))

   const hdr0: Hdr = { fetchedAtBase: 0, packIdBase: 0, packOffBase: 0, feedCounts: {} }
   const hdr1: Hdr = { fetchedAtBase: 0, packIdBase: 1, packOffBase: IDX_PACK_SIZE, feedCounts: { 0: 50000 } }
   const hdrLatest: Hdr = {
      fetchedAtBase: 10,
      packIdBase: 2,
      packOffBase: IDX_PACK_SIZE,
      feedCounts: { 0: 50000, 1: 50000 },
   }

   writeFileSync(join(dir, "idx/0.gz"), gzipSync(idxPack(hdr0, fill(0, [0, 1, 0]))))
   writeFileSync(join(dir, "idx/1.gz"), gzipSync(idxPack(hdr1, fill(1, [1, 1, 10]))))
   writeFileSync(
      join(dir, "idx/L1.gz"),
      gzipSync(
         idxPack(hdrLatest, [
            [2, 1, 10],
            [2, 0, 0],
         ]),
      ),
   )
   if (opts.summaryFile) {
      // The summary is the verbatim concatenation of each pack's
      // variable-length header (hdr0 numSlots 0, hdr1 numSlots 1).
      const h0 = headerBytes(hdr0)
      const h1 = headerBytes(hdr1)
      const sum = new Uint8Array(h0.byteLength + h1.byteLength)
      sum.set(h0)
      sum.set(h1, h0.byteLength)
      writeFileSync(join(dir, "idx/h2.gz"), gzipSync(sum))
   }

   const latestArticles = [0, 1].map((i) => JSON.stringify({ f: 2, a: FIRST_FETCHED, t: `latest-${i}`, l: "", c: "x" }))
   writeFileSync(join(dir, "data/L1.gz"), gzipSync(latestArticles.join("\n") + "\n"))

   const db = {
      seq: 1,
      fetched_at: FIRST_FETCHED,
      total_art: 100002,
      next_pid: 3,
      pack_off: 2,
      first_fetched: FIRST_FETCHED,
      ...(opts.hdrs ? { hdrs: 2 } : {}),
      feeds: {
         0: { title: "A", url: "http://a", total_art: 50000, add_idx: 0 },
         1: { title: "B", url: "http://b", total_art: 50000, add_idx: 0 },
         2: { title: "C", url: "http://c", total_art: 2, add_idx: 100000 },
      },
   }
   writeFileSync(join(dir, "db.gz"), gzipSync(JSON.stringify(db)))
   return dir
}

// ts whose 8h-block distance from first_fetched is exactly `blocks`.
function tsAtBlocks(blocks: number): number {
   return (Math.trunc(FIRST_FETCHED / FETCHED_AT_BLOCK) + blocks) * FETCHED_AT_BLOCK
}

const fetchedPaths = (r: MountedReader) => r.fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname)

describe("contract: idx header summary fast path", () => {
   let store: string
   let reader: MountedReader

   const fetched = () => fetchedPaths(reader)

   beforeAll(async () => {
      store = buildStore({ hdrs: true, summaryFile: true })
      reader = await mountReader(store)
   })

   afterAll(() => {
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("boots with db.gz + summary + latest pack only", () => {
      const paths = fetched()
      expect(paths.some((p) => p.endsWith("idx/h2.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/L1.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/0.gz") || p.endsWith("idx/1.gz"))).toBe(false)
   })

   it("countAll answers synchronously from summary counts + latest pack", () => {
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(50000)
      expect(reader.data.countAll(new Map([[2, 100000]]))).toBe(2)
      expect(fetched().some((p) => p.endsWith("idx/0.gz") || p.endsWith("idx/1.gz"))).toBe(false)
   })

   it("findLeft skips a no-match pack via header deltas without fetching it", async () => {
      // feed 0 lives only in pack 0: the walk must skip pack 1 entirely.
      expect(await reader.data.findLeft(100001, new Map([[0, 0]]))).toBe(49999)
      const paths = fetched()
      expect(paths.some((p) => p.endsWith("idx/0.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/1.gz"))).toBe(false)
   })

   it("fetches a finalized pack lazily on first touch", async () => {
      expect(await reader.data.getFeedId(75000)).toBe(1)
      expect(fetched().some((p) => p.endsWith("idx/1.gz"))).toBe(true)
   })

   it("findChronForTimestamp lands in the right pack via summary bases", async () => {
      expect(await reader.data.findChronForTimestamp(tsAtBlocks(5))).toBe(50000)
      expect(await reader.data.findChronForTimestamp(tsAtBlocks(15))).toBe(100000)
      expect(await reader.data.findChronForTimestamp(tsAtBlocks(999))).toBe(100001)
   })

   it("countLeft counts across pack boundaries", async () => {
      expect(
         await reader.data.countLeft(
            75000,
            new Map([
               [0, 0],
               [1, 0],
            ]),
         ),
      ).toBe(75000)
   })

   it("loadArticle resolves the latest data pack through the lazy idx path", async () => {
      const art = await reader.data.loadArticle(100001)
      expect(art.t).toBe("latest-1")
      expect(fetched().some((p) => p.endsWith("data/L1.gz"))).toBe(true)
   })
})

describe("contract: eager fallback when the summary is unavailable", () => {
   const stores: string[] = []

   afterAll(() => {
      for (const dir of stores) rmSync(dir, { recursive: true, force: true })
   })

   it("hdrs absent (old backend): boots eagerly with identical answers", async () => {
      const store = buildStore({ hdrs: false, summaryFile: false })
      stores.push(store)
      const reader = await mountReader(store)
      const paths = fetchedPaths(reader)
      expect(paths.some((p) => p.endsWith("idx/0.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/1.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/h2.gz"))).toBe(false)
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(50000)
      expect(await reader.data.getFeedId(75000)).toBe(1)
      expect(await reader.data.findChronForTimestamp(tsAtBlocks(5))).toBe(50000)
   })

   it("summary 404 (stale db.gz past the GC window): falls back instead of failing", async () => {
      const store = buildStore({ hdrs: true, summaryFile: false })
      stores.push(store)
      const reader = await mountReader(store)
      const paths = fetchedPaths(reader)
      expect(paths.some((p) => p.endsWith("idx/h2.gz"))).toBe(true) // attempted
      expect(paths.some((p) => p.endsWith("idx/0.gz"))).toBe(true) // then eager
      expect(await reader.data.findLeft(100001, new Map([[0, 0]]))).toBe(49999)
   })
})
