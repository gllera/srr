import { describe, it, expect } from "vitest"
import { staleCacheNames, SW_CACHE_NAME } from "./sw-cache"

describe("staleCacheNames", () => {
   it("returns empty when no caches exist", () => {
      expect(staleCacheNames([])).toEqual([])
   })

   it("returns empty when only the current cache exists", () => {
      expect(staleCacheNames([SW_CACHE_NAME])).toEqual([])
   })

   it("returns previous srr-* caches", () => {
      expect(staleCacheNames(["srr-v0", SW_CACHE_NAME, "srr-old"])).toEqual(["srr-v0", "srr-old"])
   })

   it("never includes the current cache name", () => {
      const names = ["srr-v0", SW_CACHE_NAME, "srr-tmp"]
      expect(staleCacheNames(names)).not.toContain(SW_CACHE_NAME)
   })

   it("ignores caches that don't share the srr- prefix", () => {
      // A sibling app on the same origin must not have its caches deleted.
      expect(staleCacheNames(["other-app-v1", "third-party", "workbox-precache"])).toEqual([])
   })

   it("filters by prefix and current-name simultaneously", () => {
      expect(staleCacheNames(["srr-v0", "other", SW_CACHE_NAME, "srr-tmp"])).toEqual(["srr-v0", "srr-tmp"])
   })
})
