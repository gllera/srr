import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// sync.ts holds module state (dirty flag, status, debounce timer, the guard's
// remembered remote), so each test gets a fresh instance via vi.resetModules()
// + dynamic import — the same pattern as dropdown.test.ts. fetch is a plain
// vi.fn stub (jsdom ships no fetch); responses are minimal object literals.
import { SEEN_KEY, SAVED_KEY, SYNC_URL_KEY, UNREAD_ONLY_KEY, PROFILE_TS_KEY } from "./keys"

type Sync = typeof import("./sync")

const URL = "https://sync.example/profile"

function res(status: number, body = ""): { ok: boolean; status: number; text: () => Promise<string> } {
   return { ok: status >= 200 && status < 300, status, text: async () => body }
}

// v1 helper (legacy remote — no `ts`, monotone-merge-only).
const remoteBlob = (over: object = {}) =>
   JSON.stringify({ v: 1, seen: { "feed:1": 50 }, saved: [7], unreadOnly: true, imgProxy: "", ...over })

// v2 helper (LWW remote — carries `ts`).
const v2Blob = (ts: number, seen: Record<string, number> = { "feed:1": 50 }, saved: number[] = [7]) =>
   JSON.stringify({ v: 2, ts, seen, saved, unreadOnly: true, imgProxy: "" })

let fetchMock: ReturnType<typeof vi.fn>
let sync: Sync

beforeEach(async () => {
   localStorage.clear()
   vi.useFakeTimers()
   fetchMock = vi.fn(async () => res(200, remoteBlob()))
   vi.stubGlobal("fetch", fetchMock)
   vi.resetModules()
   sync = await import("./sync")
})

afterEach(() => {
   vi.useRealTimers()
   vi.unstubAllGlobals()
})

describe("url validation / normalization", () => {
   it("accepts empty, http(s), and schemeless; rejects dangerous schemes", () => {
      expect(sync.isValidSyncUrl("")).toBe(true)
      expect(sync.isValidSyncUrl("https://s.example/p")).toBe(true)
      expect(sync.isValidSyncUrl("s.example/p")).toBe(true)
      expect(sync.isValidSyncUrl("javascript:alert(1)")).toBe(false)
      expect(sync.isValidSyncUrl("ftp://s.example/p")).toBe(false)
   })

   it("normalizes schemeless to https WITHOUT appending a trailing slash", () => {
      expect(sync.normalizeSyncUrl("s.example/profile")).toBe("https://s.example/profile")
      expect(sync.normalizeSyncUrl("  https://s.example/p  ")).toBe("https://s.example/p")
      expect(sync.normalizeSyncUrl("")).toBe("")
   })

   it("setSyncUrl stores / clears the key and resets the status", () => {
      sync.setSyncUrl(URL)
      expect(localStorage.getItem(SYNC_URL_KEY)).toBe(URL)
      expect(sync.enabled()).toBe(true)
      sync.setSyncUrl("")
      expect(localStorage.getItem(SYNC_URL_KEY)).toBeNull()
      expect(sync.enabled()).toBe(false)
      expect(sync.state()).toEqual({ on: false, okAt: 0, error: "", parked: false })
   })
})

describe("disabled (no sync url)", () => {
   it("syncNow / pushSoon / flush never touch the network", async () => {
      await sync.syncNow({ manual: true })
      sync.pushSoon()
      await vi.advanceTimersByTimeAsync(10_000)
      sync.flush()
      expect(fetchMock).not.toHaveBeenCalled()
   })
})

describe("pull-merge (legacy v1 remote)", () => {
   it("merges remote seen (max) and saved (union) but never prefs, then upgrade-pushes", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 80, "feed:2": 10 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([3]))
      localStorage.setItem(UNREAD_ONLY_KEY, "0")
      fetchMock.mockResolvedValue(res(200, remoteBlob({ seen: { "feed:1": 50, "feed:2": 99 }, saved: [7] })))
      sync.setSyncUrl(URL)

      await sync.syncNow()

      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 80, "feed:2": 99 })
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([3, 7])
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("0") // remote said "1"; prefs stay local
      expect(sync.state().okAt).toBeGreaterThan(0)
      expect(sync.state().error).toBe("")
      // A v1 remote always forces an upgrade push (dirty=true) — guarded, but
      // the merge result here dominates the remote's own seen so it can't park.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
   })

   it("notifies onMerged only when the pull changed local state", async () => {
      const merged = vi.fn()
      sync.init(merged)
      sync.setSyncUrl(URL)

      await sync.syncNow()
      expect(merged).toHaveBeenCalledTimes(1) // remote seen/saved were new here

      await sync.syncNow()
      expect(merged).toHaveBeenCalledTimes(1) // second pull merges nothing new
   })

   it("treats 404 as 'nothing stored yet', not an error", async () => {
      fetchMock.mockResolvedValue(res(404))
      sync.setSyncUrl(URL)
      await sync.syncNow()
      expect(sync.state().error).toBe("")
      expect(sync.state().okAt).toBeGreaterThan(0)
   })

   it("records HTTP and invalid-payload failures in state()", async () => {
      sync.setSyncUrl(URL)
      fetchMock.mockResolvedValue(res(500))
      await sync.syncNow()
      expect(sync.state().error).toBe("HTTP 500")

      fetchMock.mockResolvedValue(res(200, "not json"))
      await sync.syncNow()
      expect(sync.state().error).toBe("invalid profile")
   })
})

describe("LWW pull", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("adopts a newer non-regressive remote wholesale", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 })
      expect(localStorage.getItem(PROFILE_TS_KEY)).toBe("200")
      expect(sync.state().parked).toBe(false)
   })

   it("keeps local when remote is older, then pushes only if dirty", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 })
      expect(fetchMock).toHaveBeenCalledTimes(1) // GET only, not dirty
   })

   it("parks instead of adopting a newer REGRESSIVE remote (and skips the push)", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      // pushSoon stamps ts to "now" via touchProfile — pin the fake clock so
      // that stamp lands at 100 (older than the remote's 200 below), which is
      // the "local is dirty but stale" setup this test needs.
      vi.setSystemTime(100_000)
      sync.pushSoon() // local is dirty; ts = 100
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 }) // not adopted
      expect(fetchMock).toHaveBeenCalledTimes(1) // no PUT either
      expect(sync.state().parked).toBe(true)
   })

   it("a dropped feed key counts as regressive", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 50, "feed:2": 5 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 }))) // feed:2 absent
      await sync.syncNow()
      expect(sync.state().parked).toBe(true)
   })

   it("MANUAL adopts a regressive newer remote and always pushes (pure LWW)", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow({ manual: true })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 })
      expect(fetchMock).toHaveBeenCalledTimes(2) // GET then PUT
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
      expect(sync.state().parked).toBe(false)
   })

   it("a v1 remote gets one monotone merge and an upgrade push", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      fetchMock.mockResolvedValue(res(200, remoteBlob({ seen: { "feed:1": 50, "feed:2": 4 } })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90, "feed:2": 4 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).v).toBe(2)
   })

   it("adopting cancels a pending debounce push (nothing left to publish)", async () => {
      vi.setSystemTime(100_000)
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      sync.pushSoon() // dirty, timer armed; ts = 100
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow() // adopts (newer, non-regressive) → dirty=false
      const calls = fetchMock.mock.calls.length // the GET only
      await vi.advanceTimersByTimeAsync(10_000)
      // The stale debounce timer was cancelled with the adopt — no redundant
      // GET-only cycle fires after it.
      expect(fetchMock.mock.calls.length).toBe(calls)
   })

   it("a manual cycle resolves a parked state", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow() // newer regressive remote → background cycle parks
      expect(sync.state().parked).toBe(true)
      await sync.syncNow({ manual: true }) // the human tap authorizes the rewind
      expect(sync.state().parked).toBe(false)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 }) // adopted
   })
})

describe("regressiveSeen", () => {
   it("detects rewinds on the seen axis only", () => {
      expect(sync.regressiveSeen({ "feed:1": 50 }, { "feed:1": 50 })).toBe(false) // equal
      expect(sync.regressiveSeen({ "feed:1": 50 }, { "feed:1": 49 })).toBe(true) // lower value
      expect(sync.regressiveSeen({ "feed:1": 50, "feed:2": 5 }, { "feed:1": 50 })).toBe(true) // dropped key
      expect(sync.regressiveSeen({ "feed:1": 50 }, { "feed:1": 50, "feed:2": 5 })).toBe(false) // extra incoming key
   })
})

describe("regression-guarded push / flush", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("parks a background push that would rewind the endpoint", async () => {
      // pushSoon stamps ts to "now" via touchProfile — pin the fake clock so
      // that stamp (400) stays ABOVE the remote's ts (200). Without the pin
      // this silently depends on vitest's default fake clock being ≫ 200; a
      // fakeTimers config change starting the clock near 0 would flip the
      // cycle into the adopt path instead of exercising the push guard.
      vi.setSystemTime(400_000)
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 90 })))
      await sync.syncNow() // remote older → keep local; local seen LACKS feed:1
      sync.pushSoon()
      await vi.advanceTimersByTimeAsync(6000)
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0)
      expect(sync.state().parked).toBe(true)
   })

   it("flush skips when the blob would rewind the endpoint, leaving dirty set", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 90 })))
      await sync.syncNow() // remote older → keep local; local seen LACKS feed:1
      sync.pushSoon() // ts = 400 ≥ lastRemoteTs 200, but the blob is regressive
      sync.flush()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0)
      // The skip left dirty set AND the debounce timer armed: once local
      // catches up to the endpoint's progress, the pending cycle publishes.
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      await vi.advanceTimersByTimeAsync(6000)
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1)
   })

   it("flush skips when local ts is older than the last-pulled remote", async () => {
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow() // adopts; ts = 200; not dirty
      // pushSoon stamps ts to "now" via touchProfile — pin the fake clock so
      // that stamp (150) lands BEFORE the last-pulled remote's ts (200),
      // simulating a stale tab that fell behind between pulls.
      vi.setSystemTime(150_000)
      sync.pushSoon()
      sync.flush()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0)
   })

   it("flush stays unguarded when this tab never pulled", () => {
      sync.pushSoon()
      sync.flush()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1)
   })

   it("a 404 pull forgets the guard snapshot — the wiped endpoint has nothing to regress", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 90 })))
      await sync.syncNow() // snapshot: remote has feed:1; local seen LACKS it
      // Endpoint wiped: GETs now 404 (PUTs still succeed).
      fetchMock.mockImplementation(async (_u, init) => ((init as RequestInit)?.method === "PUT" ? res(200) : res(404)))
      sync.pushSoon()
      await sync.syncNow()
      // The 404 reset the snapshot, so the seeding PUT is unguarded — without
      // the reset the stale pre-404 snapshot would spuriously park it.
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1)
      expect(sync.state().parked).toBe(false)
   })
})

describe("push", () => {
   it("a v1 remote's forced upgrade push carries remote ∪ local seen", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:2": 10 }))
      sync.setSyncUrl(URL)

      await sync.syncNow()

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const put = fetchMock.mock.calls[1]
      expect(put[1].method).toBe("PUT")
      const body = JSON.parse(put[1].body)
      expect(body.seen).toEqual({ "feed:2": 10, "feed:1": 50 }) // remote ∪ local
      expect(body.saved).toEqual([7])
      expect(body.v).toBe(2)
   })

   it("skips the PUT when the pull fails (never clobber an unread remote)", async () => {
      fetchMock.mockResolvedValue(res(500))
      sync.setSyncUrl(URL)
      await sync.syncNow()
      expect(fetchMock).toHaveBeenCalledTimes(1) // GET only
      expect(sync.state().error).toBe("HTTP 500")
   })

   it("pushSoon debounces a reading burst into one cycle", async () => {
      sync.setSyncUrl(URL)
      sync.pushSoon()
      await vi.advanceTimersByTimeAsync(3000)
      sync.pushSoon()
      sync.pushSoon()
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchMock).toHaveBeenCalledTimes(2) // one GET + one PUT
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
   })

   it("flush() PUTs pending changes immediately with keepalive, no pre-GET", async () => {
      sync.setSyncUrl(URL)
      sync.pushSoon() // dirty, timer armed
      sync.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1].method).toBe("PUT")
      expect(fetchMock.mock.calls[0][1].keepalive).toBe(true)
      // The armed debounce timer was cancelled — nothing else fires.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
   })

   it("flush() is a no-op with nothing pending", () => {
      sync.setSyncUrl(URL)
      sync.flush()
      expect(fetchMock).not.toHaveBeenCalled()
   })
})

describe("init", () => {
   it("runs a boot pull when enabled", async () => {
      sync.setSyncUrl(URL)
      sync.init(vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      // The default fetchMock answers a v1 blob, which always merges + forces
      // an upgrade push (see "pull-merge" above) — GET then PUT.
      expect(fetchMock).toHaveBeenCalledTimes(2)
   })

   it("stays quiet when disabled", async () => {
      sync.init(vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).not.toHaveBeenCalled()
   })

   it("fires the status callback after every cycle, success or failure", async () => {
      const status = vi.fn()
      sync.init(vi.fn(), status)
      sync.setSyncUrl(URL)
      await sync.syncNow()
      expect(status).toHaveBeenCalledTimes(1)
      fetchMock.mockResolvedValue(res(500))
      await sync.syncNow()
      expect(status).toHaveBeenCalledTimes(2)
   })
})
