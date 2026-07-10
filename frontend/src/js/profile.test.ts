import { describe, it, expect, beforeEach } from "vitest"
// profile.ts is a pure module (no DOM, no module-load side effects) so we can
// import it statically — no vi.resetModules() needed.
import { exportProfile, importProfile, profileTs, touchProfile, localSeen } from "./profile"

const SEEN_KEY = "srr-seen"
const SAVED_KEY = "srr-saved"
const UNREAD_ONLY_KEY = "srr-unread-only"
const IMG_PROXY_KEY = "srr-img-proxy"
const HASH_KEY = "srr-hash"

function seedAll() {
   localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 42, "feed:2": 7 }))
   localStorage.setItem(SAVED_KEY, JSON.stringify([5, 10, 3]))
   localStorage.setItem(UNREAD_ONLY_KEY, "1")
   localStorage.setItem(IMG_PROXY_KEY, "https://proxy.example/?url=")
   localStorage.setItem(HASH_KEY, "#42") // must NOT appear in export
}

describe("exportProfile", () => {
   beforeEach(() => {
      localStorage.clear()
   })

   it("returns a JSON object with v:2 and the four portable keys", () => {
      seedAll()
      const obj = JSON.parse(exportProfile())
      expect(obj.v).toBe(2)
      expect(obj.seen).toEqual({ "feed:1": 42, "feed:2": 7 })
      expect(obj.saved).toEqual([3, 5, 10]) // sorted ascending
      expect(obj.unreadOnly).toBe(true)
      expect(obj.imgProxy).toBe("https://proxy.example/?url=")
   })

   it("never includes srr-hash in the export", () => {
      seedAll()
      const raw = exportProfile()
      expect(raw).not.toContain("hash")
      expect(raw).not.toContain("srr-hash")
      expect(raw).not.toContain(HASH_KEY)
   })

   it("exports empty defaults when nothing is stored", () => {
      const obj = JSON.parse(exportProfile())
      expect(obj.v).toBe(2)
      expect(obj.seen).toEqual({})
      expect(obj.saved).toEqual([])
      expect(obj.unreadOnly).toBe(false)
      expect(obj.imgProxy).toBe("")
   })
})

describe("importProfile", () => {
   beforeEach(() => {
      localStorage.clear()
   })

   it("rejects non-JSON input with ok:false and mutates nothing", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 5 }))
      const r = importProfile("not json at all", { prefs: true })
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
      // nothing mutated
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 5 })
   })

   it("rejects an unsupported v (not 1 or 2) with ok:false and mutates nothing", () => {
      const r = importProfile(JSON.stringify({ v: 3, seen: {}, saved: [], unreadOnly: false, imgProxy: "" }), {
         prefs: false,
      })
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
   })

   it("rejects a non-plain-object JSON value with ok:false", () => {
      const r = importProfile(JSON.stringify([1, 2, 3]), { prefs: false })
      expect(r.ok).toBe(false)
   })

   it("merges seen via max() — never lowers an existing entry", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 100, "feed:2": 5 }))
      const incoming = {
         v: 1,
         seen: { "feed:1": 50, "feed:2": 20, "feed:3": 15 },
         saved: [],
         unreadOnly: false,
         imgProxy: "",
      }
      const r = importProfile(JSON.stringify(incoming), { prefs: false })
      expect(r.ok).toBe(true)
      const seen = JSON.parse(localStorage.getItem(SEEN_KEY)!)
      // feed:1: existing=100, incoming=50 → stays 100
      expect(seen["feed:1"]).toBe(100)
      // feed:2: existing=5, incoming=20 → raised to 20
      expect(seen["feed:2"]).toBe(20)
      // feed:3: new key → 15
      expect(seen["feed:3"]).toBe(15)
   })

   it("union-merges saved and sorts ascending", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 5, 10]))
      const incoming = { v: 1, seen: {}, saved: [3, 5, 20], unreadOnly: false, imgProxy: "" }
      const r = importProfile(JSON.stringify(incoming), { prefs: false })
      expect(r.ok).toBe(true)
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY)!)
      expect(saved).toEqual([1, 3, 5, 10, 20])
   })

   it("import is idempotent — importing the same blob twice produces the same result", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([2, 4]))
      const blob = JSON.stringify({
         v: 1,
         seen: { "feed:1": 15, "feed:2": 3 },
         saved: [4, 6],
         unreadOnly: false,
         imgProxy: "",
      })
      importProfile(blob, { prefs: false })
      const seen1 = localStorage.getItem(SEEN_KEY)
      const saved1 = localStorage.getItem(SAVED_KEY)
      importProfile(blob, { prefs: false })
      expect(localStorage.getItem(SEEN_KEY)).toBe(seen1)
      expect(localStorage.getItem(SAVED_KEY)).toBe(saved1)
   })

   it("does NOT import prefs when opts.prefs is false", () => {
      localStorage.removeItem(UNREAD_ONLY_KEY)
      localStorage.removeItem(IMG_PROXY_KEY)
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: true, imgProxy: "https://p.example/?url=" })
      const r = importProfile(blob, { prefs: false })
      expect(r.ok).toBe(true)
      // prefs unchanged
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBeNull()
      expect(localStorage.getItem(IMG_PROXY_KEY)).toBeNull()
   })

   it("imports prefs when opts.prefs is true", () => {
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: true, imgProxy: "https://p.example/?url=" })
      const r = importProfile(blob, { prefs: true })
      expect(r.ok).toBe(true)
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("1")
      expect(localStorage.getItem(IMG_PROXY_KEY)).toBe("https://p.example/?url=")
   })

   it("imports an explicit unreadOnly:false as '0' (so it overrides the first-run default)", () => {
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      const r = importProfile(blob, { prefs: true })
      expect(r.ok).toBe(true)
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("0")
   })

   it("ignores an invalid imgProxy (explicit non-http(s) scheme) even when opts.prefs is true", () => {
      localStorage.setItem(IMG_PROXY_KEY, "https://existing/?url=")
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: false, imgProxy: "ftp://evil/" })
      const r = importProfile(blob, { prefs: true })
      expect(r.ok).toBe(true)
      // invalid proxy is ignored; existing value unchanged
      expect(localStorage.getItem(IMG_PROXY_KEY)).toBe("https://existing/?url=")
   })

   it("normalizes a schemeless imgProxy on import (https default + trailing slash)", () => {
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: false, imgProxy: "images.weserv.nl" })
      const r = importProfile(blob, { prefs: true })
      expect(r.ok).toBe(true)
      expect(localStorage.getItem(IMG_PROXY_KEY)).toBe("https://images.weserv.nl/")
   })

   it("filters non-integer values from incoming saved array", () => {
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [1, "bad", null, 3], unreadOnly: false, imgProxy: "" })
      const r = importProfile(blob, { prefs: false })
      expect(r.ok).toBe(true)
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY)!)
      expect(saved).toEqual([1, 3])
   })

   it("seen merge handles missing existing seen gracefully (no prior data)", () => {
      const blob = JSON.stringify({ v: 1, seen: { "feed:1": 7 }, saved: [], unreadOnly: false, imgProxy: "" })
      const r = importProfile(blob, { prefs: false })
      expect(r.ok).toBe(true)
      const seen = JSON.parse(localStorage.getItem(SEEN_KEY)!)
      expect(seen["feed:1"]).toBe(7)
   })

   it("silently skips non-finite seen values (Infinity, NaN) and does NOT write storage", () => {
      // JSON.stringify converts Infinity/NaN to null, so hand-craft the blob to
      // embed actual number-shaped non-finite values that bypass the typeof guard.
      // We test two paths: a numeric NaN (parsed by JSON as a number) and a string
      // "NaN" — both must be rejected by Number.isFinite and leave storage untouched.
      const r1 = importProfile(
         '{"v":1,"seen":{"feed:1":1e999,"feed:2":-1e999},"saved":[],"unreadOnly":false,"imgProxy":""}',
         { prefs: false },
      )
      expect(r1.ok).toBe(true)
      // 1e999 parses as Infinity in JS; Number.isFinite(Infinity) is false
      expect(localStorage.getItem(SEEN_KEY)).toBeNull()

      const r2 = importProfile('{"v":1,"seen":{"feed:3":"NaN"},"saved":[],"unreadOnly":false,"imgProxy":""}', {
         prefs: false,
      })
      expect(r2.ok).toBe(true)
      // string "NaN" fails typeof v === "number"; nothing written
      expect(localStorage.getItem(SEEN_KEY)).toBeNull()
   })

   it("rejects a javascript: image proxy on import", () => {
      // isValidProxy's dangerous-scheme branch — an existing proxy stays put.
      localStorage.setItem(IMG_PROXY_KEY, "https://existing/?url=")
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: false, imgProxy: "javascript:alert(1)" })
      const r = importProfile(blob, { prefs: true })
      expect(r.ok).toBe(true)
      expect(localStorage.getItem(IMG_PROXY_KEY)).toBe("https://existing/?url=")
   })
})

describe("v2 blob / ts / sync mode", () => {
   beforeEach(() => {
      localStorage.clear()
   })

   it("exportProfile emits v:2 with the stored ts (0 when never stamped)", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 5 }))
      expect(JSON.parse(exportProfile())).toMatchObject({ v: 2, ts: 0 })
      touchProfile(1234)
      expect(JSON.parse(exportProfile())).toMatchObject({ v: 2, ts: 1234 })
      expect(profileTs()).toBe(1234)
   })

   it("sync mode never lowers seen, even from a newer-ts blob", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500, "feed:2": 90 }))
      touchProfile(100)
      const blob = JSON.stringify({
         v: 2,
         ts: 200,
         seen: { "feed:1": 10, "feed:3": 7 },
         saved: [],
         unreadOnly: false,
         imgProxy: "",
      })
      expect(importProfile(blob, { prefs: false, mode: "sync" }).ok).toBe(true)
      // feed:1 kept at 500 (blob lower), feed:2 kept (absent from blob), feed:3 joined
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 500, "feed:2": 90, "feed:3": 7 })
   })

   it("sync mode raises seen from an older-ts blob WITHOUT stamping ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      touchProfile(300)
      const blob = JSON.stringify({ v: 2, ts: 50, seen: { "feed:1": 99 }, saved: [], unreadOnly: false, imgProxy: "" })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 99 })
      // The raise came from the remote, not a local action — the saved-LWW
      // ordering field must not move (blob older, so no adoption either).
      expect(profileTs()).toBe(300)
   })

   it("sync mode adopts saved wholesale (un-saves propagate) and takes ts when the blob is newer", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 2, 3]))
      touchProfile(100)
      const blob = JSON.stringify({ v: 2, ts: 200, seen: {}, saved: [7], unreadOnly: false, imgProxy: "" })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(true)
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([7]) // un-saves propagate
      expect(profileTs()).toBe(200)
   })

   it("sync mode keeps local saved and ts when the blob's ts is older or equal", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 2]))
      touchProfile(300)
      const blob = (ts: number) => JSON.stringify({ v: 2, ts, seen: {}, saved: [9], unreadOnly: false, imgProxy: "" })
      expect(importProfile(blob(200), { prefs: false, mode: "sync" }).changed).toBe(false)
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([1, 2])
      expect(profileTs()).toBe(300)
      expect(importProfile(blob(300), { prefs: false, mode: "sync" }).changed).toBe(false) // tie → local wins
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([1, 2])
      expect(profileTs()).toBe(300)
   })

   it("sync mode does NOT wipe local saved when a newer blob omits the saved field", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 2, 3]))
      touchProfile(100)
      // A truncated keepalive PUT / hand-edited endpoint: object, newer ts, but no
      // saved array. It must not zero the local star collection; ts still converges.
      const blob = JSON.stringify({ v: 2, ts: 500, seen: {}, unreadOnly: false, imgProxy: "" })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([1, 2, 3])
      expect(profileTs()).toBe(500)
   })

   it("sync mode still propagates a genuine un-save (newer blob with an empty saved array)", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 2, 3]))
      touchProfile(100)
      const blob = JSON.stringify({ v: 2, ts: 500, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob, { prefs: false, mode: "sync" })
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([])
   })

   it("sync-mode saved adoption filters and sorts the array", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([2]))
      touchProfile(100)
      const blob = JSON.stringify({
         v: 2,
         ts: 200,
         seen: {},
         saved: [3, "bad", -1, 1],
         unreadOnly: false,
         imgProxy: "",
      })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      // non-integers and negatives dropped, sorted ascending
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([1, 3])
   })

   it("a ts-only adoption (newer blob, identical saved, no seen raise) reports changed:false", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([4]))
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 50 }))
      touchProfile(100)
      const blob = JSON.stringify({
         v: 2,
         ts: 200,
         seen: { "feed:1": 50 },
         saved: [4],
         unreadOnly: false,
         imgProxy: "",
      })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(false) // ts converged, but nothing the UI shows moved
      expect(profileTs()).toBe(200) // ts still converges to max
   })

   it("sync mode never applies prefs (prefs stay carried-not-applied)", () => {
      localStorage.setItem(UNREAD_ONLY_KEY, "1")
      const blob = JSON.stringify({ v: 2, ts: 9, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob, { prefs: false, mode: "sync" })
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("1")
   })

   it("sync mode with malformed seen merges nothing and still LWW-adopts saved/ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      const blob = JSON.stringify({ v: 2, ts: 5, seen: "garbage", saved: [8] })
      expect(importProfile(blob, { prefs: false, mode: "sync" }).ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 500 }) // untouched, never wiped
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([8]) // ts 5 > local 0 → adopted
      expect(profileTs()).toBe(5)
   })

   it("sync mode floors a fractional blob ts and ignores an invalid (negative) one", () => {
      touchProfile(100)
      const blob = (ts: number) => JSON.stringify({ v: 2, ts, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob(200.9), { prefs: false, mode: "sync" })
      expect(profileTs()).toBe(200)
      importProfile(blob(-5), { prefs: false, mode: "sync" })
      expect(profileTs()).toBe(200) // invalid ts → no adoption, local ordering kept
   })

   it("merge mode reports changed only when it actually raised something", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([7]))
      const noop = JSON.stringify({ v: 1, seen: { "feed:1": 10 }, saved: [7], unreadOnly: false, imgProxy: "" })
      expect(importProfile(noop, { prefs: false }).changed).toBe(false)
      const raise = JSON.stringify({ v: 1, seen: { "feed:1": 600 }, saved: [7], unreadOnly: false, imgProxy: "" })
      expect(importProfile(raise, { prefs: false }).changed).toBe(true)
   })

   it("a merge that changes nothing does not stamp ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([7]))
      touchProfile(777)
      const blob = JSON.stringify({ v: 1, seen: { "feed:1": 10 }, saved: [7], unreadOnly: false, imgProxy: "" })
      expect(importProfile(blob, { prefs: false }).ok).toBe(true)
      expect(profileTs()).toBe(777) // lower seen + already-saved id = no-op, ts untouched
   })

   it("v1 blob still merges monotonically (max/union) and a merge stamps ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([3]))
      const blob = JSON.stringify({
         v: 1,
         seen: { "feed:1": 10, "feed:2": 4 },
         saved: [7],
         unreadOnly: true,
         imgProxy: "",
      })
      expect(importProfile(blob, { prefs: false }).ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 500, "feed:2": 4 })
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([3, 7])
      expect(profileTs()).toBeGreaterThan(0)
   })

   it("v2 blob WITHOUT adopt (file restore) merges like v1", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      const blob = JSON.stringify({ v: 2, ts: 999, seen: { "feed:1": 10 }, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob, { prefs: false })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 500 })
   })

   it("localSeen returns the parsed map", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:9": 42 }))
      expect(localSeen()).toEqual({ "feed:9": 42 })
   })
})

describe("per-key seen timestamps (st) — the explicit-rewind ordering", () => {
   const ST_KEY = "srr-seen-ts"
   beforeEach(() => {
      localStorage.clear()
   })

   it("exportProfile includes the st map alongside seen", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 5 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 42 }))
      const obj = JSON.parse(exportProfile())
      expect(obj.st).toEqual({ "feed:1": 42 })
   })

   it("a newer per-key stamp LOWERS seen — the explicit rewind propagates (sync mode)", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 100 }))
      const blob = JSON.stringify({ v: 2, ts: 200, seen: { "feed:1": 20 }, st: { "feed:1": 200 }, saved: [] })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 20 })
      // The rewind's stamp is adopted verbatim, never re-stamped to now.
      expect(JSON.parse(localStorage.getItem(ST_KEY)!)).toEqual({ "feed:1": 200 })
   })

   it("an older per-key stamp cannot lower seen — stale rewinds lose", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 300 }))
      const blob = JSON.stringify({ v: 2, ts: 400, seen: { "feed:1": 20 }, st: { "feed:1": 200 }, saved: [] })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.changed).toBe(false)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 })
   })

   it("per-key ordering beats the blob-level ts — a newer-stamped local raise survives an older-stamped rewind", () => {
      // Local raise stamped newer than the blob's rewind: the raise wins even
      // though the blob's blob-level ts is newer — ordering is per key.
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 500 }))
      const blob = JSON.stringify({ v: 2, ts: 600, seen: { "feed:1": 20 }, st: { "feed:1": 400 }, saved: [] })
      expect(importProfile(blob, { prefs: false, mode: "sync" }).changed).toBe(false)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 })
   })

   it("keys without stamps on either side keep the legacy raise-only max", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90, "feed:2": 5 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 300 }))
      // The blob carries no st at all (an old build): its lower values are
      // ignored (no ordering info → never lower), its higher values adopted.
      const blob = JSON.stringify({ v: 2, ts: 400, seen: { "feed:1": 20, "feed:2": 50 }, saved: [] })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.changed).toBe(true)
      const seen = JSON.parse(localStorage.getItem(SEEN_KEY)!)
      expect(seen["feed:1"]).toBe(90) // unstamped rewind ignored — max holds
      expect(seen["feed:2"]).toBe(50) // raise adopted
      expect(JSON.parse(localStorage.getItem(ST_KEY)!)).toEqual({ "feed:1": 300 })
   })

   it("merge mode (file restore) honors the same per-key rule", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      const blob = JSON.stringify({ v: 2, ts: 0, seen: { "feed:1": 30 }, st: { "feed:1": 77 }, saved: [] })
      const r = importProfile(blob, { prefs: false })
      expect(r.changed).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 30 })
      expect(JSON.parse(localStorage.getItem(ST_KEY)!)).toEqual({ "feed:1": 77 }) // stamp adopted verbatim
   })

   it("adopting an unstamped higher value drops the local seen-ts stamp", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 300 }))
      // An old-build blob: v2 but no `st` map at all — the raise adopts by max.
      const blob = JSON.stringify({ v: 2, ts: 1, seen: { "feed:1": 99 }, saved: [] })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 99 })
      // the adopted value has no stamp, so the local one is dropped, not kept
      expect(JSON.parse(localStorage.getItem(ST_KEY)!)).toEqual({})
   })

   it("a newer stamp at an equal value updates ordering but is not a change", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 50 }))
      localStorage.setItem(ST_KEY, JSON.stringify({ "feed:1": 100 }))
      const blob = JSON.stringify({ v: 2, ts: 50, seen: { "feed:1": 50 }, st: { "feed:1": 200 }, saved: [] })
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(false) // the value didn't move — only its ordering stamp did
      expect(JSON.parse(localStorage.getItem(ST_KEY)!)).toEqual({ "feed:1": 200 })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 })
   })
})
