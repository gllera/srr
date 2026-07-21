import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The S33 root dual-path (docs/MANIFEST-SPEC.md §8.1): data.ts must read BOTH
// root shapes — today's full legacy db.gz and the v2 {v, m, t} pointer the S34
// cutover shrinks it to — and pick between them at runtime on the bytes alone.
//
// Selection rule under test: THE ROOT IS AUTHORITATIVE FOR WHAT IT CARRIES.
// A legacy-complete root never fetches a manifest (so an S32 store, which
// carries `m` AND every legacy field, behaves exactly as it does today and an
// operator who clears manifest/* loses nothing); a root with `m` and no legacy
// state follows the indirection.
//
// The store below is the smallest real layout: one all-delta cycle (two
// articles in data/d1.gz, no consolidated tail packs) — byte-shaped after real
// `srr` output.

async function gzip(input: string): Promise<Uint8Array> {
   const stream = new Response(new TextEncoder().encode(input)).body!.pipeThrough(new CompressionStream("gzip"))
   return new Uint8Array(await new Response(stream).arrayBuffer())
}

const FEEDS = { 0: { title: "Delta", url: "http://f/a.xml", total_art: 2, add_idx: 0 } }
const DELTA_JSONL = '{"f":0,"a":100,"p":90,"t":"One","c":"one"}\n{"f":0,"a":100,"p":91,"t":"Two","c":"two"}\n'

// The legacy db.gz an S32 writer publishes: every legacy field PLUS `m`.
const legacyRoot = {
   v: 1,
   m: 2,
   fetched_at: 100,
   total_art: 2,
   na: 2,
   pack_off: 0,
   seq: 1,
   next_pid: 0,
   nd: 1,
   feeds: FEEDS,
}

// The v2 root the S34 cutover emits. SYNTHESIZED: the writer does not produce
// this shape yet (that is S34), so this is the reader-side half of the contract
// standing in for it.
const manifestRoot = { v: 2, m: 2, t: 100 }

const manifestBody = {
   v: 2,
   m: 2,
   fetched_at: 100,
   total_art: 2,
   na: 2,
   pack_off: 0,
   names: { data: { b: 1 }, idx: {}, meta: {}, deltas: ["data/d1.gz"], seen: "seen.1.gz" },
   feeds: FEEDS,
}

type Files = Record<string, string>

const baseFiles = (root: unknown, manifest: unknown = manifestBody): Files => ({
   "/db.gz": JSON.stringify(root),
   ...(manifest === null ? {} : { "/manifest/2.gz": JSON.stringify(manifest) }),
   "/data/d1.gz": DELTA_JSONL,
})

let fetched: string[]

async function mount(files: Files) {
   const bytes = new Map<string, Uint8Array>()
   for (const [path, body] of Object.entries(files)) bytes.set(path, await gzip(body))
   fetched = []
   vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
         const url = input instanceof URL ? input : new URL(String(input))
         fetched.push(url.pathname.replace(/^\/+/, ""))
         const gz = bytes.get(url.pathname)
         return gz ? new Response(gz, { status: 200 }) : new Response("not found", { status: 404 })
      }),
   )
   vi.resetModules()
   const data = await import("./data")
   return data
}

beforeEach(() => {
   sessionStorage.clear()
})
afterEach(() => {
   vi.unstubAllGlobals()
   vi.resetModules()
})

describe("root selection", () => {
   it("a legacy-complete root takes today's path and never fetches a manifest", async () => {
      const data = await mount(baseFiles(legacyRoot))
      await data.init()
      expect(fetched).toEqual(["db.gz", "data/d1.gz"])
      expect(data.db.total_art).toBe(2)
      expect((await data.loadArticle(1)).t).toBe("Two")
   })

   it("a legacy-complete root works even when every manifest is gone (S32 rollback)", async () => {
      // The manifest object is absent entirely: clearing manifest/* must leave
      // the store fully readable, which it does BY CONSTRUCTION here — the
      // legacy fields answer every question, so nothing follows the pointer.
      const data = await mount(baseFiles(legacyRoot, null))
      await data.init()
      expect(fetched).toEqual(["db.gz", "data/d1.gz"])
      expect(data.db.total_art).toBe(2)
      expect((await data.loadArticle(0)).t).toBe("One")
   })

   it("a v2 root follows the indirection and resolves to the same reader state", async () => {
      const data = await mount(baseFiles(manifestRoot))
      await data.init()
      expect(fetched).toEqual(["db.gz", "manifest/2.gz", "data/d1.gz"])
      expect(data.db.total_art).toBe(2)
      expect(data.db.fetched_at).toBe(100) // the root's own `t`
      expect(data.db.m).toBe(2)
      expect(data.db.feeds[0].title).toBe("Delta")
      expect(data.db.feeds[0].id).toBe(0)
      expect(data.tailCovered()).toBe(0)
      expect(data.deltaArticles()).toHaveLength(2)
      expect((await data.loadArticle(1)).t).toBe("Two")
      expect((await data.loadMeta(0)).t).toBe("One")
      expect(data.countAll(new Map([[0, 0]]))).toBe(2)
   })

   it("resolves the same names both ways", async () => {
      const viaLegacy = await mount(baseFiles(legacyRoot))
      await viaLegacy.init()
      const legacyNames = viaLegacy.storeNames()
      const viaManifest = await mount(baseFiles(manifestRoot))
      await viaManifest.init()
      expect(viaManifest.storeNames()).toEqual(legacyNames)
   })

   it("synthesizes the retired counters from the LISTED names", async () => {
      const data = await mount(baseFiles(manifestRoot))
      await data.init()
      // nd/next_pid/hdrs/mp exist only so the coverage gates keep one
      // implementation; nothing builds a key from them any more.
      expect(data.db.nd).toBe(1)
      expect(data.db.next_pid).toBe(1)
      expect(data.db.hdrs).toBe(0)
      expect(data.db.mp).toBe(0)
      expect(data.metaReady()).toBe(true) // mp*5000 + mt + na === total_art
   })

   it("a missing manifest on a v2 root is a hard error — there is nothing to fall back to", async () => {
      const data = await mount(baseFiles(manifestRoot, null))
      await expect(data.init()).rejects.toThrow(/manifest\/2\.gz fetch failed: 404/)
   })

   it("rejects a manifest whose body names a different generation", async () => {
      const data = await mount(baseFiles(manifestRoot, { ...manifestBody, m: 3 }))
      await expect(data.init()).rejects.toThrow(/declares generation 3/)
   })

   it("rejects a manifest newer than this reader through the version popup", async () => {
      const data = await mount(baseFiles(manifestRoot, { ...manifestBody, v: 3 }))
      await expect(data.init()).rejects.toThrow(/older than the store \(manifest v3/)
   })

   it("rejects a root with neither legacy state nor a manifest pointer", async () => {
      const data = await mount(baseFiles({ v: 2, t: 100 }))
      await expect(data.init()).rejects.toThrow(/names no manifest/)
   })

   it("still rejects a root version above what this reader understands", async () => {
      const data = await mount(baseFiles({ ...legacyRoot, v: 3 }))
      await expect(data.init()).rejects.toThrow(/older than the store \(format v3, supported v2\)/)
   })

   it("fails loudly when the named delta chain disagrees with na", async () => {
      const files = baseFiles(manifestRoot, {
         ...manifestBody,
         na: 5, // the chain really holds 2
      })
      const data = await mount(files)
      await expect(data.init()).rejects.toThrow(/delta chain holds 2 articles but the store says 5/)
   })

   it("fails loudly when a manifest names no segments for a live delta chain", async () => {
      const data = await mount(
         baseFiles(manifestRoot, {
            ...manifestBody,
            names: { ...manifestBody.names, deltas: [] },
         }),
      )
      await expect(data.init()).rejects.toThrow(/0 delta segment\(s\) named for 2 delta article\(s\)/)
   })
})

describe("refresh across the dual path", () => {
   // The rollback snapshot must cover the manifest-sourced fields: a failed
   // apply has to leave a CONSISTENT pair (old db + old names), never a mix.
   it("rolls db AND names back together when a mid-apply fetch fails", async () => {
      const bytes = new Map<string, Uint8Array>()
      const put = async (p: string, body: string) => bytes.set(p, await gzip(body))
      await put("/db.gz", JSON.stringify(manifestRoot))
      await put("/manifest/2.gz", JSON.stringify(manifestBody))
      await put("/data/d1.gz", DELTA_JSONL)
      vi.stubGlobal(
         "fetch",
         vi.fn(async (input: URL | string) => {
            const url = input instanceof URL ? input : new URL(String(input))
            const gz = bytes.get(url.pathname)
            return gz ? new Response(gz, { status: 200 }) : new Response("not found", { status: 404 })
         }),
      )
      vi.resetModules()
      const data = await import("./data")
      await data.init()
      const before = data.storeNames()
      expect(before.deltas).toEqual(["data/d1.gz"])

      // Publish a NEWER generation whose delta segment is missing from the store.
      const nextManifest = {
         ...manifestBody,
         m: 3,
         fetched_at: 200,
         total_art: 4,
         na: 4,
         names: { ...manifestBody.names, deltas: ["data/d1.gz", "data/d2.gz"] },
      }
      await put("/db.gz", JSON.stringify({ v: 2, m: 3, t: 200 }))
      await put("/manifest/3.gz", JSON.stringify(nextManifest))

      await expect(data.refresh()).rejects.toThrow()
      // Old snapshot intact, both halves.
      expect(data.db.fetched_at).toBe(100)
      expect(data.db.m).toBe(2)
      expect(data.storeNames()).toEqual(before)
      expect((await data.loadArticle(1)).t).toBe("Two")
   })

   it("adopts a newer generation when the store really moved", async () => {
      const bytes = new Map<string, Uint8Array>()
      const put = async (p: string, body: string) => bytes.set(p, await gzip(body))
      await put("/db.gz", JSON.stringify(manifestRoot))
      await put("/manifest/2.gz", JSON.stringify(manifestBody))
      await put("/data/d1.gz", DELTA_JSONL)
      vi.stubGlobal(
         "fetch",
         vi.fn(async (input: URL | string) => {
            const url = input instanceof URL ? input : new URL(String(input))
            const gz = bytes.get(url.pathname)
            return gz ? new Response(gz, { status: 200 }) : new Response("not found", { status: 404 })
         }),
      )
      vi.resetModules()
      const data = await import("./data")
      await data.init()

      expect(await data.refresh()).toBe("unchanged")

      await put("/data/d2.gz", '{"f":0,"a":200,"p":92,"t":"Three","c":"three"}\n')
      await put(
         "/manifest/3.gz",
         JSON.stringify({
            ...manifestBody,
            m: 3,
            fetched_at: 200,
            total_art: 3,
            na: 3,
            names: { ...manifestBody.names, deltas: ["data/d1.gz", "data/d2.gz"] },
            feeds: { 0: { ...FEEDS[0], total_art: 3 } },
         }),
      )
      await put("/db.gz", JSON.stringify({ v: 2, m: 3, t: 200 }))

      expect(await data.refresh()).toBe("updated")
      expect(data.db.total_art).toBe(3)
      expect(data.storeNames().deltas).toEqual(["data/d1.gz", "data/d2.gz"])
      expect((await data.loadArticle(2)).t).toBe("Three")
   })
})
