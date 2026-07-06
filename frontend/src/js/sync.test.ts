import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// sync.ts holds module state (dirty flag, status, debounce timer), so each test
// gets a fresh instance via vi.resetModules() + dynamic import — the same
// pattern as dropdown.test.ts. fetch is a plain vi.fn stub (jsdom ships no
// fetch); responses are minimal object literals.
import { SEEN_KEY, SAVED_KEY, SYNC_URL_KEY, UNREAD_ONLY_KEY } from "./keys"

type Sync = typeof import("./sync")

const URL = "https://sync.example/profile"

function res(status: number, body = ""): { ok: boolean; status: number; text: () => Promise<string> } {
   return { ok: status >= 200 && status < 300, status, text: async () => body }
}

const remoteBlob = (over: object = {}) =>
   JSON.stringify({ v: 1, seen: { "feed:1": 50 }, saved: [7], unreadOnly: true, imgProxy: "", ...over })

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
      expect(sync.state()).toEqual({ on: false, okAt: 0, error: "" })
   })
})

describe("disabled (no sync url)", () => {
   it("syncNow / pushSoon / flush never touch the network", async () => {
      await sync.syncNow(true)
      sync.pushSoon()
      await vi.advanceTimersByTimeAsync(10_000)
      sync.flush()
      expect(fetchMock).not.toHaveBeenCalled()
   })
})

describe("pull-merge", () => {
   it("merges remote seen (max) and saved (union) but never prefs", async () => {
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
      // No local changes were pending, so a plain cycle never PUTs.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined()
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
      expect(sync.state().error).toBe("Invalid JSON")
   })
})

describe("push", () => {
   it("syncNow(true) pulls first, then PUTs the merged profile", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:2": 10 }))
      sync.setSyncUrl(URL)

      await sync.syncNow(true)

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
      await sync.syncNow(true)
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
      expect(fetchMock).toHaveBeenCalledTimes(1)
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
