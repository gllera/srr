/// <reference lib="webworker" />
import {
   DATA_CACHE_PREFIX,
   DB_CACHE_NAME,
   dataCacheName,
   dbSnapshot,
   readVersion,
   staleDataCaches,
} from "./js/sw-cache"

const sw = self as unknown as ServiceWorkerGlobalScope

const dbCache = caches.open(DB_CACHE_NAME)
// dataCachePromise resolves once we know which "srr-v<N>" cache to use. Pack
// handlers await it so a concurrent pack fetch can't open a stale or
// default-named cache before we've learned the current version from db.gz.
// rejectDataCache surfaces Cache API failures from initFromExistingCaches so
// pack fetches fail fast with the underlying error instead of hanging.
let resolveDataCache!: (c: Cache) => void
let rejectDataCache!: (e: unknown) => void
let dataCachePromise: Promise<Cache> = new Promise((res, rej) => {
   resolveDataCache = res
   rejectDataCache = rej
})
let currentDataCacheName: string | null = null
let valid = false
// Tracks an in-flight db.gz check so latest-pack handlers wait for the validity
// flag to settle. Without this, a parallel true.gz/false.gz handler would read
// `valid = false` before getDB() has finished comparing against the cache.
let dbFlight: Promise<unknown> = initFromExistingCaches()

sw.addEventListener("install", () => sw.skipWaiting())
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()))

sw.addEventListener("fetch", (e) => {
   const filename = new URL(e.request.url).pathname.split("/").pop() || ""
   if (filename === "db.gz") {
      const p = getDB(e.request)
      dbFlight = p.catch(() => {})
      e.respondWith(p)
   } else if (/^\d+\.gz$/.test(filename)) {
      e.respondWith(dbFlight.then(() => cacheFirst(e.request)))
   } else if (filename === "true.gz" || filename === "false.gz") {
      e.respondWith(dbFlight.then(() => (valid ? cacheFirst(e.request) : networkFirst(e.request))))
   }
})

// "no-cache" forces a conditional request (If-None-Match) so the browser HTTP
// cache can't serve a stale db.gz/latest-pack from a CDN Cache-Control max-age.
// Freshness is managed at the SW layer via dbSnapshot comparison; HTTP cache
// would hide writer updates for up to its max-age, delaying new articles.
const revalidate: RequestInit = { cache: "no-cache" }

async function cachedFetch(req: Request, init?: RequestInit): Promise<Response> {
   const res = await fetch(init ? new Request(req, init) : req)
   if (res.ok) (await dataCachePromise).put(req, res.clone())
   return res
}

async function cacheFirst(req: Request): Promise<Response> {
   return (await (await dataCachePromise).match(req)) ?? cachedFetch(req)
}

async function networkFirst(req: Request): Promise<Response> {
   try {
      return await cachedFetch(req, revalidate)
   } catch {
      const cached = await (await dataCachePromise).match(req)
      if (cached) return cached
      throw new Error("offline and no cache")
   }
}

async function parseBody(res: Response): Promise<unknown> {
   try {
      return await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   } catch {
      return null
   }
}

// Pre-resolves dataCachePromise so pack handlers that fire before the db.gz
// round trip completes can still match against the right cache. Prefer the
// highest-versioned existing srr-v<N> cache (covers cases where a prior
// cleanup failed); fall back to srr-v0 so a fresh install can't deadlock a
// pack request that races ahead of db.gz. getDB calls switchDataCache once
// the live db.gz arrives, which rotates to the real version.
function setDataCache(name: string, c: Cache): void {
   currentDataCacheName = name
   resolveDataCache(c)
   dataCachePromise = Promise.resolve(c)
}

async function initFromExistingCaches(): Promise<void> {
   try {
      const names = await caches.keys()
      const existing = names
         .filter((n) => n.startsWith(DATA_CACHE_PREFIX))
         .sort((a, b) => Number(b.slice(DATA_CACHE_PREFIX.length)) - Number(a.slice(DATA_CACHE_PREFIX.length)))[0]
      const name = existing ?? dataCacheName(0)
      const c = await caches.open(name)
      // switchDataCache may have raced ahead while we were awaiting; only
      // resolve the initial promise if it hasn't already won, otherwise we'd
      // overwrite the authoritative version with this fallback.
      if (currentDataCacheName === null) setDataCache(name, c)
   } catch (e) {
      // Cache API is unavailable. Surface the error so pack handlers fail
      // fast instead of hanging — unless switchDataCache already resolved
      // dataCachePromise, in which case rejection would be misleading.
      if (currentDataCacheName === null) rejectDataCache(e)
   }
}

// Cleanup runs unconditionally so leftover srr-v* caches from a prior
// aborted rotation (e.g. browser killed mid-sweep) get reaped even when
// `currentDataCacheName` already matches the live version.
async function switchDataCache(version: number): Promise<void> {
   const name = dataCacheName(version)
   if (currentDataCacheName !== name) {
      setDataCache(name, await caches.open(name))
   }
   const names = await caches.keys()
   await Promise.all(staleDataCaches(names, name).map((n) => caches.delete(n)))
}

// "valid" means the cached true.gz/false.gz are still aligned with the latest
// db.gz. Latest packs only change when PutArticles runs (which advances total_art
// and flips data_tog), so compare those fields rather than raw gzipped bytes.
async function getDB(req: Request): Promise<Response> {
   const c = await dbCache
   const cached = await c.match(req)
   try {
      const res = await fetch(new Request(req, revalidate))
      if (!res.ok) throw new Error()
      const [next, prev] = await Promise.all([
         parseBody(res.clone()),
         cached ? parseBody(cached.clone()) : Promise.resolve(null),
      ])
      const nextSig = dbSnapshot(next)
      const prevSig = dbSnapshot(prev)
      valid = nextSig !== null && prevSig === nextSig
      // Skip the switch when parse failed: readVersion(null)=0 would force
      // srr-v0 and wipe the real data cache over a transient malformed
      // response. A cache-rotation failure also mustn't fall through to the
      // offline branch — we have a fresh response and the page should see it.
      // Cache write is also gated on a clean parse so a transient malformed
      // body (CDN glitch, truncated response) can't poison srr-db and force
      // the next SW boot to serve a body the page can't decode.
      if (next !== null) {
         c.put(req, res.clone()).catch(() => {})
         try {
            await switchDataCache(readVersion(next))
         } catch {}
      }
      return res
   } catch {
      if (cached) {
         valid = true
         const body = await parseBody(cached.clone())
         // Skip when parse fails: readVersion(null)=0 would force srr-v0 and
         // wipe the real srr-v<N> data cache that's still serving requests.
         // Cache-rotation failure must not prevent serving the cached body —
         // pack handlers might mismatch but the page still gets db.gz.
         if (body !== null) {
            try {
               await switchDataCache(readVersion(body))
            } catch {}
         }
         return cached
      }
      throw new Error("offline and no cache")
   }
}
