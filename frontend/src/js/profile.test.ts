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
      expect(obj.saved).toEqual([5, 10, 3]) // save order preserved, NOT sorted
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

   it("union-merges saved, preserving local order and appending new incoming saves", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 5, 10]))
      const incoming = { v: 1, seen: {}, saved: [3, 5, 20], unreadOnly: false, imgProxy: "" }
      const r = importProfile(JSON.stringify(incoming), { prefs: false })
      expect(r.ok).toBe(true)
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY)!)
      // Local order [1,5,10] kept; the new incoming saves (3, 20 — 5 already
      // present) appended in the blob's order. NOT re-sorted.
      expect(saved).toEqual([1, 5, 10, 3, 20])
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

   it("sync-mode saved adoption filters invalid entries and preserves the blob's save order", () => {
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
      // non-integers and negatives dropped; the newer blob's save ORDER adopted
      // verbatim (LWW), NOT sorted
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([3, 1])
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

// RDR18 — the per-key SAVED stamps (`sd`, srr-saved-ts). The saved set used to
// be blob-level LWW, so a save on one device concurrent with an un-save on
// another lost one of them. Per-key stamps make it mergeable; the blob-level ts
// keeps deciding the queue ORDER.
describe("per-key saved stamps (sd)", () => {
   const SD_KEY = "srr-saved-ts"
   beforeEach(() => localStorage.clear())

   // Local device state: the set, its stamps, the blob-level ordering field.
   const seedLocal = (saved: number[], sd: Record<string, number>, ts: number) => {
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved))
      localStorage.setItem(SD_KEY, JSON.stringify(sd))
      touchProfile(ts)
   }
   const blob = (ts: number, saved: number[] | undefined, sd?: Record<string, number>) =>
      JSON.stringify({ v: 2, ts, seen: {}, saved, sd })
   const pull = (b: string) => importProfile(b, { prefs: false, mode: "sync" })
   const savedNow = () => JSON.parse(localStorage.getItem(SAVED_KEY)!)
   const sdNow = () => JSON.parse(localStorage.getItem(SD_KEY) ?? "{}")

   it("exportProfile publishes the sd map alongside saved", () => {
      seedLocal([5, 9], { 5: 100, 9: 200 }, 200)
      const obj = JSON.parse(exportProfile())
      expect(obj.saved).toEqual([5, 9])
      expect(obj.sd).toEqual({ 5: 100, 9: 200 })
   })

   // THE finding's case, both directions. Device A saved chron 7 at t=100;
   // device B un-saved it at t=110. Whichever device pulls the other's blob
   // must land on the same answer — the newer INTENT (the un-save) — instead of
   // on whichever blob happened to carry the newer blob-level ts.
   it("a save and a concurrent un-save converge on the newer intent — pulling B's blob on A", () => {
      seedLocal([7], { 7: 100 }, 100) // A
      const r = pull(blob(110, [], { 7: 110 })) // B's newer un-save
      expect(r.changed).toBe(true)
      expect(savedNow()).toEqual([])
      // The tombstone stamp is kept, verbatim: it is what makes this un-save
      // outrank a THIRD device's older save of the same article.
      expect(sdNow()).toEqual({ 7: 110 })
   })

   it("…and pulling A's blob on B leaves the un-save standing (same answer, no change)", () => {
      seedLocal([], { 7: 110 }, 110) // B
      const r = pull(blob(100, [7], { 7: 100 })) // A's older save
      expect(r.changed).toBe(false)
      expect(savedNow()).toEqual([])
      expect(sdNow()).toEqual({ 7: 110 })
      expect(profileTs()).toBe(110) // an older blob never lowers the ordering field
   })

   it("the reverse polarity converges too — a newer SAVE beats an older un-save", () => {
      seedLocal([], { 7: 100 }, 100) // A un-saved at 100
      expect(pull(blob(110, [7], { 7: 110 })).changed).toBe(true) // B re-saved at 110
      expect(savedNow()).toEqual([7])

      localStorage.clear()
      seedLocal([7], { 7: 110 }, 110) // the same pair, seen from B
      expect(pull(blob(100, [], { 7: 100 })).changed).toBe(false)
      expect(savedNow()).toEqual([7])
   })

   // The blob-level LWW dropped one of two concurrent saves of DIFFERENT
   // articles as well: whichever device's blob was older lost its save
   // wholesale. Per-key, each is stamped on exactly one side, so both survive.
   it("two concurrent saves of different articles both survive", () => {
      seedLocal([5], { 5: 100 }, 100)
      expect(pull(blob(110, [9], { 9: 110 })).changed).toBe(true)
      expect(savedNow().sort()).toEqual([5, 9])
      expect(sdNow()).toEqual({ 5: 100, 9: 110 })
   })

   // ORDER: the queue comes from the blob-level winner, with the loser's
   // additions appended — so both devices compute the SAME sequence.
   it("save order survives a per-key merge, and both devices compute the same queue", () => {
      seedLocal([10, 20, 30], { 10: 90, 20: 90, 30: 90 }, 90)
      // The newer blob re-ordered the queue AND un-saved 20; local's 40 is
      // stamped newer than anything the blob knows.
      localStorage.setItem(SAVED_KEY, JSON.stringify([10, 20, 30, 40]))
      localStorage.setItem(SD_KEY, JSON.stringify({ 10: 90, 20: 90, 30: 90, 40: 500 }))
      pull(blob(200, [30, 10], { 20: 150 }))
      // base = the blob's order (its ts wins) minus nothing, then the chrons the
      // per-key layer kept from local, in local's order.
      expect(savedNow()).toEqual([30, 10, 40])
      expect(sdNow()).toEqual({ 10: 90, 20: 150, 30: 90, 40: 500 })
   })

   it("a stamp-only convergence is not a change", () => {
      seedLocal([7], { 7: 100 }, 100)
      const r = pull(blob(100, [7], { 7: 200 })) // same membership, newer stamp
      expect(r.changed).toBe(false)
      expect(savedNow()).toEqual([7])
      expect(sdNow()).toEqual({ 7: 200 }) // adopted verbatim, never re-stamped to now
   })

   // Backwards interop, both shapes of "the other side has no stamps".
   it("a blob with NO sd merges exactly as before — wholesale from a newer ts", () => {
      seedLocal([7], { 7: 500 }, 100)
      pull(blob(999, [])) // an old build's v2 blob: newer ts, no sd at all
      expect(savedNow()).toEqual([])
      // The un-save was adopted from an unstamped source, so there is no stamp
      // to keep — the same rule mergeSeen applies to an unstamped adopted value.
      expect(sdNow()).toEqual({})
   })

   it("a v1 blob still union-merges and picks up no stamps", () => {
      localStorage.setItem(SAVED_KEY, JSON.stringify([1]))
      const r = importProfile(JSON.stringify({ v: 1, seen: {}, saved: [2] }), { prefs: false })
      expect(r.changed).toBe(true)
      expect(savedNow()).toEqual([1, 2])
      expect(sdNow()).toEqual({})
   })

   it("a newer blob that omits saved entirely still cannot wipe the set", () => {
      seedLocal([1, 2], { 1: 10, 2: 20 }, 100)
      pull(blob(999, undefined, { 1: 900 })) // sd present, saved missing
      expect(savedNow()).toEqual([1, 2])
      expect(sdNow()).toEqual({ 1: 10, 2: 20 }) // no membership opinion ⇒ no stamp adoption
   })

   // merge mode (a file restore) stays MONOTONE — an explicit "add this back"
   // gesture must never delete — but it does carry stamps so a later un-save
   // anywhere in the fleet can still outrank a restored save.
   it("merge mode never deletes, even from a newer un-save stamp", () => {
      seedLocal([1], { 1: 500 }, 100)
      importProfile(JSON.stringify({ v: 2, ts: 999, seen: {}, saved: [], sd: { 1: 900 } }), { prefs: false })
      expect(savedNow()).toEqual([1])
      expect(sdNow()).toEqual({ 1: 500 }) // the local (member) stamp stands
   })

   it("merge mode adopts an incoming save's stamp verbatim", () => {
      importProfile(JSON.stringify({ v: 2, ts: 0, seen: {}, saved: [9], sd: { 9: 700 } }), { prefs: false })
      expect(savedNow()).toEqual([9])
      expect(sdNow()).toEqual({ 9: 700 })
   })

   it("bounds tombstones while never dropping a member's stamp", () => {
      // 1200 un-saved chrons (tombstones) plus one live save: the published view
      // keeps the member and the newest 1024 tombstones.
      const sd: Record<string, number> = { 7: 1 }
      for (let i = 0; i < 1200; i++) sd[1000 + i] = 1000 + i
      seedLocal([7], sd, 100)
      const out = JSON.parse(exportProfile()).sd as Record<string, number>
      expect(Object.keys(out)).toHaveLength(1025)
      expect(out["7"]).toBe(1) // the member survives its ancient stamp
      expect(out["2199"]).toBe(2199) // newest tombstone kept
      expect(out["1000"]).toBeUndefined() // oldest pruned
   })

   it("a device's own blob round-trips with no change", () => {
      seedLocal([3, 1], { 3: 100, 1: 200 }, 200)
      const r = pull(exportProfile())
      expect(r.changed).toBe(false)
      expect(savedNow()).toEqual([3, 1])
      expect(sdNow()).toEqual({ 3: 100, 1: 200 })
   })

   it("peer-store substate merges by the same per-key rule", () => {
      localStorage.setItem("srr-saved@sP", JSON.stringify([7]))
      localStorage.setItem("srr-saved-ts@sP", JSON.stringify({ 7: 100 }))
      localStorage.setItem("srr-profile-ts@sP", "100")
      const incoming = JSON.stringify({
         v: 2,
         ts: 0,
         seen: {},
         saved: [],
         mnt: [{ id: "sP", url: "https://peer/", label: "P", ord: 10, role: "peer", cred: false, ts: 9 }],
         ms: { sP: { ts: 110, seen: {}, st: {}, saved: [], sd: { 7: 110 } } },
      })
      expect(importProfile(incoming, { prefs: false, mode: "sync" }).changed).toBe(true)
      expect(JSON.parse(localStorage.getItem("srr-saved@sP")!)).toEqual([])
      expect(JSON.parse(localStorage.getItem("srr-saved-ts@sP")!)).toEqual({ 7: 110 })
   })
})

// docs/MULTI-STORE-SPEC.md §4.4 — the additive mnt (mount table) + ms (per-peer
// substate). The HOME store rides the top-level fields unchanged; peers ride ms.
describe("multi-store mnt/ms (§4.4)", () => {
   beforeEach(() => localStorage.clear())

   it("exportProfile includes the mount table + peer substate, home stays top-level", () => {
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 9 })) // home (bare)
      localStorage.setItem(
         "srr-mounts",
         JSON.stringify([{ id: "sP", url: "https://peer/", label: "P", ord: 10, role: "peer", cred: false, ts: 5 }]),
      )
      localStorage.setItem("srr-seen@sP", JSON.stringify({ "feed:3": 4 }))
      localStorage.setItem("srr-saved@sP", JSON.stringify([2]))
      const blob = JSON.parse(exportProfile())
      expect(blob.seen).toEqual({ "feed:1": 9 }) // home top-level, unchanged
      expect(blob.mnt.some((m: { id: string }) => m.id === "sP")).toBe(true)
      expect(blob.ms.sP.seen).toEqual({ "feed:3": 4 })
      expect(blob.ms.sP.saved).toEqual([2])
   })

   it("importProfile merges an incoming peer mount + its substate", () => {
      const incoming = JSON.stringify({
         v: 2,
         ts: 0,
         seen: {},
         saved: [],
         mnt: [{ id: "sP", url: "https://peer/", label: "Peer", ord: 10, role: "peer", cred: false, ts: 9 }],
         ms: { sP: { ts: 100, seen: { "feed:3": 8 }, st: {}, saved: [7] } },
      })
      const r = importProfile(incoming, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(true)
      expect(r.mountsChanged).toBe(true) // app.ts re-adopts the table on this
      const mounts = JSON.parse(localStorage.getItem("srr-mounts")!)
      expect(mounts.some((m: { id: string }) => m.id === "sP")).toBe(true)
      expect(JSON.parse(localStorage.getItem("srr-seen@sP")!)).toEqual({ "feed:3": 8 })
      expect(JSON.parse(localStorage.getItem("srr-saved@sP")!)).toEqual([7])
   })

   it("reports mountsChanged when ONLY the mnt table moved (drives the runtime re-adopt)", () => {
      // A pull that adds a peer to the mount table with no home seen/saved change
      // must still report mountsChanged, so app.ts's refreshAfterMerge re-adopts
      // it into data.ts (boots the new root, SW-routes it, repaints the picker)
      // instead of leaving it dormant until a full page reload — FIX 2.
      const incoming = JSON.stringify({
         v: 2,
         ts: 0,
         seen: {},
         saved: [],
         mnt: [{ id: "sP", url: "https://peer/", label: "Peer", ord: 10, role: "peer", cred: false, ts: 9 }],
      })
      const r = importProfile(incoming, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.mountsChanged).toBe(true)
      expect(r.changed).toBe(true) // folded in, so refreshAfterMerge still fires
   })

   it("an identical mnt round-trip reports changed:false (no spurious re-anchor)", () => {
      // The device already knows exactly this mount; pulling its own blob back
      // must NOT report a change — the bug that re-anchored the list every cycle.
      localStorage.setItem(
         "srr-mounts",
         JSON.stringify([{ id: "sP", url: "https://peer/", label: "P", ord: 10, role: "peer", cred: false, ts: 9 }]),
      )
      // exportProfile now emits the current mnt (incl. the synthesized home).
      const blob = exportProfile()
      const r = importProfile(blob, { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(false)
      expect(r.mountsChanged).toBe(false) // no re-adopt on an unchanged table
   })

   it("a home-only device (default single-store) reports changed:false on its own blob", () => {
      const r = importProfile(exportProfile(), { prefs: false, mode: "sync" })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(false)
      expect(r.mountsChanged).toBe(false)
   })

   it("a peer substate change does NOT stamp the home ts", () => {
      touchProfile(500) // home ts
      const incoming = JSON.stringify({
         v: 2,
         ts: 0,
         seen: {},
         saved: [],
         mnt: [{ id: "sP", url: "https://peer/", label: "P", ord: 10, role: "peer", cred: false, ts: 9 }],
         ms: { sP: { ts: 100, seen: { "feed:3": 8 }, st: {}, saved: [] } },
      })
      importProfile(incoming, { prefs: false, mode: "sync" })
      expect(profileTs()).toBe(500) // untouched — the peer change is on @sP's ts
   })
})
