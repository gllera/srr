import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { IDX_BOUNDARY_SIZE, IDX_ENTRY_SIZE, IDX_HEADER_PREFIX, IDX_STATE_SIZE } from "./format.gen"

// data.ts has a top-level db.gz fetch and private state set only by init(), so
// its composition edges (clamp, empty store, the 50000 pack seam,
// numFinalizedIdx's off-by-one) need a real fetch+init harness the
// always-non-empty contract stores can't reach. We stub global.fetch to
// serve gzipped synthetic packs and dynamic-import data.ts after, so its
// load-time fetch binds the stub. Real idx.ts/cache.ts compose underneath.

const PACK_SIZE = 50000

interface Entry {
   feedId: number
   // deltaPackId marks a data-pack boundary; its local index goes in the footer.
   deltaPackId?: 0 | 1
}

// Build one v2 idx pack buffer (header ‖ 2-byte feed_id entries ‖ u16 LE
// boundary footer), mirroring the backend writer and idx.test.ts's buildBuf.
// These edge cases carry no header feedCounts, so numSlots = 0 (12-byte prefix).
function packBuf(entries: Entry[]): ArrayBuffer {
   const boundaries: number[] = []
   entries.forEach((e, i) => {
      if (e.deltaPackId) boundaries.push(i)
   })
   const buf = new ArrayBuffer(
      IDX_HEADER_PREFIX + entries.length * IDX_ENTRY_SIZE + boundaries.length * IDX_BOUNDARY_SIZE,
   )
   const view = new DataView(buf)
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

// N zero-filled numSlots=0 headers (12-byte prefix each) concatenated — a
// minimal idx/h<N>.gz summary. parseIdxHeaders reads numSlots=0 from each
// prefix and advances by IDX_HEADER_PREFIX.
function summaryBuf(n: number): ArrayBuffer {
   return new ArrayBuffer(IDX_HEADER_PREFIX * n)
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
      const data = await mount({ total_art: 0, feeds: {} })
      expect(data.numFinalizedIdx()).toBe(0)
      expect(data.countAll(new Map())).toBe(0)
      expect(await data.findLeft(0, new Map())).toBe(-1)
      expect(await data.findRight(0, new Map())).toBe(-1)
      // db.gz was the only fetch — no idx pack was requested.
      const paths = (global.fetch as unknown as { mock: { calls: [URL][] } }).mock.calls.map((c) => c[0].pathname)
      expect(paths).toEqual(["/db.gz"])
   })

   it("total_art 1 → 0 finalized packs (everything in the latest pack)", async () => {
      const data = await mount({ total_art: 1, seq: 1 }, { "idx/L1.gz": packBuf([{ feedId: 3 }]) })
      expect(data.numFinalizedIdx()).toBe(0)
      expect(await data.getFeedId(0)).toBe(3)
   })

   it("total_art exactly 50000 → still 0 finalized (the article that finalizes pack 0 hasn't arrived)", async () => {
      const latest = packBuf(Array.from({ length: PACK_SIZE }, () => ({ feedId: 0 })))
      const data = await mount({ total_art: PACK_SIZE, seq: 1 }, { "idx/L1.gz": latest })
      expect(data.numFinalizedIdx()).toBe(0)
   })

   it("total_art 50001 → 1 finalized pack (the inflection)", async () => {
      const data = await mount(
         { total_art: PACK_SIZE + 1, seq: 1, hdrs: 1 },
         { "idx/h1.gz": summaryBuf(1), "idx/L1.gz": packBuf([{ feedId: 0 }]) },
      )
      expect(data.numFinalizedIdx()).toBe(1)
   })

   it("total_art 100001 → 2 finalized packs", async () => {
      const data = await mount(
         { total_art: 2 * PACK_SIZE + 1, seq: 1, hdrs: 2 },
         { "idx/h2.gz": summaryBuf(2), "idx/L1.gz": packBuf([{ feedId: 0 }]) },
      )
      expect(data.numFinalizedIdx()).toBe(2)
   })
})

describe("data.getFeedId — the 50000 pack boundary (last finalized vs first latest)", () => {
   it("addresses chron 49999 in finalized pack 0 and chron 50000 in the latest pack", async () => {
      // Eager path (no hdrs) so init fetches the finalized pack; entry 49999 of
      // pack 0 carries a sentinel feed, entry 0 of the latest carries another.
      const finalized = Array.from({ length: PACK_SIZE }, () => ({ feedId: 0 }))
      finalized[PACK_SIZE - 1] = { feedId: 7 }
      const data = await mount(
         { total_art: PACK_SIZE + 1, seq: 1 },
         { "idx/0.gz": packBuf(finalized), "idx/L1.gz": packBuf([{ feedId: 9 }]) },
      )
      expect(data.numFinalizedIdx()).toBe(1)
      expect(await data.getFeedId(PACK_SIZE - 1)).toBe(7) // last of finalized pack 0
      expect(await data.getFeedId(PACK_SIZE)).toBe(9) // first of the latest pack
   })
})

describe("data.feedTitle — deleted-feed tombstone", () => {
   it("returns the title for a known feed and [DELETED] for an absent feed_id", async () => {
      const data = await mount({
         total_art: 0,
         feeds: { 5: { id: 5, title: "Live", total_art: 1 } } as unknown as IDB["feeds"],
      })
      expect(data.feedTitle(5)).toBe("Live")
      expect(data.feedTitle(404)).toBe("[DELETED]") // its articles survive in packs; render a tombstone
   })
})

describe("data.idxSummaryDegraded — against the real module", () => {
   it("idxSummaryDegraded flags a partway summary", async () => {
      // hdrs partway (0 < hdrs < numFinalizedIdx): an actively-advancing summary
      // rebuild. total_art 100001 => nf = 2; hdrs = 1. hdrs !== nf so init takes
      // the eager fallback and fetches both finalized packs — serve them.
      const bigPack = () => packBuf(Array.from({ length: PACK_SIZE }, () => ({ feedId: 0 })))
      const partway = await mount(
         { total_art: 2 * PACK_SIZE + 1, seq: 1, hdrs: 1 },
         { "idx/0.gz": bigPack(), "idx/1.gz": bigPack(), "idx/L1.gz": packBuf([{ feedId: 0 }]) },
      )
      expect(partway.numFinalizedIdx()).toBe(2)
      expect(partway.idxSummaryDegraded()).toBe(true)

      // hdrs === numFinalizedIdx: the summary fully covers the finalized packs,
      // so the fast path is live and nothing is degraded. Summary path (no
      // finalized pack fetch).
      const covered = await mount(
         { total_art: PACK_SIZE + 1, seq: 1, hdrs: 1 },
         { "idx/h1.gz": summaryBuf(1), "idx/L1.gz": packBuf([{ feedId: 0 }]) },
      )
      expect(covered.numFinalizedIdx()).toBe(1)
      expect(covered.idxSummaryDegraded()).toBe(false)

      // hdrs absent (nf > 0) is a steady pre-summary store, NOT an active
      // rebuild — the hdrs>0 guard keeps it un-degraded so no permanent banner
      // pins. hdrs !== nf, so init eager-fetches the one finalized pack.
      const preSummary = await mount(
         { total_art: PACK_SIZE + 1, seq: 1 },
         { "idx/0.gz": bigPack(), "idx/L1.gz": packBuf([{ feedId: 0 }]) },
      )
      expect(preSummary.numFinalizedIdx()).toBe(1)
      expect(preSummary.idxSummaryDegraded()).toBe(false)
   })
})

describe("data.lastFetchedAt / hasArticles — against the real module", () => {
   it("lastFetchedAt and hasArticles read the live db", async () => {
      const data = await mount(
         { total_art: 1, seq: 1, fetched_at: 1700000000 },
         { "idx/L1.gz": packBuf([{ feedId: 3 }]) },
      )
      expect(data.lastFetchedAt()).toBe(1700000000)
      expect(data.lastFetchedAt()).toBe(data.db.fetched_at) // reads the live snapshot, not a copy
      expect(data.hasArticles()).toBe(true)

      const empty = await mount({ total_art: 0, feeds: {}, fetched_at: 0 })
      expect(empty.hasArticles()).toBe(false)
      expect(empty.lastFetchedAt()).toBe(0)
   })
})

describe("data.parseDb — a non-OK db.gz surfaces clearly", () => {
   it("surfaces a non-OK db.gz as a clear error", async () => {
      // A 404 (or 5xx) db.gz must throw the status, not a cryptic gunzip
      // "incorrect header check" from trying to decompress an HTML error body.
      global.fetch = vi.fn(
         async () => new Response("<html>not found</html>", { status: 404 }),
      ) as unknown as typeof fetch
      vi.resetModules()
      const data = await import("./data")
      await expect(data.init()).rejects.toThrow(/db\.gz fetch failed: 404/)
   })
})

describe("data.assertPackOk — stale-latest-pack self-heal", () => {
   it("reloads once on a stale latest idx pack, then the guard suppresses the loop", async () => {
      // A 404 on the write-once latest pack means this tab's db.gz predates the
      // backend GC grace window: assertPackOk reloads once (guarded), and always
      // throws so callers never touch the body. jsdom forbids redefining
      // location.reload, so swap the whole location object for one with a spy.
      const realLoc = window.location
      const reload = vi.fn()
      Object.defineProperty(window, "location", {
         value: { href: realLoc.href, reload },
         configurable: true,
         writable: true,
      })
      try {
         const dbBytes = await gzip(JSON.stringify({ total_art: 1, seq: 1 }))
         // Serve db.gz but 404 idx/L1.gz — the stale-tab latest-pack case.
         const bootAgainstStaleLatest = async () => {
            global.fetch = vi.fn(async (input: URL | string) => {
               const url = input instanceof URL ? input : new URL(String(input))
               return url.pathname === "/db.gz"
                  ? new Response(dbBytes, { status: 200 })
                  : new Response("not found", { status: 404 })
            }) as unknown as typeof fetch
            vi.resetModules()
            const data = await import("./data")
            return data.init()
         }

         // Guard clear → one reload fires and the RELOAD_GUARD key is stamped.
         await expect(bootAgainstStaleLatest()).rejects.toThrow(/pack fetch failed: 404/)
         expect(reload).toHaveBeenCalledTimes(1)
         expect(sessionStorage.getItem("srr-reload-guard")).toBe("1")

         // Guard already set → a second stale-pack failure must NOT reload again.
         await expect(bootAgainstStaleLatest()).rejects.toThrow(/pack fetch failed: 404/)
         expect(reload).toHaveBeenCalledTimes(1)
      } finally {
         Object.defineProperty(window, "location", { value: realLoc, configurable: true, writable: true })
      }
   })
})
