import { describe, it, expect } from "vitest"
import { makeLRU } from "./cache"

describe("makeLRU", () => {
   it("returns undefined for missing key", () => {
      const lru = makeLRU<string>(3)
      expect(lru.get(1)).toBeUndefined()
   })

   it("stores and retrieves a value", () => {
      const lru = makeLRU<string>(3)
      lru.put(1, "a")
      expect(lru.get(1)).toBe("a")
   })

   it("updates value for existing key", () => {
      const lru = makeLRU<string>(3)
      lru.put(1, "a")
      lru.put(1, "b")
      expect(lru.get(1)).toBe("b")
   })

   it("evicts oldest entry when exceeding maxSize", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.put(3, "c") // evicts key 1
      expect(lru.get(1)).toBeUndefined()
      expect(lru.get(2)).toBe("b")
      expect(lru.get(3)).toBe("c")
   })

   it("get promotes entry and protects it from eviction", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.get(1) // promote key 1; key 2 is now oldest
      lru.put(3, "c") // evicts key 2
      expect(lru.get(1)).toBe("a")
      expect(lru.get(2)).toBeUndefined()
      expect(lru.get(3)).toBe("c")
   })

   it("works with maxSize=1", () => {
      const lru = makeLRU<string>(1)
      lru.put(1, "a")
      expect(lru.get(1)).toBe("a")
      lru.put(2, "b")
      expect(lru.get(1)).toBeUndefined()
      expect(lru.get(2)).toBe("b")
   })

   it("put with existing key does not grow beyond maxSize", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.put(1, "a2") // update key 1, should not evict key 2
      expect(lru.get(1)).toBe("a2")
      expect(lru.get(2)).toBe("b")
   })

   it("put promotes existing key to most recent", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.put(1, "a2") // re-insert key 1, key 2 is now oldest
      lru.put(3, "c") // should evict key 2, not key 1
      expect(lru.get(1)).toBe("a2")
      expect(lru.get(2)).toBeUndefined()
      expect(lru.get(3)).toBe("c")
   })

   it("handles key 0 correctly", () => {
      const lru = makeLRU<string>(3)
      lru.put(0, "zero")
      expect(lru.get(0)).toBe("zero")
   })

   it("stores and retrieves empty string value", () => {
      const lru = makeLRU<string>(3)
      lru.put(1, "")
      expect(lru.get(1)).toBe("")
   })

   it("get does not promote missing keys", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.get(99)
      lru.put(3, "c")
      expect(lru.get(1)).toBeUndefined()
      expect(lru.get(2)).toBe("b")
      expect(lru.get(3)).toBe("c")
   })
})
