import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// refresh()'s change-detection, against the REAL data module. data.ts fetches
// db.gz at module load AND again on every refresh(), so we serve a MUTABLE file
// map through a stubbed global.fetch: set the initial db.gz (+ its manifest),
// import + init(), then rewrite db.gz to model the next cycle and call
// refresh(). The return value ("unchanged"/"updated") IS the classification
// refresh.ts keys on — "unchanged" means refresh() returned BEFORE applyDb and
// its search.invalidate()/nav.onStoreRefreshed() chain, i.e. it did NOT
// re-process. (docs/MANIFEST-SPEC.md §8.1 G2: under a manifest root only `m`
// may trigger a re-process; the root's `t`/fetched_at must not.)

const files = new Map<string, Uint8Array>()

async function gzip(obj: unknown): Promise<Uint8Array> {
   const bytes = new TextEncoder().encode(JSON.stringify(obj))
   const stream = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"))
   return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function put(path: string, obj: unknown): Promise<void> {
   files.set(path, await gzip(obj))
}

// A minimal empty-store generation manifest: total_art 0 makes applyDb
// early-return after installing db+names, so no idx/data/meta pack is needed.
function emptyManifest(m: number, fetchedAt: number) {
   return { v: 3, m, fetched_at: fetchedAt, total_art: 0, pack_off: 0, next_pid: 0, names: {}, feeds: {} }
}

async function mountInit() {
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
   files.clear()
   sessionStorage.clear()
   localStorage.clear()
})
afterEach(() => {
   vi.restoreAllMocks()
   vi.resetModules()
})

describe("data.refresh — manifest root keys change-detection on m, not fetched_at", () => {
   it("(a) same m, NEW fetched_at → unchanged (an idle cycle rewrites db.gz's t only)", async () => {
      await put("/db.gz", { v: 3, m: 1, t: 100 })
      await put("/manifest/1.gz", emptyManifest(1, 100))
      const data = await mountInit()

      // The idle cycle: db.gz's `t` advances, `m` stays — the same generation,
      // the same manifest. Before the fix the four-field compare saw the moved
      // fetched_at and re-processed every poll.
      await put("/db.gz", { v: 3, m: 1, t: 999 })
      expect(await data.refresh()).toBe("unchanged")
   })

   it("(b) changed m → updated (a publishing Commit)", async () => {
      await put("/db.gz", { v: 3, m: 1, t: 100 })
      await put("/manifest/1.gz", emptyManifest(1, 100))
      const data = await mountInit()

      await put("/db.gz", { v: 3, m: 2, t: 200 })
      await put("/manifest/2.gz", emptyManifest(2, 200))
      expect(await data.refresh()).toBe("updated")
   })
})

describe("data.refresh — legacy root still reacts to fetched_at/total_art", () => {
   it("(c) legacy root: an unchanged root stays unchanged, a new fetched_at re-processes", async () => {
      // A pre-cutover root carries the full document (total_art present → parsed
      // as legacy, v1), and its idle cycles rewrote the whole thing — so the
      // four-field compare must still fire on it.
      await put("/db.gz", { v: 1, m: 1, fetched_at: 100, total_art: 0, seq: 0, feeds: {} })
      const data = await mountInit()

      // Identical root → unchanged.
      await put("/db.gz", { v: 1, m: 1, fetched_at: 100, total_art: 0, seq: 0, feeds: {} })
      expect(await data.refresh()).toBe("unchanged")

      // fetched_at advanced with m unchanged → the legacy path still reacts.
      await put("/db.gz", { v: 1, m: 1, fetched_at: 200, total_art: 0, seq: 0, feeds: {} })
      expect(await data.refresh()).toBe("updated")
   })
})
