import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dataCacheName, dbSnapshot, evictFromDataCache, readVersion, staleDataCaches } from "./sw-cache"

describe("dataCacheName", () => {
   it("formats with explicit version", () => {
      expect(dataCacheName(5)).toBe("srr-v5")
   })

   it("treats undefined as version 0", () => {
      expect(dataCacheName(undefined)).toBe("srr-v0")
   })
})

describe("staleDataCaches", () => {
   it("returns empty when no caches exist", () => {
      expect(staleDataCaches([], "srr-v1")).toEqual([])
   })

   it("returns empty when only the current cache exists", () => {
      expect(staleDataCaches(["srr-v1"], "srr-v1")).toEqual([])
   })

   it("returns previous srr-v* caches", () => {
      expect(staleDataCaches(["srr-v0", "srr-v1", "srr-v2"], "srr-v1")).toEqual(["srr-v0", "srr-v2"])
   })

   it("never includes the current cache name", () => {
      expect(staleDataCaches(["srr-v0", "srr-v1", "srr-v2"], "srr-v1")).not.toContain("srr-v1")
   })

   it("does not touch the srr-db cache or sibling apps", () => {
      // srr-db is owned by the SW too but must survive version bumps; sibling
      // apps on the same origin must be untouched as well.
      expect(staleDataCaches(["srr-db", "other-app-v1", "workbox-precache"], "srr-v1")).toEqual([])
   })

   it("filters by prefix and current-name simultaneously", () => {
      expect(staleDataCaches(["srr-v0", "other", "srr-v1", "srr-db"], "srr-v1")).toEqual(["srr-v0"])
   })
})

describe("dbSnapshot", () => {
   it("returns null for non-object inputs", () => {
      expect(dbSnapshot(null)).toBeNull()
      expect(dbSnapshot(undefined)).toBeNull()
      expect(dbSnapshot("garbage")).toBeNull()
      expect(dbSnapshot(42)).toBeNull()
   })

   it("defaults missing fields to 0 / false", () => {
      expect(dbSnapshot({})).toBe("0|false")
   })

   it("captures total_art and data_tog", () => {
      expect(dbSnapshot({ total_art: 100, data_tog: true })).toBe("100|true")
   })
})

describe("readVersion", () => {
   it("returns 0 for non-objects or missing field", () => {
      expect(readVersion(null)).toBe(0)
      expect(readVersion(undefined)).toBe(0)
      expect(readVersion("garbage")).toBe(0)
      expect(readVersion({})).toBe(0)
   })

   it("returns the numeric version field", () => {
      expect(readVersion({ version: 7 })).toBe(7)
   })

   it("ignores non-numeric version values", () => {
      expect(readVersion({ version: "5" })).toBe(0)
      expect(readVersion({ version: NaN })).toBe(0)
   })
})

describe("evictFromDataCache", () => {
   type FakeCache = { delete: ReturnType<typeof vi.fn> }
   let caches: Record<string, FakeCache>
   let originalCaches: typeof globalThis.caches | undefined

   beforeEach(() => {
      caches = {
         "srr-v3": { delete: vi.fn().mockResolvedValue(true) },
         "srr-v4": { delete: vi.fn().mockResolvedValue(true) },
         "srr-db": { delete: vi.fn().mockResolvedValue(true) },
         "other-app": { delete: vi.fn().mockResolvedValue(true) },
      }
      originalCaches = globalThis.caches
      ;(globalThis as { caches: unknown }).caches = {
         keys: () => Promise.resolve(Object.keys(caches)),
         has: (n: string) => Promise.resolve(n in caches),
         open: (n: string) => Promise.resolve(caches[n] ?? { delete: vi.fn().mockResolvedValue(false) }),
         delete: () => Promise.resolve(true),
         match: () => Promise.resolve(undefined),
      }
   })

   afterEach(() => {
      if (originalCaches === undefined) {
         delete (globalThis as { caches?: unknown }).caches
      } else {
         ;(globalThis as { caches: unknown }).caches = originalCaches
      }
   })

   it("deletes the URL from every existing srr-v* cache, not just one", async () => {
      // Regression: signature used to be (version, url) and would no-op when
      // the page's db.version pointed at a cache the SW had already rotated
      // away from. Iterating all srr-v* covers both the old and the new cache.
      await evictFromDataCache(new URL("https://example.com/data/3.gz"))
      expect(caches["srr-v3"].delete).toHaveBeenCalledWith("https://example.com/data/3.gz")
      expect(caches["srr-v4"].delete).toHaveBeenCalledWith("https://example.com/data/3.gz")
   })

   it("skips srr-db and unrelated caches", async () => {
      await evictFromDataCache(new URL("https://example.com/data/3.gz"))
      expect(caches["srr-db"].delete).not.toHaveBeenCalled()
      expect(caches["other-app"].delete).not.toHaveBeenCalled()
   })

   it("silently no-ops when the caches API is unavailable", async () => {
      delete (globalThis as { caches?: unknown }).caches
      await expect(evictFromDataCache(new URL("https://example.com/data/3.gz"))).resolves.toBeUndefined()
   })
})
