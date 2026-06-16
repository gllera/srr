import { describe, it, expect } from "vitest"
import { makeLRU, cachedPromise, lazySlot } from "./cache"

const tick = () => new Promise((r) => setTimeout(r))

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

   it("peek returns the value without affecting recency order", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      expect(lru.peek(1)).toBe("a")
      // After peek, key 1 should still be the oldest — adding a third entry evicts it.
      lru.put(3, "c")
      expect(lru.get(1)).toBeUndefined()
      expect(lru.get(2)).toBe("b")
      expect(lru.get(3)).toBe("c")
   })

   it("peek returns undefined for missing key", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      expect(lru.peek(99)).toBeUndefined()
   })

   it("drop removes an entry without affecting other entries", () => {
      const lru = makeLRU<string>(3)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.put(3, "c")
      lru.drop(2)
      expect(lru.get(2)).toBeUndefined()
      expect(lru.get(1)).toBe("a")
      expect(lru.get(3)).toBe("c")
   })

   it("drop on missing key is a no-op", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.drop(99)
      expect(lru.get(1)).toBe("a")
   })

   it("drop frees a slot so the next put does not evict survivors", () => {
      const lru = makeLRU<string>(2)
      lru.put(1, "a")
      lru.put(2, "b")
      lru.drop(1)
      lru.put(3, "c") // no eviction now — slot 1 is free
      expect(lru.get(2)).toBe("b")
      expect(lru.get(3)).toBe("c")
   })
})

describe("cachedPromise", () => {
   it("joins in-flight + resolved work: a hit returns the stored promise, make runs once", async () => {
      const lru = makeLRU<Promise<string>>(2)
      let calls = 0
      const make = () => {
         calls++
         return Promise.resolve("v")
      }
      const p1 = cachedPromise(lru, 3, make)
      const p2 = cachedPromise(lru, 3, make)
      expect(p2).toBe(p1) // same in-flight promise, not a second make()
      expect(calls).toBe(1)
      await expect(p1).resolves.toBe("v")
      // a resolved slot is NOT dropped — it keeps serving.
      const p3 = cachedPromise(lru, 3, make)
      expect(p3).toBe(p1)
      expect(calls).toBe(1)
   })

   it("drops a rejected slot so the next call retries instead of caching the failure", async () => {
      const lru = makeLRU<Promise<string>>(2)
      let calls = 0
      const make = () => {
         calls++
         return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok")
      }
      await expect(cachedPromise(lru, 7, make)).rejects.toThrow("boom")
      await tick() // let the identity-guarded drop run
      await expect(cachedPromise(lru, 7, make)).resolves.toBe("ok")
      expect(calls).toBe(2) // retried, not a cached rejection
   })

   it("identity-guards the drop: a rejection does NOT evict a replacement already in the slot", async () => {
      const lru = makeLRU<Promise<string>>(2)
      let rejectFirst!: (e: Error) => void
      const p1 = cachedPromise(lru, 5, () => new Promise<string>((_, rej) => (rejectFirst = rej)))
      // Eviction/replacement put a different promise in the slot before p1 settles.
      const replacement = Promise.resolve("new")
      lru.put(5, replacement)
      rejectFirst(new Error("stale"))
      await p1.catch(() => {})
      await tick()
      expect(lru.peek(5)).toBe(replacement) // p1's stale catch must not drop it
   })
})

describe("lazySlot", () => {
   it("memoizes a single promise across calls (make runs once)", async () => {
      let calls = 0
      const load = lazySlot(() => {
         calls++
         return Promise.resolve("x")
      })
      const a = load()
      expect(load()).toBe(a)
      expect(calls).toBe(1)
      await a
      expect(load()).toBe(a) // resolved slot keeps serving
      expect(calls).toBe(1)
   })

   it("retries after a rejection (the failed slot is dropped)", async () => {
      let calls = 0
      const load = lazySlot(() => {
         calls++
         return calls === 1 ? Promise.reject(new Error("e")) : Promise.resolve("ok")
      })
      await expect(load()).rejects.toThrow("e")
      await tick()
      await expect(load()).resolves.toBe("ok")
      expect(calls).toBe(2)
   })
})
