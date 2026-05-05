// LRU via Map insertion order: re-insert on access, evict oldest (first key)
export function makeLRU<T>(maxSize: number) {
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
