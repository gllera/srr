import { HOME, type StoreContext } from "./base"
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
import { RELOAD_GUARD_KEY } from "./keys"
import { activeMounts, loadMounts, reconcileMounts, renameStoreState, saveMounts, type MountRecord } from "./mounts"
import { keyAt, legacyNames, manifestNames, type IManifestWire, type StoreNames } from "./names"

export { IDX_PACK_SIZE, META_PACK_SIZE }

// Every store object is fetched with an abort timeout armed across BOTH the
// request AND the body read: a connection that delivers headers then stalls
// mid-body (a mobile network handoff, sleep/wake, or a dead-but-open socket)
// leaves an un-timed-out fetch pending forever. Under app.ts's busy mutex that
// wedges ALL navigation until the page is reloaded — the reported "swipe stops
// working until refresh". On timeout abort() errors res.body, so the pending
// read rejects; cachedPromise then drops the slot so a retry refetches.
const FETCH_TIMEOUT_MS = 30_000

async function fetchTimed<T>(
   url: URL,
   cache: RequestCache,
   cred: RequestCredentials,
   read: (res: Response) => Promise<T>,
): Promise<T> {
   const ctrl = new AbortController()
   const timer = setTimeout(
      () => ctrl.abort(new DOMException(`fetch timed out: ${url}`, "TimeoutError")),
      FETCH_TIMEOUT_MS,
   )
   try {
      return await read(await fetch(url, { cache, credentials: cred, signal: ctrl.signal }))
   } finally {
      clearTimeout(timer)
   }
}

// One coherent view of the store: the normalized db state plus the resolved
// object names it addresses through. They travel together — every rollback,
// swap and cross-check below is on the PAIR, never on one half (see refresh()).
interface Snapshot {
   db: IDB
   names: StoreNames
}

// The per-store runtime record: the StoreContext identity/config (mid, base,
// cred, role — base.ts) PLUS every piece of state that WAS a module-level `let`.
// One of these exists per mounted store; S38 has N, S37 has just the home store.
// Every fetch/compute function below takes one explicitly (defaulting to the
// active store), so nothing reaches for a hidden global mid-operation: the store
// is bound at call entry and used throughout, which is what lets a background
// refresh of one store never race the lane a reader is navigating.
export interface Store extends StoreContext {
   // The eager db.gz fetch this store kicked at construction (init/refresh await it).
   dbLoad: Promise<Snapshot>
   // The normalized db state and the resolved object names it addresses through.
   db: IDB
   // The ONLY source of a pack key in this module — nothing below formats one.
   names: StoreNames
   // One in-flight-or-resolved fetch per idx pack (finalized 0..nf-1, latest at
   // nf; capacity covers every pack, so nothing ever evicts) — packs are fetched
   // once and stay resident. Only the latest pack is fetched eagerly — latestIdx
   // keeps it reachable synchronously for countAll. idxHeaders always holds every
   // pack's header (from idx/h<N>.gz on the summary path, or peeled off each pack
   // on the eager fallback), so counting, pack-skipping, and timestamp search
   // never force a pack fetch.
   idxFetches: LRU<Promise<IdxPack>>
   idxHeaders: IdxHeader[]
   latestIdx: IdxPack
   // The live delta chain (data/d<g>.gz for tailGen < g <= seq), fetched at boot
   // and RESIDENT: each segment is one dirty cycle's whole batch as data-pack
   // JSONL — the superset record the tail region derives everything from. Chrons
   // at/above tailCovered() resolve idx entries (via the extended latest pack),
   // meta cards, and article content from this slice and never touch a pack.
   deltaArts: IArticle[]
   // In-flight delta-chain fetch for the current snapshot; the latest idx pack's
   // builder awaits it so the tail bytes and the chain download in parallel.
   deltaLoad: Promise<IArticle[]>
   // Store high-water + 1: the size of the per-pack feed lookup arrays
   // (feedIds/ownFeedCounts and the filter lookup). Sized to the actual feed
   // count, not the format ceiling. Computed once at applyDb from db.feeds.
   slots: number
   expiredCounts: Uint32Array
   dataCache: LRU<Promise<IArticle[]>>
   metaCache: LRU<Promise<IMetaWire[]>>
   groupCache: Partial<Record<"active" | "all", GroupResult>>
   // One in-flight-or-resolved manifest, keyed by its generation number.
   // Manifest names are write-once, so this can never go stale; it exists so an
   // unchanged poll (refresh() re-parses the root every 5 minutes) costs no
   // second fetch.
   manifestMemo: { m: number; man: Promise<IManifestWire> } | null
   // Marks the window in which refresh() re-applies a new db.gz from the
   // background heartbeat (see assertPackOk).
   bgRefresh: boolean
}

function makeStore(ctx: StoreContext): Store {
   const s = {
      ...ctx,
      dbLoad: undefined as unknown as Promise<Snapshot>,
      db: undefined as unknown as IDB,
      names: undefined as unknown as StoreNames,
      idxFetches: makeLRU<Promise<IdxPack>>(1),
      idxHeaders: [] as IdxHeader[],
      latestIdx: undefined as unknown as IdxPack,
      deltaArts: [] as IArticle[],
      deltaLoad: Promise.resolve([] as IArticle[]),
      slots: 1,
      expiredCounts: new Uint32Array(0),
      dataCache: makeLRU<Promise<IArticle[]>>(20),
      metaCache: makeLRU<Promise<IMetaWire[]>>(20),
      groupCache: {} as Partial<Record<"active" | "all", GroupResult>>,
      manifestMemo: null as Store["manifestMemo"],
      bgRefresh: false,
   }
   // Kick the eager db.gz fetch at construction — for the home store this fires
   // at module load (the boot-latency property the reader has always had),
   // BEFORE init() is called. A no-cache load forces a conditional revalidation
   // so a stale db.gz on the client can't make chronIdx URLs like `#14099`
   // silently fall back to the last article via the `>= total_art` clamp in
   // nav.fromHash; 304 keeps the hot path cheap; the <link rel="preload"> in
   // built HTML still warms the entry.
   s.dbLoad = loadDb(s)
   return s
}

// The home store — the one the build points at (base.ts HOME) — always mounted,
// its eager db.gz fetch kicked at module load (the boot-latency property).
const home = makeStore(HOME)

// The store registry, keyed by mount id (docs/MULTI-STORE-SPEC.md §4/§8). Home
// is always present; peers are created from the mount table at init and when the
// user mounts one. `active` is the lane the UI is currently reading.
const stores = new Map<string, Store>([[home.mid, home]])
let active: Store = home

// Per-mount boot/refresh status for the UI's mount card + error chip (§8.3).
// A failed mount degrades to a per-mount error state — it never blanks the
// reader (MS4). The chip variant is derived from `kind` + navigator.onLine.
export type MountKind = "" | "offline" | "toonew" | "error"
export interface MountStatus {
   state: "ok" | "error"
   kind: MountKind
   error: string // human chip text ("" when ok)
}
const statuses = new Map<string, MountStatus>()
// Per-mount backoff for the background peer poll (§8.3): 1min → 5min → 30min
// cap, reset on any success or an `online` event. A dead peer must not cost a
// request every cycle forever.
interface Backoff {
   ms: number
   nextAt: number
}
const backoffs = new Map<string, Backoff>()
const BACKOFF_MIN = 60_000
const BACKOFF_MAX = 1_800_000

// The mount table (mounts.ts records). The UI reads it for the picker sections +
// the SW `mounts` post. Loaded at MODULE LOAD (not just init) so app.ts can post
// the roots to the SW BEFORE data.init() kicks the peer stores' fetches — the SW
// must already know a cross-origin root to route + cache its packs (PWA0).
// init() reconciles it (home-collision/rename) and applyMountTable() keeps it
// current; both reassign this.
let mountTable: MountRecord[] = loadMounts()

// activeStore is the nav/UI layer's one notion of "the lane I am in"
// (docs/MULTI-STORE-SPEC.md §11.2). The data/search hot functions take a store
// explicitly (defaulting to this) rather than reading `active` internally.
export function activeStore(): Store {
   return active
}

// The active lane's normalized db state, mirrored for the read-mostly consumers
// (nav/list/picker/search/app read `data.db.feeds` etc.). The source of truth is
// active.db on the Store record above; this is kept === active.db by applyDb and
// the refresh() rollback, and by setActive when the lane changes.
export let db: IDB

// storeNames exposes the active snapshot's names to search.ts, the other module
// that fetches store objects (the meta shards, tail and bloom summary).
export function storeNames(store: Store = active): StoreNames {
   return store.names
}

// A StoreContext from a mount record: the home mount is the build's HOME context
// verbatim (bare keys, no migration); a peer resolves its base + credentials
// from the record.
function ctxFromMount(m: MountRecord): StoreContext {
   if (m.id === HOME.mid) return HOME
   return {
      mid: m.id,
      base: new URL(m.url),
      cred: m.cred ? "include" : "same-origin",
      role: m.role,
   }
}

// mountedStores: the Store for every ACTIVE (non-deleted) mount, in picker order
// (home first, then peers by ord). Includes stores whose boot failed — the
// picker shows those as an error chip, not a lane (§8.3). One entry per record;
// a record with no created store yet (should not happen post-init) is skipped.
export function mountedStores(): Store[] {
   const out: Store[] = []
   for (const m of activeMounts(mountTable)) {
      const s = stores.get(m.id)
      if (s) out.push(s)
   }
   return out
}

export function mountStore(mid: string): Store | undefined {
   return stores.get(mid)
}

export function mountStatus(mid: string): MountStatus {
   return statuses.get(mid) ?? { state: "ok", kind: "", error: "" }
}

// The reconciled mount table — the UI's picker sections + app.ts's SW `mounts`
// post read it. A copy so callers can't mutate the module's state.
export function mountRecords(): MountRecord[] {
   return mountTable
}

// Re-point the active lane. Keeps the `db` mirror coherent (nav/list/picker read
// data.db). Returns false when the mid names no mounted, successfully-booted
// store (the caller stays on the current lane). A peer in an error state has no
// usable db, so it cannot become active.
export function setActive(mid: string): boolean {
   const s = stores.get(mid)
   if (!s || !s.db || mountStatus(mid).state !== "ok") return false
   active = s
   db = s.db
   return true
}

// Classify a boot/refresh failure into a chip kind (§8.3). A CORS rejection and
// a network outage are indistinguishable to fetch (both a TypeError) — the chip
// is honest about that ("Unreachable…") rather than claiming a cause.
function classifyError(e: unknown): { kind: MountKind; error: string } {
   const msg = e instanceof Error ? e.message : String(e)
   if (/older than the store/.test(msg)) return { kind: "toonew", error: msg }
   // fetch threw (no Response) — network, CORS, or a timeout/abort.
   if (e instanceof TypeError || (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")))
      return { kind: "offline", error: "Unreachable" }
   return { kind: "error", error: msg }
}

// Boot ONE store: run its per-mount handshake (its eager db.gz fetch → parseDb →
// applyDb). On success record "ok"; on failure record the per-mount error state
// and rethrow so the caller's Promise.allSettled sees the rejection (init uses
// that only to decide the all-failed global-popup case). A store that is not
// `active` never touches the `db` mirror (applyDb guards on `store === active`).
async function bootStore(s: Store): Promise<void> {
   try {
      await applyDb(s, await s.dbLoad)
      statuses.set(s.mid, { state: "ok", kind: "", error: "" })
      backoffs.delete(s.mid)
   } catch (e) {
      statuses.set(s.mid, { state: "error", ...classifyError(e) })
      throw e
   }
}

function loadDb(store: Store): Promise<Snapshot> {
   return fetchTimed(new URL("db.gz", store.base), "no-cache", store.cred, (res) => parseDb(store, res))
}

function assertPackOk(store: Store, res: Response, isLatest: boolean): void {
   if (res.ok) return
   // A pack name is write-once, so a non-OK response means the name itself no
   // longer matches the store. For a latest pack (L<seq>) that means this tab's
   // db.gz predates the backend's GC grace window — only a fresh db.gz (fetched
   // no-cache) can name the current generation, so reload once. The
   // sessionStorage guard prevents reload loops; it is cleared only after a
   // successful applyDb so a transient failure can't permanently disable
   // self-healing for the tab. During a background refresh (store.bgRefresh) the
   // reload is suppressed — refresh() has its own recovery (restore the previous
   // coherent snapshot, surface via lastRefreshError), so a transient tail 404
   // must not yank a reading user out; refresh() runs under app.ts's guardBg
   // mutex, so no user navigation can observe the flag set.
   //
   // §8.5: the guarded reload is a WHOLE-PAGE action, so it is HOME-ONLY. Firing
   // it because a PEER's tail 404'd would yank a reading user out of an unrelated
   // store; a peer instead just throws here, and its own refreshPeers/retryMount
   // re-boots that mount in place (the scoped recovery). The single global
   // reload guard stays correct — it guards the global action, cleared once the
   // home mount completes a successful applyDb.
   if (store.role === "home" && isLatest && !store.bgRefresh && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      sessionStorage.setItem(RELOAD_GUARD_KEY, "1")
      location.reload()
   }
   // reload() doesn't halt execution — always throw so callers never touch
   // res.body, and so the failure stays visible when the guard suppressed
   // the reload (or under jsdom, where reload is a no-op).
   throw new Error(`pack fetch failed: ${res.status} ${res.url}`)
}

// The root object as it arrives on the wire, before the dual-path resolution
// below: either today's full legacy db.gz (IDBWire) or the v2 pointer
// {v, m, t} the S34 cutover shrinks it to.
type IRootWire = Partial<IDBWire> & { t?: number }

function loadManifest(store: Store, m: number): Promise<IManifestWire> {
   if (store.manifestMemo?.m === m) return store.manifestMemo.man
   const man = fetchTimed(new URL(`manifest/${m}.gz`, store.base), "force-cache", store.cred, async (res) => {
      // NOT assertPackOk: a 404 here is not the stale-tab tail-GC case that
      // reload self-heals. The root we just fetched no-cache is by definition
      // current, so it names a manifest the store should still serve; if it
      // doesn't, reloading would fetch the same pair again. Surface it.
      if (!res.ok) throw new Error(`manifest/${m}.gz fetch failed: ${res.status} ${res.url}`)
      return (await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()) as IManifestWire
   }).then((parsed) => {
      // manifest/<m>.gz is write-once, so its body can only ever describe
      // generation m. A disagreement means the store served something else
      // entirely — refuse it rather than address every pack through the wrong
      // generation's name list.
      if (parsed.m !== m) throw new Error(`manifest/${m}.gz declares generation ${parsed.m}`)
      // One constant for the whole store format: the root and every manifest
      // it names carry the same `v` (backend dbFormatVersion), because a root
      // is a pointer into the manifest chain and neither is meaningful without
      // the other.
      if ((parsed.v ?? 0) > DB_FORMAT_VERSION)
         throw new Error(
            `This reader is older than the store (manifest v${parsed.v}, supported v${DB_FORMAT_VERSION}) — reload to update.`,
         )
      return parsed
   })
   store.manifestMemo = { m, man }
   // A rejected memo must not poison the next attempt (the cachedPromise
   // discipline, applied by hand since this is a single slot).
   man.catch(() => {
      if (store.manifestMemo?.man === man) store.manifestMemo = null
   })
   return man
}

// The root selection rule — THE ROOT IS AUTHORITATIVE FOR WHAT IT CARRIES; the
// manifest supplies only what the root omits (docs/MANIFEST-SPEC.md §8.1).
//
//   • A v2 root ({v, m, t}) follows the indirection.
//   • A PRE-CUTOVER root — one whose writer has not migrated it yet — carries
//     the full legacy document, and `total_art` is the probe: it is a
//     non-omitempty key every such db.gz carries (even at 0), and a v2 root
//     carries none of the manifest-sourced fields at all. Such a store is read
//     through the derived names it was written with, never hard-errored.
//
// The predicate switches branch on the BYTES, not on a build flag, which is
// what let this reader ship before the writer flipped and what lets it keep
// reading a store the writer has not reached yet.
function rootIsLegacy(raw: IRootWire): boolean {
   return raw.total_art !== undefined
}

// The read-side twin of rootIsLegacy for an ALREADY-NORMALIZED snapshot.
// rootIsLegacy switches the PARSE branch on the wire's `total_art` probe, but a
// normalized db always carries total_art, so change-detection (refresh()) keys
// on the store-format version instead — retained verbatim through both root
// paths (fromManifestRoot copies `raw.v`, fromLegacyRoot keeps the wire's). The
// manifest era begins at v2 — the {v, m, t} pointer the cutover shrank db.gz to
// (v2 was the retired dual-write encoding, v3 the current one); a pre-cutover
// legacy root is v1, or an absent v (0). This is what lets refresh() compare
// ONLY `m` under a manifest root (docs/MANIFEST-SPEC.md §8.1 G2).
function isManifestRoot(db: IDB): boolean {
   return (db.v ?? 0) >= 2
}

async function parseDb(store: Store, res: Response): Promise<Snapshot> {
   // A missing/erroring store (404 on a fresh/empty store or a misconfigured CDN
   // URL, or a 5xx) would otherwise try to gunzip an HTML error body and reject
   // with a cryptic "incorrect header check"; surface the real status instead
   // (mirrors assertPackOk for the pack fetches).
   if (!res.ok) throw new Error(`db.gz fetch failed: ${res.status} ${res.url}`)
   const raw: IRootWire = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   // A store stamped newer than this build understands: its layout may have
   // changed in ways this reader would misread, so say so plainly through the
   // error popup instead of rendering wrong (or crashing on a shifted field).
   // Absent v (0) is a store written before the field existed — readable.
   if ((raw.v ?? 0) > DB_FORMAT_VERSION)
      throw new Error(
         `This reader is older than the store (format v${raw.v}, supported v${DB_FORMAT_VERSION}) — reload to update.`,
      )
   const snap = rootIsLegacy(raw) ? fromLegacyRoot(raw) : await fromManifestRoot(store, raw)
   snap.db.feeds ??= {}
   snap.db.seq ??= 0 // backend omitempty: absent for an empty store
   for (const [k, ch] of Object.entries(snap.db.feeds)) ch.id = Number(k)
   return snap
}

function fromLegacyRoot(raw: IRootWire): Snapshot {
   const legacy = raw as IDB
   return {
      db: legacy,
      names: legacyNames({
         total_art: legacy.total_art,
         seq: legacy.seq ?? 0,
         nd: legacy.nd,
         na: legacy.na,
         next_pid: legacy.next_pid,
         hdrs: legacy.hdrs,
         mp: legacy.mp,
      }),
   }
}

// fromManifestRoot follows the root's indirection and normalizes the manifest
// into the same in-memory IDB shape the rest of the module consumes, so
// everything downstream of parseDb is root-shape-blind.
async function fromManifestRoot(store: Store, raw: IRootWire): Promise<Snapshot> {
   const m = raw.m ?? 0
   if (m <= 0)
      throw new Error(
         `db.gz carries no store state and names no manifest (m=${m}) — this store cannot be read by this reader.`,
      )
   const man = await loadManifest(store, m)
   const resolved = manifestNames(man)
   const finalizedMeta = resolved.meta.keys.length - (resolved.meta.tail >= 0 ? 1 : 0)
   const normalized: IDB = {
      v: raw.v,
      m,
      // `t` on the root is the same fetched_at the manifest carries; the root
      // copy is what lets an idle cycle rewrite 60 bytes and leave `m` — and
      // therefore every reader's cached manifest — untouched (§4.1).
      fetched_at: raw.t ?? man.fetched_at,
      total_art: man.total_art,
      mt: man.mt,
      na: man.na,
      head: man.head,
      hb: man.hb,
      pack_off: man.pack_off ?? 0,
      feeds: (man.feeds ?? {}) as Record<number, IFeed>,
      // The name-derivation counters the manifest RETIRES (§5.1). They are
      // synthesized from the LISTED names purely so the reader's coverage
      // gates (metaReady, idxSummaryDegraded, numFinalized*) keep exactly one
      // implementation across both root shapes. NOTHING builds a key from them
      // any more — `names` above is the only source of a pack name.
      seq: 0,
      nd: resolved.deltas.length,
      next_pid: resolved.data.tail >= 0 ? resolved.data.tail : resolved.data.keys.length,
      hdrs: resolved.hsum?.covers ?? 0,
      mp: finalizedMeta,
   }
   // The pack↔delta seam, cross-checked on the NAMING side before a single
   // pack is addressed: a store whose delta chain holds articles must name the
   // segments holding them, and one with no live chain must name none.
   // fetchDeltas below then cross-checks the same seam on the CONTENT side
   // (parsed article count vs `na`) — both directions fail loudly, neither
   // misaddresses.
   const na = normalized.na ?? 0
   if (na > 0 !== resolved.deltas.length > 0)
      throw new Error(`manifest ${m}: ${resolved.deltas.length} delta segment(s) named for ${na} delta article(s)`)
   return { db: normalized, names: resolved }
}

// The (re-runnable) boot body: swap the snapshot into `store` and rebuild
// everything derived from it. Also the refresh() path — the caches are recreated
// wholesale (one code path, no diff logic); refetches ride the SW/HTTP cache,
// and on a gen change the stale bytes MUST go anyway.
async function applyDb(store: Store, snap: Snapshot): Promise<void> {
   // db and names are installed TOGETHER and synchronously, before any await:
   // every name the rest of this function resolves must belong to the snapshot
   // it is applying, and deltaLoad below is set in the same synchronous run.
   store.db = snap.db
   store.names = snap.names
   if (store === active) db = snap.db // keep the active-lane mirror coherent

   // Size the per-pack feed lookup arrays to the store's high-water id + 1
   // (min 1). All feedIds in packs and filters are store feed ids, so this
   // bounds the typed-array allocations by the actual feed count.
   const ids = Object.keys(store.db.feeds).map(Number)
   // reduce, not Math.max(...ids): a store approaching FEED_ID_CEILING would
   // overflow the JS engine's spread-argument limit and throw in init/refresh.
   store.slots = ids.reduce((m, id) => (id > m ? id : m), 0) + 1

   // Per-feed expired totals (db.gz xp), threaded into countLeft so the
   // immutable header cumulative counts are corrected to visible articles.
   store.expiredCounts = new Uint32Array(store.slots)
   for (const ch of Object.values(store.db.feeds)) store.expiredCounts[ch.id] = ch.xp ?? 0

   store.dataCache = makeLRU<Promise<IArticle[]>>(20)
   store.metaCache = makeLRU<Promise<IMetaWire[]>>(20)
   store.groupCache = {}
   // Reset idxFetches with the other derived caches — BEFORE the empty-store
   // early return — so a re-run against a total_art===0 store can never leave it
   // undefined for a later data path (nf===0 here, so this is makeLRU(1)).
   const nf = numFinalizedIdx(store)
   store.idxFetches = makeLRU(nf + 1)
   store.deltaArts = []
   store.deltaLoad = Promise.resolve([])

   if (store.db.total_art === 0) {
      store.idxHeaders = [] // defensive: a re-run must never leave headers from a previous snapshot
      sessionStorage.removeItem(RELOAD_GUARD_KEY)
      return
   }

   // The latest pack is always needed: it holds the newest articles (the
   // default landing view) and its header is the cumulative boundary after
   // the last finalized pack. Its builder awaits deltaLoad, so kicking the
   // chain fetch first downloads deltas, tail bytes, and the summary in
   // parallel; refetches of unchanged segments ride the SW/HTTP cache.
   store.deltaLoad = fetchDeltas(store)
   const latest = fetchIdxPack(store, nf)

   let headers: IdxHeader[] | null = null
   if (nf > 0 && store.names.hsum?.covers === nf) {
      try {
         headers = parseIdxHeaders(await fetchPackBytes(store.names.hsum.key, false, store), nf)
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
      const packs = await Promise.all(Array.from({ length: nf }, (_, p) => fetchIdxPack(store, p)))
      headers = packs.map((p) => p.header)
   }
   store.latestIdx = await latest
   store.deltaArts = await store.deltaLoad // resolved: the latest pack's builder awaited it
   headers.push(store.latestIdx.header)
   store.idxHeaders = headers
   sessionStorage.removeItem(RELOAD_GUARD_KEY)
}

// Boot all mounted stores in parallel (docs/MULTI-STORE-SPEC.md §8.2). Each
// mount's handshake is independent (Promise.allSettled): one bad mount records a
// per-mount error state and never blanks the reader (MS4). Only when EVERY mount
// fails does init throw — reaching app.ts's global error popup (today's
// single-store behavior). The active lane lands on home when it booted, else the
// first healthy mount (§8.3 "the reader still opens on the first healthy mount").
export async function init() {
   // Load + reconcile the mount table (home-collision collapse, rename replay —
   // §3.2/§3.5); persist any reconciliation so it doesn't recompute every boot.
   const loaded = loadMounts()
   const { records, renames } = reconcileMounts(loaded)
   for (const r of renames) renameStoreState(r.from, r.to)
   if (renames.length) saveMounts(records)
   mountTable = records

   // Create a Store per active mount (home already exists; creating a peer kicks
   // its eager db.gz fetch). A record for the home url other than mount 0 was
   // collapsed by reconcileMounts, so every active peer here is a real peer.
   for (const m of activeMounts(mountTable)) {
      if (!stores.has(m.id)) stores.set(m.id, makeStore(ctxFromMount(m)))
   }

   const booting = mountedStores()
   const results = await Promise.allSettled(booting.map((s) => bootStore(s)))

   // Pick the active lane: home if it booted, else the first healthy mount.
   if (mountStatus(home.mid).state === "ok") setActive(home.mid)
   else {
      const firstOk = booting.find((s) => mountStatus(s.mid).state === "ok")
      if (firstOk) setActive(firstOk.mid)
   }

   // Every mount failed → surface the global error popup (today's behavior). Use
   // home's rejection reason so the message matches the single-store case.
   if (!booting.some((s) => mountStatus(s.mid).state === "ok")) {
      const homeIdx = booting.findIndex((s) => s.mid === home.mid)
      const r = results[homeIdx] ?? results[0]
      throw r && r.status === "rejected" ? r.reason : new Error("no store could be loaded")
   }
}

// Adopt a changed mount table at runtime (the user mounted/unmounted a store, or
// a sync pull merged the table). Boots newly-added mounts, records the reconciled
// table, and drops the runtime state of unmounted stores (their device state
// survives per §3.4 — only the Store cache is released). Returns the mids of
// mounts that newly booted OK, so the caller can repaint the picker. Does NOT
// change the active lane unless it was unmounted (then it falls back to home).
export async function applyMountTable(recs: MountRecord[]): Promise<string[]> {
   const { records, renames } = reconcileMounts(recs)
   for (const r of renames) renameStoreState(r.from, r.to)
   mountTable = records
   saveMounts(records)

   const wanted = new Set(activeMounts(mountTable).map((m) => m.id))
   // Drop stores for mounts that are gone (never home).
   for (const mid of [...stores.keys()]) {
      if (mid !== home.mid && !wanted.has(mid)) {
         stores.delete(mid)
         statuses.delete(mid)
         backoffs.delete(mid)
      }
   }
   // If the active lane was unmounted, fall back to home.
   if (!stores.has(active.mid)) setActive(home.mid)

   // Create + boot newly-added mounts.
   const fresh: Store[] = []
   for (const m of activeMounts(mountTable)) {
      if (!stores.has(m.id)) {
         const s = makeStore(ctxFromMount(m))
         stores.set(m.id, s)
         fresh.push(s)
      }
   }
   await Promise.allSettled(fresh.map((s) => bootStore(s)))
   return fresh.filter((s) => mountStatus(s.mid).state === "ok").map((s) => s.mid)
}

// tailCovered is the pack↔delta seam: chrons below it are served by the pack
// series, chrons at/above it by the resident delta articles.
export function tailCovered(store: Store = active): number {
   return store.db.total_art - (store.db.na ?? 0)
}

// deltaArticles exposes the resident chain (search.ts overlays it).
export function deltaArticles(store: Store = active): IArticle[] {
   return store.deltaArts
}

// fetchDeltas downloads + parses the live chain, oldest first, from the names
// the snapshot resolved (derived from seq/nd under a legacy root, LISTED under
// a manifest one). Write-once names → force-cache; every segment passes
// isLatest=true so a stale-db.gz tab whose deltas were GC'd self-heals with
// the guarded reload. The na cross-check mirrors the backend's loadDeltas
// (invariant I1) and is the CONTENT half of the seam check: a mismatched chain
// must fail loudly, not misaddress every tail chron.
async function fetchDeltas(store: Store): Promise<IArticle[]> {
   const keys = store.names.deltas
   if (keys.length === 0) return []
   const parts = await Promise.all(
      keys.map((k) => fetchPackBytes(k, true, store).then((buf) => parseJsonl<IArticle>(buf))),
   )
   const all = parts.flat()
   if (all.length !== (store.db.na ?? 0)) {
      throw new Error(`delta chain holds ${all.length} articles but the store says ${store.db.na ?? 0}`)
   }
   return all
}

// refresh() re-fetches db.gz and re-runs the boot path when the store moved.
// The swap decision keys on the STORE's own change signal, which depends on the
// RESIDENT root shape (docs/MANIFEST-SPEC.md §8.1 G2):
//
//   • Under a MANIFEST root (v3) `m` is that signal and `m` ALONE — every
//     publishing Commit bumps it (invariants M2/M3), so total_art/seq cannot
//     move without it, while the root's `t` (→ fetched_at) DOES move on an idle
//     cycle (a fully backoff-thinned poll, a zero-feed maintenance cycle) that
//     leaves `m` untouched. Comparing fetched_at there would misclassify that
//     ~60-byte rewrite as "updated" and needlessly re-run applyDb +
//     search.invalidate() + nav.onStoreRefreshed() every poll. fetched_at is
//     still read for the "Updated X ago" freshness line; it just no longer
//     triggers a re-process.
//   • A pre-cutover LEGACY root keeps the four-field compare — its idle cycles
//     rewrote the whole document, so m/fetched_at/total_art/seq together are the
//     signal. Branching on the RESIDENT shape also keeps a legacy→manifest
//     migration adoptable: the resident is still legacy, so the four-field
//     compare sees m/total_art/fetched_at all move and reports "updated".
//
// An in-place rebuild needs no signal of its own — it writes NEW names, so it
// moves `m` like everything else, which is exactly what retired `gen`. The SW's
// checkManifest rides this same response, reconciling its cache before our
// subsequent pack refetches.
export async function refresh(store: Store = active): Promise<"unchanged" | "updated"> {
   const snap = await loadDb(store)
   const raw = snap.db
   const unchanged = isManifestRoot(store.db)
      ? (raw.m ?? 0) === (store.db.m ?? 0)
      : (raw.m ?? 0) === (store.db.m ?? 0) &&
        raw.fetched_at === store.db.fetched_at &&
        raw.total_art === store.db.total_art &&
        raw.seq === store.db.seq
   if (unchanged) {
      // Keep the "Updated X ago" freshness readout live even when we skip the
      // re-process: under a manifest root an idle cycle (a fully backoff-thinned
      // poll, a zero-feed maintenance cycle) advances the root's `t` without
      // moving `m`, and picker.renderStatus reads it via lastFetchedAt(). The
      // m-only compare above ignores fetched_at, so refreshing it in place can't
      // perturb the next comparison; for a legacy root the compare already
      // required equality, so this is a no-op there. Nothing else is derived
      // from fetched_at, so no applyDb work is owed.
      store.db.fetched_at = raw.fetched_at ?? store.db.fetched_at
      return "unchanged"
   }
   // applyDb swaps db first (fetchIdxPack and the finalized-count math read the
   // store state), so a rejected pack fetch mid-apply would otherwise strand a
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
   // `names` is in the set for the same reason `db` is, and it is the half the
   // manifest indirection adds: applyDb installs the two together, so a
   // mid-apply reject must restore BOTH or the module would address the old
   // db's chrons through the new store's name lists — the exact "consistent
   // set, not a mix of old legacy fields and new manifest fields" the
   // Appendix-D rollback rule forbids. All of it lives on the ONE Store record,
   // so the snapshot is that record's fields captured before the swap.
   const prev = {
      db: store.db,
      names: store.names,
      slots: store.slots,
      expiredCounts: store.expiredCounts,
      idxFetches: store.idxFetches,
      latestIdx: store.latestIdx,
      idxHeaders: store.idxHeaders,
      dataCache: store.dataCache,
      metaCache: store.metaCache,
      groupCache: store.groupCache,
      deltaArts: store.deltaArts,
      deltaLoad: store.deltaLoad,
   }
   store.bgRefresh = true
   try {
      await applyDb(store, snap)
   } catch (e) {
      Object.assign(store, prev)
      if (store === active) db = store.db // re-point the active-lane mirror to the restored snapshot
      throw e
   } finally {
      store.bgRefresh = false
   }
   return "updated"
}

// Refresh every mounted store EXCEPT the active one (the active lane is refreshed
// by refresh.ts's existing path, which also reconciles nav/search/UI). This is
// the background peer poll (§6.3 "refresh.ts polls every enabled mount"). Each
// peer respects its backoff window (§8.3) and a failed OR not-yet-booted peer is
// retried here — a booted peer that recovers becomes a usable lane. Returns
// whether ANY peer changed shape, so the caller can repaint the picker (peer
// unread rollups). A peer refresh never touches the active lane's nav state.
export async function refreshPeers(): Promise<boolean> {
   const now = Date.now()
   let anyUpdated = false
   await Promise.all(
      mountedStores()
         .filter((s) => s !== active)
         .map(async (s) => {
            const b = backoffs.get(s.mid)
            if (b && now < b.nextAt) return // still in backoff
            try {
               const needsBoot = !s.db || mountStatus(s.mid).state === "error"
               if (needsBoot) {
                  // A never-booted or errored mount: (re)fetch db.gz from scratch.
                  // bgRefresh suppresses assertPackOk's guarded reload — this is a
                  // BACKGROUND poll, so even the home store (in here only when it
                  // failed to boot and a peer is active) must never reload the page.
                  s.dbLoad = loadDb(s)
                  s.bgRefresh = true
                  try {
                     await applyDb(s, await s.dbLoad)
                  } finally {
                     s.bgRefresh = false
                  }
                  statuses.set(s.mid, { state: "ok", kind: "", error: "" })
                  anyUpdated = true
               } else if ((await refresh(s)) === "updated") {
                  anyUpdated = true
               }
               backoffs.delete(s.mid)
            } catch (e) {
               statuses.set(s.mid, { state: "error", ...classifyError(e) })
               const prev = backoffs.get(s.mid)?.ms ?? 0
               const ms = prev ? Math.min(prev * 5, BACKOFF_MAX) : BACKOFF_MIN
               backoffs.set(s.mid, { ms, nextAt: now + ms })
            }
         }),
   )
   return anyUpdated
}

// Reset every mount's backoff (an `online` event, or the user's retry action) so
// the next poll retries immediately (§8.3 "reset on any success or an `online`
// event").
export function resetMountBackoff(mid?: string): void {
   if (mid) backoffs.delete(mid)
   else backoffs.clear()
}

// Retry ONE mount now: clear its backoff and (re)boot it. Used by the mount
// card's per-mount retry action (§8.3). Returns true if it booted OK.
export async function retryMount(mid: string): Promise<boolean> {
   const s = stores.get(mid)
   if (!s) return false
   backoffs.delete(mid)
   try {
      s.dbLoad = loadDb(s)
      await applyDb(s, await s.dbLoad)
      statuses.set(mid, { state: "ok", kind: "", error: "" })
      return true
   } catch (e) {
      statuses.set(mid, { state: "error", ...classifyError(e) })
      return false
   }
}

// Finalized idx-pack count for the current store (the latest pack holds the
// rest). Used throughout for idx addressing and the header summary.
export function numFinalizedIdx(store: Store = active): number {
   return store.db.total_art > 0 ? Math.floor((store.db.total_art - 1) / IDX_PACK_SIZE) : 0
}

// Finalized meta-shard count. The meta/ series strides at META_PACK_SIZE (a
// divisor of IDX_PACK_SIZE), so this differs from numFinalizedIdx. Used by the
// list and search to address meta shards and gate coverage (see metaReady).
export function numFinalizedMeta(store: Store = active): number {
   return store.db.total_art > 0 ? Math.floor((store.db.total_art - 1) / META_PACK_SIZE) : 0
}

// feedTitle resolves a feed_id for display: a deleted feed's articles
// stay in the packs, so render a tombstone instead of crashing (the rendering
// contract `srr inspect`'s unknown-feeds diagnostic references).
export function feedTitle(feedId: number, store: Store = active): string {
   return store.db.feeds[feedId]?.title ?? "[DELETED]"
}

// Unix timestamp of the last successful backend fetch (0 when never fetched).
export function lastFetchedAt(store: Store = active): number {
   return store.db.fetched_at
}

// True when the idx header summary lags the store (old backend, warn-only summary
// failure, or a post-rebuild gap). The reader is still correct but fetches all
// idx packs on boot instead of using the fast summary path.
export function idxSummaryDegraded(store: Store = active): boolean {
   const nf = numFinalizedIdx(store)
   // Only an actively-advancing summary rebuild (hdrs partway) — NOT a steady
   // pre-summary store (hdrs===0/absent, e.g. an old backend), which would pin a
   // permanent, misleading "(optimizing index…)" banner the user can't act on.
   return nf > 0 && (store.db.hdrs ?? 0) > 0 && (store.db.hdrs ?? 0) < nf
}

// Fetches + gunzips one pack key. Every pack name is write-once — a stem is
// drawn from a counter that is never reused — so the HTTP cache may serve them
// all without revalidation (force-cache). Also used by the meta/ loaders (list + search): like the idx
// and data loaders, the latest meta pack passes isLatest=true so a 404 on a
// stale-db.gz tab self-heals with one guarded reload; finalized meta shards
// pass false (write-once, never GC'd). The "meta lagged" case is handled
// upstream by metaReady() (loadMeta skips meta entirely), not here.
export async function fetchPackBytes(path: string, isLatest: boolean, store: Store = active): Promise<ArrayBuffer> {
   return fetchTimed(new URL(path, store.base), "force-cache", store.cred, (res) => {
      assertPackOk(store, res, isLatest)
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

function buildLatestIdx(store: Store, tailBuf: ArrayBuffer | null, deltas: IArticle[], nf: number): IdxPack {
   const tcEntries = tailCovered(store) - nf * IDX_PACK_SIZE
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
   return makeIdxPack(buf, nf, tcEntries + deltas.length, store.slots)
}

// Starts (or joins) the fetch of one idx pack.
function fetchIdxPack(store: Store, p: number): Promise<IdxPack> {
   return cachedPromise(store.idxFetches, p, async () => {
      if (p < numFinalizedIdx(store)) {
         return makeIdxPack(
            await fetchPackBytes(keyAt(store.names.idx, p, `idx pack ${p}`), false, store),
            p,
            IDX_PACK_SIZE,
            store.slots,
         )
      }
      const tcEntries = tailCovered(store) - p * IDX_PACK_SIZE
      // tcEntries > 0 means the store consolidated a tail, so it MUST name one
      // — keyAt fails loudly instead of synthesizing a name that would 404
      // (§4.5: no computed-name fallback). deltaLoad is awaited alongside the
      // tail bytes so the chain and the pack download in parallel; the splice
      // in buildLatestIdx depends on both.
      const [tailBuf, deltas] = await Promise.all([
         tcEntries > 0 ? fetchPackBytes(keyAt(store.names.idx, p, "idx tail"), true, store) : Promise.resolve(null),
         store.deltaLoad,
      ])
      return buildLatestIdx(store, tailBuf, deltas, p)
   })
}

function packIdx(store: Store, chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / IDX_PACK_SIZE), numFinalizedIdx(store))
}

export async function getFeedId(chronIdx: number, store: Store = active): Promise<number> {
   const n = packIdx(store, chronIdx)
   const feedIds = (await fetchIdxPack(store, n)).parse().feedIds
   return feedIds[chronIdx - n * IDX_PACK_SIZE]
}

// Total filtered count across the whole store. Synchronous on purpose:
// chronIdx=total_art always lands in the latest pack (resident since init),
// whose header carries the cumulative counts of every finalized pack — so
// nav's filter bookkeeping never waits on a fetch.
export function countAll(feeds: Map<number, number>, store: Store = active): number {
   if (store.db.total_art === 0) return 0
   return store.latestIdx.countLeft(store.db.total_art, feeds, makeFeedsLookup(feeds, store.slots), store.expiredCounts)
}

export async function countLeft(chronIdx: number, feeds: Map<number, number>, store: Store = active): Promise<number> {
   if (store.db.total_art === 0) return 0
   const n = packIdx(store, chronIdx)
   return (await fetchIdxPack(store, n)).countLeft(
      chronIdx,
      feeds,
      makeFeedsLookup(feeds, store.slots),
      store.expiredCounts,
   )
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
   store: Store = active,
): { counts: Map<number, number>; rare: T[] } {
   if (store.db.total_art === 0) return { counts: new Map(chs.map((c) => [c.id, 0])), rare: [] }
   return tallyUnread(
      store.latestIdx,
      numFinalizedIdx(store) * IDX_PACK_SIZE,
      store.db.total_art,
      store.slots,
      chs,
      seenOf,
      store.expiredCounts,
   )
}

// A finalized pack can be skipped without fetching it: its per-feed
// counts are the deltas between consecutive cumulative headers. The latest
// pack has no next boundary — it is resident anyway and scans cheaply.
function packHasCandidate(store: Store, p: number, feeds: Map<number, number>): boolean {
   if (p >= numFinalizedIdx(store)) return true
   // Mid-refresh header swap can briefly outrun this array — treat unknown as candidate.
   const cur = store.idxHeaders[p]
   const next = store.idxHeaders[p + 1]
   if (!cur || !next) return true
   const packEnd = (p + 1) * IDX_PACK_SIZE
   for (const [feedId, addIdx] of feeds) {
      const delta = countAt(next.feedCounts, feedId) - countAt(cur.feedCounts, feedId)
      if (delta > 0 && addIdx < packEnd) return true
   }
   return false
}

export async function findLeft(from: number, feeds: Map<number, number>, store: Store = active): Promise<number> {
   if (from < 0 || store.db.total_art === 0) return -1
   const lookup = makeFeedsLookup(feeds, store.slots)
   for (let p = packIdx(store, from); p >= 0; p--) {
      if (!packHasCandidate(store, p, feeds)) continue
      const found = (await fetchIdxPack(store, p)).findLeft(from, feeds, lookup)
      if (found !== -1) return found
   }
   return -1
}

export async function findRight(from: number, feeds: Map<number, number>, store: Store = active): Promise<number> {
   if (from < 0) from = 0
   if (from >= store.db.total_art) return -1
   const lookup = makeFeedsLookup(feeds, store.slots)
   const nf = numFinalizedIdx(store)
   for (let p = packIdx(store, from); p <= nf; p++) {
      if (!packHasCandidate(store, p, feeds)) continue
      const found = (await fetchIdxPack(store, p)).findRight(from, feeds, lookup)
      if (found !== -1) return found
   }
   return -1
}

async function getPackRef(store: Store, chronIdx: number): Promise<{ packId: number; offset: number }> {
   // Structural seam guard (mirrors the Go mirror's deltaPackID sentinel): the
   // extended latest pack's bounds end at the last REAL data pack, so a
   // delta-region chron reaching here would silently misroute into it. Every
   // legitimate caller short-circuits at tailCovered() first — fail loudly if
   // a future one forgets.
   if (chronIdx >= tailCovered(store)) {
      throw new Error(`getPackRef(${chronIdx}): delta-region chron has no data pack (seam at ${tailCovered(store)})`)
   }
   const n = packIdx(store, chronIdx)
   const bounds = (await fetchIdxPack(store, n)).parse().bounds
   // The last bound whose startChron <= chronIdx.
   const bound = bounds[lowerBound(bounds.length, (i) => bounds[i].startChron <= chronIdx) - 1]
   return { packId: bound.packId, offset: chronIdx - bound.startChron }
}

async function fetchDataPack(store: Store, packId: number): Promise<IArticle[]> {
   // The idx footer's packId IS the positional index into the data series'
   // name list — exactly what it has always been, whether the list is derived
   // (legacy) or listed (manifest).
   const key = keyAt(store.names.data, packId, `data pack ${packId}`)
   const isLatest = packId === store.names.data.tail
   return fetchTimed(new URL(key, store.base), "force-cache", store.cred, async (res) => {
      assertPackOk(store, res, isLatest)
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

export async function loadArticle(chronIdx: number, store: Store = active): Promise<IArticle> {
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
   const tc = tailCovered(store)
   if (chronIdx >= tc) {
      const a = (await store.deltaLoad)[chronIdx - tc]
      if (!a) throw new Error(`delta chain out of sync at chron ${chronIdx}; retry to refresh`)
      return a
   }
   const ref = await getPackRef(store, chronIdx)
   const entries = await cachedPromise(store.dataCache, ref.packId, () => fetchDataPack(store, ref.packId))
   if (ref.offset >= entries.length) {
      // Pack names are write-once, so this is unreachable in normal operation;
      // it survives as defense-in-depth for a store rebuilt in place (same
      // names, new bytes) before its `gen` bump propagates. Drop the cache so
      // a retry refetches.
      store.dataCache.drop(ref.packId)
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
export function hasArticles(store: Store = active): boolean {
   return store.db.total_art > 0
}

// meta/ is a warn-only derived projection, so after a failed SyncMeta it can
// lag db.gz for one fetch cycle. metaReady() reports whether mp+mt fully cover
// the store — only then is every meta shard (finalized + tail) present and
// consistent. The list and search both gate on it; the list falls back to data/.
export function metaReady(store: Store = active): boolean {
   if (store.db.total_art === 0) return false
   const mp = store.db.mp ?? 0
   // The meta series covers the consolidated region only; the resident delta
   // chain carries the rest (na) — coverage is complete when the three parts
   // sum to the store.
   return (
      mp === numFinalizedMeta(store) &&
      mp * META_PACK_SIZE + (store.db.mt ?? 0) + (store.db.na ?? 0) === store.db.total_art
   )
}

function metaPackId(store: Store, chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / META_PACK_SIZE), numFinalizedMeta(store))
}

function loadMetaPack(store: Store, n: number): Promise<IMetaWire[]> {
   return cachedPromise(store.metaCache, n, async () => {
      const isLatest = n === store.names.meta.tail
      const buf = await fetchPackBytes(keyAt(store.names.meta, n, `meta shard ${n}`), isLatest, store)
      // Finalized shards carry a SEARCH_BLOOM_BYTES bloom prefix; the latest tail does not.
      return parseJsonl<IMetaWire>(isLatest ? buf : buf.slice(SEARCH_BLOOM_BYTES))
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
export async function loadMeta(chronIdx: number, store: Store = active): Promise<IMetaWire> {
   // Delta-region cards project straight off the resident chain — zero
   // fetches, and the meta series deliberately does not cover these chrons.
   // Via deltaLoad, not the deltaArts array, for the applyDb-window reason in
   // loadArticle.
   const tc = tailCovered(store)
   if (chronIdx >= tc) {
      const a = (await store.deltaLoad)[chronIdx - tc]
      if (a) return { f: a.f, w: a.p || a.a, t: a.t }
   }
   const head = store.db.head
   if (head?.length) {
      const base = store.db.hb ?? 0
      if (chronIdx >= base && chronIdx < base + head.length) return head[chronIdx - base]
   }
   if (metaReady(store)) {
      const n = metaPackId(store, chronIdx)
      const entries = await loadMetaPack(store, n)
      const e = entries[chronIdx - n * META_PACK_SIZE]
      if (e) return e
      // Defensive: an undefined slot (coverage race) — fall through to data/.
   }
   const a = await loadArticle(chronIdx, store)
   return { f: a.f, w: a.p || a.a, t: a.t }
}

type GroupResult = { tagged: Map<string, IFeed[]>; sortedTags: string[]; untagged: IFeed[] }

export function groupFeedsByTag(includeEmpty = false, store: Store = active): GroupResult {
   const key = includeEmpty ? "all" : "active"
   const cached = store.groupCache[key]
   if (cached) return cached
   const tagged = new Map<string, IFeed[]>()
   const untagged: IFeed[] = []
   const feeds = Object.values(store.db.feeds)
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
   store.groupCache[key] = result
   return result
}

// packNamesForFilter enumerates the write-once pack names needed to read a
// given filter scope end-to-end offline. The names are relative pack paths
// (e.g. "meta/0.gz", "data/1.gz", "idx/L1.gz") — the same strings the fetch
// handler sees after the "/packs/" prefix, and the same form data.ts resolves
// against the store base when fetching. The SW message handler prefixes them
// with "packs/" to build the full request URL.
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

export async function packNamesForFilter(feeds: Map<number, number>, store: Store = active): Promise<string[]> {
   if (store.db.total_art === 0) return []

   const nfIdx = numFinalizedIdx(store)
   const tc = tailCovered(store)
   // The enumerator reads the SAME resolved name lists every fetch site uses,
   // so a pinned scope caches exactly the keys the online reader would request
   // under either root shape (§8.3: "it already enumerates names, and now it
   // reads them from a list instead of reconstructing them").
   const names = store.names
   const out = new Set<string>()
   const dataWanted = new Set<string>()
   const addData = (key: string | undefined) => {
      if (!key) return
      out.add(key)
      dataWanted.add(key)
   }

   // Always include the tail of every series and the live delta segments —
   // they hold the newest articles of every filter. A series with no tail (an
   // all-delta store never consolidated one) contributes nothing rather than a
   // guaranteed 404.
   if (names.idx.tail >= 0) out.add(names.idx.keys[names.idx.tail])
   if (names.meta.tail >= 0) out.add(names.meta.keys[names.meta.tail])
   if (names.data.tail >= 0) addData(names.data.keys[names.data.tail])
   for (const k of names.deltas) out.add(k)

   // The boot/search fast-path summaries, when the reader will actually use them
   // — distinct write-once files the online reader fetches but the pin used to
   // omit. Without idx/h<N> a feed/tag offline boot can't take the summary fast
   // path and falls back to eager-fetch-all (idx packs a feed/tag pin never
   // cached); without meta/s<N> search can't prune shards, so it's unavailable
   // offline even for a fully-pinned scope.
   if (nfIdx > 0 && names.hsum?.covers === nfIdx) out.add(names.hsum.key) // offline reader boot
   if (names.ssum) out.add(names.ssum.key) // offline search

   const isAll = feeds.size === 0

   if (isAll) {
      // [ALL]: include every listed object of every series (the tails above
      // included — a Set, so re-adding is free).
      for (const k of names.idx.keys) if (k) out.add(k)
      for (const k of names.data.keys) addData(k)
      for (const k of names.meta.keys) if (k) out.add(k)
   } else {
      // Feed/tag/unread scope: walk only the idx packs that have candidates.
      // For each matching chronIdx, derive the data pack id (from idx bounds)
      // and the meta shard id (floor(chron / META_PACK_SIZE)).
      const lookup = makeFeedsLookup(feeds, store.slots)

      for (let p = 0; p <= nfIdx; p++) {
         if (!packHasCandidate(store, p, feeds)) continue

         // This idx pack is needed (it has at least one matching article). The
         // tail position is listed only when a tail was consolidated.
         const idxKey = names.idx.keys[p]
         if (idxKey) out.add(idxKey)

         const pack = (await fetchIdxPack(store, p)).parse()
         const baseChron = p * IDX_PACK_SIZE
         const packSize = p < nfIdx ? IDX_PACK_SIZE : store.db.total_art - p * IDX_PACK_SIZE

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
               addData(names.data.keys[bounds[boundsIdx].packId])

               // Meta shard for this chron.
               const metaKey = names.meta.keys[Math.floor(chron / META_PACK_SIZE)]
               if (metaKey) out.add(metaKey)
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
   const dataTailKey = names.data.tail >= 0 ? names.data.keys[names.data.tail] : null
   for (const dn of dataWanted) {
      const arts = parseJsonl<IArticle>(await fetchPackBytes(dn, dn === dataTailKey, store))
      for (const a of arts) {
         if (!a.c) continue
         for (const m of a.c.matchAll(ASSET_REF_RE)) out.add(m[0])
      }
   }
   // Delta-region articles are resident — scrape their asset refs without a fetch.
   for (const a of store.deltaArts) {
      if (!a.c) continue
      for (const m of a.c.matchAll(ASSET_REF_RE)) out.add(m[0])
   }

   return Array.from(out)
}
