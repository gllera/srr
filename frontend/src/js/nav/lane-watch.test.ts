import { beforeEach, describe, expect, it, vi } from "vitest"

const data = vi.hoisted(() => ({
   db: { total_art: 100000, feeds: {} as Record<number, IFeed> } as unknown as IDB,
   rules: {} as Record<string, number>,
   covered: 0,
   feedTitle: vi.fn(() => "x"),
   // Region 0 is feed 1's, region 1 feed 2's.
   getFeedId: vi.fn(async (chron: number) => (chron < 50000 ? 1 : 2)),
   watchRules: vi.fn(() => data.rules),
   watchCovered: vi.fn(() => data.covered),
   loadWatchPlane: vi.fn(),
   activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
}))
vi.mock("../data", () => data)

import { emptyPlane, parseWatchPlane, type WatchPlane } from "../watch-plane"
import { b64, bytesOf } from "../watch-plane.testfixtures"
import { WatchLane } from "./lane-watch"

const WPS = 50000

// A region with the given offsets set per rule, encoded the writer's way and
// decoded through the real parser. Full-width (n = WPS) unless `n` is given —
// a region still the tail when fetched publishes a PARTIAL n, exactly what
// refreshed() must tell apart from an already-finalized region.
function plane(p: number, rules: Record<string, number[]>, n = WPS): WatchPlane {
   const bits: Record<string, string> = {}
   for (const [rule, set] of Object.entries(rules)) bits[rule] = b64(bytesOf(n, set))
   return parseWatchPlane({ v: 1, base: p * WPS, n, bits }, p * WPS, WPS)
}

let planes: Map<number, WatchPlane>
// The positions loaded, in order (the second argument is the lane's pinned store,
// undefined for an active-store lane).
const loaded = () => data.loadWatchPlane.mock.calls.map((c) => c[0] as number)
const lane = (rule = "hot") => new WatchLane([`w:${rule}`], rule)

beforeEach(() => {
   vi.clearAllMocks()
   data.db.feeds = {
      1: { id: 1, title: "A", url: "u", total_art: 1, add_idx: 0 } as IFeed,
      // Feed 2's articles below chron 50010 have EXPIRED.
      2: { id: 2, title: "B", url: "u", total_art: 1, add_idx: 50010 } as IFeed,
   }
   // hot starts at 15 (chron 10 predates it); late starts inside region 1.
   data.rules = { hot: 15, cold: 0, late: 50020 }
   data.covered = 50040
   planes = new Map([
      [0, plane(0, { hot: [10, 20, 49999], late: [100] })],
      [1, plane(1, { hot: [5, 30], cold: [12], late: [25] })],
   ])
   data.loadWatchPlane.mockImplementation(async (p: number) => planes.get(p) ?? emptyPlane(p * WPS, WPS))
})

describe("WatchLane — shape", () => {
   it("is a feed-agnostic, chron-ordered peek lane with no dividers", async () => {
      const l = lane()
      expect([l.kind, l.key, l.rule, l.peek, l.dividers, l.chronOrdered]).toEqual([
         "watch",
         "w:hot",
         "hot",
         true,
         false,
         true,
      ])
      expect(l.members.size).toBe(0)
      expect([l.entryAnchor(), await l.anchor()]).toEqual([-1, -1])
   })
})

describe("WatchLane — walk", () => {
   it("steps up through set bits, across regions, skipping expired articles and stopping at wc", async () => {
      const l = lane()
      expect(await l.oldest()).toBe(20) // 10 is below the rule's floor
      expect(await l.newer(20)).toBe(49999)
      expect(await l.newer(49999)).toBe(50030) // 50005 is set but expired
      expect(await l.newer(50030)).toBe(-1)
      expect(await l.atOrAbove(50031)).toBe(-1)
   })

   it("steps down the same way and never below wf", async () => {
      const l = lane()
      expect(await l.newest()).toBe(50030)
      expect(await l.older(50030)).toBe(49999)
      expect(await l.older(49999)).toBe(20)
      expect(await l.older(20)).toBe(-1)
   })

   it("skips a region with no plane for the rule whole", async () => {
      expect([await lane("cold").oldest(), await lane("cold").newest()]).toEqual([50012, 50012])
   })

   it("honours a floor that sits inside a later region", async () => {
      const l = lane("late")
      expect(await l.oldest()).toBe(50025) // region 0's bit 100 predates the rule
      expect(await l.older(50025)).toBe(-1)
      // The floor excludes region 0 entirely — the walk must never even fetch
      // it to discover that, not merely skip past its (irrelevant) bit 100.
      expect(loaded()).not.toContain(0)
   })

   it("walks nothing when nothing is covered, and loads nothing to prepare", async () => {
      data.covered = 0
      const l = lane()
      await l.prepare()
      expect(data.loadWatchPlane).not.toHaveBeenCalled()
      expect([await l.oldest(), await l.newest(), await l.ahead(-1)]).toEqual([-1, -1, 0])
   })
})

describe("WatchLane — matches, counts, entry, refresh", () => {
   it("matches a set, covered, unexpired bit — and only once its region is resident", async () => {
      const l = lane()
      expect(l.matches(2, 50030)).toBe(false) // nothing loaded yet
      await l.prepare() // the region holding wc-1
      expect(loaded()).toContain(1)
      expect(l.matches(2, 50030)).toBe(true)
      expect(l.matches(2, 50005)).toBe(false) // expired
      expect(l.matches(2, 50035)).toBe(false) // bit not set
      expect(l.matches(1, 20)).toBe(false) // region 0 not resident
      await l.atOrAbove(0)
      expect(l.matches(1, 20)).toBe(true)
      expect(l.matches(1, 10)).toBe(false) // below the floor
   })

   it("counts set bits inside coverage strictly after the floor", async () => {
      const l = lane()
      expect(await l.ahead(-1)).toBe(4) // 20, 49999, 50005, 50030 — expiry is not subtracted
      expect(await l.ahead(20)).toBe(2) // 49999, 50030 — 50005 is expired
      expect(await l.ahead(50030)).toBe(0)
   })

   it("the badge (floor -1) keeps the spec's count; a cursor-relative count drops the expired hits", async () => {
      const l = lane()
      expect(await l.ahead(-1)).toBe(4) // 20, 49999, 50005, 50030
      expect(await l.ahead(50000)).toBe(1) // only 50030 is reachable from 50000
   })

   it("covers nothing once the store stops listing its rule", async () => {
      const l = lane()
      expect(await l.newest()).toBe(50030)
      data.rules = { cold: 0 } // `srr watch rm hot`, adopted by a refresh
      expect(await l.newest()).toBe(-1)
      expect(await l.oldest()).toBe(-1)
      expect(await l.ahead(-1)).toBe(0)
      await l.ensureRegion(20)
      expect(l.matches(1, 20)).toBe(false)
   })

   it("a region load that straddles a refresh does not overwrite the refreshed region", async () => {
      const l = lane()
      let release!: (p: WatchPlane) => void
      data.loadWatchPlane.mockImplementationOnce(() => new Promise<WatchPlane>((r) => (release = r)))
      const stale = l.newest() // a region-1 load in flight against the old snapshot
      planes.set(1, plane(1, { hot: [5, 30, 35] }))
      await l.refreshed() // installs the fresh region 1
      release(plane(1, { hot: [5, 30] }, 20)) // the old, partial copy lands last
      await stale
      expect(l.matches(2, 50035)).toBe(true)
   })

   it("a straddling load of a region its snapshot covered in full is still installed — that region is final", async () => {
      const l = lane() // covered = 50040: region 0 is covered end to end
      let release!: (p: WatchPlane) => void
      data.loadWatchPlane.mockImplementationOnce(() => new Promise<WatchPlane>((r) => (release = r)))
      const fault = l.ensureRegion(20) // listAnchor's fault of region 0, in flight
      await l.refreshed() // region 0 is not resident, so the refresh reloads only the tail
      expect(loaded()).toEqual([0, 1])
      release(planes.get(0)!) // the finalized region lands after the refresh
      await fault
      expect(l.matches(1, 20)).toBe(true)
   })

   it("a refresh that expires more of a feed skips the newly expired hits in the walk and the pill", async () => {
      const l = lane()
      expect(await l.newest()).toBe(50030)
      data.db.feeds[2].add_idx = 50031 // the adopted snapshot expired feed B up to 50030
      await l.refreshed()
      expect(await l.newest()).toBe(49999) // 50030 and 50005 are both expired now
      expect(await l.newer(49999)).toBe(-1)
      expect(await l.ahead(20)).toBe(1) // 49999 alone is reachable from 20
   })

   it("an unexpired chron needs no idx lookup", async () => {
      data.db.feeds = { 1: { id: 1, title: "A", url: "u", total_art: 1, add_idx: 0 } as IFeed }
      const l = lane()
      expect(await l.newest()).toBe(50030)
      expect(data.getFeedId).not.toHaveBeenCalled()
   })

   it("uses each region's cached popcount when the whole region is inside the range", async () => {
      data.rules = { hot: 0 }
      data.covered = 100000
      expect(await lane().ahead(-1)).toBe(5)
   })

   it("lands a switch on the newest hit", async () => {
      expect(await lane().entry()).toEqual({ land: 50030 })
   })

   it("a refresh drops only the tail region, keeping a finalized resident region", async () => {
      const l = lane()
      await l.atOrAbove(0) // faults in region 0 — strictly below the tail (region 1)
      await l.prepare() // faults in region 1, the tail
      expect(l.matches(1, 20)).toBe(true)
      data.loadWatchPlane.mockClear()

      await l.refreshed()

      // The tail alone is re-fetched — region 0 is immutable (docs/MANIFEST-SPEC.md
      // §4.8: compact leaves the watch series untouched) and never re-fetched.
      expect(data.loadWatchPlane).toHaveBeenCalledTimes(1)
      expect(loaded()).toContain(1)
      expect(l.matches(1, 20)).toBe(true) // region 0 answers correctly with no refetch
      expect(l.matches(2, 50030)).toBe(true) // the reloaded tail still answers too
   })

   it("reloads a region loaded while coverage had not reached its end, whatever n its plane claims", async () => {
      const l = lane()
      await l.prepare() // loads region 1 while covered = 50040 — its n is the snapshot's, not proof of finality
      expect(l.matches(2, 50030)).toBe(true)
      data.loadWatchPlane.mockClear()

      data.covered = 100050 // a background sync grows the store, pushing the tail into region 2
      planes.set(1, plane(1, { hot: [5, 30, 60] })) // …and finished describing region 1
      await l.refreshed()

      expect(loaded()).toContain(1)
      expect(loaded()).toContain(2)
      expect(l.matches(2, 50060)).toBe(true) // the hit coverage reached after the first load
   })

   it("a straddling load of a region its snapshot had not covered is dropped, and the next fault sees the fresh plane", async () => {
      data.covered = 30 // SyncWatch lagging: region 0 holds 50k articles, 30 covered
      planes.delete(0) // …and the manifest lists no object there: an all-zero plane with the snapshot's full n
      const l = lane()
      let release!: (p: WatchPlane) => void
      data.loadWatchPlane.mockImplementationOnce(() => new Promise<WatchPlane>((r) => (release = r)))
      const fault = l.ensureRegion(20)
      data.covered = 50040 // the catch-up sync published region 0
      planes.set(0, plane(0, { hot: [20] }))
      await l.refreshed()
      release(emptyPlane(0, WPS)) // the old snapshot's all-zero plane lands last
      await fault
      await l.ensureRegion(20)
      expect(l.matches(1, 20)).toBe(true)
   })

   it("a resident region its snapshot had not covered is reloaded by a refresh, though it sits below the tail", async () => {
      data.covered = 30
      planes.delete(0)
      const l = lane()
      await l.ensureRegion(20)
      expect(l.matches(1, 20)).toBe(false) // nothing there yet
      data.covered = 50040
      planes.set(0, plane(0, { hot: [20] }))
      await l.refreshed()
      expect(l.matches(1, 20)).toBe(true) // refreshed() reloaded it itself
   })

   it("reloads a region loaded while it WAS the tail, even once the tail has moved two positions past it", async () => {
      const l = lane()
      // Region 1 is faulted in while it IS the tail (covered = 50040), so the
      // writer's doc — and therefore this plane — is necessarily PARTIAL: it only
      // covers the 40 chrons that existed so far, not the full 50,000-wide region.
      planes.set(1, plane(1, { hot: [] }, 40))
      await l.prepare()
      expect(loaded()).toContain(1)
      expect(l.matches(2, 50050)).toBe(false) // a hit here doesn't exist yet at fetch time

      // A background refresh grows the store far enough that the tail moves to
      // region 3 — two positions past region 1 — and region 1 has since finalized
      // with a hit at chron 50050, past what the stale partial plane ever covered.
      data.covered = 150040
      planes.set(1, plane(1, { hot: [50] }, WPS))
      data.loadWatchPlane.mockClear()

      await l.refreshed()

      // refreshed() must reload EVERY position it drops as stale, not only the new
      // tail (region 3) — region 1 was dropped here for being a former-tail whose
      // recorded `n` went stale, and matches() must answer for it immediately,
      // with no separate fault from ensureRegion()/a walk needed afterwards.
      expect(loaded()).toContain(1)
      expect(loaded()).toContain(3)
      expect(l.matches(2, 50050)).toBe(true) // now visible, reloaded by refreshed() itself
   })

   it("ensureRegion is a no-op below the floor or at/above wc", async () => {
      const l = lane() // floor 15, wc 50040
      await l.ensureRegion(10) // below the floor
      await l.ensureRegion(50040) // == wc, not yet published
      expect(data.loadWatchPlane).not.toHaveBeenCalled()
      expect(l.matches(1, 10)).toBe(false)
   })

   it("ensureRegion faults in an in-range, unresident region exactly once", async () => {
      const l = lane()
      expect(l.matches(1, 20)).toBe(false) // region 0 not resident yet
      await l.ensureRegion(20)
      expect(loaded()).toEqual([0])
      expect(l.matches(1, 20)).toBe(true)
   })

   it("ensureRegion is a no-op when the chron's region is already resident", async () => {
      const l = lane()
      await l.atOrAbove(0) // faults in region 0
      data.loadWatchPlane.mockClear()
      await l.ensureRegion(20) // same region, still resident
      expect(data.loadWatchPlane).not.toHaveBeenCalled()
   })
})
