import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { IDX_BOUNDARY_SIZE, IDX_ENTRY_SIZE, IDX_HEADER_PREFIX, IDX_STATE_SIZE, PACK_SERIES_KINDS } from "./format.gen"

// --- helpers copied from data.edge.test.ts ---

const IDX_PACK_SIZE = 50000
const META_PACK_SIZE = 5000

interface Entry {
   feedId: number
   deltaPackId?: 0 | 1
}

// packBuf builds one idx pack. `feedCounts` populates the variable-length header
// (the cumulative per-feed counts BEFORE this pack, numSlots = feedCounts.length);
// it defaults to [] (numSlots 0, header prefix only) so the latest-only callers
// below are unchanged. The finalized-scope test needs a populated latest-pack
// header so packHasCandidate sees a real feed delta.
function packBuf(entries: Entry[], packIdBase = 1, packOffBase = 0, feedCounts: number[] = []): ArrayBuffer {
   const numSlots = feedCounts.length
   const headerBytes = IDX_HEADER_PREFIX + numSlots * 4
   const boundaries: number[] = []
   entries.forEach((e, i) => {
      if (e.deltaPackId) boundaries.push(i)
   })
   const buf = new ArrayBuffer(headerBytes + entries.length * IDX_ENTRY_SIZE + boundaries.length * IDX_BOUNDARY_SIZE)
   const view = new DataView(buf)
   view.setUint32(0, packIdBase, true)
   view.setUint32(4, packOffBase, true)
   view.setUint32(IDX_STATE_SIZE, numSlots, true)
   for (let s = 0; s < numSlots; s++) view.setUint32(IDX_HEADER_PREFIX + s * 4, feedCounts[s], true)
   const bytes = new Uint8Array(buf)
   for (let i = 0; i < entries.length; i++) {
      const off = headerBytes + i * IDX_ENTRY_SIZE
      bytes[off] = entries[i].feedId & 0xff
      bytes[off + 1] = (entries[i].feedId >> 8) & 0xff
   }
   let foff = headerBytes + entries.length * IDX_ENTRY_SIZE
   for (const b of boundaries) {
      view.setUint16(foff, b, true)
      foff += IDX_BOUNDARY_SIZE
   }
   return buf
}

// summaryBuf builds an idx/h<N>.gz body: the verbatim concatenation of finalized
// packs' variable-length headers (each a 12-byte prefix + numSlots u32 counts),
// exactly what parseIdxHeaders walks by variable stride.
function summaryBuf(headers: { packIdBase: number; packOffBase: number; feedCounts: number[] }[]): ArrayBuffer {
   let size = 0
   for (const h of headers) size += IDX_HEADER_PREFIX + h.feedCounts.length * 4
   const buf = new ArrayBuffer(size)
   const view = new DataView(buf)
   let off = 0
   for (const h of headers) {
      view.setUint32(off, h.packIdBase, true)
      view.setUint32(off + 4, h.packOffBase, true)
      view.setUint32(off + IDX_STATE_SIZE, h.feedCounts.length, true)
      for (let s = 0; s < h.feedCounts.length; s++) {
         view.setUint32(off + IDX_HEADER_PREFIX + s * 4, h.feedCounts[s], true)
      }
      off += IDX_HEADER_PREFIX + h.feedCounts.length * 4
   }
   return buf
}

async function gzip(input: ArrayBuffer | string): Promise<Uint8Array> {
   const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
   const stream = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"))
   return new Uint8Array(await new Response(stream).arrayBuffer())
}

// A minimal data-pack body (one JSONL article) with NO assets/ refs, so
// packNamesForFilter's asset-enumeration pass can fetch+parse the data packs it
// returns without 404ing — and adds no asset names (these tests assert pack-name
// grammar only). Tests that exercise asset enumeration pass their own content.
const DATA_NOASSET = '{"f":0,"a":1,"c":"plain text, no assets here"}\n'

// manifestFor turns the store description below into the `names` table the
// writer publishes. Stems are opaque, so these tests pick ones that coincide
// with each object's POSITION — the tail of each series therefore lands at
// <series>/<finalized count>.gz — plus two out-of-band stems for the summaries.
// Nothing under test depends on that choice; it just keeps the fixtures legible.
const HSUM_STEM = 900
const SSUM_STEM = 901
function manifestFor(db: Partial<IDB>) {
   const total = db.total_art ?? 0
   const tc = total - (db.na ?? 0)
   const nfIdx = total > 0 ? Math.floor((total - 1) / IDX_PACK_SIZE) : 0
   const mp = db.mp ?? 0
   const nextPid = db.next_pid ?? 0
   const run = (count: number) => (count > 0 ? [[0, count]] : [])
   const names: Record<string, unknown> = {
      idx: { r: run(nfIdx + (tc > 0 ? 1 : 0)), ...(tc > 0 ? { l: nfIdx } : {}) },
      data: { b: 1, r: nextPid > 0 ? [[1, nextPid - 1 + (tc > 0 ? 1 : 0)]] : [], ...(tc > 0 ? { l: nextPid } : {}) },
      meta: { r: run(mp + (tc > 0 ? 1 : 0)), ...(tc > 0 ? { l: mp } : {}) },
   }
   if (db.hdrs) names.hsum = { s: "idx", stem: HSUM_STEM, covers: db.hdrs }
   if (mp) names.ssum = { s: "meta", stem: SSUM_STEM, covers: mp }
   return {
      v: 2,
      m: 1,
      fetched_at: 1,
      total_art: total,
      mt: db.mt,
      na: db.na,
      pack_off: db.pack_off ?? 0,
      names,
      feeds: db.feeds ?? {},
   }
}

async function mount(db: Partial<IDB>, packs: Record<string, ArrayBuffer | string> = {}) {
   const files = new Map<string, Uint8Array>()
   files.set("/db.gz", await gzip(JSON.stringify({ v: 2, m: 1, t: 1 })))
   files.set("/manifest/1.gz", await gzip(JSON.stringify(manifestFor(db))))
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
const PACK_KINDS = [...new Set(Object.values(PACK_SERIES_KINDS).join(""))].join("")
const KIND_CLASS = PACK_KINDS ? `[${PACK_KINDS}]?` : ""
const RE_PACK = new RegExp(`/packs/(${Object.keys(PACK_SERIES_KINDS).join("|")})/(${KIND_CLASS})(\\d+)\\.gz$`)
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
      const data = await mount(db, { "idx/0.gz": latestIdx, "data/1.gz": DATA_NOASSET })

      // all feeds = empty Map means [ALL]
      const names = await data.packNamesForFilter(new Map())
      expect(names.length).toBeGreaterThan(0)
      // All names must pass parsePackName
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }
      // Latest idx and data should be included
      expect(names).toContain("idx/0.gz")
      expect(names).toContain("data/1.gz")
      // Latest meta should be included
      expect(names).toContain("meta/0.gz")
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
         [`idx/${HSUM_STEM}.gz`]: summary,
         "idx/1.gz": latestIdx,
         "data/1.gz": DATA_NOASSET,
         "data/2.gz": DATA_NOASSET,
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
      // Should include the tail packs
      expect(names).toContain("idx/1.gz")
      expect(names).toContain("data/2.gz")
      expect(names).toContain(`meta/${nMetaFinalized}.gz`)
   })

   it("packNamesForFilter enumerates finalized packs for a single-feed filter", async () => {
      // The non-[ALL] FINALIZED branch (data.ts ~517-559) had no coverage: every
      // other feed/tag case here uses a latest-only 3-article store, so the
      // pack-skip `continue`, the multi-boundary boundsIdx++ advance, and the
      // asset loop's empty-content skip never ran. This mounts a MULTI-PACK store
      // (2 finalized idx packs) where the target feed 5 is ABSENT from finalized
      // pack 0 (→ `continue`), present in finalized pack 1 spanning two data packs
      // (→ boundsIdx++), and present in the latest pack — then filters on feed 5.
      const nArt = 2 * IDX_PACK_SIZE + 1 // 100001 → nfIdx=2, latest idx pack = 1 entry
      const nfMeta = Math.floor((nArt - 1) / META_PACK_SIZE) // 20
      const db: Partial<IDB> = {
         total_art: nArt,
         seq: 1,
         next_pid: 4, // data packs 1..3 finalized; data/L1 = latest (bounds packId 4)
         pack_off: 10,
         hdrs: 2,
         mp: nfMeta,
         mt: 1,
         feeds: {
            0: { id: 0, title: "P0", total_art: IDX_PACK_SIZE, add_idx: 0 },
            1: { id: 1, title: "P1", total_art: IDX_PACK_SIZE - 2, add_idx: 0 },
            5: { id: 5, title: "T", total_art: 3, add_idx: 0 },
         } as unknown as IDB["feeds"],
      }

      // idx summary (idx/h2.gz): one header per finalized pack.
      //  - pack 0: cumulative-before-pack-0 = nothing → numSlots 0.
      //  - pack 1: cumulative-before-pack-1 = pack 0's counts (feed 0: 50000); feed 5
      //    absent here (countAt past numSlots → 0), so packHasCandidate(0) skips it.
      const summary = summaryBuf([
         { packIdBase: 1, packOffBase: 0, feedCounts: [] },
         { packIdBase: 2, packOffBase: 0, feedCounts: [IDX_PACK_SIZE] },
      ])

      // Finalized idx pack 1 (chron 50000..99999): feed 5 at local 0 (data pack 2)
      // and local 30000 (data pack 3, past the boundary at local 25000); the rest is
      // filler feed 1. Its own header counts are unread by packNamesForFilter, so
      // numSlots 0 keeps it minimal.
      const pack1: Entry[] = new Array(IDX_PACK_SIZE)
      for (let i = 0; i < IDX_PACK_SIZE; i++) pack1[i] = { feedId: 1 }
      pack1[0] = { feedId: 5 }
      pack1[25000] = { feedId: 1, deltaPackId: 1 } // data pack 2 → 3 boundary
      pack1[30000] = { feedId: 5 }
      const idx1 = packBuf(pack1, 2, 0) // packIdBase 2 (data pack 2)

      // Latest idx pack (chron 100000): feed 5. Its header carries cumulative-before-
      // latest (packs 0+1) so packHasCandidate(1) sees a positive feed-5 delta.
      //   feed 0: 50000 (all pack 0), feed 1: 49998, feed 5: 2 (both in pack 1)
      const latestIdx = packBuf([{ feedId: 5 }], 4, 0, [IDX_PACK_SIZE, IDX_PACK_SIZE - 2, 0, 0, 0, 2])

      // Data packs — fetched only by the asset-enumeration pass. data/2.gz carries an
      // asset-bearing article AND a c:"" article (the empty-content skip); the c:""
      // articles (here and in data/L1.gz) must contribute no asset name.
      const asset = "assets/ab/0123456789abcdef.webp"
      const data2 = `{"f":5,"a":1,"c":"<img src=\\"${asset}\\">"}\n{"f":1,"a":1,"c":""}\n`
      const data3 = '{"f":5,"a":1,"c":"plain, no asset here"}\n'
      const dataL = '{"f":5,"a":1}\n' // no content field → skipped by the asset pass

      const data = await mount(db, {
         [`idx/${HSUM_STEM}.gz`]: summary,
         "idx/1.gz": idx1,
         "idx/2.gz": latestIdx,
         "data/2.gz": data2,
         "data/3.gz": data3,
         "data/4.gz": dataL,
      })

      const names = await data.packNamesForFilter(new Map([[5, 0]]))

      // Every pack name passes the SW grammar (asset keys use RE_ASSET, not RE_PACK).
      for (const n of names) {
         if (!n.startsWith("assets/")) expect(checkName(n)).toBe(true)
      }

      // Finalized subset for feed 5: pack 1 is walked; pack 0 is SKIPPED (feed absent).
      expect(names).toContain("idx/1.gz")
      expect(names).not.toContain("idx/0.gz")
      // feed 5's finalized data packs (spanning the boundary) + their meta shards.
      expect(names).toContain("data/2.gz")
      expect(names).toContain("data/3.gz")
      expect(names).toContain("meta/10.gz") // chron 50000
      expect(names).toContain("meta/16.gz") // chron 80000
      // Tail packs + the boot/search summaries.
      expect(names).toContain("idx/2.gz")
      expect(names).toContain("data/4.gz")
      expect(names).toContain(`meta/${nfMeta}.gz`)
      expect(names).toContain(`idx/${HSUM_STEM}.gz`)
      expect(names).toContain(`meta/${SSUM_STEM}.gz`)
      // The asset-bearing article's key is enumerated; the c:"" articles add none.
      expect(names.filter((n) => n.startsWith("assets/"))).toEqual([asset])
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
      const data = await mount(db, { "idx/0.gz": latestIdx, "data/1.gz": DATA_NOASSET })

      // Filter for feed 0 only
      const feedsMap = new Map([[0, 0]])
      const names = await data.packNamesForFilter(feedsMap)

      expect(names.length).toBeGreaterThan(0)
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }
      // Should include the tail idx (since feed 0 is there)
      expect(names).toContain("idx/0.gz")
      // Should include the data pack that holds feed 0's articles
      expect(names).toContain("data/1.gz")
      // Should include meta for those chronIdxs
      expect(names).toContain("meta/0.gz")
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
      const data = await mount(db, { "idx/0.gz": latestIdx, "data/1.gz": DATA_NOASSET })

      const names = await data.packNamesForFilter(new Map())
      for (const n of names) {
         expect(checkName(n)).toBe(true)
      }
      expect(names).toContain("idx/0.gz")
      expect(names).toContain("data/1.gz")
   })

   it("includes self-hosted assets/ keys referenced by the pinned data packs", async () => {
      // A pinned scope must also cache the assets/ images its articles link to,
      // or they show broken offline. packNamesForFilter parses each pinned data
      // pack and emits every assets/<2hex>/<16hex> key it finds.
      const db: Partial<IDB> = {
         total_art: 1,
         seq: 1,
         next_pid: 1,
         pack_off: 50,
         mp: 0,
         mt: 1,
         feeds: {
            0: { id: 0, title: "A", total_art: 1, add_idx: 0 },
         } as unknown as IDB["feeds"],
      }
      const latestIdx = packBuf([{ feedId: 0 }], 1, 0)
      const withAsset =
         '{"f":0,"a":1,"c":"<p>see <img src=\\"assets/ab/0123456789abcdef.webp\\"> and ' +
         '<a href=\\"assets/cd/fedcba9876543210.pdf\\">doc</a></p>"}\n'
      const data = await mount(db, { "idx/0.gz": latestIdx, "data/1.gz": withAsset })

      const names = await data.packNamesForFilter(new Map())
      expect(names).toContain("assets/ab/0123456789abcdef.webp")
      expect(names).toContain("assets/cd/fedcba9876543210.pdf")
      // The pack names themselves still pass the SW grammar; assets are validated
      // separately (RE_ASSET) on the SW side.
      expect(names).toContain("data/1.gz")
   })
})
