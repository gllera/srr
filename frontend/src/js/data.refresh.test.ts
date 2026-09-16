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

   it("(d) idle cycle still advances the freshness readout (lastFetchedAt) though unchanged", async () => {
      await put("/db.gz", { v: 3, m: 1, t: 100 })
      await put("/manifest/1.gz", emptyManifest(1, 100))
      const data = await mountInit()
      expect(data.lastFetchedAt()).toBe(100)

      // Same m, newer t: refresh() returns "unchanged" (no re-process) but the
      // "Updated X ago" line must still move — picker.renderStatus reads it via
      // lastFetchedAt(). Before the fix the unchanged branch returned before
      // ever touching store.db, freezing the readout on idle cycles.
      await put("/db.gz", { v: 3, m: 1, t: 777 })
      expect(await data.refresh()).toBe("unchanged")
      expect(data.lastFetchedAt()).toBe(777)
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

// data.setActive publishes model.activeMid, and that write runs every effect over
// it: a throwing one rethrows from the write (signals semantic 7). A mount-table
// change that falls back to home must have done its own work by then.
describe("data.applyMountTable — the active-store fallback publishes last", () => {
   it("still boots the new mounts and bumps mountsRev when an effect over the active store throws", async () => {
      await put("/db.gz", { v: 3, m: 1, t: 100 })
      await put("/manifest/1.gz", emptyManifest(1, 100))
      const data = await mountInit()
      const model = await import("./model")
      const { effect } = await import("./signals")
      const { mountId, normalizeStoreUrl } = await import("./mounts")
      const peer = async (name: string) => {
         const url = normalizeStoreUrl(new URL(`${name}/`, data.activeStore().base).href)!
         await put(new URL("db.gz", url).pathname, { v: 3, m: 1, t: 100 })
         await put(new URL("manifest/1.gz", url).pathname, emptyManifest(1, 100))
         return {
            id: mountId(url),
            url,
            label: "",
            ord: 1,
            role: "peer" as const,
            cred: false,
            added: 1,
            ts: 1,
            del: false,
         }
      }
      const home = data.mountRecords().find((r) => r.id === "0")!
      const a = await peer("a")
      const b = await peer("b")
      await data.applyMountTable([home, a])
      expect(data.setActive(a.id)).toBe(true)
      const rev = model.mountsRev()

      let armed = false
      const stop = effect(() => {
         model.activeMid()
         if (armed) throw new Error("paint")
      })
      try {
         armed = true
         // Unmounting the active peer falls back to home — the throwing publish.
         await expect(data.applyMountTable([home, { ...a, del: true, ts: 2 }, b])).rejects.toThrow("paint")
      } finally {
         armed = false
         stop()
      }
      expect(data.activeStore().mid).toBe("0")
      await vi.waitFor(() => {
         expect(data.mountStatus(b.id).state).toBe("ok")
         expect(data.mountStore(b.id)).toBeDefined()
         expect(model.mountsRev()).toBe(rev + 1)
      })
   })
})

// A mount whose boot has installed db + names but whose delta chain / latest idx
// is still in flight is NOT a usable store: counting against it throws. It reads
// "booting" until the boot finishes, cannot be made active meanwhile (a picker
// row tap, a #!@<mid> route), and the background peer poll leaves it alone rather
// than run a second applyDb on the same store under the first.
describe("a peer still booting", () => {
   const DELTA = '{"f":0,"a":100,"p":90,"t":"One","c":"one"}\n{"f":0,"a":100,"p":91,"t":"Two","c":"two"}\n'
   const deltaManifest = {
      v: 3,
      m: 2,
      fetched_at: 100,
      total_art: 2,
      na: 2,
      pack_off: 0,
      names: { data: { b: 1 }, idx: {}, meta: {}, deltas: { s: "data", r: [1] }, next: { data: 2 } },
      feeds: { 0: { title: "Delta", url: "http://f/a.xml", total_art: 2, add_idx: 0 } },
   }
   const gzipText = async (text: string) =>
      new Uint8Array(
         await new Response(
            new Response(new TextEncoder().encode(text)).body!.pipeThrough(new CompressionStream("gzip")),
         ).arrayBuffer(),
      )
   const peerRecord = async (data: typeof import("./data")) => {
      const { mountId, normalizeStoreUrl } = await import("./mounts")
      const url = normalizeStoreUrl(new URL("peer/", data.activeStore().base).href)!
      const rec = {
         id: mountId(url),
         url,
         label: "",
         ord: 1,
         role: "peer" as const,
         cred: false,
         added: 1,
         ts: 1,
         del: false,
      }
      return { rec, home: data.mountRecords().find((r) => r.id === "0")! }
   }

   async function halfBooted() {
      await put("/db.gz", { v: 3, m: 1, t: 100 })
      await put("/manifest/1.gz", emptyManifest(1, 100))
      await put("/peer/db.gz", { v: 3, m: 2, t: 100 })
      await put("/peer/manifest/2.gz", deltaManifest)
      files.set("/peer/data/1.gz", await gzipText(DELTA))
      const data = await mountInit()
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const plain = global.fetch
      const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
         const url = input instanceof URL ? input : new URL(String(input))
         if (url.pathname === "/peer/data/1.gz") await gate // the delta chain is slow
         return plain(input, init)
      })
      global.fetch = fetchMock as unknown as typeof fetch
      const { rec, home } = await peerRecord(data)
      const booted = data.applyMountTable([home, rec])
      await vi.waitFor(() => expect(data.mountStore(rec.id)?.db).toBeDefined()) // db + names in, the chain not
      return { data, mid: rec.id, release, booted, fetchMock }
   }

   it("reads booting and cannot become active until its boot finished", async () => {
      const { data, mid, release, booted } = await halfBooted()
      expect(data.mountStatus(mid).state).toBe("booting")
      expect(data.setActive(mid)).toBe(false)
      expect(data.activeStore().mid).toBe("0")
      release()
      expect(await booted).toEqual([mid])
      expect(data.mountStatus(mid).state).toBe("ok")
      expect(data.setActive(mid)).toBe(true)
   })

   it("is left alone by the background peer poll while it boots", async () => {
      const { data, mid, release, booted, fetchMock } = await halfBooted()
      fetchMock.mockClear()
      await data.refreshPeers()
      const peerFetches = fetchMock.mock.calls.filter(([u]) => String(u).includes("/peer/"))
      expect(peerFetches).toEqual([])
      release()
      await booted
      expect(data.mountStatus(mid).state).toBe("ok")
   })

   it("an errored peer keeps its error chip while a retry boots it", async () => {
      await put("/db.gz", { v: 3, m: 1, t: 100 })
      await put("/manifest/1.gz", emptyManifest(1, 100))
      const data = await mountInit()
      const { rec, home } = await peerRecord(data)
      expect(await data.applyMountTable([home, rec])).toEqual([]) // /peer/db.gz is absent: the boot fails
      expect(data.mountStatus(rec.id).state).toBe("error")
      await put("/peer/db.gz", { v: 3, m: 1, t: 100 })
      await put("/peer/manifest/1.gz", emptyManifest(1, 100))
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const plain = global.fetch
      global.fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
         await gate
         return plain(input, init)
      }) as unknown as typeof fetch
      const retry = data.refreshPeers()
      await Promise.resolve()
      expect(data.mountStatus(rec.id).state).toBe("error") // no chip flicker mid-retry
      release()
      await retry
      expect(data.mountStatus(rec.id).state).toBe("ok")
   })
})
