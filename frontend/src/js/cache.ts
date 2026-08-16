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

// The default in-flight cap for every pooled fetch loop. It is a property of the
// TRANSPORT — roughly the per-origin connection budget — not of any one caller,
// which is why it lives beside runPool rather than being re-declared next to each
// pool (it was three independent 6s, one of them a bare literal).
export const POOL_LIMIT = 6

// Run `items` through `worker` with at most `limit` in flight, pulling them in
// the given order — so the earliest items dispatch and resolve before later
// ones, regardless of transport (HTTP/2 would otherwise race them all at once).
// First failure rejects the whole pool and stops the other lanes from claiming
// further work; a worker that must not fail the pool catches its own errors.
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
   let next = 0
   let failed = false
   const run = async (): Promise<void> => {
      while (next < items.length && !failed) {
         const i = next++
         try {
            await worker(items[i])
         } catch (e) {
            // Flip the flag so the other lanes stop instead of running on as
            // orphans — writing to torn-down state and raising further unhandled
            // rejections after Promise.all has already settled.
            failed = true
            throw e
         }
      }
   }
   await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
}
