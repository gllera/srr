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
//      write-once — finalized `idx|data|meta/<n>.gz` (numeric), the latest
//      generation `idx|data|meta/L<seq>.gz` (a generation is never rewritten
//      after the db.gz commit that publishes it), and the `idx/h<N>` /
//      `meta/s<N>` summaries → cache-first. Only `db.gz` is mutable →
//      network-first (offline → last cached). Finalized series are bounded
//      per series (enforceCacheBounds), lowest-numbered (oldest) evicted
//      first.
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
import { LATEST_KEEP, PACK_SERIES_KINDS, type IDBWire } from "./js/format.gen"
import { parsePackName, RE_ASSET, RE_DB, RE_SHELL_HASHED } from "./js/sw-grammar"

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
// Eviction-exempt offline-pin bucket. Populated via the "pin" message from the
// page (per packNamesForFilter), consulted before PACKS in the pack fetch
// branch, and purged only on store gen change (same invalidation as PACKS).
// Unlike PACKS it is never touched by enforceCacheBounds — pinned packs survive
// the rolling-window eviction so an offline-pinned filter stays fully readable.
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

// Pack/asset cache-first: check the eviction-exempt PINNED bucket first — a
// pinned filter scope caches its packs AND the assets/ images its articles
// reference there (via the "pin" message) — then fall through to the rolling
// bucket. A PINNED hit survives PACKS/ASSETS eviction and stays readable
// offline. Packs pass revalidate (write-once names can outlive a rebuild —
// see cacheFirst); assets are content-hashed, so a hit can never be stale.
async function pinnedCacheFirst(req: Request, name: string, revalidate = false): Promise<Response> {
   const pinned = await caches.open(PINNED)
   const pinnedHit = await pinned.match(req)
   if (pinnedHit) return pinnedHit
   return cacheFirst(req, name, revalidate)
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
const META_KEEP = 80 // meta shards run ~200 KB each — a tighter bound for the same idea
const ASSET_KEEP = 500 // self-hosted images/files: order of ~100 MB at typical sizes

const SERIES_KEEP: Record<string, number> = { idx: PACK_KEEP, data: PACK_KEEP, meta: META_KEEP }

async function enforceCacheBounds(): Promise<void> {
   try {
      const packs = await caches.open(PACKS)
      const series: Record<string, { req: Request; n: number }[]> = Object.fromEntries(
         Object.keys(PACK_SERIES_KINDS).map((name) => [name, []]),
      )
      for (const req of await packs.keys()) {
         const p = parsePackName(new URL(req.url).pathname)
         if (p && p.kind === "") series[p.series].push({ req, n: p.n })
      }
      const assets = await caches.open(ASSETS)
      const assetKeys = await assets.keys()
      await Promise.all([
         ...Object.entries(series).flatMap(([name, list]) =>
            list
               .sort((a, b) => b.n - a.n)
               .slice(SERIES_KEEP[name] ?? PACK_KEEP)
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
      const db = (await new Response(body).json()) as Pick<IDBWire, "gen" | "seq" | "hdrs" | "mp" | "gcs">
      const gen = db.gen ?? 0
      const seq = db.seq ?? 0
      const hdrs = db.hdrs ?? 0
      const mp = db.mp ?? 0
      // The backend GC's own low-water mark: it has deleted every tail generation
      // L<g>/d<g> with g <= gcs and still serves everything above it (see the
      // delta-tail spec §8). Mirroring it is what keeps the SW cache aligned with
      // the store — and correct for offline reads at ANY runtime --max-deltas
      // without the reader knowing that value: a stale open tab needs names only
      // down to its own tailGen, which the backend's grace window guarantees sits
      // above gcs, so a name it needs is never evicted (a bare tailGen-based
      // cutoff would evict the just-consolidated chain across a tailGen jump).
      const gcs = db.gcs ?? 0
      const meta = await caches.open(META)
      const packs = await caches.open(PACKS)
      if (gen !== (await readMetaNumber(GEN_KEY))) {
         // An in-place store rebuild reuses pack names with new bytes. Purge
         // both the rolling PACKS bucket and the eviction-exempt PINNED bucket —
         // pinned packs are keyed by name, so stale bytes under a reused name
         // must be evicted just like PACKS. On seq-only changes PINNED is left
         // untouched: latest packs are write-once (generation-named), so a
         // cached L<g> pack in PINNED is still valid for its seq.
         const pinned = await caches.open(PINNED)
         await Promise.all([
            ...(await packs.keys()).map((k) => packs.delete(k)),
            ...(await pinned.keys()).map((k) => pinned.delete(k)),
         ])
         await meta.put(GEN_KEY, new Response(String(gen)))
         await meta.put(SEQ_KEY, new Response(String(seq)))
         // The PINNED bucket was just purged — tell open pages to clear their
         // srr-pins registry so the menu doesn't claim "Remove offline copy" over
         // evicted bytes.
         const purgedClients = await sw.clients.matchAll()
         for (const c of purgedClients) c.postMessage({ type: "pins-purged" })
         return
      }
      if (seq !== (await readMetaNumber(SEQ_KEY))) {
         const keys = await packs.keys()
         // Superseded summaries (idx h<N> headers, meta s<N> blooms) ride
         // the seq prune instead of tracking meta keys of their own. Their
         // counters CAN advance without a seq bump (a zero-article migration
         // or sync-retry cycle), but such a cycle strands at most one stale
         // name each, pruned on the next article-producing fetch — and a
         // store rebuild purges the whole bucket via gen above. Tail packs
         // (L<g>) and delta segments (d<g>) prune against gcs — the backend
         // GC's own low-water — so the cache evicts exactly what the store has
         // deleted and keeps exactly what it still serves (see gcs above); gcs
         // in db.gz lags the live sweep by one cycle (GC runs post-Commit), a
         // safe direction (the cache keeps a just-swept name one cycle longer).
         const cutoff: Record<string, number> = {
            l: gcs + 1,
            d: gcs + 1,
            h: hdrs - LATEST_KEEP,
            s: mp - LATEST_KEEP,
         }
         await Promise.all(
            keys.map((k) => {
               const p = parsePackName(new URL(k.url).pathname)
               return p && p.kind !== "" && p.n < cutoff[p.kind] ? packs.delete(k) : undefined
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
   else if (parsePackName(path)) event.respondWith(pinnedCacheFirst(req, PACKS, true))
   else if (RE_SHELL_HASHED.test(path)) event.respondWith(cacheFirst(req, SHELL))
   // everything else (sw.js, favicon, sourcemaps) → default network passthrough
})
