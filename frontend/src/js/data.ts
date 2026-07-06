import { PACK_BASE } from "./base"
import { cachedPromise, makeLRU, type LRU } from "./cache"
import { META_PACK_SIZE, SEARCH_BLOOM_BYTES, type IMetaWire } from "./format.gen"
import {
   countAt,
   IDX_PACK_SIZE,
   lowerBound,
   makeFeedsLookup,
   makeIdxPack,
   parseIdxHeaders,
   type IdxHeader,
   type IdxPack,
} from "./idx"

export { IDX_PACK_SIZE, META_PACK_SIZE }

// no-cache forces a conditional revalidation on every load so a stale db.gz on
// the client (mobile browsers cache aggressively) can't make chronIdx URLs like
// `#14099` silently fall back to the last article via the `>= total_art` clamp
// in nav.fromHash. 304 keeps the hot path cheap when the CDN sends ETag /
// Last-Modified; the <link rel="preload"> in built HTML still warms the entry.
function fetchDb(): Promise<Response> {
   return fetch(new URL("db.gz", PACK_BASE), { cache: "no-cache" })
}
const dbFetch = fetchDb()

export let db: IDB

// One in-flight-or-resolved fetch per idx pack (finalized 0..nf-1, latest at
// nf; capacity covers every pack, so nothing ever evicts) — packs are fetched
// once and stay resident. Only the latest pack is fetched eagerly — latestIdx
// keeps it reachable synchronously for countAll. idxHeaders always holds
// every pack's header (from idx/h<N>.gz on the summary path, or peeled off
// each pack on the eager fallback), so counting, pack-skipping, and timestamp
// search never force a pack fetch.
let idxFetches: LRU<Promise<IdxPack>>
let idxHeaders: IdxHeader[] = []
let latestIdx: IdxPack
// Store high-water + 1: the size of the per-pack feed lookup arrays
// (feedIds/ownFeedCounts and the filter lookup). Sized to the actual feed
// count, not the format ceiling. Computed once at init from db.feeds.
let slots = 1
let expiredCounts = new Uint32Array(0)

// A pack name is write-once, so a non-OK response means the name itself no
// longer matches the store. For a latest pack (L<seq>) that means this tab's
// db.gz predates the backend's GC grace window — only a fresh db.gz (fetched
// no-cache) can name the current generation, so reload once. The
// sessionStorage guard prevents reload loops; it is cleared only after a
// successful init() so a transient failure can't permanently disable
// self-healing for the tab.
const RELOAD_GUARD = "srr-reload-guard"

function assertPackOk(res: Response, isLatest: boolean): void {
   if (res.ok) return
   if (isLatest && !sessionStorage.getItem(RELOAD_GUARD)) {
      sessionStorage.setItem(RELOAD_GUARD, "1")
      location.reload()
   }
   // reload() doesn't halt execution — always throw so callers never touch
   // res.body, and so the failure stays visible when the guard suppressed
   // the reload (or under jsdom, where reload is a no-op).
   throw new Error(`pack fetch failed: ${res.status} ${res.url}`)
}

async function parseDb(res: Response): Promise<IDB> {
   // A missing/erroring store (404 on a fresh/empty store or a misconfigured CDN
   // URL, or a 5xx) would otherwise try to gunzip an HTML error body and reject
   // with a cryptic "incorrect header check"; surface the real status instead
   // (mirrors assertPackOk for the pack fetches).
   if (!res.ok) throw new Error(`db.gz fetch failed: ${res.status} ${res.url}`)
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.feeds ??= {}
   raw.seq ??= 0 // backend omitempty: absent for an empty store
   for (const [k, ch] of Object.entries(raw.feeds)) ch.id = Number(k)
   return raw
}

// The (re-runnable) boot body: swap the snapshot in and rebuild everything
// derived from it. Also the refresh() path — the caches are recreated
// wholesale (one code path, no diff logic); refetches ride the SW/HTTP cache,
// and on a gen change the stale bytes MUST go anyway.
async function applyDb(raw: IDB): Promise<void> {
   db = raw

   // Size the per-pack feed lookup arrays to the store's high-water id + 1
   // (min 1). All feedIds in packs and filters are store feed ids, so this
   // bounds the typed-array allocations by the actual feed count.
   const ids = Object.keys(db.feeds).map(Number)
   slots = ids.length > 0 ? Math.max(...ids) + 1 : 1

   // Per-feed expired totals (db.gz xp), threaded into countLeft so the
   // immutable header cumulative counts are corrected to visible articles.
   expiredCounts = new Uint32Array(slots)
   for (const ch of Object.values(db.feeds)) expiredCounts[ch.id] = ch.xp ?? 0

   dataCache = makeLRU<Promise<IArticle[]>>(20)
   metaCache = makeLRU<Promise<IMetaWire[]>>(20)
   groupCache = {}

   if (db.total_art === 0) {
      idxHeaders = [] // defensive: a re-run must never leave headers from a previous snapshot
      sessionStorage.removeItem(RELOAD_GUARD)
      return
   }

   const nf = numFinalizedIdx()
   idxFetches = makeLRU(nf + 1)

   // The latest pack is always needed: it holds the newest articles (the
   // default landing view) and its header is the cumulative boundary after
   // the last finalized pack.
   const latest = fetchIdxPack(nf)

   let headers: IdxHeader[] | null = null
   if (nf > 0 && db.hdrs === nf) {
      try {
         headers = parseIdxHeaders(await fetchPackBytes(`idx/h${db.hdrs}.gz`, false), nf)
      } catch {
         // A stale db.gz past the summary GC window, or a half-written
         // store: fall through to the eager path instead of reloading —
         // finalized pack names are never GC'd, so eager is always correct,
         // just heavier.
      }
   }
   if (headers === null) {
      // Eager fallback: a store whose hdrs lags its finalized packs (old
      // backend, warn-only summary failure, post-rebuild gap) or a failed
      // summary fetch. Fetch everything like the pre-summary reader did and
      // peel each pack's own header.
      const packs = await Promise.all(Array.from({ length: nf }, (_, p) => fetchIdxPack(p)))
      headers = packs.map((p) => p.header)
   }
   latestIdx = await latest
   headers.push(latestIdx.header)
   idxHeaders = headers
   sessionStorage.removeItem(RELOAD_GUARD)
}

export async function init() {
   await applyDb(await parseDb(await dbFetch))
}

// refresh() re-fetches db.gz and re-runs the boot path when the store moved.
// "unchanged" when the snapshot is byte-equivalent on the fields that matter:
// fetched_at catches every fetch-cycle commit; gen independently catches an
// in-place rebuild published by `srr gen --bump` (no fetch, so fetched_at
// doesn't move); total_art/seq are cheap belt-and-braces. A gen change takes
// the same path — everything derived is discarded anyway, and the SW's
// checkManifest rides this same response, purging its buckets before our
// subsequent pack refetches.
export async function refresh(): Promise<"unchanged" | "updated"> {
   const raw = await parseDb(await fetchDb())
   if (
      raw.fetched_at === db.fetched_at &&
      raw.total_art === db.total_art &&
      raw.seq === db.seq &&
      (raw.gen ?? 0) === (db.gen ?? 0)
   )
      return "unchanged"
   await applyDb(raw)
   return "updated"
}

// Finalized idx-pack count for the current store (the latest pack holds the
// rest). Used throughout for idx addressing and the header summary.
export function numFinalizedIdx(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / IDX_PACK_SIZE) : 0
}

// Finalized meta-shard count. The meta/ series strides at META_PACK_SIZE (a
// divisor of IDX_PACK_SIZE), so this differs from numFinalizedIdx. Used by the
// list and search to address meta shards and gate coverage (see metaReady).
export function numFinalizedMeta(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / META_PACK_SIZE) : 0
}

// feedTitle resolves a feed_id for display: a deleted feed's articles
// stay in the packs, so render a tombstone instead of crashing (the rendering
// contract `srr inspect`'s unknown-feeds diagnostic references).
export function feedTitle(feedId: number): string {
   return db.feeds[feedId]?.title ?? "[DELETED]"
}

// Unix timestamp of the last successful backend fetch (0 when never fetched).
export function lastFetchedAt(): number {
   return db.fetched_at
}

// True when the idx header summary lags the store (old backend, warn-only summary
// failure, or a post-rebuild gap). The reader is still correct but fetches all
// idx packs on boot instead of using the fast summary path.
export function idxSummaryDegraded(): boolean {
   const nf = numFinalizedIdx()
   // Only an actively-advancing summary rebuild (hdrs partway) — NOT a steady
   // pre-summary store (hdrs===0/absent, e.g. an old backend), which would pin a
   // permanent, misleading "(optimizing index…)" banner the user can't act on.
   return nf > 0 && (db.hdrs ?? 0) > 0 && (db.hdrs ?? 0) < nf
}

// Fetches + gunzips one pack key. Every pack name is write-once (finalized
// numeric, the L<seq> generation or h<N>/s<N> summary a db.gz commit
// published), so the HTTP cache may serve them all without revalidation
// (force-cache). Also used by the meta/ loaders (list + search): like the idx
// and data loaders, the latest meta pack passes isLatest=true so a 404 on a
// stale-db.gz tab self-heals with one guarded reload; finalized meta shards
// pass false (write-once, never GC'd). The "meta lagged" case is handled
// upstream by metaReady() (loadMeta skips meta entirely), not here.
export async function fetchPackBytes(path: string, isLatest: boolean): Promise<ArrayBuffer> {
   const res = await fetch(new URL(path, PACK_BASE), { cache: "force-cache" })
   assertPackOk(res, isLatest)
   return new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
}

// Starts (or joins) the fetch of one idx pack.
function fetchIdxPack(p: number): Promise<IdxPack> {
   return cachedPromise(idxFetches, p, () => {
      const isFinalized = p < numFinalizedIdx()
      const path = `idx/${isFinalized ? p.toString() : `L${db.seq}`}.gz`
      const size = isFinalized ? IDX_PACK_SIZE : db.total_art - p * IDX_PACK_SIZE
      return fetchPackBytes(path, !isFinalized).then((buf) => makeIdxPack(buf, p, size, slots))
   })
}

function packIdx(chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / IDX_PACK_SIZE), numFinalizedIdx())
}

export async function getFeedId(chronIdx: number): Promise<number> {
   const n = packIdx(chronIdx)
   const feedIds = (await fetchIdxPack(n)).parse().feedIds
   return feedIds[chronIdx - n * IDX_PACK_SIZE]
}

// Total filtered count across the whole store. Synchronous on purpose:
// chronIdx=total_art always lands in the latest pack (resident since init),
// whose header carries the cumulative counts of every finalized pack — so
// nav's filter bookkeeping never waits on a fetch.
export function countAll(feeds: Map<number, number>): number {
   if (db.total_art === 0) return 0
   return latestIdx.countLeft(db.total_art, feeds, makeFeedsLookup(feeds, slots), expiredCounts)
}

export async function countLeft(chronIdx: number, feeds: Map<number, number>): Promise<number> {
   if (db.total_art === 0) return 0
   const n = packIdx(chronIdx)
   return (await fetchIdxPack(n)).countLeft(chronIdx, feeds, makeFeedsLookup(feeds, slots), expiredCounts)
}

// A finalized pack can be skipped without fetching it: its per-feed
// counts are the deltas between consecutive cumulative headers. The latest
// pack has no next boundary — it is resident anyway and scans cheaply.
function packHasCandidate(p: number, feeds: Map<number, number>): boolean {
   if (p >= numFinalizedIdx()) return true
   // Mid-refresh header swap can briefly outrun this array — treat unknown as candidate.
   const cur = idxHeaders[p]
   const next = idxHeaders[p + 1]
   if (!cur || !next) return true
   const packEnd = (p + 1) * IDX_PACK_SIZE
   for (const [feedId, addIdx] of feeds) {
      const delta = countAt(next.feedCounts, feedId) - countAt(cur.feedCounts, feedId)
      if (delta > 0 && addIdx < packEnd) return true
   }
   return false
}

export async function findLeft(from: number, feeds: Map<number, number>): Promise<number> {
   if (from < 0 || db.total_art === 0) return -1
   const lookup = makeFeedsLookup(feeds, slots)
   for (let p = packIdx(from); p >= 0; p--) {
      if (!packHasCandidate(p, feeds)) continue
      const found = (await fetchIdxPack(p)).findLeft(from, feeds, lookup)
      if (found !== -1) return found
   }
   return -1
}

export async function findRight(from: number, feeds: Map<number, number>): Promise<number> {
   if (from < 0) from = 0
   if (from >= db.total_art) return -1
   const lookup = makeFeedsLookup(feeds, slots)
   const nf = numFinalizedIdx()
   for (let p = packIdx(from); p <= nf; p++) {
      if (!packHasCandidate(p, feeds)) continue
      const found = (await fetchIdxPack(p)).findRight(from, feeds, lookup)
      if (found !== -1) return found
   }
   return -1
}

async function getPackRef(chronIdx: number): Promise<{ packId: number; offset: number }> {
   const n = packIdx(chronIdx)
   const bounds = (await fetchIdxPack(n)).parse().bounds
   // The last bound whose startChron <= chronIdx.
   const bound = bounds[lowerBound(bounds.length, (i) => bounds[i].startChron <= chronIdx) - 1]
   return { packId: bound.packId, offset: chronIdx - bound.startChron }
}

let dataCache = makeLRU<Promise<IArticle[]>>(20)

async function fetchDataPack(packId: number): Promise<IArticle[]> {
   const isFinalized = packId < db.next_pid
   const name = isFinalized ? packId.toString() : `L${db.seq}`
   const res = await fetch(new URL(`data/${name}.gz`, PACK_BASE), { cache: "force-cache" })
   assertPackOk(res, !isFinalized)
   const reader = res
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream())
      .getReader()
   try {
      const entries: IArticle[] = []
      let remainder = ""
      while (true) {
         const { done, value } = await reader.read()
         if (done) break
         const chunk = remainder ? remainder + value : value
         remainder = ""
         let start = 0
         let idx: number
         while ((idx = chunk.indexOf("\n", start)) !== -1) {
            const seg = chunk.substring(start, idx)
            start = idx + 1
            if (seg) entries.push(JSON.parse(seg) as IArticle)
         }
         if (start < chunk.length) remainder = chunk.substring(start)
      }
      if (remainder.length > 0) entries.push(JSON.parse(remainder) as IArticle)
      return entries
   } finally {
      reader.cancel().catch(() => {})
   }
}

export async function loadArticle(chronIdx: number): Promise<IArticle> {
   const ref = await getPackRef(chronIdx)
   const entries = await cachedPromise(dataCache, ref.packId, () => fetchDataPack(ref.packId))
   if (ref.offset >= entries.length) {
      // Pack names are write-once, so this is unreachable in normal operation;
      // it survives as defense-in-depth for a store rebuilt in place (same
      // names, new bytes) before its `gen` bump propagates. Drop the cache so
      // a retry refetches.
      dataCache.drop(ref.packId)
      throw new Error(`pack ${ref.packId} out of sync (offset ${ref.offset} of ${entries.length}); retry to refresh`)
   }
   return entries[ref.offset]
}

// parseJsonl decodes an ArrayBuffer of newline-delimited JSON into typed
// objects. Exported for search.ts (meta shard parsing).
export function parseJsonl<T>(buf: ArrayBuffer): T[] {
   const text = new TextDecoder().decode(buf)
   const out: T[] = []
   for (const line of text.split("\n")) {
      if (line) out.push(JSON.parse(line) as T)
   }
   return out
}

// True when the store has at least one article.
export function hasArticles(): boolean {
   return db.total_art > 0
}

// meta/ is a warn-only derived projection, so after a failed SyncMeta it can
// lag db.gz for one fetch cycle. metaReady() reports whether mp+mt fully cover
// the store — only then is every meta shard (finalized + tail) present and
// consistent. The list and search both gate on it; the list falls back to data/.
export function metaReady(): boolean {
   if (db.total_art === 0) return false
   const mp = db.mp ?? 0
   return mp === numFinalizedMeta() && mp * META_PACK_SIZE + (db.mt ?? 0) === db.total_art
}

let metaCache = makeLRU<Promise<IMetaWire[]>>(20)

function metaPackId(chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / META_PACK_SIZE), numFinalizedMeta())
}

function loadMetaPack(n: number): Promise<IMetaWire[]> {
   return cachedPromise(metaCache, n, async () => {
      const isFinalized = n < numFinalizedMeta()
      const path = `meta/${isFinalized ? n.toString() : `L${db.seq}`}.gz`
      const buf = await fetchPackBytes(path, !isFinalized)
      // Finalized shards carry a SEARCH_BLOOM_BYTES bloom prefix; the latest tail does not.
      return parseJsonl<IMetaWire>(isFinalized ? buf.slice(SEARCH_BLOOM_BYTES) : buf)
   })
}

// loadMeta returns one card. Uses meta/ when the projection is consistent
// (metaReady), otherwise reads the data/ source of truth (projected) so the
// home list never breaks while meta lags after a failed SyncMeta. A stale-tab
// 404 on the latest meta pack is NOT handled here — it self-heals via the
// guarded reload in fetchPackBytes (same as the reader's data/ path).
export async function loadMeta(chronIdx: number): Promise<IMetaWire> {
   if (metaReady()) {
      const n = metaPackId(chronIdx)
      const entries = await loadMetaPack(n)
      const e = entries[chronIdx - n * META_PACK_SIZE]
      if (e) return e
      // Defensive: an undefined slot (coverage race) — fall through to data/.
   }
   const a = await loadArticle(chronIdx)
   return { f: a.f, w: a.p || a.a, t: a.t }
}

type GroupResult = { tagged: Map<string, IFeed[]>; sortedTags: string[]; untagged: IFeed[] }
// Cached per includeEmpty flag (feeds are fixed for the session): the active-only
// grouping (total_art > 0 — the default, used by nav's cycle rotation, which must
// never land on a feed with nothing to read) and the include-empty grouping (the
// config picker when read items are shown — it also surfaces never-fetched / empty
// feeds so they can be inspected or selected).
let groupCache: Partial<Record<"active" | "all", GroupResult>> = {}

export function groupFeedsByTag(includeEmpty = false): GroupResult {
   const key = includeEmpty ? "all" : "active"
   const cached = groupCache[key]
   if (cached) return cached
   const tagged = new Map<string, IFeed[]>()
   const untagged: IFeed[] = []
   const feeds = Object.values(db.feeds)
      .filter((ch) => includeEmpty || ch.total_art > 0)
      .sort((a, b) => (a.title < b.title ? -1 : 1))
   for (const ch of feeds) {
      if (ch.tag) {
         let group = tagged.get(ch.tag)
         if (!group) {
            group = []
            tagged.set(ch.tag, group)
         }
         group.push(ch)
      } else {
         untagged.push(ch)
      }
   }
   const result = { tagged, sortedTags: Array.from(tagged.keys()).sort(), untagged }
   groupCache[key] = result
   return result
}

// packNamesForFilter enumerates the write-once pack names needed to read a
// given filter scope end-to-end offline. The names are relative pack paths
// (e.g. "meta/0.gz", "data/1.gz", "idx/L1.gz") — the same strings the fetch
// handler sees after the "/packs/" prefix, and the same form data.ts resolves
// against PACK_BASE when fetching. The SW message handler prefixes them with
// "packs/" to build the full request URL.
//
// feeds: the filter's feeds Map (feed_id → addIdx), exactly as in filter.feeds.
//   - Empty Map  →  [ALL] scope: all finalized + latest packs.
//   - Non-empty  →  feed/tag/unread scope: only the idx, data, and meta packs
//     that contain at least one matching article.
//
// Latest packs (L<seq>) are always included (they hold the newest articles of
// every filter). For saved/search scopes the caller should not pass a feeds map
// derived from filter.feeds (those modes don't use the map); pinning those
// scopes is deferred to v2 — the UI guards them.
//
// idx packs: for a feed/tag scope every idx pack touching the filter is needed
// (the reader's idx addressing jumps to arbitrary packs). For [ALL] all idx
// packs are included.
// Self-hosted asset keys as they appear (relative) in article content:
// assets/<2hex>/<16hex><ext>. Mirrors the SW's RE_ASSET shape; global so
// matchAll finds every reference in a data pack's articles.
const ASSET_REF_RE = /assets\/[0-9a-f]{2}\/[0-9a-f]{16}(?:\.\w+)?/gi

export async function packNamesForFilter(feeds: Map<number, number>): Promise<string[]> {
   if (db.total_art === 0) return []

   const nfIdx = numFinalizedIdx()
   const nfMeta = numFinalizedMeta()
   const seq = db.seq
   const names = new Set<string>()

   // Always include the latest generation packs — they hold the newest articles
   // of every filter and are the only packs in an empty/fresh store.
   names.add(`idx/L${seq}.gz`)
   names.add(`data/L${seq}.gz`)
   names.add(`meta/L${seq}.gz`)

   // The boot/search fast-path summaries, when the reader will actually use them
   // — distinct write-once files the online reader fetches but the pin used to
   // omit. Without idx/h<N> a feed/tag offline boot can't take the summary fast
   // path and falls back to eager-fetch-all (idx packs a feed/tag pin never
   // cached); without meta/s<N> search can't prune shards, so it's unavailable
   // offline even for a fully-pinned scope.
   const hdrs = db.hdrs ?? 0
   const mp = db.mp ?? 0
   if (nfIdx > 0 && hdrs === nfIdx) names.add(`idx/h${hdrs}.gz`) // offline reader boot
   if (mp > 0) names.add(`meta/s${mp}.gz`) // offline search

   const isAll = feeds.size === 0

   if (isAll) {
      // [ALL]: include every finalized pack of every series.
      for (let p = 0; p < nfIdx; p++) names.add(`idx/${p}.gz`)
      // data packs start at id 1; ids < next_pid are finalized.
      for (let id = 1; id < db.next_pid; id++) names.add(`data/${id}.gz`)
      for (let s = 0; s < nfMeta; s++) names.add(`meta/${s}.gz`)
   } else {
      // Feed/tag/unread scope: walk only the idx packs that have candidates.
      // For each matching chronIdx, derive the data pack id (from idx bounds)
      // and the meta shard id (floor(chron / META_PACK_SIZE)).
      const lookup = makeFeedsLookup(feeds, slots)

      for (let p = 0; p <= nfIdx; p++) {
         if (!packHasCandidate(p, feeds)) continue

         // This idx pack is needed (it has at least one matching article).
         const idxName = p < nfIdx ? `idx/${p}.gz` : `idx/L${seq}.gz`
         names.add(idxName)

         const pack = (await fetchIdxPack(p)).parse()
         const baseChron = p * IDX_PACK_SIZE
         const packSize = p < nfIdx ? IDX_PACK_SIZE : db.total_art - p * IDX_PACK_SIZE

         // Walk this idx pack's entries to find matching chronIdxs.
         // Use the bounds list to efficiently map chron → data pack id.
         let boundsIdx = 0
         const bounds = pack.bounds

         for (let i = 0; i < packSize; i++) {
            const feedId = pack.feedIds[i]
            const addIdx = feedId < lookup.length ? lookup[feedId] : -1
            const chron = baseChron + i
            if (addIdx !== -1 && chron >= addIdx) {
               // This chronIdx matches the filter.
               // Advance bounds pointer to find the data pack for this chron.
               while (boundsIdx + 1 < bounds.length && bounds[boundsIdx + 1].startChron <= chron) {
                  boundsIdx++
               }
               const dataPackId = bounds[boundsIdx].packId
               const dataName = dataPackId < db.next_pid ? `data/${dataPackId}.gz` : `data/L${seq}.gz`
               names.add(dataName)

               // Meta shard for this chron.
               const shardId = Math.floor(chron / META_PACK_SIZE)
               const metaName = shardId < nfMeta ? `meta/${shardId}.gz` : `meta/L${seq}.gz`
               names.add(metaName)
            }
         }
      }
   }

   // Enumerate the self-hosted assets/ images the pinned data packs reference, so
   // a pinned scope renders images offline (the SW's assetCacheFirst serves them
   // from the eviction-exempt PINNED bucket). Parse each needed data pack once
   // and scrape its articles' content for asset keys. For a narrow feed/tag
   // filter this may include a few co-located non-matching articles' assets —
   // harmless, since that data pack is pinned anyway and asset keys are
   // content-addressed. Pinning is an explicit "download for offline" action, so
   // the extra reads are acceptable.
   const dataNames = [...names].filter((n) => n.startsWith("data/"))
   for (const dn of dataNames) {
      const arts = parseJsonl<IArticle>(await fetchPackBytes(dn, dn === `data/L${seq}.gz`))
      for (const a of arts) {
         if (!a.c) continue
         for (const m of a.c.matchAll(ASSET_REF_RE)) names.add(m[0])
      }
   }

   return Array.from(names)
}
