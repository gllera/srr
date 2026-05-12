// Two cache names so a version bump in db.gz only rotates the data cache,
// leaving the db.gz cache (which we always revalidate against the network)
// stable across version changes:
//   - DB_CACHE_NAME ("srr-db"): only ever holds db.gz
//   - dataCacheName(v) ("srr-v<N>"): everything else; rotates when version
//     changes so the SW abandons stale packs without per-entry eviction.
// Backend mirror: store.Cache.getDB wipes its local subdir when version in the
// remote db.gz disagrees with the cached db.gz (see backend/store/cache.go).
export const DB_CACHE_NAME = "srr-db"
export const DATA_CACHE_PREFIX = "srr-v"

export function dataCacheName(version: number | undefined): string {
   return `${DATA_CACHE_PREFIX}${version ?? 0}`
}

// Prefix guard prevents nuking a sibling app's cache on the same origin.
export function staleDataCaches(names: readonly string[], current: string): string[] {
   return names.filter((n) => n.startsWith(DATA_CACHE_PREFIX) && n !== current)
}

// Iterates every existing srr-v* cache so a page whose `db.version` predates a
// SW rotation still evicts the bad entry from the current data cache. Targeting
// only `dataCacheName(stale_version)` would no-op against a cache the SW just
// deleted, leaving the bad pack in `srr-v<new>` and trapping the user in a
// retry loop. The `has` guard inside the loop minimizes the recreate-on-open
// race with concurrent SW rotations.
export async function evictFromDataCache(url: URL): Promise<void> {
   try {
      const names = (await caches.keys()).filter((n) => n.startsWith(DATA_CACHE_PREFIX))
      await Promise.all(
         names.map(async (n) => {
            if (!(await caches.has(n))) return
            const c = await caches.open(n)
            await c.delete(url.href)
         }),
      )
   } catch {
      // caches API unavailable
   }
}

// Latest-pack alignment marker derived from db.gz: total_art + data_tog,
// the only fields the SW compares to decide whether cached latest packs
// (true.gz/false.gz) are still aligned with the latest db.gz.
export function dbSnapshot(body: unknown): string | null {
   if (!body || typeof body !== "object") return null
   const b = body as { total_art?: number; data_tog?: boolean }
   return `${b.total_art ?? 0}|${!!b.data_tog}`
}

export function readVersion(body: unknown): number {
   if (!body || typeof body !== "object") return 0
   const v = (body as { version?: unknown }).version
   return typeof v === "number" && Number.isFinite(v) ? v : 0
}
