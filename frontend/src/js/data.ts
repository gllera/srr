import { PACK_BASE } from "./base"
import { cachedPromise, makeLRU, type LRU } from "./cache"
import {
   DB_FORMAT_VERSION,
   IDX_ENTRY_SIZE,
   IDX_HEADER_PREFIX,
   META_PACK_SIZE,
   SEARCH_BLOOM_BYTES,
   type IMetaWire,
} from "./format.gen"
import {
   countAt,
   IDX_PACK_SIZE,
   lowerBound,
   makeFeedsLookup,
   makeIdxPack,
   parseIdxHeaders,
   tallyUnread,
   type IdxHeader,
   type IdxPack,
   type TallyFeed,
} from "./idx"

export { IDX_PACK_SIZE, META_PACK_SIZE }

// Every store object is fetched with an abort timeout armed across BOTH the
// request AND the body read: a connection that delivers headers then stalls
// mid-body (a mobile network handoff, sleep/wake, or a dead-but-open socket)
// leaves an un-timed-out fetch pending forever. Under app.ts's busy mutex that
// wedges ALL navigation until the page is reloaded — the reported "swipe stops
// working until refresh". On timeout abort() errors res.body, so the pending
// read rejects; cachedPromise then drops the slot so a retry refetches.
const FETCH_TIMEOUT_MS = 30_000

async function fetchTimed<T>(url: URL, cache: RequestCache, read: (res: Response) => Promise<T>): Promise<T> {
   const ctrl = new AbortController()
   const timer = setTimeout(
      () => ctrl.abort(new DOMException(`fetch timed out: ${url}`, "TimeoutError")),
      FETCH_TIMEOUT_MS,
   )
   try {
      return await read(await fetch(url, { cache, signal: ctrl.signal }))
   } finally {
      clearTimeout(timer)
   }
}

// no-cache forces a conditional revalidation on every load so a stale db.gz on
// the client (mobile browsers cache aggressively) can't make chronIdx URLs like
// `#14099` silently fall back to the last article via the `>= total_art` clamp
// in nav.fromHash. 304 keeps the hot path cheap when the CDN sends ETag /
// Last-Modified; the <link rel="preload"> in built HTML still warms the entry.
function loadDb(): Promise<IDB> {
   return fetchTimed(new URL("db.gz", PACK_BASE), "no-cache", parseDb)
}
const dbLoad = loadDb()

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
// The live delta chain (data/d<g>.gz for tailGen < g <= seq), fetched at boot
// and RESIDENT: each segment is one dirty cycle's whole batch as data-pack
// JSONL — the superset record the tail region derives everything from. Chrons
// at/above tailCovered() resolve idx entries (via the extended latest pack),
// meta cards, and article content from this slice and never touch a pack.
let deltaArts: IArticle[] = []
// In-flight delta-chain fetch for the current snapshot; the latest idx pack's
// builder awaits it so the tail bytes and the chain download in parallel.
let deltaLoad: Promise<IArticle[]> = Promise.resolve([])
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

// bgRefresh marks the window in which refresh() re-applies a new db.gz from the
// background heartbeat. In that window a transient tail 404 must NOT reload the
// app out from under a reading user: refresh() has its own recovery story (it
// restores the previous coherent snapshot wholesale and surfaces the failure via
// lastRefreshError), so the worst case is "stale until the next cycle".
//
// Boot and user navigation keep the reload — that is the designed stale-tab
// self-heal, and it is pinned by delta.e2e.test.ts's guarded-reload case.
// refresh() runs under app.ts's guardBg mutex, so no user navigation can
// observe this flag set.
let bgRefresh = false

function assertPackOk(res: Response, isLatest: boolean): void {
   if (res.ok) return
   if (isLatest && !bgRefresh && !sessionStorage.getItem(RELOAD_GUARD)) {
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
   // A store stamped newer than this build understands: its layout may have
   // changed in ways this reader would misread, so say so plainly through the
   // error popup instead of rendering wrong (or crashing on a shifted field).
   // Absent v (0) is a store written before the field existed — readable.
   if ((raw.v ?? 0) > DB_FORMAT_VERSION)
      throw new Error(
         `This reader is older than the store (format v${raw.v}, supported v${DB_FORMAT_VERSION}) — reload to update.`,
      )
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
   // reduce, not Math.max(...ids): a store approaching FEED_ID_CEILING would
   // overflow the JS engine's spread-argument limit and throw in init/refresh.
   slots = ids.reduce((m, id) => (id > m ? id : m), 0) + 1

   // Per-feed expired totals (db.gz xp), threaded into countLeft so the
   // immutable header cumulative counts are corrected to visible articles.
   expiredCounts = new Uint32Array(slots)
   for (const ch of Object.values(db.feeds)) expiredCounts[ch.id] = ch.xp ?? 0

   dataCache = makeLRU<Promise<IArticle[]>>(20)
   metaCache = makeLRU<Promise<IMetaWire[]>>(20)
   groupCache = {}
   // Reset idxFetches with the other derived caches — BEFORE the empty-store
   // early return — so a re-run against a total_art===0 store can never leave it
   // undefined for a later data path (nf===0 here, so this is makeLRU(1)).
   const nf = numFinalizedIdx()
   idxFetches = makeLRU(nf + 1)
   deltaArts = []
   deltaLoad = Promise.resolve([])

   if (db.total_art === 0) {
      idxHeaders = [] // defensive: a re-run must never leave headers from a previous snapshot
      sessionStorage.removeItem(RELOAD_GUARD)
      return
   }

   // The latest pack is always needed: it holds the newest articles (the
   // default landing view) and its header is the cumulative boundary after
   // the last finalized pack. Its builder awaits deltaLoad, so kicking the
   // chain fetch first downloads deltas, tail bytes, and the summary in
   // parallel; refetches of unchanged segments ride the SW/HTTP cache.
   deltaLoad = fetchDeltas()
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
   deltaArts = await deltaLoad // resolved: the latest pack's builder awaited it
   headers.push(latestIdx.header)
   idxHeaders = headers
   sessionStorage.removeItem(RELOAD_GUARD)
}

export async function init() {
   await applyDb(await dbLoad)
}

// tailGen names the consolidated tail packs (idx|data|meta/L<tailGen>): seq
// minus the live delta count. nd absent (a pre-delta store, or right after a
// consolidation) makes it seq — the historical latest-pack layout, so old
// stores read identically.
export function tailGen(): number {
   return db.seq - (db.nd ?? 0)
}

// tailCovered is the pack↔delta seam: chrons below it are served by the pack
// series, chrons at/above it by the resident delta articles.
export function tailCovered(): number {
   return db.total_art - (db.na ?? 0)
}

// deltaArticles exposes the resident chain (search.ts overlays it).
export function deltaArticles(): IArticle[] {
   return deltaArts
}

// fetchDeltas downloads + parses the live chain, oldest first. Write-once
// names → force-cache; every segment passes isLatest=true so a stale-db.gz
// tab whose deltas were GC'd self-heals with the guarded reload. The na
// cross-check mirrors the backend's loadDeltas (invariant I1): a mismatched
// chain must fail loudly, not misaddress every tail chron.
async function fetchDeltas(): Promise<IArticle[]> {
   const nd = db.nd ?? 0
   if (nd === 0) return []
   const base = tailGen() + 1
   const parts = await Promise.all(
      Array.from({ length: nd }, (_, i) =>
         fetchPackBytes(`data/d${base + i}.gz`, true).then((buf) => parseJsonl<IArticle>(buf)),
      ),
   )
   const all = parts.flat()
   if (all.length !== (db.na ?? 0)) {
      throw new Error(`delta chain holds ${all.length} articles but db.gz says ${db.na ?? 0}`)
   }
   return all
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
   const raw = await loadDb()
   if (
      raw.fetched_at === db.fetched_at &&
      raw.total_art === db.total_art &&
      raw.seq === db.seq &&
      (raw.gen ?? 0) === (db.gen ?? 0)
   )
      return "unchanged"
   // applyDb swaps db first (fetchIdxPack and the finalized-count math read the
   // module state), so a rejected pack fetch mid-apply would otherwise strand a
   // half-swapped snapshot — new db, stale idx structures — that the NEXT
   // refresh() can't repair (its compare above sees the new fetched_at and
   // reports "unchanged"). Restore the previous coherent snapshot wholesale on
   // failure: nothing mutates the old structures (applyDb replaces, never
   // edits), so they are still valid, and the next refresh() retries from the
   // old fetched_at like the failure never happened.
   // deltaArts/deltaLoad are in the set: applyDb reassigns deltaLoad to the new
   // chain fetch BEFORE it awaits, so a mid-apply reject must restore the old
   // deltaLoad too — delta-region loadArticle/loadMeta resolve against it, so a
   // stranded rejecting/half-loaded chain under the rolled-back (na>0) db would
   // otherwise fail every tail read until a full reload.
   const prev = {
      db,
      slots,
      expiredCounts,
      idxFetches,
      latestIdx,
      idxHeaders,
      dataCache,
      metaCache,
      groupCache,
      deltaArts,
      deltaLoad,
   }
   bgRefresh = true
   try {
      await applyDb(raw)
   } catch (e) {
      ;({
         db,
         slots,
         expiredCounts,
         idxFetches,
         latestIdx,
         idxHeaders,
         dataCache,
         metaCache,
         groupCache,
         deltaArts,
         deltaLoad,
      } = prev)
      throw e
   } finally {
      bgRefresh = false
   }
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
   return fetchTimed(new URL(path, PACK_BASE), "force-cache", (res) => {
      assertPackOk(res, isLatest)
      return new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
   })
}

// buildLatestIdx synthesizes the ONE logical latest idx pack spanning the
// whole tail [nf·50k, total_art): the physical idx/L<tailGen> bytes (header ‖
// tcEntries entries ‖ footer) with the delta articles' feed ids spliced in
// between entries and footer. Every consumer — counting, find*, tallyUnread,
// header math — then sees a uniform pack and needs no seam awareness. The
// footer's boundary indices all reference pre-splice entries, so the parse is
// undisturbed; delta-region chrons must never resolve content through
// getPackRef (loadArticle short-circuits them to the resident chain).
// Splice the delta articles' feed ids into out as 2-byte LE idx entries,
// starting at off; returns the offset past the last one. The single writer of
// the delta-entry layout, shared by both buildLatestIdx branches so a format
// tweak (e.g. IDX_ENTRY_SIZE) is edited once.
function writeFeedIds(out: Uint8Array, off: number, deltas: IArticle[]): number {
   for (const a of deltas) {
      out[off++] = a.f & 0xff
      out[off++] = (a.f >> 8) & 0xff
   }
   return off
}

function buildLatestIdx(tailBuf: ArrayBuffer | null, deltas: IArticle[], nf: number): IdxPack {
   const tcEntries = tailCovered() - nf * IDX_PACK_SIZE
   let buf: ArrayBuffer
   if (tailBuf) {
      const numSlots = new Uint32Array(tailBuf, 0, 3)[2]
      const entriesEnd = IDX_HEADER_PREFIX + numSlots * 4 + tcEntries * IDX_ENTRY_SIZE
      if (tailBuf.byteLength < entriesEnd) {
         throw new Error(`idx tail: ${tailBuf.byteLength}B but db.gz expects >= ${entriesEnd}B`)
      }
      const src = new Uint8Array(tailBuf)
      const out = new Uint8Array(tailBuf.byteLength + deltas.length * IDX_ENTRY_SIZE)
      out.set(src.subarray(0, entriesEnd), 0)
      const off = writeFeedIds(out, entriesEnd, deltas)
      out.set(src.subarray(entriesEnd), off) // the boundary footer, verbatim
      buf = out.buffer
   } else {
      // All-delta store (tailCovered 0): no tail pack was ever written —
      // synthesize the minimal zero header (bases 0, numSlots 0) + entries.
      const out = new Uint8Array(IDX_HEADER_PREFIX + deltas.length * IDX_ENTRY_SIZE)
      writeFeedIds(out, IDX_HEADER_PREFIX, deltas)
      buf = out.buffer
   }
   return makeIdxPack(buf, nf, tcEntries + deltas.length, slots)
}

// Starts (or joins) the fetch of one idx pack.
function fetchIdxPack(p: number): Promise<IdxPack> {
   return cachedPromise(idxFetches, p, async () => {
      if (p < numFinalizedIdx()) {
         return makeIdxPack(await fetchPackBytes(`idx/${p}.gz`, false), p, IDX_PACK_SIZE, slots)
      }
      const tcEntries = tailCovered() - p * IDX_PACK_SIZE
      const [tailBuf, deltas] = await Promise.all([
         tcEntries > 0 ? fetchPackBytes(`idx/L${tailGen()}.gz`, true) : Promise.resolve(null),
         deltaLoad,
      ])
      return buildLatestIdx(tailBuf, deltas, p)
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

// Batched per-feed unread counting: ONE latest-tail pass for every feed at
// once (idx.tallyUnread) instead of the per-feed countAll/countLeft fan-out
// that re-scanned the same resident pack once per feed. Synchronous like
// countAll — the latest pack is resident since init. Feeds whose seen
// frontier sits below the latest pack's base need finalized-pack scans (and
// possibly fetches); they come back in `rare` for the caller's per-feed async
// fallback — structurally empty while total_art ≤ IDX_PACK_SIZE.
export function unreadTally<T extends TallyFeed>(
   chs: T[],
   seenOf: (id: number) => number | undefined,
): { counts: Map<number, number>; rare: T[] } {
   if (db.total_art === 0) return { counts: new Map(chs.map((c) => [c.id, 0])), rare: [] }
   return tallyUnread(latestIdx, numFinalizedIdx() * IDX_PACK_SIZE, db.total_art, slots, chs, seenOf, expiredCounts)
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
   // Structural seam guard (mirrors the Go mirror's deltaPackID sentinel): the
   // extended latest pack's bounds end at the last REAL data pack, so a
   // delta-region chron reaching here would silently misroute into it. Every
   // legitimate caller short-circuits at tailCovered() first — fail loudly if
   // a future one forgets.
   if (chronIdx >= tailCovered()) {
      throw new Error(`getPackRef(${chronIdx}): delta-region chron has no data pack (seam at ${tailCovered()})`)
   }
   const n = packIdx(chronIdx)
   const bounds = (await fetchIdxPack(n)).parse().bounds
   // The last bound whose startChron <= chronIdx.
   const bound = bounds[lowerBound(bounds.length, (i) => bounds[i].startChron <= chronIdx) - 1]
   return { packId: bound.packId, offset: chronIdx - bound.startChron }
}

let dataCache = makeLRU<Promise<IArticle[]>>(20)

async function fetchDataPack(packId: number): Promise<IArticle[]> {
   const isFinalized = packId < db.next_pid
   const name = isFinalized ? packId.toString() : `L${tailGen()}`
   return fetchTimed(new URL(`data/${name}.gz`, PACK_BASE), "force-cache", async (res) => {
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
   })
}

export async function loadArticle(chronIdx: number): Promise<IArticle> {
   // Delta-region chrons are resident — no pack holds them (and the extended
   // latest pack's bounds would misroute them to the last data pack). Resolve
   // from deltaLoad, NOT the deltaArts array: applyDb installs the new db
   // (na>0) and wipes deltaArts to [] several awaits before it repopulates it,
   // so an unguarded caller (list IntersectionObserver paging, the idle-callback
   // neighbor prefetch) reading a delta-region chron in that window would hit an
   // empty array and throw. deltaLoad is set synchronously with db (before any
   // await), so it is always the in-flight/resolved chain for the installed
   // snapshot; tc and the deltaLoad reference are captured in the same
   // synchronous run, so they can't disagree. After boot it is already resolved,
   // so the await is a free microtask.
   const tc = tailCovered()
   if (chronIdx >= tc) {
      const a = (await deltaLoad)[chronIdx - tc]
      if (!a) throw new Error(`delta chain out of sync at chron ${chronIdx}; retry to refresh`)
      return a
   }
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
   // The meta series covers the consolidated region only; the resident delta
   // chain carries the rest (na) — coverage is complete when the three parts
   // sum to the store.
   return mp === numFinalizedMeta() && mp * META_PACK_SIZE + (db.mt ?? 0) + (db.na ?? 0) === db.total_art
}

let metaCache = makeLRU<Promise<IMetaWire[]>>(20)

function metaPackId(chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / META_PACK_SIZE), numFinalizedMeta())
}

function loadMetaPack(n: number): Promise<IMetaWire[]> {
   return cachedPromise(metaCache, n, async () => {
      const isFinalized = n < numFinalizedMeta()
      const path = `meta/${isFinalized ? n.toString() : `L${tailGen()}`}.gz`
      const buf = await fetchPackBytes(path, !isFinalized)
      // Finalized shards carry a SEARCH_BLOOM_BYTES bloom prefix; the latest tail does not.
      return parseJsonl<IMetaWire>(isFinalized ? buf.slice(SEARCH_BLOOM_BYTES) : buf)
   })
}

// loadMeta returns one card. The newest window comes straight from db.head
// (the writer's newest-glance projection riding db.gz — the one object every
// load already fetches, so the home list's landing costs zero meta fetches);
// below that, meta/ when the projection is consistent (metaReady), otherwise
// the data/ source of truth (projected) so the home list never breaks while
// meta lags after a failed SyncMeta. head is addressed by its OWN base chron
// (db.hb, absent = 0) rather than total_art: SyncMeta is warn-only, so a
// db.gz can carry a grown total_art with the previous cycle's head — anchored
// to hb, that stale head still serves correct (immutable) cards for its own
// range and the new chrons fall through. head needs no metaReady gate. A
// stale-tab 404 on the latest meta pack is NOT handled here — it self-heals
// via the guarded reload in fetchPackBytes (same as the reader's data/ path).
export async function loadMeta(chronIdx: number): Promise<IMetaWire> {
   // Delta-region cards project straight off the resident chain — zero
   // fetches, and the meta series deliberately does not cover these chrons.
   // Via deltaLoad, not the deltaArts array, for the applyDb-window reason in
   // loadArticle.
   const tc = tailCovered()
   if (chronIdx >= tc) {
      const a = (await deltaLoad)[chronIdx - tc]
      if (a) return { f: a.f, w: a.p || a.a, t: a.t }
   }
   const head = db.head
   if (head?.length) {
      const base = db.hb ?? 0
      if (chronIdx >= base && chronIdx < base + head.length) return head[chronIdx - base]
   }
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
   const tg = tailGen()
   const tc = tailCovered()
   const names = new Set<string>()

   // Always include the tail generation packs and the live delta segments —
   // they hold the newest articles of every filter. An all-delta store
   // (tailCovered 0) never wrote a tail generation, so those names are
   // skipped rather than pinned as guaranteed 404s.
   if (tc > 0) {
      names.add(`idx/L${tg}.gz`)
      names.add(`data/L${tg}.gz`)
      names.add(`meta/L${tg}.gz`)
   }
   const deltaNames = new Set<string>()
   for (let g = tg + 1; g <= db.seq; g++) {
      names.add(`data/d${g}.gz`)
      deltaNames.add(`data/d${g}.gz`)
   }

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

         // This idx pack is needed (it has at least one matching article). The
         // latest pack's physical name exists only when a tail was consolidated.
         if (p < nfIdx) names.add(`idx/${p}.gz`)
         else if (tc > 0) names.add(`idx/L${tg}.gz`)

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
               // Delta-region matches are covered by the unconditionally-added
               // delta segments — no data pack or meta shard holds them.
               if (chron >= tc) continue
               // This chronIdx matches the filter.
               // Advance bounds pointer to find the data pack for this chron.
               while (boundsIdx + 1 < bounds.length && bounds[boundsIdx + 1].startChron <= chron) {
                  boundsIdx++
               }
               const dataPackId = bounds[boundsIdx].packId
               const dataName = dataPackId < db.next_pid ? `data/${dataPackId}.gz` : `data/L${tg}.gz`
               names.add(dataName)

               // Meta shard for this chron.
               const shardId = Math.floor(chron / META_PACK_SIZE)
               const metaName = shardId < nfMeta ? `meta/${shardId}.gz` : `meta/L${tg}.gz`
               names.add(metaName)
            }
         }
      }
   }

   // Enumerate the self-hosted assets/ images the pinned data packs reference, so
   // a pinned scope renders images offline (the SW's pinnedCacheFirst serves them
   // from the eviction-exempt PINNED bucket). Parse each needed data pack once
   // and scrape its articles' content for asset keys. For a narrow feed/tag
   // filter this may include a few co-located non-matching articles' assets —
   // harmless, since that data pack is pinned anyway and asset keys are
   // content-addressed. Pinning is an explicit "download for offline" action, so
   // the extra reads are acceptable.
   const dataNames = [...names].filter((n) => n.startsWith("data/") && !deltaNames.has(n))
   for (const dn of dataNames) {
      const arts = parseJsonl<IArticle>(await fetchPackBytes(dn, dn === `data/L${tg}.gz`))
      for (const a of arts) {
         if (!a.c) continue
         for (const m of a.c.matchAll(ASSET_REF_RE)) names.add(m[0])
      }
   }
   // Delta-region articles are resident — scrape their asset refs without a fetch.
   for (const a of deltaArts) {
      if (!a.c) continue
      for (const m of a.c.matchAll(ASSET_REF_RE)) names.add(m[0])
   }

   return Array.from(names)
}
