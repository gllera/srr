import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mountReader, type MountedReader } from "./mount"

// Lazy-idx contract: a synthetic store with two finalized idx packs
// (100,002 articles) drives the REAL reader through the summary fast path —
// boot fetches db.gz + idx/h2.gz + idx/L1.gz only, finalized packs load
// lazily on first touch, and header deltas skip packs without fetching.
// The writer side of idx/h<N>.gz is exercised at real scale by the backend
// Go tests (TestSyncIdxSummary*, TestInspectValidateSummary); hand-built
// bytes here keep this layer inside the `make verify` time budget.

const IDX_PACK_SIZE = 50000
const HEADER_BYTES = 259 * 4

interface Hdr {
   fetchedAtBase: number
   packIdBase: number
   packOffBase: number
   chanCounts: Record<number, number>
}

function headerBytes(h: Hdr): Uint8Array {
   const buf = new Uint8Array(HEADER_BYTES)
   const view = new DataView(buf.buffer)
   view.setUint32(0, h.fetchedAtBase, true)
   view.setUint32(4, h.packIdBase, true)
   view.setUint32(8, h.packOffBase, true)
   for (const [k, v] of Object.entries(h.chanCounts)) view.setUint32(12 + Number(k) * 4, v, true)
   return buf
}

// Entries: [chanId, deltaPackId, deltaFetchedAt][]
function idxPack(h: Hdr, entries: [number, number, number][]): Uint8Array {
   const buf = new Uint8Array(HEADER_BYTES + entries.length * 2)
   buf.set(headerBytes(h))
   entries.forEach(([chanId, deltaPack, deltaFetched], i) => {
      buf[HEADER_BYTES + i * 2] = chanId
      buf[HEADER_BYTES + i * 2 + 1] = (deltaPack << 7) | (deltaFetched & 0x7f)
   })
   return buf
}

function fill(chanId: number, first: [number, number, number]): [number, number, number][] {
   const out: [number, number, number][] = [first]
   for (let i = 1; i < IDX_PACK_SIZE; i++) out.push([chanId, 0, 0])
   return out
}

const FIRST_FETCHED = 1700000000

// Layout: pack 0 = 50k × chan 0 (fetchedAts 0, data pack 1) · pack 1 = 50k ×
// chan 1 (fetchedAts 10, data pack 2) · latest = 2 × chan 2 (fetchedAts 20,
// data pack 3 = data/L1.gz). hdrs=2 covers packs 0 and 1.
function buildStore(opts: { hdrs: boolean; summaryFile: boolean }): string {
   const dir = mkdtempSync(join(tmpdir(), "srr-summary-"))
   mkdirSync(join(dir, "idx"))
   mkdirSync(join(dir, "data"))

   const hdr0: Hdr = { fetchedAtBase: 0, packIdBase: 0, packOffBase: 0, chanCounts: {} }
   const hdr1: Hdr = { fetchedAtBase: 0, packIdBase: 1, packOffBase: IDX_PACK_SIZE, chanCounts: { 0: 50000 } }
   const hdrLatest: Hdr = {
      fetchedAtBase: 10,
      packIdBase: 2,
      packOffBase: IDX_PACK_SIZE,
      chanCounts: { 0: 50000, 1: 50000 },
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
      const sum = new Uint8Array(2 * HEADER_BYTES)
      sum.set(headerBytes(hdr0))
      sum.set(headerBytes(hdr1), HEADER_BYTES)
      writeFileSync(join(dir, "idx/h2.gz"), gzipSync(sum))
   }

   const latestArticles = [0, 1].map((i) => JSON.stringify({ s: 2, a: FIRST_FETCHED, t: `latest-${i}`, l: "", c: "x" }))
   writeFileSync(join(dir, "data/L1.gz"), gzipSync(latestArticles.join("\n") + "\n"))

   const db = {
      seq: 1,
      fetched_at: FIRST_FETCHED,
      total_art: 100002,
      next_pid: 3,
      pack_off: 2,
      first_fetched: FIRST_FETCHED,
      ...(opts.hdrs ? { hdrs: 2 } : {}),
      channels: {
         0: { title: "A", feeds: [], total_art: 50000, add_idx: 0 },
         1: { title: "B", feeds: [], total_art: 50000, add_idx: 0 },
         2: { title: "C", feeds: [], total_art: 2, add_idx: 100000 },
      },
   }
   writeFileSync(join(dir, "db.gz"), gzipSync(JSON.stringify(db)))
   return dir
}

// ts whose 8h-block distance from first_fetched is exactly `blocks`.
function tsAtBlocks(blocks: number): number {
   return (Math.trunc(FIRST_FETCHED / 28800) + blocks) * 28800
}

describe("contract: idx header summary fast path", () => {
   let store: string
   let reader: MountedReader

   const fetched = () => reader.fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname)

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
      // chan 0 lives only in pack 0: the walk must skip pack 1 entirely.
      expect(await reader.data.findLeft(100001, new Map([[0, 0]]))).toBe(49999)
      const paths = fetched()
      expect(paths.some((p) => p.endsWith("idx/0.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/1.gz"))).toBe(false)
   })

   it("fetches a finalized pack lazily on first touch", async () => {
      expect(await reader.data.getChannelId(75000)).toBe(1)
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
      const paths = reader.fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname)
      expect(paths.some((p) => p.endsWith("idx/0.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/1.gz"))).toBe(true)
      expect(paths.some((p) => p.endsWith("idx/h2.gz"))).toBe(false)
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(50000)
      expect(await reader.data.getChannelId(75000)).toBe(1)
      expect(await reader.data.findChronForTimestamp(tsAtBlocks(5))).toBe(50000)
   })

   it("summary 404 (stale db.gz past the GC window): falls back instead of failing", async () => {
      const store = buildStore({ hdrs: true, summaryFile: false })
      stores.push(store)
      const reader = await mountReader(store)
      const paths = reader.fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname)
      expect(paths.some((p) => p.endsWith("idx/h2.gz"))).toBe(true) // attempted
      expect(paths.some((p) => p.endsWith("idx/0.gz"))).toBe(true) // then eager
      expect(await reader.data.findLeft(100001, new Map([[0, 0]]))).toBe(49999)
   })
})
