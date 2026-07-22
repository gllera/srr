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
import { type IDBWire, type IManifestWire } from "./js/format.gen"
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

// The last-adopted generation + the object-name set it listed persist as
// synthetic META entries, PER ROOT (§5.4): a peer's generation change must never
// purge the home store's packs. The URLs are never fetched — just cache keys.
const metaManKey = (mid: string): string => `https://srr.invalid/${mid}/manifest`
const metaNamesKey = (mid: string): string => `https://srr.invalid/${mid}/names`
// The pre-multi-store GLOBAL keys, upgraded to the home root's on first activate.
const LEGACY_MAN_KEY = "https://srr.invalid/manifest"
const LEGACY_NAMES_KEY = "https://srr.invalid/names"

// Deployment root, e.g. "/srr/" or "/srr.tmp/" (or "/" in e2e) — so we never touch
// a sibling deployment sharing the origin.
const SCOPE = new URL(sw.registration.scope).pathname

// --- multi-store roots (docs/MULTI-STORE-SPEC.md §5) ----------------------
//
// The reader mounts N store roots at once; the deployed reader's own home base
// (cdn.llera.eu) is CROSS-ORIGIN to its shell origin (srr.32b.io), so the old
// `url.origin !== sw.location.origin` early-out never cached a single pack in
// production (finding PWA0). The fix: route by the set of mounted roots, not by
// origin equality. The page posts {type:"mounts", roots} on boot and on every
// mount-table change; we persist it (a synthetic META entry) so a worker
// restarted before any page speaks to it still knows its roots.
interface Root {
   mid: string
   base: string // full href, trailing "/"
   cred: RequestCredentials
   role: string
}

// In-memory roots, hydrated from the META cache and refreshed by the "mounts"
// message. `null` = not hydrated this worker lifetime yet.
let roots: Root[] | null = null

// The synthetic META entry the roots list persists under.
const ROOTS_KEY = "https://srr.invalid/roots"

// The cold-start fallback (§5.1): with no known roots, behave exactly as the
// pre-multi-store worker did — own origin under our scope. For the self-hosted
// layout the home base equals this, so the posted roots agree; for a
// cross-origin home the page's "mounts" post (fired early in app boot) replaces
// it. A cold worker is thus never worse than the single-origin behavior.
function fallbackHome(): Root {
   return { mid: "0", base: new URL(SCOPE, sw.location.origin).href, cred: "same-origin", role: "home" }
}

function effectiveRoots(): Root[] {
   return roots && roots.length ? roots : [fallbackHome()]
}

// The mounted root a URL belongs to: the LONGEST base that is a prefix of the
// URL (§5.1). Longest-prefix keeps two stores on one origin under different path
// prefixes from bleeding into each other, and keeps a sibling deployment / the
// image proxy (no root a prefix) out entirely.
function matchRoot(url: URL): Root | null {
   let best: Root | null = null
   for (const r of effectiveRoots()) {
      if (url.href.startsWith(r.base) && (!best || r.base.length > best.base.length)) best = r
   }
   return best
}

function coerceRoots(raw: unknown): Root[] {
   if (!Array.isArray(raw)) return []
   const out: Root[] = []
   for (const r of raw) {
      if (!r || typeof r !== "object") continue
      const o = r as Record<string, unknown>
      if (typeof o.mid !== "string" || typeof o.base !== "string") continue
      let base = o.base
      if (!base.endsWith("/")) base += "/"
      out.push({
         mid: o.mid,
         base,
         cred: o.cred === "include" ? "include" : "same-origin",
         role: o.role === "peer" ? "peer" : "home",
      })
   }
   return out
}

async function persistRoots(rs: Root[]): Promise<void> {
   try {
      const cache = await caches.open(META)
      await cache.put(ROOTS_KEY, new Response(JSON.stringify(rs)))
   } catch {
      // best-effort
   }
}

// Fire-and-forget hydration at module load: a worker restarted mid-session (its
// in-memory `roots` lost) re-learns the mounted roots from the META cache
// BEFORE the page re-posts them, so a cross-origin pack fetch that races the
// re-post is still routed. Never clobbers a "mounts" message that already ran.
async function hydrateRoots(): Promise<void> {
   if (roots !== null) return
   try {
      const cache = await caches.open(META)
      const hit = await cache.match(ROOTS_KEY)
      const stored = hit ? coerceRoots(await hit.json()) : []
      if (roots === null) roots = stored
   } catch {
      if (roots === null) roots = []
   }
}
void hydrateRoots()

// The pack-name grammar (RE_ASSET / RE_PACK / RE_DB / RE_SHELL_HASHED +
// parsePackName) lives in ./js/sw-grammar so it can be unit-tested without the
// worker global scope. The fetch route, the cache bound, and the manifest
// prunes all consume that one grammar.

sw.addEventListener("install", () => {
   // A fresh worker is useful immediately; nothing to pre-cache.
   sw.skipWaiting()
})

sw.addEventListener("activate", (event) => {
   // Drop caches left by older versions, upgrade the pre-multi-store META keys,
   // then control open clients right away.
   event.waitUntil(
      caches
         .keys()
         .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
         .then(() => upgradeMetaKeys())
         .then(() => sw.clients.claim()),
   )
})

// One-shot on first activation after S38 (§5.6): the last-adopted-generation
// record was a single GLOBAL META entry; it becomes per-root. Copy the legacy
// global keys to the HOME root's (mid "0") entries and delete the originals.
// Skipping this would make the first boot read the home store's adopted
// generation as 0, decide the store changed, and purge the PACKS bucket — every
// user's offline copies, for no reason.
async function upgradeMetaKeys(): Promise<void> {
   try {
      const cache = await caches.open(META)
      for (const legacy of [LEGACY_MAN_KEY, LEGACY_NAMES_KEY]) {
         const hit = await cache.match(legacy)
         if (!hit) continue
         const dst = legacy === LEGACY_MAN_KEY ? metaManKey("0") : metaNamesKey("0")
         if (!(await cache.match(dst))) await cache.put(dst, hit.clone())
         await cache.delete(legacy)
      }
   } catch {
      // best-effort — a failed upgrade at worst costs one home-store re-purge
   }
}

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
//   { type: "mounts", roots: [{mid, base, cred, role}] }
//     The mounted store table (§5.1). Refreshes the in-memory routing set and
//     persists it (a synthetic META entry) so a restarted worker re-learns it.
//
//   { type: "pin", names: string[], base?: string, port?: MessagePort }
//     Caches each name into the eviction-exempt PINNED bucket. Names MUST pass
//     isPinnableName validation (a write-once pack name OR a content-hash asset
//     key) — anything else is silently dropped (no arbitrary cache-key
//     injection). `base` is the ACTIVE store's base (the cdn-url each name
//     resolves against when the page fetches); pin caches at those exact URLs so
//     a later page fetch is a hit. Only URLs under a MOUNTED ROOT are pinned
//     (§5.5) — a cross-origin peer store is now legitimate, but a URL under no
//     mounted root (a malicious base, the image proxy) is rejected. The matched
//     root's `cred` is honored so a credentialed mount's pin carries cookies.
//     Asset keys let a pinned scope render its self-hosted images offline;
//     pinnedCacheFirst consults PINNED first for both. Each name is
//     fetched with cache:"no-cache" so fresh bytes are always written. Per-name
//     errors (404 on GC'd latest packs, quota) are caught and skipped; progress
//     is reported via the provided MessagePort or e.source.
//     Progress message: { type: "pin-progress", done: number, total: number,
//                         error?: string }
//
//   { type: "unpin-all" }
//     Clears the entire PINNED bucket (called when the user removes all pins).
//
//   { type: "unpin", names: string[], base?: string }
//     Removes specific entries from the PINNED bucket (base as in "pin").
sw.addEventListener("message", (event) => {
   const msg = event.data as { type: string; names?: string[]; base?: string; roots?: unknown }
   if (!msg || typeof msg.type !== "string") return

   if (msg.type === "mounts") {
      roots = coerceRoots(msg.roots)
      event.waitUntil(persistRoots(roots))
      return
   }

   // The page resolves pack names against the active store's base (the cdn-url)
   // when it fetches; pin must cache at those SAME URLs. Fall back to the SW
   // scope (self-hosted layout, base===scope).
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
            await hydrateRoots()
            const pinned = await caches.open(PINNED)
            let cached = 0
            for (const name of validNames) {
               try {
                  // The exact URL the page will later fetch (name resolved against
                  // the page's pack base). Only pin a URL under a mounted root
                  // (§5.5) — this admits a cross-origin peer store while rejecting
                  // a malicious base. Carry the root's credentials.
                  const url = new URL(name, packBase)
                  const hit = matchRoot(url)
                  if (hit) {
                     const res = await fetch(new Request(url.href, { cache: "no-cache", credentials: hit.cred }))
                     if (res.ok && res.type !== "opaque") {
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
   // Never cache an opaque response (§5.2): a cross-origin mount without CORS
   // yields status-0 unreadable bytes — caching it would serve a broken hit
   // forever. `res.ok` is already false for opaque; the explicit guard documents
   // the multi-store requirement (the page's own fetch surfaces the CORS error).
   if (res.ok && res.type !== "opaque") cache.put(req, res.clone())
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
      if (res.ok && res.type !== "opaque") cache.put(req, res.clone())
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
const PEER_PACK_KEEP = 40 // peers are browsed less; N mounts otherwise multiply the footprint (§5.3)
const PEER_META_KEEP = 30
const ASSET_KEEP = 500 // self-hosted images/files: order of ~100 MB at typical sizes

// Only the ARTICLE series are rolling-window bounded. A series absent from this
// table is owned by checkManifest instead: `manifest` and `seen` are reconciled
// against what the adopted generation names (the `seen` sidecar is never
// fetched by the reader at all — its series exists here only so the route
// grammar knows it).
const SERIES_KEEP: Record<string, number> = { idx: PACK_KEEP, data: PACK_KEEP, meta: META_KEEP }
const PEER_SERIES_KEEP: Record<string, number> = { idx: PEER_PACK_KEEP, data: PEER_PACK_KEEP, meta: PEER_META_KEEP }

// Cache keys are absolute URLs so two roots never collide, but the BOUND must be
// per-root (§5.3): otherwise a peer store's archive walk evicts the home store's
// packs. Group cached keys by matched root first, then series, then apply the
// series budget WITHIN each group — home keeps the roomy budget, peers a tighter
// one. Assets stay one global content-hashed bound (shared-by-accident across
// stores is harmless). Runs only after a successful ONLINE db.gz fetch — an
// offline reader must never lose a cached object it cannot refetch.
async function enforceCacheBounds(): Promise<void> {
   try {
      await hydrateRoots()
      const packs = await caches.open(PACKS)
      // group[mid][series] = entries; keep the role for the budget choice.
      const group = new Map<string, { role: string; series: Record<string, { req: Request; n: number }[]> }>()
      for (const req of await packs.keys()) {
         const url = new URL(req.url)
         const p = parsePackName(url.pathname)
         if (!p) continue
         const hit = matchRoot(url)
         const mid = hit?.mid ?? "?" // an unmatched cached pack (a since-unmounted root) still gets bounded
         let g = group.get(mid)
         if (!g) {
            g = { role: hit?.role ?? "peer", series: {} }
            group.set(mid, g)
         }
         ;(g.series[p.series] ??= []).push({ req, n: p.n })
      }
      const deletes: Promise<boolean>[] = []
      for (const { role, series } of group.values()) {
         const budget = role === "home" ? SERIES_KEEP : PEER_SERIES_KEEP
         for (const [name, list] of Object.entries(series)) {
            const keep = budget[name]
            if (keep === undefined) continue
            for (const e of list.sort((a, b) => b.n - a.n).slice(keep)) deletes.push(packs.delete(e.req))
         }
      }
      const assets = await caches.open(ASSETS)
      const assetKeys = await assets.keys()
      for (const req of assetKeys.slice(0, Math.max(0, assetKeys.length - ASSET_KEEP))) deletes.push(assets.delete(req))
      await Promise.all(deletes)
   } catch {
      // best-effort — a failed prune never affects serving
   }
}

async function readMetaNumber(key: string): Promise<number> {
   const cache = await caches.open(META)
   const hit = await cache.match(key)
   return hit ? Number(await hit.text()) || 0 : 0
}

async function readMetaNames(key: string): Promise<string[]> {
   const cache = await caches.open(META)
   const hit = await cache.match(key)
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
async function checkManifest(dbRes: Response, root: Root): Promise<void> {
   try {
      const body = dbRes.clone().body!.pipeThrough(new DecompressionStream("gzip"))
      const rootDoc = (await new Response(body).json()) as Pick<IDBWire, "m">
      const m = rootDoc.m ?? 0
      // Per-root record (§5.4): a peer's generation change must not touch the
      // home store's adopted-generation number or its cached packs.
      if (m === 0 || m === (await readMetaNumber(metaManKey(root.mid)))) return

      // The page is about to fetch this very manifest, so caching it here is
      // work it would do anyway. Resolve against the ROOT's base (dbRes.url is
      // the db.gz URL, so a same-directory resolve works either way).
      const url = new URL(`manifest/${m}.gz`, dbRes.url)
      const res = await cacheFirst(new Request(url.href, { credentials: root.cred }), PACKS)
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
      const keep = new Set<string>([...listed, ...(await readMetaNames(metaNamesKey(root.mid)))])

      const packs = await caches.open(PACKS)
      await Promise.all(
         (await packs.keys()).map((req) => {
            const reqUrl = new URL(req.url)
            const path = reqUrl.pathname
            if (!parsePackName(path)) return undefined
            // Evict only THIS root's objects: a cached pack under a different
            // mounted root must survive this root's generation change (§5.4).
            if (!reqUrl.href.startsWith(root.base)) return undefined
            // Names are store-relative; a cached URL carries whatever prefix
            // the cdn-url adds, so match on the suffix.
            for (const name of keep) if (path.endsWith("/" + name)) return undefined
            return packs.delete(req)
         }),
      )

      const meta = await caches.open(META)
      await meta.put(metaManKey(root.mid), new Response(String(m)))
      await meta.put(metaNamesKey(root.mid), new Response(JSON.stringify(listed)))
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

async function dbNetworkFirst(req: Request, event: FetchEvent, root: Root): Promise<Response> {
   const cache = await caches.open(PACKS)
   try {
      const res = await fetch(req)
      if (res.ok && res.type !== "opaque") {
         const v = validator(res)
         const prev = v ? await cache.match(req) : undefined
         if (!prev || validator(prev) !== v) {
            cache.put(req, res.clone())
            await checkManifest(res, root)
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

   // The app SHELL always lives at the SW's own origin under its scope,
   // independent of any store root (a peer store never serves the shell).
   const ownScope = url.origin === sw.location.origin && url.pathname.startsWith(SCOPE)
   if (req.mode === "navigate") {
      // A navigation is only ours when it is same-origin under our scope; a
      // cross-origin navigation (opening a peer store's root in a tab) is not.
      if (ownScope) event.respondWith(networkFirst(req, SHELL))
      return
   }
   if (ownScope && RE_SHELL_HASHED.test(url.pathname)) {
      event.respondWith(cacheFirst(req, SHELL))
      return
   }

   // Store objects: route by the mounted root the URL belongs to (§5.1). This
   // REPLACES the old `url.origin !== sw.location.origin` early-out — the fix for
   // PWA0: the deployed reader's home base (cdn.llera.eu) is cross-origin to its
   // shell origin, so origin-equality never cached a single production pack.
   const hit = matchRoot(url)
   if (!hit) return // under no mounted root — the image proxy, a sibling deploy — untouched

   const path = url.pathname
   if (RE_ASSET.test(path)) event.respondWith(pinnedCacheFirst(req, ASSETS))
   else if (RE_DB.test(path)) event.respondWith(dbNetworkFirst(req, event, hit))
   else if (parsePackName(path)) event.respondWith(pinnedCacheFirst(req, PACKS))
   // everything else (favicon, sourcemaps) under a root → passthrough
})
