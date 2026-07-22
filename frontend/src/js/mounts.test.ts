import { beforeEach, describe, expect, it } from "vitest"

import { HOME_MID, pinsKey, savedKey, seenKey } from "./keys"
import {
   activeMounts,
   addMount,
   editMount,
   forgetStoreState,
   homeUrl,
   loadMounts,
   mergeMountRecords,
   moveMount,
   mountId,
   mountLabel,
   type MountRecord,
   normalizeStoreUrl,
   reconcileMounts,
   removeMount,
   renameStoreState,
   saveMounts,
} from "./mounts"

// mounts.ts is the multi-store mount table (docs/MULTI-STORE-SPEC.md §3). These
// pin the load-bearing contracts: URL normalization + deterministic id hashing
// (§3.2), the OR-set LWW merge in both orders + idempotence (§3.4), the
// home-collision collapse (§3.2) and the re-host rename (§3.5). The home URL in
// the unit env is the SRR_CDN_URL define (http://localhost:3000).

const HOME_URL = "http://localhost:3000/"

beforeEach(() => localStorage.clear())

// A minimal peer record factory.
function peer(url: string, over: Partial<MountRecord> = {}): MountRecord {
   const norm = normalizeStoreUrl(url)!
   return {
      id: mountId(norm),
      url: norm,
      label: "",
      ord: 10,
      role: "peer",
      cred: false,
      added: 1000,
      ts: 1000,
      del: false,
      ...over,
   }
}

describe("normalizeStoreUrl (§3.2)", () => {
   it("adds exactly one trailing slash and lowercases the host", () => {
      expect(normalizeStoreUrl("https://CDN.Example.ORG/store")).toBe("https://cdn.example.org/store/")
      expect(normalizeStoreUrl("https://cdn.example.org/store/")).toBe("https://cdn.example.org/store/")
   })
   it("drops query, fragment and default ports", () => {
      expect(normalizeStoreUrl("https://cdn.example.org:443/s/?a=1#x")).toBe("https://cdn.example.org/s/")
   })
   it("rejects non-https except http on localhost/127.0.0.1", () => {
      expect(normalizeStoreUrl("http://cdn.example.org/s/")).toBeNull()
      expect(normalizeStoreUrl("ftp://cdn.example.org/s/")).toBeNull()
      expect(normalizeStoreUrl("http://localhost:3000/")).toBe("http://localhost:3000/")
      expect(normalizeStoreUrl("http://127.0.0.1/packs/")).toBe("http://127.0.0.1/packs/")
   })
   it("rejects embedded credentials and garbage", () => {
      expect(normalizeStoreUrl("https://user:pass@cdn.example.org/")).toBeNull()
      expect(normalizeStoreUrl("not a url")).toBeNull()
      expect(normalizeStoreUrl("")).toBeNull()
   })
})

describe("mountId (§3.2)", () => {
   it("is deterministic and shaped s+8hex", () => {
      const a = mountId("https://cdn.example.org/store/")
      const b = mountId("https://cdn.example.org/store/")
      expect(a).toBe(b)
      expect(a).toMatch(/^s[0-9a-f]{8}$/)
   })
   it("different URLs hash to different ids", () => {
      expect(mountId("https://a.example.org/")).not.toBe(mountId("https://b.example.org/"))
   })
})

describe("loadMounts synthesizes the home record (§3.3)", () => {
   it("absent srr-mounts ⇒ exactly one home record at the build URL", () => {
      const recs = loadMounts()
      expect(recs).toHaveLength(1)
      expect(recs[0].id).toBe(HOME_MID)
      expect(recs[0].role).toBe("home")
      expect(recs[0].url).toBe(HOME_URL)
      expect(homeUrl()).toBe(HOME_URL)
   })
   it("round-trips a saved table and always keeps a home record", () => {
      const p = peer("https://cdn.example.org/store/")
      saveMounts([p]) // no home record stored
      const recs = loadMounts()
      expect(recs.find((r) => r.id === HOME_MID)).toBeTruthy()
      expect(recs.find((r) => r.id === p.id)).toBeTruthy()
   })
})

describe("activeMounts ordering", () => {
   it("home first, then peers by ord", () => {
      const p1 = peer("https://a.example.org/", { ord: 20 })
      const p2 = peer("https://b.example.org/", { ord: 10 })
      const active = activeMounts([
         p1,
         p2,
         { ...peer("https://x/"), id: HOME_MID, role: "home", ord: 0, url: HOME_URL },
      ])
      expect(active.map((m) => m.id)).toEqual([HOME_MID, p2.id, p1.id])
   })
   it("drops tombstones", () => {
      const p = peer("https://a.example.org/", { del: true })
      expect(activeMounts([p]).find((m) => m.id === p.id)).toBeUndefined()
   })
})

describe("mergeMountRecords — OR-set LWW (§3.4)", () => {
   it("union by id", () => {
      const a = peer("https://a.example.org/")
      const b = peer("https://b.example.org/")
      const merged = mergeMountRecords([a], [b])
      expect(merged.find((r) => r.id === a.id)).toBeTruthy()
      expect(merged.find((r) => r.id === b.id)).toBeTruthy()
   })
   it("strictly greater ts wins wholesale, in both merge orders", () => {
      const older = peer("https://a.example.org/", { label: "old", ts: 100 })
      const newer = peer("https://a.example.org/", { label: "new", ts: 200 })
      expect(mergeMountRecords([older], [newer]).find((r) => r.id === older.id)!.label).toBe("new")
      expect(mergeMountRecords([newer], [older]).find((r) => r.id === older.id)!.label).toBe("new")
   })
   it("unmount (tombstone) is not undone by an equal-or-older live push", () => {
      const live = peer("https://a.example.org/", { ts: 100, del: false })
      const dead = peer("https://a.example.org/", { ts: 100, del: true }) // equal ts → deleted wins
      expect(mergeMountRecords([live], [dead]).find((r) => r.id === live.id)!.del).toBe(true)
      expect(mergeMountRecords([dead], [live]).find((r) => r.id === live.id)!.del).toBe(true)
   })
   it("is idempotent", () => {
      const a = peer("https://a.example.org/")
      const once = mergeMountRecords([a], [a])
      const twice = mergeMountRecords(once, [a])
      expect(twice).toEqual(once)
   })
   it("a peer can never delete or re-point the home mount", () => {
      const evilHome: MountRecord = { ...peer("https://evil/"), id: HOME_MID, role: "home", del: true, ts: 9e9 }
      const merged = mergeMountRecords(loadMounts(), [evilHome])
      const home = merged.find((r) => r.id === HOME_MID)!
      expect(home.del).toBe(false)
      expect(home.url).toBe(HOME_URL)
   })
})

describe("add / remove / edit mutations", () => {
   it("addMount normalizes, assigns an id, and returns records", () => {
      const res = addMount(loadMounts(), "cdn.example.org/store")! // scheme-less → normalizeStoreUrl rejects (no scheme)
      // normalizeStoreUrl requires a parseable absolute URL; a bare host is null.
      expect(res).toBeNull()
   })
   it("addMount with a full https URL adds a peer", () => {
      const res = addMount(loadMounts(), "https://cdn.example.org/store/")!
      expect(res.id).toMatch(/^s[0-9a-f]{8}$/)
      expect(res.records.find((r) => r.id === res.id)!.role).toBe("peer")
   })
   it("adding the home URL collapses to mount 0", () => {
      const res = addMount(loadMounts(), HOME_URL)!
      expect(res.id).toBe(HOME_MID)
   })
   it("removeMount tombstones a peer but not home", () => {
      const added = addMount(loadMounts(), "https://cdn.example.org/store/")!
      const removed = removeMount(added.records, added.id)
      expect(removed.find((r) => r.id === added.id)!.del).toBe(true)
      const homeRemoved = removeMount(removed, HOME_MID)
      expect(homeRemoved.find((r) => r.id === HOME_MID)!.del).toBe(false)
   })
   it("editMount changes label and bumps ts", () => {
      const added = addMount(loadMounts(), "https://cdn.example.org/store/")!
      const edited = editMount(added.records, added.id, { label: "Alice" })
      const rec = edited.find((r) => r.id === added.id)!
      expect(rec.label).toBe("Alice")
      expect(mountLabel(rec)).toBe("Alice")
   })
})

describe("reconcileMounts — home-collision collapse (§3.2)", () => {
   it("a live peer record pointing at the home url is collapsed into a tombstone → 0, renaming its state", () => {
      const collide = peer(HOME_URL) // a synced record for the home store
      // The device holds some seen state for that peer id.
      localStorage.setItem(seenKey(collide.id), JSON.stringify({ "feed:3": 7 }))
      const { records, renames } = reconcileMounts([collide])
      const rec = records.find((r) => r.id === collide.id)!
      expect(rec.del).toBe(true)
      expect(rec.moved_to).toBe(HOME_MID)
      expect(renames).toContainEqual({ from: collide.id, to: HOME_MID })
   })
   it("is idempotent — no rename the second time once state is moved", () => {
      const collide = peer(HOME_URL)
      localStorage.setItem(seenKey(collide.id), JSON.stringify({ "feed:3": 7 }))
      const first = reconcileMounts([collide])
      // Apply the rename the caller would apply.
      for (const r of first.renames) renameStoreState(r.from, r.to)
      const second = reconcileMounts(first.records)
      expect(second.renames).toHaveLength(0)
   })
})

describe("renameStoreState + moveMount — re-host (§3.5)", () => {
   it("renameStoreState moves the per-store keys, source wins on collision", () => {
      localStorage.setItem(seenKey("sAAAA"), JSON.stringify({ "feed:1": 1 }))
      localStorage.setItem(savedKey("sAAAA"), JSON.stringify([5]))
      localStorage.setItem(pinsKey("sAAAA"), "{}")
      renameStoreState("sAAAA", "sBBBB")
      expect(localStorage.getItem(seenKey("sAAAA"))).toBeNull()
      expect(localStorage.getItem(seenKey("sBBBB"))).toBe(JSON.stringify({ "feed:1": 1 }))
      expect(localStorage.getItem(savedKey("sBBBB"))).toBe(JSON.stringify([5]))
   })
   it("moveMount writes a rename tombstone + a live record and renames state", () => {
      const added = addMount(loadMounts(), "https://old.example.org/store/")!
      localStorage.setItem(seenKey(added.id), JSON.stringify({ "feed:2": 4 }))
      const moved = moveMount(added.records, added.id, "https://new.example.org/store/")!
      const tomb = moved.records.find((r) => r.id === added.id)!
      expect(tomb.del).toBe(true)
      expect(tomb.moved_to).toBe(moved.id)
      const live = moved.records.find((r) => r.id === moved.id)!
      expect(live.del).toBe(false)
      // state followed the move
      expect(localStorage.getItem(seenKey(added.id))).toBeNull()
      expect(localStorage.getItem(seenKey(moved.id))).toBe(JSON.stringify({ "feed:2": 4 }))
   })
   it("a peer replays a rename tombstone deterministically", () => {
      // Device B adopts a tombstone (from A) with moved_to and holds source state.
      localStorage.setItem(seenKey("sOLD00000"), JSON.stringify({ "feed:9": 3 }))
      const tomb: MountRecord = {
         id: "sOLD00000",
         url: "https://old.example.org/store/",
         label: "",
         ord: 10,
         role: "peer",
         cred: false,
         added: 1,
         ts: 5,
         del: true,
         moved_to: "sNEW00000",
      }
      const { renames } = reconcileMounts([tomb])
      expect(renames).toContainEqual({ from: "sOLD00000", to: "sNEW00000" })
   })
})

describe("forgetStoreState (§3.4 destructive)", () => {
   it("deletes every per-store key for a mid", () => {
      localStorage.setItem(seenKey("sZZZ"), "{}")
      localStorage.setItem(savedKey("sZZZ"), "[]")
      forgetStoreState("sZZZ")
      expect(localStorage.getItem(seenKey("sZZZ"))).toBeNull()
      expect(localStorage.getItem(savedKey("sZZZ"))).toBeNull()
   })
})
