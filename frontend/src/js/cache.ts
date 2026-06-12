export interface LRU<T> {
   get(id: number): T | undefined
   peek(id: number): T | undefined
   put(id: number, val: T): void
   drop(id: number): void
}

// LRU via Map insertion order: re-insert on access, evict oldest (first key)
export function makeLRU<T>(maxSize: number): LRU<T> {
   const map = new Map<number, T>()
   return {
      get(id: number): T | undefined {
         const entry = map.get(id)
         if (entry !== undefined) {
            map.delete(id)
            map.set(id, entry)
         }
         return entry
      },
      peek(id: number): T | undefined {
         return map.get(id)
      },
      put(id: number, val: T) {
         map.delete(id)
         map.set(id, val)
         if (map.size > maxSize) map.delete(map.keys().next().value!)
      },
      drop(id: number) {
         map.delete(id)
      },
   }
}

// cachedPromise joins in-flight-or-resolved work per key: a hit returns the
// stored promise, a miss starts make() and stores it, and a rejection drops
// the slot — identity-guarded, since eviction may have replaced it — so the
// next call retries instead of caching the failure forever.
export function cachedPromise<T>(lru: LRU<Promise<T>>, key: number, make: () => Promise<T>): Promise<T> {
   const cached = lru.get(key)
   if (cached) return cached
   const promise = make()
   lru.put(key, promise)
   promise.catch(() => {
      if (lru.peek(key) === promise) lru.drop(key)
   })
   return promise
}

// lazySlot memoizes one promise with the same drop-on-rejection retry
// discipline: a single-slot cachedPromise (a 1-entry LRU with one constant
// key never evicts).
export function lazySlot<T>(make: () => Promise<T>): () => Promise<T> {
   const slot = makeLRU<Promise<T>>(1)
   return () => cachedPromise(slot, 0, make)
}
