/// <reference lib="webworker" />
// Service worker: offline-capable cache for the SRR reader.
//
// Three buckets, split by how mutable each resource is:
//
//   assets (srr-assets-vN)  content-hash `assets/<2hex>/<16hex><ext>` — immutable
//                           (the hash is the sha256 of the bytes). Cache-first;
//                           a hit can never be stale. Bounded to ASSET_KEEP
//                           entries, oldest-cached evicted first.
//   packs  (srr-packs-vN)   the CDN store under `packs/`: every pack name is
//      write-once — finalized `idx/<n>.gz` / `data/<n>.gz` (numeric) and the
//      latest generation `idx|data/L<seq>.gz` (a generation is never rewritten
//      after the db.gz commit that publishes it) → cache-first. Only `db.gz`
//      is mutable → network-first (offline → last cached). Finalized series
//      are bounded to PACK_KEEP entries each, lowest-numbered (oldest) evicted
//      first (enforceCacheBounds).
//   shell  (srr-shell-vN)   the app itself: the `/…/` navigation + content-hashed
//                           JS/CSS. Runtime-cached (no build-time manifest — keeps
//                           this SW hand-written and zero-dep). Hashed JS/CSS are
//                           immutable → cache-first; the navigation/index.html is the
//                           version pointer → network-first so a fresh deploy wins
//                           online and the cached shell serves offline.
//   meta   (srr-meta-vN)    two synthetic entries: the last-seen db.gz `gen` (store
//                           generation) and `seq` (latest-pack generation). A gen
//                           change purges the packs bucket (in-place store rebuild,
//                           see checkManifest); a seq change prunes cached L<g>
//                           generations the backend GC has already dropped.
//
// Offline correctness is structural: a cached db.gz of generation N can only ever
// pair with `L<N>` — the name is write-once, so the pair can never disagree on
// next_pid/offsets, even across a mid-load network blip. Both were cached on the
// last online visit; offline serves that consistent snapshot.
//
// Best-effort throughout: every miss/failure falls through to the network, so a
// browser without SW support (or an insecure-context LAN deploy) just runs straight
// off the network, exactly as before. Self-contained: no SRR_CDN_URL, so it works
// under any cdn-url prefix.
import { LATEST_KEEP, type IDBWire } from "./js/format.gen"

const sw = self as unknown as ServiceWorkerGlobalScope

// Bump a suffix to invalidate that bucket on the next activate.
const ASSETS = "srr-assets-v1"
// vN now only marks format changes of the cache itself. Store rebuilds are
// handled by the db.gz `gen` field (checkManifest below): an in-place wipe+rebuild
// reuses finalized pack ids (data/N.gz) with new bytes — cache-first would
// serve the stale cached packs — so the operator bumps `srr gen --bump` and
// every client purges PACKS on its next db.gz fetch, no redeploy needed.
// (History: v2→v3 was the 2026-06-08 AVIF→WebP rebuild, hand-bumped before
// gen existed; cron only appends, so prod never rebuilds.)
const PACKS = "srr-packs-v3"
const SHELL = "srr-shell-v1"
// Tiny bucket holding the last-seen store generation + latest-pack
// generation (a Cache is the only storage a SW shares across restarts
// without IndexedDB).
const META = "srr-meta-v1"
const KEEP = new Set([ASSETS, PACKS, SHELL, META])

// Deployment root, e.g. "/srr/" or "/srr.tmp/" (or "/" in e2e) — so we never touch
// a sibling deployment sharing the origin.
const SCOPE = new URL(sw.registration.scope).pathname

// Matched anywhere in the path so they hold whatever prefix the cdn-url adds.
const RE_ASSET = /\/assets\/[0-9a-f]{2}\/[0-9a-f]{16}\.\w+$/i
// Write-once pack names: finalized numeric stems, L<seq> latest generations,
// and idx/h<N> header summaries (published before the db.gz that names them).
const RE_PACK = /\/packs\/(?:idx|data)\/[Lh]?\d+\.gz$/i
const RE_DB = /\/packs\/db\.gz$/i // the store's only mutable key
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
// `revalidate` (write-once packs, numeric and L<seq>): a miss must bypass the
// HTTP cache underneath — the page fetches packs with force-cache and they're
// served immutable/1y, so a stale post-rebuild copy (same name, new bytes) can
// outlive checkManifest's purge of this bucket; no-cache forces origin
// revalidation exactly once, then this cache is the hit path again.
// Content-hashed assets/bundles can't go stale → they keep re-filling from
// the HTTP cache for free.
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

// Cache-size backstop: the store grows forever, a device shouldn't. Finalized
// pack names are numbered in chron order and reading skews to the tail, so each
// series (idx/, data/) keeps its PACK_KEEP highest-numbered entries and evicts
// the rest — the names themselves encode age, no access-time bookkeeping.
// Evicting a pack someone is still reading just costs one CDN refetch on the
// next miss. db.gz and the L<seq>/h<N> names are exempt (checkManifest owns
// those, and offline consistency depends on them). Assets are content-hashed
// (no age in the name), so that bucket prunes oldest-cached-first: Cache.keys()
// returns insertion order and cacheFirst never re-puts on a hit. Runs only
// after a successful ONLINE db.gz fetch — an offline reader must never lose a
// cached pack it cannot refetch.
const PACK_KEEP = 100 // per finalized series: ~20 MB of data packs + ~5 MB of idx packs
const ASSET_KEEP = 500 // self-hosted images/files: order of ~100 MB at typical sizes

const RE_PACK_FINAL = /\/packs\/(idx|data)\/(\d+)\.gz$/i

async function enforceCacheBounds(): Promise<void> {
   try {
      const packs = await caches.open(PACKS)
      const series: Record<string, { req: Request; n: number }[]> = { idx: [], data: [] }
      for (const req of await packs.keys()) {
         const m = RE_PACK_FINAL.exec(new URL(req.url).pathname)
         if (m) series[m[1].toLowerCase()].push({ req, n: Number(m[2]) })
      }
      const assets = await caches.open(ASSETS)
      const assetKeys = await assets.keys()
      await Promise.all([
         ...Object.values(series).flatMap((list) =>
            list
               .sort((a, b) => b.n - a.n)
               .slice(PACK_KEEP)
               .map((e) => packs.delete(e.req)),
         ),
         ...assetKeys.slice(0, Math.max(0, assetKeys.length - ASSET_KEEP)).map((req) => assets.delete(req)),
      ])
   } catch {
      // best-effort — a failed prune never affects serving
   }
}

// The last-seen gen/seq persist as synthetic entries in META (the URLs are
// never fetched — they're just cache keys).
const GEN_KEY = "https://srr.invalid/gen"
const SEQ_KEY = "https://srr.invalid/seq"

// LATEST_KEEP (imported from the generated contract) is the backend GC's
// grace window: the SW never prunes a generation the store itself still
// serves (an offline device may be reading from it).

async function readMetaNumber(key: string): Promise<number> {
   const cache = await caches.open(META)
   const hit = await cache.match(key)
   return hit ? Number(await hit.text()) || 0 : 0
}

// Best-effort manifest tracking: gunzip the db.gz body (raw gzip bytes, no
// Content-Encoding — same manual decompression as data.ts) and read `gen`
// and `seq` (absent == 0).
//   gen differs → in-place store rebuild: every cached pack may hold stale
//   bytes under a reused name, purge the whole PACKS bucket. Inequality, not
//   greater-than: a wipe+rebuild may reset gen.
//   seq differs (gen same) → normal fetch-cron advance: prune only cached
//   L<g> generations older than the store's GC grace window; newer cached
//   generations stay usable offline.
// ASSETS stays (content-hashed — a hit can never be stale); SHELL is
// unrelated. Any failure is swallowed: a malformed db.gz must still be served.
async function checkManifest(dbRes: Response): Promise<void> {
   try {
      const body = dbRes.clone().body!.pipeThrough(new DecompressionStream("gzip"))
      const db = (await new Response(body).json()) as Pick<IDBWire, "gen" | "seq" | "hdrs">
      const gen = db.gen ?? 0
      const seq = db.seq ?? 0
      const hdrs = db.hdrs ?? 0
      const meta = await caches.open(META)
      const packs = await caches.open(PACKS)
      if (gen !== (await readMetaNumber(GEN_KEY))) {
         await Promise.all((await packs.keys()).map((k) => packs.delete(k)))
         await meta.put(GEN_KEY, new Response(String(gen)))
         await meta.put(SEQ_KEY, new Response(String(seq)))
         return
      }
      if (seq !== (await readMetaNumber(SEQ_KEY))) {
         const keys = await packs.keys()
         await Promise.all(
            keys.map((k) => {
               const path = new URL(k.url).pathname
               const m = /\/packs\/(?:idx|data)\/L(\d+)\.gz$/i.exec(path)
               if (m && Number(m[1]) < seq - LATEST_KEEP) return packs.delete(k)
               // Superseded idx header summaries ride the seq prune instead
               // of tracking their own meta key. hdrs CAN advance without a
               // seq bump (a zero-article migration or summary-retry cycle),
               // but such a cycle leaves at most one stale ~1KB name, pruned
               // on the next article-producing fetch — and a store rebuild
               // purges the whole bucket via gen above.
               const h = /\/packs\/idx\/h(\d+)\.gz$/i.exec(path)
               return h && Number(h[1]) < hdrs - LATEST_KEEP ? packs.delete(k) : undefined
            }),
         )
         await meta.put(SEQ_KEY, new Response(String(seq)))
      }
   } catch {
      // best-effort — leave caches as-is
   }
}

// db.gz gets its own network-first variant that awaits the manifest check
// BEFORE resolving: the page awaits db.gz (data.ts init) before requesting
// any idx pack, so a purge that completes first is race-free. Offline (fetch
// threw) the check is unreachable — correct, there is no new gen/seq to
// discover and the cached db.gz/pack pair stays mutually consistent.
async function dbNetworkFirst(req: Request, event: FetchEvent): Promise<Response> {
   const cache = await caches.open(PACKS)
   try {
      const res = await fetch(req)
      if (res.ok) {
         cache.put(req, res.clone())
         await checkManifest(res)
         // Size backstop rides the same online-db.gz signal, but off the
         // critical path — the page is waiting on this response. waitUntil
         // keeps the worker alive; new puts after the keys() snapshot are
         // never deleted, so it can't race the page's pack fetches.
         event.waitUntil(enforceCacheBounds())
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
   else if (RE_DB.test(path)) event.respondWith(dbNetworkFirst(req, event))
   else if (RE_PACK.test(path)) event.respondWith(cacheFirst(req, PACKS, true))
   else if (RE_SHELL_HASHED.test(path)) event.respondWith(cacheFirst(req, SHELL))
   // everything else (sw.js, favicon, sourcemaps) → default network passthrough
})
