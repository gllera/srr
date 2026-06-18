export interface LRU<T, K = number> {
   get(id: K): T | undefined
   peek(id: K): T | undefined
   put(id: K, val: T): void
   drop(id: K): void
}

// LRU via Map insertion order: re-insert on access, evict oldest (first key).
// Keyed by number by default (pack ids); K widens it to e.g. string query keys.
export function makeLRU<T, K = number>(maxSize: number): LRU<T, K> {
   const map = new Map<K, T>()
   return {
      get(id: K): T | undefined {
         const entry = map.get(id)
         if (entry !== undefined) {
            map.delete(id)
            map.set(id, entry)
         }
         return entry
      },
      peek(id: K): T | undefined {
         return map.get(id)
      },
      put(id: K, val: T) {
         map.delete(id)
         map.set(id, val)
         if (map.size > maxSize) map.delete(map.keys().next().value!)
      },
      drop(id: K) {
         map.delete(id)
      },
   }
}

// cachedPromise joins in-flight-or-resolved work per key: a hit returns the
// stored promise, a miss starts make() and stores it, and a rejection drops
// the slot — identity-guarded, since eviction may have replaced it — so the
// next call retries instead of caching the failure forever.
export function cachedPromise<T, K = number>(lru: LRU<Promise<T>, K>, key: K, make: () => Promise<T>): Promise<T> {
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
