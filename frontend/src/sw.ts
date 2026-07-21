/// <reference lib="webworker" />
// Service worker: offline-capable cache for the SRR reader.
//
// Three buckets, split by how mutable each resource is:
//
//   assets (srr-assets-vN)  content-hash `assets/<2hex>/<16hex><ext>` — immutable
//                           (the hash is the sha256 of the bytes). Cache-first;
//                           a hit can never be stale. Bounded to ASSET_KEEP
//                           entries, oldest-cached evicted first.
//   packs  (srr-packs-vN)   the CDN store: every object name is write-once —
//      a stem is drawn from a per-series counter that is NEVER reused
//      (docs/MANIFEST-SPEC.md §4.5), so a cached name can never hold different
//      bytes later → cache-first, unconditionally. Only `db.gz` is mutable →
//      network-first (offline → last cached). The article series are bounded
//      per series (enforceCacheBounds), lowest-stem (oldest) evicted first;
//      everything else is reconciled against the manifest (checkManifest).
//   shell  (srr-shell-vN)   the app itself: the `/…/` navigation + content-hashed
//                           JS/CSS. Runtime-cached (no build-time manifest — keeps
//                           this SW hand-written and zero-dep). Hashed JS/CSS are
//                           immutable → cache-first; the navigation/index.html is the
//                           version pointer → network-first so a fresh deploy wins
//                           online and the cached shell serves offline.
//   meta   (srr-meta-vN)    two synthetic entries: the last-adopted generation
//                           counter `m` (db.gz's only moving field) and the SET of
//                           object names that generation listed. On adopting a new
//                           manifest the SW evicts every cached object named by
//                           neither it nor the previous one — exact, rather than the
//                           four approximate window formulas the cutover retired.
//
// Offline correctness is structural: a cached db.gz names one manifest, that
// manifest names one set of objects, and every one of those names is write-once.
// The snapshot can never disagree with itself, even across a mid-load network
// blip. All of it was cached on the last online visit; offline serves it.
//
// Best-effort throughout: every miss/failure falls through to the network, so a
// browser without SW support (or an insecure-context LAN deploy) just runs straight
// off the network, exactly as before. Self-contained: no SRR_CDN_URL, so it works
// under any cdn-url prefix.
import { PACK_SERIES_KINDS, type IDBWire, type IManifestWire } from "./js/format.gen"
import { manifestNames } from "./js/names"
import { parsePackName, RE_ASSET, RE_DB, RE_SHELL_HASHED } from "./js/sw-grammar"

const sw = self as unknown as ServiceWorkerGlobalScope

// Bump a suffix to invalidate that bucket on the next activate.
const ASSETS = "srr-assets-v1"
// vN marks format changes of the cache itself. v3→v4 is the generation-manifest
// cutover: names became opaque stems, so entries cached under the retired
// kind-lettered names (idx/L7.gz, data/d9.gz, idx/h2.gz) can never be requested
// again and would sit in the bucket forever — this bucket rename drops them in
// one go. There is no store-rebuild invalidation any more: a rebuild writes NEW
// names, which is exactly what retired `gen` and its purge.
const PACKS = "srr-packs-v4"
const SHELL = "srr-shell-v1"
// Tiny bucket holding the last-seen store generation + latest-pack
// generation (a Cache is the only storage a SW shares across restarts
// without IndexedDB).
const META = "srr-meta-v1"
// Eviction-exempt offline-pin bucket. Populated via the "pin" message from the
// page (per packNamesForFilter) and consulted before PACKS in the pack fetch
// branch. Unlike PACKS it is never touched by enforceCacheBounds — pinned packs
// survive the rolling-window eviction so an offline-pinned filter stays fully
// readable — and never by the manifest reconciliation either: a pin is a
// snapshot of write-once names, valid until the page unpins it.
const PINNED = "srr-pinned-v1"
const KEEP = new Set([ASSETS, PACKS, SHELL, META, PINNED])

// Deployment root, e.g. "/srr/" or "/srr.tmp/" (or "/" in e2e) — so we never touch
// a sibling deployment sharing the origin.
const SCOPE = new URL(sw.registration.scope).pathname

// The pack-name grammar (RE_ASSET / RE_PACK / RE_DB / RE_SHELL_HASHED +
// parsePackName) lives in ./js/sw-grammar so it can be unit-tested without the
// worker global scope. The fetch route, the cache bound, and the manifest
// prunes all consume that one grammar.

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

// A pinnable name is either a write-once pack name (parsePackName) or a
// content-hash asset key (RE_ASSET): the page's packNamesForFilter enumerates
// both so a pinned scope renders its self-hosted images offline. Names are
// store-relative (e.g. "idx/0.gz"); the leading "/" anchors the suffix grammar.
// Validating here keeps the cache-key surface closed — no arbitrary injection.
function isPinnableName(n: unknown): n is string {
   if (typeof n !== "string") return false
   const p = `/${n}`
   return parsePackName(p) !== null || RE_ASSET.test(p)
}

// Message handler — protocol between the page and the SW:
//
//   { type: "pin", names: string[], base?: string, port?: MessagePort }
//     Caches each name into the eviction-exempt PINNED bucket. Names MUST pass
//     isPinnableName validation (a write-once pack name OR a content-hash asset
//     key) — anything else is silently dropped (no arbitrary cache-key
//     injection). `base` is the page's PACK_BASE (the cdn-url each name resolves
//     against when the page fetches); pin caches at those exact URLs so a later
//     page fetch is a hit, and only same-origin URLs under our scope are pinned
//     (defaults to the SW scope for the self-hosted layout, base===scope). Asset
//     keys let a pinned scope render its self-hosted images offline;
//     pinnedCacheFirst consults PINNED first for both. Each name is
//     fetched with cache:"no-cache" so fresh bytes are always written (the SW's
//     own cache-first could serve a stale copy under a reused name before a gen
//     bump — using no-cache here means the pinned entry is always fresh at pin
//     time). Per-name errors (404 on GC'd latest packs, quota) are caught and
//     skipped; progress is reported via the provided MessagePort or e.source.
//     Progress message: { type: "pin-progress", done: number, total: number,
//                         error?: string }
//
//   { type: "unpin-all" }
//     Clears the entire PINNED bucket (called when the user removes all pins).
//
//   { type: "unpin", names: string[], base?: string }
//     Removes specific entries from the PINNED bucket (base as in "pin").
sw.addEventListener("message", (event) => {
   const msg = event.data as { type: string; names?: string[]; base?: string }
   if (!msg || typeof msg.type !== "string") return
   // The page resolves pack names against PACK_BASE (the cdn-url) when it fetches;
   // pin must cache at those SAME URLs. PACK_BASE isn't knowable in the worker, so
   // the page sends it. Fall back to the SW scope (self-hosted layout, base===scope).
   const packBase = typeof msg.base === "string" ? msg.base : sw.registration.scope

   const port: MessagePort | null = event.ports?.[0] ?? null
   const reply = (data: unknown) => {
      if (port) port.postMessage(data)
      else event.source?.postMessage(data)
   }

   if (msg.type === "pin") {
      const rawNames = Array.isArray(msg.names) ? msg.names : []
      // Validate every name as a pinnable pack OR asset key — reject anything else.
      const validNames = rawNames.filter(isPinnableName)
      const total = validNames.length
      let done = 0
      event.waitUntil(
         (async () => {
            const pinned = await caches.open(PINNED)
            let cached = 0
            for (const name of validNames) {
               try {
                  // The exact URL the page will later fetch (name resolved against
                  // the page's pack base). Only pin same-origin packs under our
                  // scope — a cross-origin CDN pack is never served by the fetch
                  // handler anyway, and this rejects a malicious base.
                  const url = new URL(name, packBase)
                  if (url.origin === sw.location.origin && url.pathname.startsWith(SCOPE)) {
                     const res = await fetch(new Request(url.href, { cache: "no-cache" }))
                     if (res.ok) {
                        await pinned.put(new Request(url.href), res)
                        cached++
                     }
                  }
               } catch (err) {
                  // 404 from GC'd latest packs, quota error, network error — skip.
                  reply({
                     type: "pin-progress",
                     done,
                     total,
                     cached,
                     error: String(err),
                  })
               }
               done++
               reply({ type: "pin-progress", done, total, cached })
            }
         })(),
      )
      return
   }

   if (msg.type === "unpin-all") {
      event.waitUntil(
         (async () => {
            const pinned = await caches.open(PINNED)
            await Promise.all((await pinned.keys()).map((k) => pinned.delete(k)))
         })(),
      )
      return
   }

   if (msg.type === "unpin") {
      const rawNames = Array.isArray(msg.names) ? msg.names : []
      // Validate every name as a pinnable pack OR asset key — reject anything else.
      const validNames = rawNames.filter(isPinnableName)
      event.waitUntil(
         (async () => {
            const pinned = await caches.open(PINNED)
            await Promise.all(
               validNames.map(async (name) => {
                  const url = new URL(name, packBase).href
                  await pinned.delete(new Request(url))
               }),
            )
         })(),
      )
      return
   }
})

// Serve the cached copy if present, else fetch and cache a genuine success.
//
// Unconditionally cache-first: the `revalidate` flag this used to carry existed
// solely because an in-place rebuild could reuse a finalized pack name with new
// bytes. It cannot any more — a stem is never reused (§4.5) — so a hit can
// never be stale, for packs exactly as for content-hashed assets and bundles.
async function cacheFirst(req: Request, name: string): Promise<Response> {
   const cache = await caches.open(name)
   const hit = await cache.match(req)
   if (hit) return hit
   const res = await fetch(req)
   if (res.ok) cache.put(req, res.clone())
   return res
}

// Pack/asset cache-first: check the eviction-exempt PINNED bucket first — a
// pinned filter scope caches its packs AND the assets/ images its articles
// reference there (via the "pin" message) — then fall through to the rolling
// bucket. A PINNED hit survives PACKS/ASSETS eviction and stays readable
// offline.
async function pinnedCacheFirst(req: Request, name: string): Promise<Response> {
   const pinned = await caches.open(PINNED)
   const pinnedHit = await pinned.match(req)
   if (pinnedHit) return pinnedHit
   return cacheFirst(req, name)
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

// Cache-size backstop: the store grows forever, a device shouldn't. Stems are
// handed out in write order, so a series' higher stems are its newer objects
// and reading skews to the tail: each article series keeps its PACK_KEEP
// highest-stem entries and evicts the rest — no access-time bookkeeping.
// Evicting a pack someone is still reading just costs one CDN refetch on the
// next miss. Assets are content-hashed (no order in the name), so that bucket
// prunes oldest-cached-first: Cache.keys() returns insertion order and
// cacheFirst never re-puts on a hit. Runs only after a successful ONLINE db.gz
// fetch — an offline reader must never lose a cached object it cannot refetch.
const PACK_KEEP = 100 // per finalized series: ~20 MB of data packs + ~5 MB of idx packs
const META_KEEP = 80 // meta shards run ~200 KB each — a tighter bound for the same idea
const ASSET_KEEP = 500 // self-hosted images/files: order of ~100 MB at typical sizes

// Only the ARTICLE series are rolling-window bounded. A series absent from this
// table is owned by checkManifest instead: `manifest` and `seen` are reconciled
// against what the adopted generation names (the `seen` sidecar is never
// fetched by the reader at all — its series exists here only so the route
// grammar knows it).
const SERIES_KEEP: Record<string, number> = { idx: PACK_KEEP, data: PACK_KEEP, meta: META_KEEP }

async function enforceCacheBounds(): Promise<void> {
   try {
      const packs = await caches.open(PACKS)
      const series: Record<string, { req: Request; n: number }[]> = Object.fromEntries(
         Object.keys(PACK_SERIES_KINDS)
            .filter((name) => SERIES_KEEP[name] !== undefined)
            .map((name) => [name, []]),
      )
      for (const req of await packs.keys()) {
         const p = parsePackName(new URL(req.url).pathname)
         if (p && series[p.series]) series[p.series].push({ req, n: p.n })
      }
      const assets = await caches.open(ASSETS)
      const assetKeys = await assets.keys()
      await Promise.all([
         ...Object.entries(series).flatMap(([name, list]) =>
            list
               .sort((a, b) => b.n - a.n)
               .slice(SERIES_KEEP[name])
               .map((e) => packs.delete(e.req)),
         ),
         ...assetKeys.slice(0, Math.max(0, assetKeys.length - ASSET_KEEP)).map((req) => assets.delete(req)),
      ])
   } catch {
      // best-effort — a failed prune never affects serving
   }
}

// The last-adopted generation and the object-name set it listed persist as
// synthetic entries in META (the URLs are never fetched — they're just cache
// keys).
const MAN_KEY = "https://srr.invalid/manifest"
const NAMES_KEY = "https://srr.invalid/names"

async function readMetaNumber(key: string): Promise<number> {
   const cache = await caches.open(META)
   const hit = await cache.match(key)
   return hit ? Number(await hit.text()) || 0 : 0
}

async function readMetaNames(): Promise<string[]> {
   const cache = await caches.open(META)
   const hit = await cache.match(NAMES_KEY)
   if (!hit) return []
   try {
      return (await hit.json()) as string[]
   } catch {
      return []
   }
}

// Best-effort cache reconciliation, and the whole of it (docs/MANIFEST-SPEC.md
// §8.3): gunzip the db.gz body (raw gzip bytes, no Content-Encoding — the same
// manual decompression as data.ts), read the ONE field a v2 root carries that
// moves, and if it moved, adopt the manifest it names:
//
//   evict every cached pack object named by NEITHER the new manifest NOR the
//   previously-adopted one.
//
// One generation of overlap covers a tab mid-swap. This is EXACT — it evicts
// what the store no longer serves and keeps what it does — where the retired
// scheme needed four separate window formulas (a gen purge, a gcs mirror for
// L/d, and LATEST_KEEP cutoffs for h/s) and still had to know the writer's
// runtime --max-deltas. Any failure is swallowed: a malformed root or an
// unreachable manifest must still let db.gz be served.
async function checkManifest(dbRes: Response): Promise<void> {
   try {
      const body = dbRes.clone().body!.pipeThrough(new DecompressionStream("gzip"))
      const root = (await new Response(body).json()) as Pick<IDBWire, "m">
      const m = root.m ?? 0
      if (m === 0 || m === (await readMetaNumber(MAN_KEY))) return

      // The page is about to fetch this very manifest, so caching it here is
      // work it would do anyway.
      const url = new URL(`manifest/${m}.gz`, dbRes.url)
      const res = await cacheFirst(new Request(url.href), PACKS)
      if (!res.ok) return
      const man = (await new Response(
         res.clone().body!.pipeThrough(new DecompressionStream("gzip")),
      ).json()) as IManifestWire
      if (man.m !== m) return

      const names = manifestNames(man)
      const listed = [
         ...names.idx.keys,
         ...names.data.keys,
         ...names.meta.keys,
         ...names.deltas,
         ...(names.hsum ? [names.hsum.key] : []),
         ...(names.ssum ? [names.ssum.key] : []),
         `manifest/${m}.gz`,
      ].filter(Boolean)
      // Keep = this generation ∪ the PREVIOUSLY-ADOPTED one. Exactly one
      // generation of overlap, which is what covers a tab mid-swap; the stored
      // set is this generation's alone, or the kept set would only ever grow.
      const keep = new Set<string>([...listed, ...(await readMetaNames())])

      const packs = await caches.open(PACKS)
      await Promise.all(
         (await packs.keys()).map((req) => {
            const path = new URL(req.url).pathname
            if (!parsePackName(path)) return undefined
            // Names are store-relative; a cached URL carries whatever prefix
            // the cdn-url adds, so match on the suffix.
            for (const name of keep) if (path.endsWith("/" + name)) return undefined
            return packs.delete(req)
         }),
      )

      const meta = await caches.open(META)
      await meta.put(MAN_KEY, new Response(String(m)))
      await meta.put(NAMES_KEY, new Response(JSON.stringify(listed)))
   } catch {
      // best-effort — leave caches as-is
   }
}

// db.gz gets its own network-first variant that awaits the manifest check
// BEFORE resolving: the page awaits db.gz (data.ts init) before requesting
// any idx pack, so a purge that completes first is race-free. Offline (fetch
// threw) the check is unreachable — correct, there is no new gen/seq to
// discover and the cached db.gz/pack pair stays mutually consistent.
//
// validator: an unchanged ETag/Last-Modified against the cached copy means
// unchanged bytes — same gen/seq/hdrs/mp — so the common no-change load
// skips the gunzip+parse (and the redundant cache.put) on the boot critical
// path; the await stays a cheap header compare. No validator (or a changed
// one) falls through to the full check. checkManifest is best-effort anyway,
// so trusting the validator weakens nothing.
function validator(r: Response): string | null {
   return r.headers.get("etag") ?? r.headers.get("last-modified")
}

async function dbNetworkFirst(req: Request, event: FetchEvent): Promise<Response> {
   const cache = await caches.open(PACKS)
   try {
      const res = await fetch(req)
      if (res.ok) {
         const v = validator(res)
         const prev = v ? await cache.match(req) : undefined
         if (!prev || validator(prev) !== v) {
            cache.put(req, res.clone())
            await checkManifest(res)
         }
         // Size backstop rides the same online-db.gz signal (the packs bucket
         // grows from archive navigation even when db.gz is unchanged), but
         // off the critical path — the page is waiting on this response.
         // waitUntil keeps the worker alive; new puts after the keys()
         // snapshot are never deleted, so it can't race the page's pack
         // fetches.
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
   if (RE_ASSET.test(path)) event.respondWith(pinnedCacheFirst(req, ASSETS))
   else if (RE_DB.test(path)) event.respondWith(dbNetworkFirst(req, event))
   else if (parsePackName(path)) event.respondWith(pinnedCacheFirst(req, PACKS))
   else if (RE_SHELL_HASHED.test(path)) event.respondWith(cacheFirst(req, SHELL))
   // everything else (sw.js, favicon, sourcemaps) → default network passthrough
})
