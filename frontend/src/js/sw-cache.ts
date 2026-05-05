// Bump on any breaking change to pack format or db.gz schema; sw.ts will
// sweep older srr-* caches on activate to force a clean re-fetch.
export const SW_CACHE_NAME = "srr-v1"
const SW_CACHE_PREFIX = "srr-"

// Prefix guard prevents nuking a sibling app's cache on the same origin.
export function staleCacheNames(names: readonly string[]): string[] {
   return names.filter((n) => n.startsWith(SW_CACHE_PREFIX) && n !== SW_CACHE_NAME)
}

// Silently no-ops if the caches API is unavailable (e.g., insecure context).
export async function evictFromCache(url: URL): Promise<void> {
   try {
      const c = await caches.open(SW_CACHE_NAME)
      await c.delete(url.href)
   } catch {
      // caches API unavailable
   }
}
