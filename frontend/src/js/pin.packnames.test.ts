import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { IDX_BOUNDARY_SIZE, IDX_ENTRY_SIZE, IDX_HEADER_PREFIX, IDX_STATE_SIZE, PACK_SERIES_KINDS } from "./format.gen"

// --- helpers copied from data.edge.test.ts ---

const IDX_PACK_SIZE = 50000
const META_PACK_SIZE = 5000

interface Entry {
   feedId: number
   deltaPackId?: 0 | 1
}

function packBuf(entries: Entry[], packIdBase = 1, packOffBase = 0): ArrayBuffer {
   const boundaries: number[] = []
   entries.forEach((e, i) => {
      if (e.deltaPackId) boundaries.push(i)
   })
   const buf = new ArrayBuffer(
      IDX_HEADER_PREFIX + entries.length * IDX_ENTRY_SIZE + boundaries.length * IDX_BOUNDARY_SIZE,
   )
   const view = new DataView(buf)
   view.setUint32(0, packIdBase, true)
   view.setUint32(4, packOffBase, true)
   view.setUint32(IDX_STATE_SIZE, 0, true) // numSlots = 0
   const bytes = new Uint8Array(buf)
   for (let i = 0; i < entries.length; i++) {
      const off = IDX_HEADER_PREFIX + i * IDX_ENTRY_SIZE
      bytes[off] = entries[i].feedId & 0xff
      bytes[off + 1] = (entries[i].feedId >> 8) & 0xff
   }
   let foff = IDX_HEADER_PREFIX + entries.length * IDX_ENTRY_SIZE
   for (const b of boundaries) {
      view.setUint16(foff, b, true)
      foff += IDX_BOUNDARY_SIZE
   }
   return buf
}

async function gzip(input: ArrayBuffer | string): Promise<Uint8Array> {
   const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
   const stream = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"))
   return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function mount(db: Partial<IDB>, packs: Record<string, ArrayBuffer> = {}) {
   const files = new Map<string, Uint8Array>()
   files.set("/db.gz", await gzip(JSON.stringify(db)))
   for (const [path, buf] of Object.entries(packs)) files.set("/" + path, await gzip(buf))
   global.fetch = vi.fn(async (input: URL | string) => {
      const url = input instanceof URL ? input : new URL(String(input))
      const gz = files.get(url.pathname)
      return gz ? new Response(gz, { status: 200 }) : new Response("not found", { status: 404 })
   }) as unknown as typeof fetch
   vi.resetModules()
   const data = await import("./data")
   await data.init()
   return data
}

// Validates that all returned names pass the SW's parsePackName grammar.
const PACK_KINDS = [...new Set(Object.values(PACK_SERIES_KINDS).join(""))].join("") // "Lhs"
const RE_PACK = new RegExp(`/packs/(${Object.keys(PACK_SERIES_KINDS).join("|")})/([${PACK_KINDS}]?)(\\d+)\\.gz$`)
function checkName(name: string): boolean {
   // Simulate the SW's parsePackName: prefix with "/packs/" for RE_PACK test
   const path = `/packs/${name}`
   const m = RE_PACK.exec(path)
   if (!m || !PACK_SERIES_KINDS[m[1]].includes(m[2])) return false
   return true
}

beforeEach(() => {
   sessionStorage.clear()
})
afterEach(() => {
   vi.restoreAllMocks()
   vi.resetModules()
})

describe("packNamesForFilter", () => {
   it("empty store returns no names", async () => {
      const data = await mount({ total_art: 0, seq: 0, next_pid: 1, feeds: {} })
      const names = await data.packNamesForFilter(new Map())
      expect(names).toEqual([])
   })

   it("[ALL] with only latest packs: returns latest idx, data, meta names", async () => {
      // total_art=3, seq=1: no finalized packs; latest pack L1 holds everything
      // next_pid=1 means data pack 1 is current (not yet finalized — data packs
      // start at 1 and next_pid > current = finalized)
      const db = {
         total_art: 3,
         seq: 1,
         next_pid: 1,
         pack_off: 100,
         mp: 0,
         mt: 3,
         feeds: {
            0: { id: 0, title: "A", total_art: 3, add_idx: 0 },
         } as unknown as IDB["feeds"],
      }
      const latestIdx = packBuf([{ feedId: 0 }, { feedId: 0 }, { feedId: 0 }], 1, 0)
      const data = await mount(db, { "idx/L1.gz": latestIdx })

      // all feeds = empty Map means [ALL]
      const names = await data.packNamesForFilter(new Map())
      expect(names.length).toBeGreaterThan(0)
      // All names must pass parsePackName
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }
      // Latest idx and data should be included
      expect(names).toContain("idx/L1.gz")
      expect(names).toContain("data/L1.gz")
      // Latest meta should be included
      expect(names).toContain("meta/L1.gz")
   })

   it("[ALL] with finalized packs: returns all finalized names + latest", async () => {
      // total_art = IDX_PACK_SIZE + 1 → 1 finalized idx pack (idx/0.gz)
      // next_pid = 2 → data/1.gz finalized; data/L1.gz = latest
      // numFinalizedMeta = floor((50001-1)/5000) = floor(50000/5000) = 10 shards
      const nArt = IDX_PACK_SIZE + 1
      const nMetaFinalized = Math.floor((nArt - 1) / META_PACK_SIZE) // 10
      const db: Partial<IDB> = {
         total_art: nArt,
         seq: 1,
         next_pid: 2,
         pack_off: 10,
         hdrs: 1,
         mp: nMetaFinalized,
         mt: 1,
         feeds: {
            0: { id: 0, title: "A", total_art: nArt, add_idx: 0 },
         } as unknown as IDB["feeds"],
      }
      // idx summary: 1 finalized header (12 bytes, numSlots=0)
      const summary = new ArrayBuffer(IDX_HEADER_PREFIX)
      const latestIdx = packBuf([{ feedId: 0 }], 2, 0)
      const data = await mount(db, {
         "idx/h1.gz": summary,
         "idx/L1.gz": latestIdx,
      })

      const names = await data.packNamesForFilter(new Map())
      expect(names.length).toBeGreaterThan(0)

      // All must pass parsePackName grammar
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }

      // Should include finalized idx pack
      expect(names).toContain("idx/0.gz")
      // Should include finalized data pack
      expect(names).toContain("data/1.gz")
      // Should include finalized meta shards 0..9
      for (let i = 0; i < nMetaFinalized; i++) {
         expect(names).toContain(`meta/${i}.gz`)
      }
      // Should include latest packs
      expect(names).toContain("idx/L1.gz")
      expect(names).toContain("data/L1.gz")
      expect(names).toContain("meta/L1.gz")
   })

   it("single-feed filter: only touches idx packs that have the feed, maps to data packs", async () => {
      // 3 articles: feed 0 has articles at chron 0, 2; feed 1 has chron 1
      // All in the latest pack (total_art=3, seq=1, no finalized)
      // data pack: id=1 (latest, next_pid=1)
      const db: Partial<IDB> = {
         total_art: 3,
         seq: 1,
         next_pid: 1,
         pack_off: 100,
         mp: 0,
         mt: 3,
         feeds: {
            0: { id: 0, title: "A", total_art: 2, add_idx: 0 },
            1: { id: 1, title: "B", total_art: 1, add_idx: 0 },
         } as unknown as IDB["feeds"],
      }
      const latestIdx = packBuf([{ feedId: 0 }, { feedId: 1 }, { feedId: 0 }], 1, 0)
      const data = await mount(db, { "idx/L1.gz": latestIdx })

      // Filter for feed 0 only
      const feedsMap = new Map([[0, 0]])
      const names = await data.packNamesForFilter(feedsMap)

      expect(names.length).toBeGreaterThan(0)
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }
      // Should include the latest idx (since feed 0 is there)
      expect(names).toContain("idx/L1.gz")
      // Should include the data pack that holds feed 0's articles
      expect(names).toContain("data/L1.gz")
      // Should include meta for those chronIdxs
      expect(names).toContain("meta/L1.gz")
   })

   it("no includeLatest flag: still includes latest pack by default", async () => {
      const db: Partial<IDB> = {
         total_art: 2,
         seq: 2,
         next_pid: 1,
         pack_off: 50,
         mp: 0,
         mt: 2,
         feeds: {
            0: { id: 0, title: "A", total_art: 2, add_idx: 0 },
         } as unknown as IDB["feeds"],
      }
      const latestIdx = packBuf([{ feedId: 0 }, { feedId: 0 }], 1, 0)
      const data = await mount(db, { "idx/L2.gz": latestIdx })

      const names = await data.packNamesForFilter(new Map())
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }
      expect(names).toContain("idx/L2.gz")
      expect(names).toContain("data/L2.gz")
   })
})
