import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { IDX_HEADER_SIZE, FETCHED_AT_BLOCK } from "./format.gen"

// data.ts has a top-level db.gz fetch and private state set only by init(), so
// its composition edges (clamp, empty store, the first_fetched NaN guard, the
// 50000 pack seam, numFinalizedIdx's off-by-one) need a real fetch+init harness
// the always-non-empty contract stores can't reach. We stub global.fetch to
// serve gzipped synthetic packs and dynamic-import data.ts after, so its
// load-time fetch binds the stub. Real idx.ts/cache.ts compose underneath.

const PACK_SIZE = 50000

interface Entry {
   chanId: number
   deltaPackId?: 0 | 1
   deltaFetchedAt?: number
}

// Build one idx pack buffer (header + 2-byte entries), mirroring the backend
// writer and idx.test.ts's buildBuf.
function packBuf(entries: Entry[], opts: { fetchedAtBase?: number } = {}): ArrayBuffer {
   const buf = new ArrayBuffer(IDX_HEADER_SIZE + entries.length * 2)
   const view = new DataView(buf)
   view.setUint32(0, opts.fetchedAtBase ?? 0, true)
   const bytes = new Uint8Array(buf)
   for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      bytes[IDX_HEADER_SIZE + i * 2] = e.chanId
      bytes[IDX_HEADER_SIZE + i * 2 + 1] = ((e.deltaPackId ?? 0) << 7) | ((e.deltaFetchedAt ?? 0) & 0x7f)
   }
   return buf
}

// N zero-filled 1036-byte headers concatenated — a minimal idx/h<N>.gz summary.
function summaryBuf(n: number): ArrayBuffer {
   return new ArrayBuffer(IDX_HEADER_SIZE * n)
}

async function gzip(input: ArrayBuffer | string): Promise<Uint8Array> {
   const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
   const stream = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"))
   return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Mount a synthetic store: db.gz JSON + a map of pack path → buffer, all gzipped
// and served by a stubbed global.fetch. Returns the freshly imported data module
// after a successful init().
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

beforeEach(() => {
   sessionStorage.clear()
})
afterEach(() => {
   vi.restoreAllMocks()
   vi.resetModules()
})

describe("data.init / numFinalizedIdx — the (total_art-1)/50000 inflection", () => {
   it("empty store (total_art 0): init returns before any idx fetch; counts degrade to 0/-1", async () => {
      const data = await mount({ total_art: 0, channels: {} })
      expect(data.numFinalizedIdx()).toBe(0)
      expect(data.countAll(new Map())).toBe(0)
      expect(await data.findLeft(0, new Map())).toBe(-1)
      expect(await data.findRight(0, new Map())).toBe(-1)
      // db.gz was the only fetch — no idx pack was requested.
      const paths = (global.fetch as unknown as { mock: { calls: [URL][] } }).mock.calls.map((c) => c[0].pathname)
      expect(paths).toEqual(["/db.gz"])
   })

   it("total_art 1 → 0 finalized packs (everything in the latest pack)", async () => {
      const data = await mount({ total_art: 1, seq: 1 }, { "idx/L1.gz": packBuf([{ chanId: 3 }]) })
      expect(data.numFinalizedIdx()).toBe(0)
      expect(await data.getChannelId(0)).toBe(3)
   })

   it("total_art exactly 50000 → still 0 finalized (the article that finalizes pack 0 hasn't arrived)", async () => {
      const latest = packBuf(Array.from({ length: PACK_SIZE }, () => ({ chanId: 0 })))
      const data = await mount({ total_art: PACK_SIZE, seq: 1 }, { "idx/L1.gz": latest })
      expect(data.numFinalizedIdx()).toBe(0)
   })

   it("total_art 50001 → 1 finalized pack (the inflection)", async () => {
      const data = await mount(
         { total_art: PACK_SIZE + 1, seq: 1, hdrs: 1 },
         { "idx/h1.gz": summaryBuf(1), "idx/L1.gz": packBuf([{ chanId: 0 }]) },
      )
      expect(data.numFinalizedIdx()).toBe(1)
   })

   it("total_art 100001 → 2 finalized packs", async () => {
      const data = await mount(
         { total_art: 2 * PACK_SIZE + 1, seq: 1, hdrs: 2 },
         { "idx/h2.gz": summaryBuf(2), "idx/L1.gz": packBuf([{ chanId: 0 }]) },
      )
      expect(data.numFinalizedIdx()).toBe(2)
   })
})

describe("data.getChannelId — the 50000 pack boundary (last finalized vs first latest)", () => {
   it("addresses chron 49999 in finalized pack 0 and chron 50000 in the latest pack", async () => {
      // Eager path (no hdrs) so init fetches the finalized pack; entry 49999 of
      // pack 0 carries a sentinel chan, entry 0 of the latest carries another.
      const finalized = Array.from({ length: PACK_SIZE }, () => ({ chanId: 0 }))
      finalized[PACK_SIZE - 1] = { chanId: 7 }
      const data = await mount(
         { total_art: PACK_SIZE + 1, seq: 1 },
         { "idx/0.gz": packBuf(finalized), "idx/L1.gz": packBuf([{ chanId: 9 }]) },
      )
      expect(data.numFinalizedIdx()).toBe(1)
      expect(await data.getChannelId(PACK_SIZE - 1)).toBe(7) // last of finalized pack 0
      expect(await data.getChannelId(PACK_SIZE)).toBe(9) // first of the latest pack
   })
})

describe("data.channelTitle — deleted-channel tombstone", () => {
   it("returns the title for a known channel and [DELETED] for an absent chan_id", async () => {
      const data = await mount({
         total_art: 0,
         channels: { 5: { id: 5, title: "Live", total_art: 1 } } as unknown as IDB["channels"],
      })
      expect(data.channelTitle(5)).toBe("Live")
      expect(data.channelTitle(404)).toBe("[DELETED]") // its articles survive in packs; render a tombstone
   })
})

describe("data.findChronForTimestamp — clamp + first_fetched NaN guard", () => {
   // A 4-article single-pack store; fetchedAts (blocks) = [0, 5, 5, 20].
   const latest = () =>
      packBuf([{ chanId: 1 }, { chanId: 1, deltaFetchedAt: 5 }, { chanId: 1 }, { chanId: 1, deltaFetchedAt: 15 }])
   const at = (blocks: number) => blocks * FETCHED_AT_BLOCK // ts (seconds) for a block

   it("clamps a timestamp past the newest article to total_art-1 (not total_art)", async () => {
      const data = await mount({ total_art: 4, seq: 1, first_fetched: 0 }, { "idx/L1.gz": latest() })
      expect(await data.findChronForTimestamp(at(100))).toBe(3) // far future → last article
   })

   it("resolves a timestamp at/before the first article to chron 0", async () => {
      const data = await mount({ total_art: 4, seq: 1, first_fetched: 0 }, { "idx/L1.gz": latest() })
      expect(await data.findChronForTimestamp(0)).toBe(0)
      expect(await data.findChronForTimestamp(at(5))).toBe(1) // leftmost with block >= 5
   })

   it("stays finite when db.gz omits first_fetched (the NaN guard) instead of collapsing to NaN", async () => {
      // Without `?? 0`, trunc(undefined/B) is NaN → the whole search collapses.
      const data = await mount({ total_art: 4, seq: 1 }, { "idx/L1.gz": latest() })
      const chron = await data.findChronForTimestamp(at(5))
      expect(Number.isFinite(chron)).toBe(true)
      expect(chron).toBe(1)
   })
})
