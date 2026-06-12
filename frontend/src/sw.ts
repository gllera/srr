/// <reference lib="webworker" />
// Service worker: offline-capable cache for the SRR reader.
//
// Three buckets, split by how mutable each resource is:
//
//   assets (srr-assets-vN)  content-hash `assets/<2hex>/<16hex><ext>` — immutable
//                           (the hash is the sha256 of the bytes). Cache-first,
//                           permanent; a hit can never be stale.
//   packs  (srr-packs-vN)   the CDN store under `packs/`:
//      finalized `idx/<n>.gz` / `data/<n>.gz` (numeric)  → immutable, cache-first.
//      `db.gz`, `idx|data/{true,false}.gz`               → mutable, network-first
//                                                           (offline → last cached).
//   shell  (srr-shell-vN)   the app itself: the `/…/` navigation + content-hashed
//                           JS/CSS. Runtime-cached (no build-time manifest — keeps
//                           this SW hand-written and zero-dep). Hashed JS/CSS are
//                           immutable → cache-first; the navigation/index.html is the
//                           version pointer → network-first so a fresh deploy wins
//                           online and the cached shell serves offline.
//   meta   (srr-meta-vN)    one synthetic entry: the last-seen db.gz `gen` (store
//                           generation). When a fresh db.gz carries a different gen,
//                           the packs bucket is purged (see checkGen) — that's how an
//                           in-place store rebuild invalidates cache-first packs
//                           without a frontend redeploy.
//
// Offline correctness rests on one invariant: db.gz and the latest pack
// (true/false.gz) must agree on data_tog/next_pid. Network-first fetches the freshest
// of BOTH when online and the last-cached of BOTH when offline — and they were cached
// together on the last online visit, so the offline pair is mutually consistent. (A
// mid-load network blip can still pair a fresh db.gz with a stale pack, but that race
// already exists without the SW — a fetch-cron rewrite vs an open tab.)
//
// Best-effort throughout: every miss/failure falls through to the network, so a
// browser without SW support (or an insecure-context LAN deploy) just runs straight
// off the network, exactly as before. Self-contained: no SRR_CDN_URL, so it works
// under any cdn-url prefix.
const sw = self as unknown as ServiceWorkerGlobalScope

// Bump a suffix to invalidate that bucket on the next activate.
const ASSETS = "srr-assets-v1"
// vN now only marks format changes of the cache itself. Store rebuilds are
// handled by the db.gz `gen` field (checkGen below): an in-place wipe+rebuild
// reuses finalized pack ids (data/N.gz) with new bytes — cache-first would
// serve the stale cached packs — so the operator bumps `srr gen --bump` and
// every client purges PACKS on its next db.gz fetch, no redeploy needed.
// (History: v2→v3 was the 2026-06-08 AVIF→WebP rebuild, hand-bumped before
// gen existed; cron only appends, so prod never rebuilds.)
const PACKS = "srr-packs-v3"
const SHELL = "srr-shell-v1"
// Tiny bucket holding the last-seen store generation (a Cache is the only
// storage a SW shares across restarts without IndexedDB).
const META = "srr-meta-v1"
const KEEP = new Set([ASSETS, PACKS, SHELL, META])

// Deployment root, e.g. "/srr/" or "/srr.tmp/" (or "/" in e2e) — so we never touch
// a sibling deployment sharing the origin.
const SCOPE = new URL(sw.registration.scope).pathname

// Matched anywhere in the path so they hold whatever prefix the cdn-url adds.
const RE_ASSET = /\/assets\/[0-9a-f]{2}\/[0-9a-f]{16}\.\w+$/i
const RE_PACK_FINAL = /\/packs\/(?:idx|data)\/\d+\.gz$/i
const RE_PACK_LATEST = /\/packs\/(?:db\.gz|(?:idx|data)\/(?:true|false)\.gz)$/i
const RE_DB = /\/packs\/db\.gz$/i // subset of RE_PACK_LATEST — test first
const RE_SHELL_HASHED = /\.[0-9a-f]{8,}\.(?:js|css)$/i // Parcel content-hashed bundles

sw.addEventListener("install", () => {
   // A fresh worker is useful immediately; nothing to pre-cache.
   sw.skipWaiting()
})

sw.addEventListener("activate", (event) => {
   // Drop caches left by older versions, then control open clients right away.
   event.waitUntil(
      caches
         .keys()
         .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
         .then(() => sw.clients.claim()),
   )
})

// Serve the cached copy if present, else fetch and cache a genuine success.
// `revalidate` (finalized packs): a miss must bypass the HTTP cache underneath —
// the page fetches packs with force-cache and they're served immutable/1y, so a
// stale post-rebuild copy can outlive checkGen's purge of this bucket; no-cache
// forces origin revalidation exactly once, then this cache is the hit path
// again. Content-hashed assets/bundles can't go stale → they keep re-filling
// from the HTTP cache for free.
async function cacheFirst(req: Request, name: string, revalidate = false): Promise<Response> {
   const cache = await caches.open(name)
   const hit = await cache.match(req)
   if (hit) return hit
   const res = await fetch(revalidate ? new Request(req, { cache: "no-cache" }) : req)
   if (res.ok) cache.put(req, res.clone())
   return res
}

// Prefer the network (refreshing the cache); fall back to cache only when the
// network is unreachable. A 4xx/5xx is a real answer, not an outage — returned
// as-is, never masked by a stale hit.
async function networkFirst(req: Request, name: string): Promise<Response> {
   const cache = await caches.open(name)
   try {
      const res = await fetch(req)
      if (res.ok) cache.put(req, res.clone())
      return res
   } catch (err) {
      const hit = await cache.match(req)
      if (hit) return hit
      throw err
   }
}

// The last-seen gen persists as a synthetic entry in META (the URL is never
// fetched — it's just a cache key).
const GEN_KEY = "https://srr.invalid/gen"

async function readStoredGen(): Promise<number> {
   const cache = await caches.open(META)
   const hit = await cache.match(GEN_KEY)
   return hit ? Number(await hit.text()) || 0 : 0
}

// Best-effort store-rebuild detection: gunzip the db.gz body (raw gzip bytes,
// no Content-Encoding — same manual decompression as data.ts), read `gen`
// (absent == 0), and when it differs from the last-seen value purge PACKS so
// the next finalized-pack fetch re-pulls fresh bytes. Inequality, not
// greater-than: a wipe+rebuild may reset gen. ASSETS stays (content-hashed —
// a hit can never be stale); SHELL is unrelated. Any failure is swallowed:
// a malformed db.gz must still be served.
async function checkGen(dbRes: Response): Promise<void> {
   try {
      const body = dbRes.clone().body!.pipeThrough(new DecompressionStream("gzip"))
      const db = (await new Response(body).json()) as { gen?: number }
      const gen = db.gen ?? 0
      if (gen === (await readStoredGen())) return
      const packs = await caches.open(PACKS)
      await Promise.all((await packs.keys()).map((k) => packs.delete(k)))
      const meta = await caches.open(META)
      await meta.put(GEN_KEY, new Response(String(gen)))
   } catch {
      // best-effort — leave caches as-is
   }
}

// db.gz gets its own network-first variant that awaits the gen check BEFORE
// resolving: the page awaits db.gz (data.ts init) before requesting any idx
// pack, so a purge that completes first is race-free. Offline (fetch threw)
// the check is unreachable — correct, there is no new gen to discover and the
// cached db.gz/pack pair stays mutually consistent.
async function dbNetworkFirst(req: Request): Promise<Response> {
   const cache = await caches.open(PACKS)
   try {
      const res = await fetch(req)
      if (res.ok) {
         cache.put(req, res.clone())
         await checkGen(res)
      }
      return res
   } catch (err) {
      const hit = await cache.match(req)
      if (hit) return hit
      throw err
   }
}

sw.addEventListener("fetch", (event) => {
   const req = event.request
   if (req.method !== "GET") return

   const url = new URL(req.url)
   if (url.origin !== sw.location.origin) return // external (e.g. img proxy) — untouched
   if (!url.pathname.startsWith(SCOPE)) return // sibling deployment on the same origin

   // The page itself → network-first so a new deploy wins online, cached shell offline.
   if (req.mode === "navigate") {
      event.respondWith(networkFirst(req, SHELL))
      return
   }

   const path = url.pathname
   if (RE_ASSET.test(path)) event.respondWith(cacheFirst(req, ASSETS))
   else if (RE_DB.test(path)) event.respondWith(dbNetworkFirst(req))
   else if (RE_PACK_FINAL.test(path)) event.respondWith(cacheFirst(req, PACKS, true))
   else if (RE_PACK_LATEST.test(path)) event.respondWith(networkFirst(req, PACKS))
   else if (RE_SHELL_HASHED.test(path)) event.respondWith(cacheFirst(req, SHELL))
   // everything else (sw.js, favicon, sourcemaps) → default network passthrough
})
