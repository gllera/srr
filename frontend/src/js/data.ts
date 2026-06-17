import { PACK_BASE } from "./base"
import { cachedPromise, makeLRU, type LRU } from "./cache"
import { FETCHED_AT_BLOCK } from "./format.gen"
import {
   countAt,
   findPackForBlocks,
   IDX_PACK_SIZE,
   lowerBound,
   makeFeedsLookup,
   makeIdxPack,
   parseIdxHeaders,
   type IdxHeader,
   type IdxPack,
} from "./idx"

export { IDX_PACK_SIZE }

// no-cache forces a conditional revalidation on every load so a stale db.gz on
// the client (mobile browsers cache aggressively) can't make chronIdx URLs like
// `#14099` silently fall back to the last article via the `>= total_art` clamp
// in nav.fromHash. 304 keeps the hot path cheap when the CDN sends ETag /
// Last-Modified; the <link rel="preload"> in built HTML still warms the entry.
const dbFetch = fetch(new URL("db.gz", PACK_BASE), { cache: "no-cache" })

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

export async function init() {
   const res = await dbFetch
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.feeds ??= {}
   raw.seq ??= 0 // backend omitempty: absent for an empty store
   for (const [k, ch] of Object.entries(raw.feeds)) ch.id = Number(k)
   db = raw

   // Size the per-pack feed lookup arrays to the store's high-water id + 1
   // (min 1). All feedIds in packs and filters are store feed ids, so this
   // bounds the typed-array allocations by the actual feed count.
   const ids = Object.keys(db.feeds).map(Number)
   slots = ids.length > 0 ? Math.max(...ids) + 1 : 1

   if (db.total_art === 0) {
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

// Exported for search.ts: the search/ shards align 1:1 with idx packs, so its
// coverage gate and chron bases derive from the same formula.
export function numFinalizedIdx(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / IDX_PACK_SIZE) : 0
}

// feedTitle resolves a feed_id for display: a deleted feed's articles
// stay in the packs, so render a tombstone instead of crashing (the rendering
// contract `srr inspect`'s unknown-feeds diagnostic references).
export function feedTitle(feedId: number): string {
   return db.feeds[feedId]?.title ?? "[DELETED]"
}

// Fetches + gunzips one pack key. Every pack name is write-once (finalized
// numeric, the L<seq> generation or h<N>/s<N> summary a db.gz commit
// published), so the HTTP cache may serve them all without revalidation
// (force-cache). Exported for search.ts (the search/ series rides the same
// addressing); isLatest=false there — a missing search pack degrades search
// instead of triggering the guarded reload.
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

// Binary search for leftmost entry where fetchedAt >= ts: pack-level over
// the always-resident headers, then entry-level inside the one target pack.
export async function findChronForTimestamp(ts: number): Promise<number> {
   // `?? 0` guards a hand-edited/migrated db.gz missing first_fetched: the
   // writer always emits it (omitempty dropped backend-side), but an absent
   // key would make the subtraction NaN and collapse the search to index 0.
   const tsBlocks = Math.trunc(ts / FETCHED_AT_BLOCK) - Math.trunc((db.first_fetched ?? 0) / FETCHED_AT_BLOCK)
   const n = findPackForBlocks(idxHeaders, tsBlocks)
   const chron = (await fetchIdxPack(n)).findChronForBlocks(tsBlocks)
   return chron < db.total_art ? chron : Math.max(0, db.total_art - 1)
}

// Total filtered count across the whole store. Synchronous on purpose:
// chronIdx=total_art always lands in the latest pack (resident since init),
// whose header carries the cumulative counts of every finalized pack — so
// nav's filter bookkeeping never waits on a fetch.
export function countAll(feeds: Map<number, number>): number {
   if (db.total_art === 0) return 0
   return latestIdx.countLeft(db.total_art, feeds, makeFeedsLookup(feeds, slots))
}

export async function countLeft(chronIdx: number, feeds: Map<number, number>): Promise<number> {
   if (db.total_art === 0) return 0
   const n = packIdx(chronIdx)
   return (await fetchIdxPack(n)).countLeft(chronIdx, feeds, makeFeedsLookup(feeds, slots))
}

// A finalized pack can be skipped without fetching it: its per-feed
// counts are the deltas between consecutive cumulative headers. The latest
// pack has no next boundary — it is resident anyway and scans cheaply.
function packHasCandidate(p: number, feeds: Map<number, number>): boolean {
   if (p >= numFinalizedIdx()) return true
   const cur = idxHeaders[p].feedCounts
   const next = idxHeaders[p + 1].feedCounts
   const packEnd = (p + 1) * IDX_PACK_SIZE
   for (const [feedId, addIdx] of feeds) {
      const delta = countAt(next, feedId) - countAt(cur, feedId)
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

const dataCache = makeLRU<Promise<IArticle[]>>(20)

function loadDataPack(packId: number): Promise<IArticle[]> {
   return cachedPromise(dataCache, packId, () => fetchDataPack(packId))
}

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
   const entries = await loadDataPack(ref.packId)
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

let activeFeedsCache: IFeed[] | null = null
function activeFeeds(): IFeed[] {
   if (activeFeedsCache) return activeFeedsCache
   activeFeedsCache = Object.values(db.feeds)
      .filter((ch) => ch.total_art > 0)
      .sort((a, b) => (a.title < b.title ? -1 : 1))
   return activeFeedsCache
}

type GroupResult = { tagged: Map<string, IFeed[]>; sortedTags: string[]; untagged: IFeed[] }
let groupCache: GroupResult | null = null

export function groupFeedsByTag(): GroupResult {
   if (groupCache) return groupCache
   const tagged = new Map<string, IFeed[]>()
   const untagged: IFeed[] = []
   for (const ch of activeFeeds()) {
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
   groupCache = { tagged, sortedTags: Array.from(tagged.keys()).sort(), untagged }
   return groupCache
}
