import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// refresh.ts holds throttle state and wires document/window listeners at
// init(), so each test gets a fresh instance via vi.resetModules() + dynamic
// import (the sync.test.ts pattern). data/nav/search are mocked.
const data = vi.hoisted(() => ({
   db: { total_art: 0 },
   refresh: vi.fn(async () => "updated" as const),
   refreshPeers: vi.fn(async () => false),
   resetMountBackoff: vi.fn(),
}))
const nav = vi.hoisted(() => ({ onStoreRefreshed: vi.fn(async () => {}) }))
const search = vi.hoisted(() => ({ invalidate: vi.fn() }))
vi.mock("./data", () => data)
vi.mock("./nav", () => nav)
vi.mock("./search", () => search)

type Refresh = typeof import("./refresh")
let refresh: Refresh
let model: typeof import("./model")

const exclusive = async (fn: () => Promise<void>) => (await fn(), true)

// init() wires listeners on the SHARED jsdom window/document with no teardown
// (mirroring sync.ts), so each test records what its module instance registers
// and removes it in afterEach — otherwise earlier instances' visibilitychange/
// online listeners stack up and fire alongside the current one (the
// dropdown.test.ts listener-hygiene precedent). The heartbeat interval needs
// no cleanup: the per-test fake-timer swap orphans it.
type Recorded = { target: EventTarget; type: string; handler: EventListenerOrEventListenerObject }
let recorded: Recorded[] = []
const recordListeners = (target: EventTarget) => {
   const original = target.addEventListener.bind(target)
   vi.spyOn(target, "addEventListener").mockImplementation((type, handler, opts) => {
      if (handler) recorded.push({ target, type, handler })
      original(type, handler, opts)
   })
}

beforeEach(async () => {
   vi.useFakeTimers()
   recorded = []
   recordListeners(document)
   recordListeners(window)
   data.refresh.mockClear().mockResolvedValue("updated")
   nav.onStoreRefreshed.mockClear()
   search.invalidate.mockClear()
   data.db.total_art = 0
   vi.resetModules()
   model = await import("./model")
   refresh = await import("./refresh")
})

afterEach(() => {
   vi.useRealTimers()
   // Restores the addEventListener recorders AND any per-test getter spy
   // (visibilityState, navigator.onLine); vi.fn module mocks are unaffected.
   vi.restoreAllMocks()
   for (const { target, type, handler } of recorded) target.removeEventListener(type, handler)
})

describe("refreshNow", () => {
   it("runs the full chain on 'updated' and returns ''", async () => {
      refresh.init(exclusive)
      expect(await refresh.refreshNow()).toBe("")
      expect(data.refresh).toHaveBeenCalledTimes(1)
      expect(search.invalidate).toHaveBeenCalledTimes(1)
      expect(nav.onStoreRefreshed).toHaveBeenCalledTimes(1)
      expect(model.snapshot()).toBe(1)
   })

   it("skips the chain on 'unchanged'", async () => {
      data.refresh.mockResolvedValue("unchanged")
      refresh.init(exclusive)
      await refresh.refreshNow()
      expect(search.invalidate).not.toHaveBeenCalled()
   })

   it("returns the error message on failure (and remembers it)", async () => {
      data.refresh.mockRejectedValue(new Error("boom"))
      refresh.init(exclusive)
      expect(await refresh.refreshNow()).toBe("boom")
      expect(refresh.lastRefreshError()).toBe("boom")
   })

   it("a busy mutex skips the tick entirely", async () => {
      refresh.init(async () => false)
      expect(await refresh.refreshNow()).toBe("")
      expect(data.refresh).not.toHaveBeenCalled()
   })

   it("chains in order: invalidate → onStoreRefreshed → the snapshot publish", async () => {
      // The ordering contract: nav's search-snapshot reload must hit the
      // already-invalidated caches (search.invalidate()'s docblock), and the
      // UI routine runs last, over fully reconciled state.
      const { effect } = await import("./signals")
      const published = vi.fn()
      effect(() => {
         if (model.snapshot() > 0) published()
      })
      refresh.init(exclusive)
      await refresh.refreshNow()
      const [inv] = search.invalidate.mock.invocationCallOrder
      const [reload] = nav.onStoreRefreshed.mock.invocationCallOrder
      const [ui] = published.mock.invocationCallOrder
      expect(inv).toBeLessThan(reload)
      expect(reload).toBeLessThan(ui)
   })

   it("offline failures stay silent", async () => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      data.refresh.mockRejectedValue(new Error("net down"))
      refresh.init(exclusive)
      expect(await refresh.refreshNow()).toBe("")
      expect(refresh.lastRefreshError()).toBe("")
   })

   it("a trigger before init is a fail-closed no-op", async () => {
      // No refresh.init(...) here: runExclusive is still the module's fail-closed
      // default (async () => false), so a pre-init tick acts busy and skips.
      expect(await refresh.refreshNow()).toBe("")
      expect(data.refresh).not.toHaveBeenCalled()
   })

   it("publishes the adopted snapshot only after nav reconciled to it (D2)", async () => {
      const seenAtReconcile: number[] = []
      nav.onStoreRefreshed.mockImplementationOnce(async () => void seenAtReconcile.push(model.snapshot()))
      refresh.init(exclusive)
      await refresh.refreshNow()
      expect(seenAtReconcile).toEqual([0])
      expect(model.snapshot()).toBe(1)
   })

   it("bumps storeGrown only when the article count rose", async () => {
      data.db.total_art = 5
      data.refresh.mockImplementationOnce(async () => {
         data.db.total_art = 7
         return "updated"
      })
      refresh.init(exclusive)
      await refresh.refreshNow()
      expect(model.storeGrown()).toBe(1)
      await refresh.refreshNow() // "updated" again, same count (an expiration-only cycle)
      expect(model.snapshot()).toBe(2)
      expect(model.storeGrown()).toBe(1)
   })

   it("publishes nothing on 'unchanged'", async () => {
      data.refresh.mockResolvedValue("unchanged")
      refresh.init(exclusive)
      await refresh.refreshNow()
      expect(model.snapshot()).toBe(0)
   })

   it("still publishes when the post-swap reload fails", async () => {
      nav.onStoreRefreshed.mockRejectedValueOnce(new Error("reload failed"))
      refresh.init(exclusive)
      await refresh.refreshNow()
      expect(model.snapshot()).toBe(1)
   })

   it("mirrors the last refresh error into the model", async () => {
      data.refresh.mockRejectedValueOnce(new Error("boom"))
      refresh.init(exclusive)
      await refresh.refreshNow()
      expect(model.refreshError()).toBe("boom")
      await refresh.refreshNow()
      expect(model.refreshError()).toBe("")
   })
})

describe("triggers", () => {
   it("visibilitychange → visible refreshes, throttled to one per minute", async () => {
      refresh.init(exclusive)
      const fire = () => document.dispatchEvent(new Event("visibilitychange"))
      fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
      fire() // within the throttle window
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(61_000)
      fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
   })

   it("the 5-minute heartbeat fires while visible", async () => {
      refresh.init(exclusive)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(data.refresh).toHaveBeenCalled()
   })

   it("online refreshes immediately", async () => {
      refresh.init(exclusive)
      window.dispatchEvent(new Event("online"))
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
   })

   it("visibilitychange while hidden does not refresh", async () => {
      refresh.init(exclusive)
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).not.toHaveBeenCalled()
   })

   it("a busy-skipped tick does not consume the throttle window", async () => {
      // The stamp lands only once the guard is acquired: a busy skip leaves
      // due() true, so the very next trigger retries instead of waiting ~60s.
      let busy = true
      refresh.init(async (fn) => (busy ? false : (await fn(), true)))
      const fire = () => document.dispatchEvent(new Event("visibilitychange"))
      fire() // busy — skipped, must not disarm due()
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).not.toHaveBeenCalled()
      busy = false
      fire() // immediate retry, still inside the would-be window
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
   })
})
