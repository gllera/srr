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
})

describe("v2 blob / ts / adopt", () => {
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

   it("adopt replaces seen and saved wholesale and takes the blob's ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500, "feed:2": 90 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 2, 3]))
      touchProfile(100)
      const blob = JSON.stringify({
         v: 2,
         ts: 200,
         seen: { "feed:1": 10 },
         saved: [7],
         unreadOnly: false,
         imgProxy: "",
      })
      expect(importProfile(blob, { prefs: false, adopt: true }).ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 10 }) // feed:2 dropped — wholesale
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([7]) // un-saves propagate
      expect(profileTs()).toBe(200)
   })

   it("adopt never applies prefs (prefs stay carried-not-applied)", () => {
      localStorage.setItem(UNREAD_ONLY_KEY, "1")
      const blob = JSON.stringify({ v: 2, ts: 9, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob, { prefs: false, adopt: true })
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("1")
   })

   it("adopt with malformed seen still replaces wholesale (empty map) and takes ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      const blob = JSON.stringify({ v: 2, ts: 5, seen: "garbage", saved: [] })
      expect(importProfile(blob, { prefs: false, adopt: true }).ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({})
      expect(profileTs()).toBe(5)
   })

   it("adopt floors a fractional ts and clamps a negative ts to 0", () => {
      const blob = (ts: number) => JSON.stringify({ v: 2, ts, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob(200.9), { prefs: false, adopt: true })
      expect(profileTs()).toBe(200)
      importProfile(blob(-5), { prefs: false, adopt: true })
      expect(profileTs()).toBe(0)
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
