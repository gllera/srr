/// <reference lib="webworker" />
const sw = self as unknown as ServiceWorkerGlobalScope

const cache = caches.open("srr-v1")

sw.addEventListener("install", () => sw.skipWaiting())
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()))

sw.addEventListener("fetch", (e) => {
   const filename = new URL(e.request.url).pathname.split("/").pop() || ""
   if (/^\d+\.gz$/.test(filename)) e.respondWith(cacheFirst(e.request))
   else if (filename === "db.gz") e.respondWith(staleWhileRevalidate(e.request))
   else if (filename === "true.gz" || filename === "false.gz") e.respondWith(networkFirst(e.request))
})

async function cachedFetch(req: Request): Promise<Response> {
   const res = await fetch(req)
   if (res.ok) (await cache).put(req, res.clone())
   return res
}

async function cacheFirst(req: Request): Promise<Response> {
   const c = await cache
   return (await c.match(req)) ?? cachedFetch(req)
}

async function networkFirst(req: Request): Promise<Response> {
   try {
      return await cachedFetch(req)
   } catch {
      const c = await cache
      const cached = await c.match(req)
      if (cached) return cached
      throw new Error("offline and no cache")
   }
}

async function staleWhileRevalidate(req: Request): Promise<Response> {
   const c = await cache
   const cached = await c.match(req)
   const net = cachedFetch(req)
   if (cached) {
      net.catch(() => {})
      return cached
   }
   return net
}
