/// <reference lib="webworker" />
const sw = self as unknown as ServiceWorkerGlobalScope

const cache = caches.open("srr-v1")
let valid = false

sw.addEventListener("install", () => sw.skipWaiting())
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()))

sw.addEventListener("fetch", (e) => {
   const filename = new URL(e.request.url).pathname.split("/").pop() || ""
   if (/^\d+\.gz$/.test(filename)) e.respondWith(cacheFirst(e.request))
   else if (filename === "db.gz") e.respondWith(getDB(e.request))
   else if (filename === "true.gz" || filename === "false.gz")
      e.respondWith(valid ? cacheFirst(e.request) : networkFirst(e.request))
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

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
   const va = new Uint8Array(a),
      vb = new Uint8Array(b)
   return va.length === vb.length && va.every((v, i) => v === vb[i])
}

async function getDB(req: Request): Promise<Response> {
   const cached = await (await cache).match(req)
   try {
      const res = await cachedFetch(req)
      if (!res.ok) throw new Error()
      valid = !!cached && buffersEqual(await res.clone().arrayBuffer(), await cached.arrayBuffer())
      return res
   } catch {
      if (cached) {
         valid = true
         return cached
      }
      throw new Error("offline and no cache")
   }
}
