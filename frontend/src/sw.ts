/// <reference lib="webworker" />
import { staleCacheNames, SW_CACHE_NAME } from "./js/sw-cache"

const sw = self as unknown as ServiceWorkerGlobalScope

const cache = caches.open(SW_CACHE_NAME)
let valid = false
// Tracks an in-flight db.gz check so latest-pack handlers wait for the validity
// flag to settle. Without this, a parallel true.gz/false.gz handler would read
// `valid = false` before getDB() has finished comparing against the cache.
let dbFlight: Promise<unknown> = Promise.resolve()

sw.addEventListener("install", () => sw.skipWaiting())
sw.addEventListener("activate", (e) => e.waitUntil(onActivate()))

async function onActivate(): Promise<void> {
   const names = await caches.keys()
   await Promise.all([...staleCacheNames(names).map((n) => caches.delete(n)), sw.clients.claim()])
}

sw.addEventListener("fetch", (e) => {
   const filename = new URL(e.request.url).pathname.split("/").pop() || ""
   if (/^\d+\.gz$/.test(filename)) e.respondWith(cacheFirst(e.request))
   else if (filename === "db.gz") {
      const p = getDB(e.request)
      dbFlight = p.catch(() => {})
      e.respondWith(p)
   } else if (filename === "true.gz" || filename === "false.gz") {
      e.respondWith(dbFlight.then(() => (valid ? cacheFirst(e.request) : networkFirst(e.request))))
   }
})

async function cachedFetch(req: Request): Promise<Response> {
   const res = await fetch(req)
   if (res.ok) (await cache).put(req, res.clone())
   return res
}

async function cacheFirst(req: Request): Promise<Response> {
   return (await (await cache).match(req)) ?? cachedFetch(req)
}

async function networkFirst(req: Request): Promise<Response> {
   try {
      return await cachedFetch(req)
   } catch {
      const cached = await (await cache).match(req)
      if (cached) return cached
      throw new Error("offline and no cache")
   }
}

// "valid" means the cached true.gz/false.gz are still aligned with the latest
// db.gz. Latest packs only change when PutArticles runs (which advances total_art
// and flips data_tog), so compare those fields rather than raw gzipped bytes.
async function dbSig(res: Response): Promise<string | null> {
   try {
      const body = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
      return `${body.total_art ?? 0}|${!!body.data_tog}`
   } catch {
      return null
   }
}

async function getDB(req: Request): Promise<Response> {
   const cached = await (await cache).match(req)
   try {
      const res = await cachedFetch(req)
      if (!res.ok) throw new Error()
      if (cached) {
         const [a, b] = await Promise.all([dbSig(res.clone()), dbSig(cached.clone())])
         valid = a !== null && a === b
      } else {
         valid = false
      }
      return res
   } catch {
      if (cached) {
         valid = true
         return cached
      }
      throw new Error("offline and no cache")
   }
}
