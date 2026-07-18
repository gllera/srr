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

// init() wires visibilitychange/pagehide/online listeners on the SHARED jsdom
// document/window with no teardown, so each test records what its module
// instance registers and removes it in afterEach — otherwise earlier instances'
// listeners stack up and fire alongside the current one on a dispatched event
// (the refresh.test.ts listener-hygiene precedent).
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
   localStorage.clear()
   vi.useFakeTimers()
   fetchMock = vi.fn(async () => res(200, remoteBlob()))
   vi.stubGlobal("fetch", fetchMock)
   recorded = []
   recordListeners(document)
   recordListeners(window)
   vi.resetModules()
   sync = await import("./sync")
})

afterEach(() => {
   vi.useRealTimers()
   // Restores the addEventListener recorders and any per-test getter spy
   // (visibilityState); the fetch stub is undone by unstubAllGlobals.
   vi.restoreAllMocks()
   vi.unstubAllGlobals()
   for (const { target, type, handler } of recorded) target.removeEventListener(type, handler)
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
      // A v1 remote always forces an upgrade push (dirty=true) so the endpoint
      // moves to v2 even when the merge itself raised nothing.
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

describe("sync pull (raise-only seen, LWW saved)", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("raises seen and adopts saved/ts from a newer remote, and reports changed", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([1]))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 }, [7])))
      expect(await sync.syncNow()).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 })
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([7]) // un-save of 1 propagated
      expect(localStorage.getItem(PROFILE_TS_KEY)).toBe("200")
      // local ⊑ remote after the merge — nothing to push back
      expect(fetchMock).toHaveBeenCalledTimes(1)
   })

   it("NEVER lowers local seen — not even from a newer remote — and self-heals the endpoint", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90, "feed:2": 5 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      // Newer remote with a lower feed:1 and feed:2 missing entirely.
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 }, [])))
      const changed = await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90, "feed:2": 5 })
      expect(localStorage.getItem(PROFILE_TS_KEY)).toBe("200") // ts still converges to max
      expect(changed).toBe(false) // nothing the UI shows moved (ts-only)
      expect("parked" in sync.state()).toBe(false) // parking is gone as a concept
      // The endpoint's seen is BEHIND local → the delta-derived push re-raises it.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).seen).toEqual({ "feed:1": 90, "feed:2": 5 })
   })

   it("re-raises a behind endpoint even with dirty lost (fresh module, no pending reads)", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 }, [])))
      await sync.syncNow() // background; dirty=false (this "tab" just loaded)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 })
      // The reload-lost-dirty heal: local is ahead → push fires anyway.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
   })

   it("a ts-only convergence reports changed=false and pushes nothing", async () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([7]))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, {}, [7])))
      expect(await sync.syncNow()).toBe(false)
      expect(localStorage.getItem(PROFILE_TS_KEY)).toBe("200")
      expect(fetchMock).toHaveBeenCalledTimes(1) // GET only
   })

   it("MANUAL also merges raise-only — it can no longer rewind — and always pushes", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 }, [])))
      await sync.syncNow({ manual: true })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 }) // NOT rewound
      expect(fetchMock).toHaveBeenCalledTimes(2) // GET then PUT
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).seen).toEqual({ "feed:1": 90 })
   })

   it("a v1 remote gets one monotone merge and an upgrade push", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      fetchMock.mockResolvedValue(res(200, remoteBlob({ seen: { "feed:1": 50, "feed:2": 4 } })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90, "feed:2": 4 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).v).toBe(2)
   })

   it("a cycle with pending local reads pushes them and cancels the debounce timer", async () => {
      vi.setSystemTime(100_000)
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      sync.pushSoon() // dirty, timer armed; ts = 100
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 }, [])))
      await sync.syncNow() // raises seen from remote; dirty → PUT in this same cycle
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1)
      const calls = fetchMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      // The debounce timer was cancelled with the push — no redundant cycle.
      expect(fetchMock.mock.calls.length).toBe(calls)
   })

   it("reports changed=false when the pull moved nothing at all", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 50 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([7]))
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 }, [7])))
      expect(await sync.syncNow()).toBe(false)
   })
})

describe("seenBehind", () => {
   it("detects missing progress on the seen axis (legacy, no per-key timestamps)", () => {
      expect(sync.seenBehind({ "feed:1": 50 }, {}, { "feed:1": 50 }, {})).toBe(false) // equal
      expect(sync.seenBehind({ "feed:1": 50 }, {}, { "feed:1": 49 }, {})).toBe(true) // lower value
      expect(sync.seenBehind({ "feed:1": 50, "feed:2": 5 }, {}, { "feed:1": 50 }, {})).toBe(true) // dropped key
      expect(sync.seenBehind({ "feed:1": 50 }, {}, { "feed:1": 50, "feed:2": 5 }, {})).toBe(false) // extra b key
   })

   it("orders by per-key timestamp when both sides carry one — a newer rewind counts as ahead", () => {
      const a = { "feed:1": 10 }
      const b = { "feed:1": 50 }
      // a holds a LOWER value with a NEWER timestamp (an explicit rewind): b is behind.
      expect(sync.seenBehind(a, { "feed:1": 200 }, b, { "feed:1": 100 })).toBe(true)
      // …and a is NOT behind b, despite b's higher value (b's raise is older intent).
      expect(sync.seenBehind(b, { "feed:1": 100 }, a, { "feed:1": 200 })).toBe(false)
      // Equal timestamps tie-break by value (max), like the merge.
      expect(sync.seenBehind(b, { "feed:1": 100 }, a, { "feed:1": 100 })).toBe(true)
      // A newer timestamp at EQUAL values still counts — the ordering metadata
      // itself must propagate.
      expect(sync.seenBehind(a, { "feed:1": 200 }, { ...a }, { "feed:1": 100 })).toBe(true)
      // One side without a timestamp falls back to the value comparison.
      expect(sync.seenBehind(a, { "feed:1": 200 }, b, {})).toBe(false)
      expect(sync.seenBehind(b, {}, a, { "feed:1": 200 })).toBe(true)
   })
})

describe("explicit rewind round-trip (per-key st)", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   // The markUnreadFrom scenario: the device that just rewound pulls a remote
   // still holding the OLD higher frontier (with an older per-key stamp). The
   // merge must NOT re-raise the rewind, and the push must fire so the endpoint
   // adopts it — this is exactly what blob-level max-merge got wrong.
   it("a local rewind survives its own next cycle and republishes the endpoint", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 20 }))
      localStorage.setItem("srr-seen-ts", JSON.stringify({ "feed:1": 500 }))
      localStorage.setItem(PROFILE_TS_KEY, "500")
      const remote = JSON.stringify({
         v: 2,
         ts: 400,
         seen: { "feed:1": 90 },
         st: { "feed:1": 400 },
         saved: [],
         unreadOnly: false,
         imgProxy: "",
      })
      fetchMock.mockImplementation(async (_u, init) =>
         (init as RequestInit)?.method === "PUT" ? res(200) : res(200, remote),
      )
      await sync.syncNow()
      // The older remote raise did not undo the rewind…
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 20 })
      // …and the endpoint was behind (older per-key stamp), so the PUT fired
      // carrying the rewound frontier and its stamp.
      const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")
      expect(puts).toHaveLength(1)
      const body = JSON.parse(puts[0][1].body)
      expect(body.seen).toEqual({ "feed:1": 20 })
      expect(body.st).toEqual({ "feed:1": 500 })
   })

   it("another device adopts a remote rewind with a newer per-key stamp", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem("srr-seen-ts", JSON.stringify({ "feed:1": 400 }))
      localStorage.setItem(PROFILE_TS_KEY, "400")
      const remote = JSON.stringify({
         v: 2,
         ts: 500,
         seen: { "feed:1": 20 },
         st: { "feed:1": 500 },
         saved: [],
         unreadOnly: false,
         imgProxy: "",
      })
      fetchMock.mockResolvedValue(res(200, remote))
      expect(await sync.syncNow()).toBe(true) // the rewind changed local state
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 20 })
      // Local now equals the remote — nothing to push back.
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0)
   })
})

describe("flush guard (stale-tab protection)", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("a push after a pull can never rewind the endpoint — the merge absorbed it", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 90 }, [])))
      await sync.syncNow() // remote's feed:1 progress absorbed into local seen
      sync.pushSoon()
      await vi.advanceTimersByTimeAsync(6000)
      const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")
      expect(puts.length).toBeGreaterThan(0)
      // Every published blob carries the absorbed remote progress.
      for (const p of puts) expect(JSON.parse(p[1].body).seen["feed:1"]).toBe(90)
   })

   it("flush skips when local seen fell below the remembered remote, leaving dirty set", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 90 }, [])))
      await sync.syncNow() // remembered remote (post-push): seen has feed:1=90
      // Local seen drops below the snapshot afterwards (nav.pruneSeen dropping a
      // deleted feed's key is the legitimate way this happens).
      localStorage.setItem(SEEN_KEY, "{}")
      sync.pushSoon() // ts newer than the snapshot, but the blob is regressive
      sync.flush()
      const putsAfterFlush = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT").length
      // The flush was skipped: no NEW put beyond the cycle's own one.
      expect(putsAfterFlush).toBe(1)
      // The skip left dirty set AND the debounce timer armed: the pending full
      // cycle pulls first, re-absorbs the remote's progress, and publishes.
      await vi.advanceTimersByTimeAsync(6000)
      const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")
      expect(puts).toHaveLength(2)
      expect(JSON.parse(puts[1][1].body).seen["feed:1"]).toBe(90) // re-absorbed, not rewound
   })

   it("flush skips when local ts is older than the last-pulled remote", async () => {
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 }, [])))
      await sync.syncNow() // seen raised + ts converged to 200; nothing pushed
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

   it("flush delivers progress a FAILED background push left ahead, with dirty never set", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "300")
      // A background cycle pulls a BEHIND remote (feed:1=50) — the delta-derived
      // push fires (local is ahead) but the PUT 500s, so it never clears/sets
      // `dirty`. Local (feed:1=90) is now ahead of the endpoint with dirty false.
      fetchMock.mockImplementation(async (_u, init) =>
         (init as RequestInit)?.method === "PUT" ? res(500) : res(200, v2Blob(200, { "feed:1": 50 }, [])),
      )
      await sync.syncNow()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1) // the failed one
      expect(sync.state().error).toBe("HTTP 500")

      // On page-hide the keepalive flush retries — local is provably ahead of the
      // remembered remote, so it publishes despite `dirty` being false (the old
      // `if (!dirty) return` would have silently dropped this on the floor).
      fetchMock.mockImplementation(async () => res(200))
      sync.flush()
      await vi.advanceTimersByTimeAsync(0)
      const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")
      expect(puts).toHaveLength(2)
      expect(puts[1][1].keepalive).toBe(true)
      expect(JSON.parse(puts[1][1].body).seen["feed:1"]).toBe(90) // the missing progress, delivered
   })

   it("flush stays quiet when local is already even with the endpoint (no redundant PUT)", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "300")
      // Pull a behind remote → the cycle pushes local up to the endpoint and the
      // remembered remote becomes local. Nothing is pending afterwards.
      fetchMock.mockImplementation(async (_u, init) =>
         (init as RequestInit)?.method === "PUT" ? res(200) : res(200, v2Blob(200, { "feed:1": 50 }, [])),
      )
      await sync.syncNow()
      const before = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT").length
      sync.flush() // local == remote on seen and ts → no delta, no PUT
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(before)
   })

   it("a 404 pull forgets the guard snapshot and seeds the endpoint", async () => {
      vi.setSystemTime(400_000)
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 90 }, [])))
      await sync.syncNow() // pull + push (local ts newer) — snapshot set
      // Endpoint wiped: GETs now 404 (PUTs still succeed).
      fetchMock.mockImplementation(async (_u, init) => ((init as RequestInit)?.method === "PUT" ? res(200) : res(404)))
      await sync.syncNow()
      // The 404 forgot the snapshot and triggered the seeding PUT directly —
      // even with dirty false (nothing pending locally).
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(2)
   })

   it("a failed flush PUT leaves changes pending", async () => {
      vi.setSystemTime(100_000)
      sync.pushSoon() // dirty=true, ts=100, timer armed (this tab never pulled)
      fetchMock.mockRejectedValueOnce(new Error("net down")) // flush's OWN PUT fails
      sync.flush()
      await vi.advanceTimersByTimeAsync(0) // the rejected PUT's .catch re-arms dirty
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1)
      // A subsequent cycle whose pulled remote matches local exactly (no seen
      // delta, ts not newer) — so ONLY the retained `dirty` can drive a push.
      fetchMock.mockResolvedValue(res(200, v2Blob(200, {}, [7])))
      await sync.syncNow()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(2)
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
      await vi.advanceTimersByTimeAsync(500) // still within the 1s debounce window
      sync.pushSoon()
      sync.pushSoon()
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
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

describe("init triggers", () => {
   it("re-pulls on the online event", async () => {
      sync.setSyncUrl(URL)
      sync.init(vi.fn())
      await vi.advanceTimersByTimeAsync(0) // boot pull settles
      fetchMock.mockClear()
      window.dispatchEvent(new Event("online"))
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalled()
      expect(fetchMock.mock.calls[0][1]?.method).not.toBe("PUT") // a GET pull, not a blind push
   })

   it("throttles the focus re-pull to the pull interval", async () => {
      sync.setSyncUrl(URL)
      sync.init(vi.fn())
      await vi.advanceTimersByTimeAsync(0) // boot pull → lastPullAt = now
      fetchMock.mockClear()
      const fire = () => document.dispatchEvent(new Event("visibilitychange"))
      fire() // visible, but inside the 60s PULL_MIN_INTERVAL_MS window → no pull
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(61_000) // past the window
      fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalled()
   })

   it("flushes on hide/pagehide", async () => {
      sync.init(vi.fn())
      sync.setSyncUrl(URL) // enable AFTER init, so the boot pull never fired
      sync.pushSoon() // dirty; this tab never pulled → flush is unguarded
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
      let puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")
      expect(puts).toHaveLength(1)
      expect(puts[0][1].keepalive).toBe(true)
      // pagehide flushes too
      sync.pushSoon() // re-arm the pending change
      window.dispatchEvent(new Event("pagehide"))
      await vi.advanceTimersByTimeAsync(0)
      puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")
      expect(puts).toHaveLength(2)
      expect(puts[1][1].keepalive).toBe(true)
   })
})

describe("pullRemote corrupt-remote guards", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("rejects a non-object remote profile", async () => {
      // Valid JSON, but not an object — JSON.parse succeeds, the typeof guard
      // rejects (the existing "not json" case fails earlier, at JSON.parse).
      fetchMock.mockResolvedValue(res(200, "42"))
      await sync.syncNow()
      expect(sync.state().error).toBe("invalid profile")
   })

   it("rejects an unsupported profile version", async () => {
      fetchMock.mockResolvedValue(res(200, JSON.stringify({ v: 3 })))
      await sync.syncNow()
      expect(sync.state().error).toBe("unsupported profile version: 3")
   })
})
