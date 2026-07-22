import * as data from "./data"
import { extractPrefetchMedia } from "./fmt"
import { savedKey, seenKey, seenTsKey, UNREAD_ONLY_KEY } from "./keys"
import * as search from "./search"
import * as sync from "./sync"

// The seen/saved keys are per-store (docs/MULTI-STORE-SPEC.md §4.2): they are
// namespaced by the ACTIVE store's mid, the lane nav is reading. For the home
// store (mid "0") these resolve to the bare legacy names (srr-seen / srr-seen-ts
// / srr-saved), so a single-store user's state is unchanged.
const seenK = () => seenKey(data.activeStore().mid)
const seenTsK = () => seenTsKey(data.activeStore().mid)
const savedK = () => savedKey(data.activeStore().mid)

let pos = -1
// Feed id of the article currently on screen (-1 = none). app.ts reads it via
// currentFeedId; anchorChron pairs it with pos for the list anchor. Unread
// counting never consults it — reading is accounted on ENTER (recordSeen).
let currentFeed = -1
const next: { left?: Promise<number>; right?: Promise<number> } = {}

// Unseen-only navigation: when on, the active filter skips articles already
// seen (per the seen positions read at filter-apply time), so you glide past
// feeds you're caught up on. A device-local preference, not part of the
// shareable #pos!tokens hash. See filter.set / filter.applyUnseen and
// dropdown.ts's chip.
let unreadOnly = ((): boolean => {
   try {
      return localStorage.getItem(UNREAD_ONLY_KEY) === "1"
   } catch {
      return false
   }
})()
export function isUnreadOnly(): boolean {
   return unreadOnly
}
export function setUnreadOnly(on: boolean) {
   unreadOnly = on
   try {
      // Persist BOTH states explicitly ("1"/"0"): an absent key means "never
      // chosen", which app.ts treats as the unread-only default on first run — so
      // a user who turns it off must store "0", not clear the key, or it'd revert.
      localStorage.setItem(UNREAD_ONLY_KEY, on ? "1" : "0")
   } catch {}
   // Re-apply the current filter so its members immediately pick up (or shed) the
   // raised unseen-only bounds — the caller just flips the mode and rebuilds.
   applyFilter([...filter.tokens])
}

// Saved articles ("★ Saved") — a per-article collection orthogonal to the
// feed/tag axes and the positional seen frontier. Stored device-local as a
// chronIdx set in localStorage (srr-saved), like srr-seen. chronIdx is a
// permanent article address — finalized packs are immutable and never GC'd — so
// a saved id stays loadable indefinitely (it survives even its feed being
// deleted; data.feedTitle then shows the "[DELETED]" tombstone). "★ Saved" is
// a distinct nav MODE (filter.saved): navigation walks the explicit set, not the
// idx packs, so it needs no fetch and is feed-agnostic. The reserved token
// "~saved" addresses the mode in the #hash and the filter rotation; a
// (vanishingly unlikely) real tag literally named "~saved" is shadowed by it.
export const SAVED_TOKEN = "~saved"

// Re-read on each access (no module-level cache): the set is small and
// user-curated, so the localStorage parse is cheap, and reading fresh stays
// correct across tabs and keeps tests/`vi.resetModules` free of stale state.
function readSavedSet(): Set<number> {
   try {
      const raw = localStorage.getItem(savedK())
      const arr = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : [])
   } catch {
      return new Set()
   }
}
// Save order (Set iteration == insertion order): the ★ Saved queue read
// front-to-back. NOT sorted by chronIdx — new saves append to the end.
function savedOrder(): number[] {
   return [...readSavedSet()]
}
// ★ Saved unsave-of-current anchor (the saved cousin of filter.anchor). Un-saving
// the article on screen drops it from the queue but leaves it in the reader
// (toggleSave is a state flip, not a navigation). Its save-index neighbors then
// vanish — savedNeighbor(pos) can't find a chron that left the set — so prev/next
// would dead-end on "no right match". Remember the just-unsaved chron plus the
// queue neighbors and ahead-count it held, so savedNeighbor/pendingRight still
// answer for it until the reader steps off (resolve) or the filter changes
// (resolveNoMatch). Set by toggleSaved, cleared on any landing. null = none.
let savedGhost: { chron: number; older: number; newer: number; ahead: number } | null = null
// Save-order neighbor of member `chron`: "older" = the earlier save (toward the
// front of the queue, lower index), "newer" = the later save (higher index,
// toward the newest save). -1 at the ends or if `chron` isn't saved. Steps by
// save-INDEX, so — unlike the chronIdx ±1 trick the value seam uses — it never
// aliases two numerically-adjacent saved articles. A `chron` no longer in the set
// falls back to savedGhost (the article was just un-saved on screen).
function savedNeighbor(chron: number, dir: "older" | "newer"): number {
   const order = savedOrder()
   const i = order.indexOf(chron)
   if (i < 0) return savedGhost?.chron === chron ? savedGhost[dir] : -1
   return dir === "older" ? (order[i - 1] ?? -1) : (order[i + 1] ?? -1)
}

export function isSaved(chron: number): boolean {
   return readSavedSet().has(chron)
}
// The bulk-read twin of getSeenMap: one parse for a whole render/refresh pass
// (list.ts threads it through rowEl) instead of a localStorage read per row.
export function getSavedSet(): Set<number> {
   return readSavedSet()
}
export function savedCount(): number {
   return readSavedSet().size
}
// Toggle one article's saved state; returns the new state. A save APPENDS to the
// queue (Set.add keeps insertion order — written unsorted), so the ★ Saved view
// reads in save order. Clears the neighbor-prefetch slots since the saved
// queue's neighbors may have shifted.
export function toggleSaved(chron: number): boolean {
   const set = readSavedSet()
   const nowSaved = !set.has(chron)
   // Un-saving the article currently on screen in ★ Saved mode: capture its queue
   // neighbors + ahead-count from the pre-removal order so the reader can still
   // step off it (savedGhost, consulted by savedNeighbor/pendingRight while pos is
   // a non-member). Re-saving that same article — or any state flip that returns
   // it to the set — drops the ghost.
   if (!nowSaved && filter.saved && chron === pos) {
      const order = [...set]
      const i = order.indexOf(chron)
      savedGhost = { chron, older: order[i - 1] ?? -1, newer: order[i + 1] ?? -1, ahead: order.length - 1 - i }
   } else if (savedGhost?.chron === chron) {
      savedGhost = null
   }
   if (nowSaved) set.add(chron)
   else set.delete(chron)
   try {
      localStorage.setItem(savedK(), JSON.stringify([...set]))
   } catch {}
   sync.pushSoon()
   next.left = next.right = undefined
   return nowSaved
}
// The chronIdx of the article currently in the reader (-1 = none), so app.ts can
// reflect its saved state on the star toggle without threading pos into IShowFeed.
export function currentChron(): number {
   return pos
}

// The feed id of the article currently in the reader (-1 = none). app.ts derives
// the reader source title and the feed-menu auto-expand tag from this, so it
// keeps no parallel copy of the current article's feed.
export function currentFeedId(): number {
   return currentFeed
}

// Where the list surface should anchor when (re)built: the article currently in
// the reader (pos) when it still matches the active filter — so opening the list
// drops you back at the article you were reading, with newer ("next") articles
// above and older below — else -1, meaning "newest" (a fresh boot, or a filter
// change that left the prior article behind). filter.matches consults the same
// state navigation does — raised bounds (unseen-only), the explicit set
// (saved/search) — so the list anchors exactly where the reader sits.
export function anchorChron(): number {
   // The unseen-only entry anchor counts as a member (it renders as a list row
   // via the feedLeft/feedRight walks), so returning to the list from it lands
   // on it instead of losing the position to the oldest-unread fallback.
   if (pos >= 0 && currentFeed >= 0 && (filter.matches(currentFeed, pos) || pos === filter.anchor)) return pos
   return -1
}

// Where the LIST surface anchors when (re)built — and, since the list highlight
// tracks it (render's nav.select), the article the list SELECTS on a fresh
// filter. The reader's live article still wins when it matches the active filter
// (you tapped back from reading it — anchorChron). Otherwise:
//   • a feed/tag/[ALL] opens at its OLDEST UNREAD article — the start of the
//     unread backlog, to read forward (newer) from there — falling back to its
//     newest article (the -1 newest-default below) when nothing is unread. Computed by
//     raising each member's bound past its seen high-water (idempotent with
//     unseen-only's already-raised bounds; a never-seen feed keeps its bound, so
//     its full backlog counts as unread) and taking the OLDEST match under those
//     bounds — the same unread set unseen-only navigation walks, evaluated
//     transiently here without touching filter.feeds, so the list still SHOWS
//     every article (read rows below the anchor, unread above). [ALL] runs this
//     identical scan across every feed (filter.clear populates filter.feeds with
//     all of them); on a fresh device with nothing read it lands at the oldest
//     article overall, exactly as a never-opened tag does.
//   • ★ Saved opens at its OLDEST saved article: the saved set is a read-later
//     queue consumed front-to-back, so you land at the front and read forward
//     (newer) through it — the saved cousin of the oldest-unread anchor. -1
//     only when nothing is saved.
//   • search keeps the newest-first default (-1): a query always shows its
//     newest hit, regardless of seen state. An empty store (no feeds) also
//     stays at -1.
// Async because findRight may touch an idx pack; anchorChron stays synchronous
// for the live-position callers.
export async function listAnchor(): Promise<number> {
   const live = anchorChron()
   if (live >= 0) return live
   // ★ Saved (feed-agnostic, filter.feeds empty): the front of the queue — the
   // earliest save (save-index 0), not the lowest chronIdx.
   if (filter.saved) return savedOrder()[0] ?? -1
   // [ALL] (filter.clear) populates filter.feeds with every feed, so it runs the
   // same oldest-unread scan as a feed/tag — just spanning all feeds. Only
   // search (feed-agnostic, filter.feeds empty) keeps the newest-first default.
   if (filter.search) return -1
   return oldestUnread()
}

// The oldest unread article under the current feed membership: raise each
// member's bound past its seen high-water (idempotent with unseen-only's
// already-raised bounds; a never-seen feed keeps its bound, so its full backlog
// counts as unread) and take the OLDEST match under those bounds — the same
// unread set unseen-only navigation walks, evaluated transiently without
// touching filter.feeds. -1 when nothing is unread, or on an empty store (no
// member feeds, which the size guard below returns before the minOf scan). Shared
// by listAnchor (the list's fresh-filter anchor) and switchFilter's [ALL] entry.
async function oldestUnread(): Promise<number> {
   if (filter.feeds.size === 0) return -1
   const seen = readSeen()
   const unread = new Map<number, number>()
   for (const [id, bound] of filter.feeds) {
      const s = seen["feed:" + id]
      unread.set(id, s === undefined ? bound : Math.max(bound, s + 1))
   }
   // Oldest unread: the smallest matching chron under the raised bounds (scan up
   // from the smallest bound — nothing matches below it). minOf, not
   // Math.min(...), so [ALL]'s ~65k-feed map can't overflow the spread limit.
   const start = minOf(unread.values())
   return data.findRight(start, unread)
}

// ── Search filter mode ───────────────────────────────────────────────────────
// A third filter mode beside feed-membership and ★ Saved: when the single
// token is "q:<query>", navigation walks an explicit set of matching chronIdxs —
// the title-search hits — exactly as ★ Saved walks the saved set. The set is
// computed once per query by search.loadHits (cached there via cachedPromise,
// so concurrent walks within one render dedupe); nav keeps only the sorted
// snapshot and a Set for matches(). The query rides in the shareable
// #!q:<query> hash like any token, so reload / back / forward restore the
// search and it behaves like a tag filter (picking another filter, two-finger
// cycle, or arrow-cycling leaves it — search is not part of getFilterEntries).
// Capped at SEARCH_CAP newest hits so a broad query can't fetch the whole
// archive; searchTruncated() flags the cap for the UI.
export const SEARCH_PREFIX = "q:"
const SEARCH_CAP = 500
let searchSorted: number[] = [] // ascending matching chronIdxs in the snapshot
let searchSet = new Set<number>() // the same hits, for matches()
let searchCards = new Map<number, import("./format.gen").IMetaWire>() // {f,w,t} per hit chron
let searchTruncatedFlag = false
// The term the current snapshot was loaded for — distinct from the active query
// when a query changes before its load resolves (A→B→A): dropping this key on
// filter.set ensures a returning query re-loads rather than trusting an emptied
// snapshot.
let searchLoadedFor: string | null = null

// Clear the snapshot so the next ensureSearchSet reloads it. Called when a new
// query is set (filter.set) so a fast A→B→A sequence doesn't trust a stale or
// emptied snapshot. The search.ts cache (cachedPromise on loadHits) stays warm,
// so a returning query re-resolves from the cache without re-scanning.
export function resetSearchStream(): void {
   searchSorted = []
   searchSet = new Set<number>()
   searchCards = new Map()
   searchTruncatedFlag = false
   searchLoadedFor = null
}

// Derives the active search query from filter.tokens — always consistent with
// filter.search since set() flips both synchronously (no hand-sync invariant).
function activeQuery(): string {
   return filter.search ? filter.tokens[0].slice(SEARCH_PREFIX.length) : ""
}

export function isSearchFilter(): boolean {
   return filter.search
}
export function searchQuery(): string {
   return activeQuery()
}
export function searchTruncated(): boolean {
   return searchTruncatedFlag
}
// The {f,w,t} card for a search hit chron, captured during the scan so the list
// can render search rows without re-fetching/re-parsing the meta packs. Undefined
// for a chron not in the current snapshot.
export function searchCard(chron: number): import("./format.gen").IMetaWire | undefined {
   return searchCards.get(chron)
}
export function searchAvailable(): boolean {
   return search.available()
}
export function searchShort(q: string): boolean {
   return search.shortQuery(q)
}

// Largest entry <= from / smallest entry >= from in an ascending array (-1 =
// none) — the pure value scan the SEARCH hit set walks (its order is chronIdx
// order, so a value threshold gives the strict neighbor). Never fetches an idx
// pack. (★ Saved does not use this — its order isn't chronIdx order, see
// savedNeighbor.)
function setLeft(sorted: number[], from: number): number {
   let res = -1
   for (const c of sorted) {
      if (c > from) break
      res = c
   }
   return res
}
function setRight(sorted: number[], from: number): number {
   for (const c of sorted) if (c >= from) return c
   return -1
}

// Load (or confirm) the full hit-set snapshot for the active query. Supersession
// guard: captures the query at call entry; if it changed while we awaited
// loadHits, the late result is discarded (the concurrent call for the newer query
// will store its own snapshot). The cachedPromise in search.ts dedupes concurrent
// calls for the same query, so concurrent neighbor walks within one render share
// one in-flight load.
async function ensureSearchSet(): Promise<void> {
   const term = activeQuery()
   if (searchLoadedFor === term) return // snapshot already up to date
   // An empty query has no hits — reset to the empty snapshot and mark it
   // loaded without calling loadHits (parity with search.loadHits's own
   // `if (query)` guard; tests assert it).
   if (!term) {
      resetSearchStream()
      searchLoadedFor = term
      return
   }
   const { chrons, truncated, cards } = await search.loadHits(term, SEARCH_CAP)
   if (term !== activeQuery()) return // superseded — discard stale result
   searchSorted = chrons
   searchSet = new Set(chrons)
   searchCards = cards
   searchTruncatedFlag = truncated
   searchLoadedFor = term
}

// The value-addressed neighbor primitive: the nearest matching member ≤ `from`
// (feedLeft) / ≥ `from` (feedRight). Feed mode walks the idx packs; search walks
// its explicit chronIdx-sorted hit set (order == value order, so the value seam
// is sound). ★ Saved does NOT come through here — its display order isn't
// chronIdx order, so it steps by save-index through neighborOlder/neighborNewer
// and the boundary branches (first/last/goTo/listAnchor/pendingRight) instead.
// Async to match data.findLeft/findRight; the search branch resolves once its
// snapshot loads.
// The feed-membership walks fold in filter.anchor — the unseen-only entry
// article (a SEEN article the reader landed on, which the raised bounds
// exclude). Slotting it into both directional walks keeps it a member of the
// navigable sequence, so ← returns to the first article shown after → steps
// into the unseen, and every consumer of this seam (prev/next enablement,
// step(), the list's rows, prefetch) agrees it exists.
export function feedLeft(from: number): Promise<number> {
   if (filter.search) return ensureSearchSet().then(() => setLeft(searchSorted, from))
   const a = filter.anchor
   // No anchor (the usual case): return the walk's promise untouched — an
   // unconditional .then would add a microtask tick to every neighbor lookup.
   if (a < 0) return data.findLeft(from, filter.feeds)
   return data.findLeft(from, filter.feeds).then((found) => (a <= from && a > found ? a : found))
}
export function feedRight(from: number): Promise<number> {
   if (filter.search) return ensureSearchSet().then(() => setRight(searchSorted, from))
   const a = filter.anchor
   if (a < 0) return data.findRight(from, filter.feeds)
   return data.findRight(from, filter.feeds).then((found) => (a >= from && (found === -1 || a < found) ? a : found))
}

// Strict neighbor of MEMBER `chron` under the active mode — the ONE seam the
// reader's prev/next step and the list's row walk both route through, so "what's
// the next/prev article" is decided in one place. Feed/search stay on the value
// seam (member ∓ 1); ★ Saved steps by save-index (savedNeighbor), the one mode
// whose display order isn't chronIdx order. "older" = the previous article
// (feed: lower chronIdx; saved: the earlier save), "newer" = the next.
export function neighborOlder(chron: number): Promise<number> {
   if (filter.saved) return Promise.resolve(savedNeighbor(chron, "older"))
   return feedLeft(chron - 1)
}
export function neighborNewer(chron: number): Promise<number> {
   if (filter.saved) return Promise.resolve(savedNeighbor(chron, "newer"))
   return feedRight(chron + 1)
}

// Resolve a token list to its feed membership at natural add_idx bounds —
// numeric token = that feed, else a tag's members; only feeds with articles
// join. Empty tokens = every feed ([ALL]). The ONE copy of the resolution
// rule: filter.set, filter.clear, and onStoreRefreshed must never drift on
// what a token means.
function resolveMembership(tokens: string[]): Map<number, number> {
   const feeds = new Map<number, number>()
   if (tokens.length === 0) {
      for (const ch of Object.values(data.db.feeds)) if (ch.total_art) feeds.set(ch.id, ch.add_idx ?? 0)
      return feeds
   }
   for (const token of tokens) {
      const num = Number(token)
      if (Number.isFinite(num)) {
         const ch = data.db.feeds[num]
         if (ch?.total_art && !feeds.has(num)) feeds.set(num, ch.add_idx ?? 0)
      } else
         for (const ch of Object.values(data.db.feeds))
            if (ch.tag === token && ch.total_art && !feeds.has(ch.id)) feeds.set(ch.id, ch.add_idx ?? 0)
   }
   return feeds
}

export const filter = {
   feeds: new Map<number, number>(),
   tokens: [] as string[],
   // Unseen-only ENTRY ANCHOR: the chron of a SEEN article the reader landed on
   // under raised bounds — switchFilter's resume position or a restored/shared
   // #pos, the landings isValidSeen accepts by true add_idx. The raised (seen+1)
   // bounds exclude it, so without this the walk loses it the moment you step
   // off: → to the first unseen, then ← finds nothing — the entry article is
   // gone. feedLeft/feedRight slot the anchor into their walks so it stays a
   // reachable member of the navigable sequence ({anchor} ∪ unseen) until the
   // filter is re-applied (set/clear reset it; a reload re-establishes it from
   // the new landing). -1 = none. Set by resolve(); navigation-only — it does
   // NOT make matches() true, so the unread counting (feedUnread) and badges are
   // untouched.
   anchor: -1,
   // "★ Saved" mode: navigation walks the explicit srr-saved set, feed-agnostic
   // (feeds stays empty). Set by set() when the only token is SAVED_TOKEN.
   saved: false,
   // Search mode: navigation walks the explicit title-search set (searchSorted),
   // feed-agnostic like saved. Set by set() when the only token is "q:<query>"
   // — see the Search filter mode section above.
   search: false,
   get active() {
      return this.tokens.length > 0
   },
   matches(feedId: number, chronIdx: number) {
      // Saved/search modes ignore the feed: membership IS the explicit set.
      // (feedId is still passed by callers that don't know the mode.)
      if (this.saved) return isSaved(chronIdx)
      if (this.search) return searchSet.has(chronIdx)
      const addIdx = this.feeds.get(feedId)
      return addIdx !== undefined && chronIdx >= addIdx
   },
   clear() {
      this.saved = false
      this.search = false
      this.anchor = -1
      this.feeds = resolveMembership([])
      this.tokens = []
      // [ALL] honours unseen-only too now (a global "only unread" catch-up view).
      this.applyUnseen(readSeen())
   },
   set(tokens: string[]) {
      this.tokens = tokens
      this.feeds = new Map<number, number>()
      this.anchor = -1
      // "★ Saved" is a standalone mode, not a feed resolution: short-circuit
      // before the feed loop (which would find no feeds and clear() back
      // to [ALL]). feeds stays empty; feedLeft/feedRight/matches/showFeed all
      // branch on filter.saved.
      this.saved = tokens.length === 1 && tokens[0] === SAVED_TOKEN
      // "q:<query>" — title-search mode (see Search filter mode above). Like
      // ★ Saved it short-circuits the feed resolution; the matching set is loaded
      // once by ensureSearchSet (via feedLeft/feedRight) and cached in search.ts.
      this.search = !this.saved && tokens.length === 1 && tokens[0].startsWith(SEARCH_PREFIX)
      if (this.saved) return
      if (this.search) {
         const term = tokens[0].slice(SEARCH_PREFIX.length)
         // New query: drop the snapshot so ensureSearchSet reloads it. A returning
         // query (back/forward, term unchanged) would already have its snapshot if it
         // loaded before; resetSearchStream just nulls searchLoadedFor so a stale or
         // emptied snapshot doesn't strand the list on no matches (the A→B→A case:
         // B's load emptied the set; on return to A, resetSearchStream forces reload).
         if (term !== searchLoadedFor) resetSearchStream()
         return
      }
      // Resolve membership at natural add_idx bounds (numeric token = a feed,
      // else a tag's members), then fold in unseen-only via applyUnseen.
      this.feeds = resolveMembership(tokens)
      if (this.feeds.size === 0) {
         this.clear()
         return
      }
      this.applyUnseen(readSeen())
   },
   // Fold unseen-only into the just-built feed membership (shared by set() and
   // clear()). When on, raise EVERY member's lower bound past its seen high-water
   // (read from localStorage at apply time) — so read articles fall below it for findLeft/findRight/matches.
   // Generalised from the old single-tag case: it now applies to any filter, so
   // [ALL]/a feed/a tag all become a "show only unread" view. When off, no-op.
   // Saved/search short-circuit before this.
   applyUnseen(seenMap: Record<string, number>) {
      if (!unreadOnly) return
      for (const [id, addIdx] of this.feeds) {
         const seen = seenMap["feed:" + id] ?? -1
         this.feeds.set(id, Math.max(addIdx, seen + 1))
      }
   },
}

// After data.refresh() swapped the store snapshot: reconcile the filter and the
// navigation caches WITHOUT re-snapshotting the walk. Bounds only ever rise by
// a grown add_idx (expiration) — never re-derived from seen, which would yank
// the unseen-only sequence mid-session (articles read this session would drop
// out from under ←). New members (a new feed under [ALL], a feed newly tagged
// into the active tag) join with the same bound set()/applyUnseen would give
// them; members gone from the store leave. New articles need no bound work at
// all — they sit above every existing bound, so matches()/findRight see them
// automatically. pos is untouched: chronIdx is a permanent address and
// total_art only ever grows. Saved/search have no per-feed bounds (filter.feeds
// stays empty for them) — skipped here.
export async function onStoreRefreshed(): Promise<void> {
   if (!filter.saved && !filter.search) {
      // Recompute the fresh membership set exactly as filter.set/clear would:
      // [ALL] (no active tokens) = every feed with total_art>0; a feed/tag
      // filter = the union its tokens resolve to (numeric ids as feeds, else a
      // tag match) — the SAME resolveMembership filter.set/clear use, so a mixed
      // multi-token filter (feed ids + tags) gets the identical union.
      const fresh = resolveMembership(filter.active ? filter.tokens : [])
      const seenMap = readSeen()
      for (const [id, addIdx] of fresh) {
         const old = filter.feeds.get(id)
         if (old !== undefined) {
            // Existing member: raise the bound only if add_idx grew (expiration
            // advanced past it) — never re-derive it from seen.
            if (addIdx > old) filter.feeds.set(id, addIdx)
         } else {
            // A brand-new member: join with the same bound a fresh set()/
            // applyUnseen would give it (raised past its seen high-water only
            // in unseen-only mode; a never-seen member keeps its natural add_idx).
            const s = unreadOnly ? (seenMap["feed:" + id] ?? -1) : -1
            filter.feeds.set(id, Math.max(addIdx, s + 1))
         }
      }
      // A member gone from the store (feed deleted, or dropped from the tag/
      // [ALL] scope) leaves.
      for (const id of [...filter.feeds.keys()]) if (!fresh.has(id)) filter.feeds.delete(id)
   }
   // Cached neighbor probes are exactly what new content invalidates (a stored
   // "no right neighbor" at the article that was newest before the refresh,
   // most of all), and any in-flight prefetch may equally target stale content.
   // Drop both; the next step re-probes fresh.
   next.left = next.right = undefined
   abortPrefetch()
   // An active search walks a snapshot computed against the old store. The
   // caller (refresh.ts) invalidates search.ts's caches first — see
   // search.invalidate()'s docblock — so this is nav's half of that pairing:
   // drop nav's own snapshot and reload it. ensureSearchSet's supersession
   // guard absorbs a concurrent query change racing this reload.
   if (filter.search) {
      resetSearchStream()
      await ensureSearchSet()
   }
}

// Recompute the reader chrome (has_left/has_right/right_count) for the article
// already on screen — after a store refresh, without re-rendering the content
// (no fade, no scroll: the silent-refresh contract). null when nothing is
// showing. data.loadArticle(pos) is cache-warm (the article itself didn't
// change), so this costs idx/meta probes at most, no re-fetch of the article.
export async function probeCurrent(): Promise<IShowFeed | null> {
   if (pos < 0) return null
   const article = await data.loadArticle(pos)
   return showFeed(article)
}

// True only in unseen-only mode with a feed/tag filter active (not saved, not
// search). Matches the exact conditions under which applyUnseen raises bounds,
// so feedUnread and isValidSeen can branch on the same predicate.
function unseenActive(): boolean {
   return unreadOnly && !filter.saved && !filter.search
}

// One member's unread given its seen index: its articles strictly after that
// position, or — when the feed was NEVER seen on this device (undefined) —
// its full backlog (countAll). A never-seen feed counts as fully unread so
// its row badge matches its tag header (tagUnreadFromCounts) and the
// unseen-only nav that would walk its whole history; a fresh device thus
// shows a count on every feed, not a blank. Both terms come from the same idx
// counting (countAll − countLeft) so db.gz total_art drift can't skew it, and
// the boundary pack is the resident latest pack whenever seen is recent (zero
// fetches; the never-seen branch is sync countAll — no fetch at all). Shared
// by unreadCounts and (through tallyWith's rare fallback) pendingRight.
//
// Accounted on ENTER, not on leave: the article you open is marked seen on
// ARRIVAL (recordSeen), so it drops out of this count the instant you read it —
// there is no "current article" pad holding it as still-unread until you step
// away. The badge is the plain true unread — and the reader's pending pill is
// these same counts with each frontier floored at the cursor (pendingRight),
// identical on every recorded landing. It also agrees with the list's
// per-row read/unread dots (isRowUnread), which already treat the current
// article as read. Switching filters lands on an already-seen resume article
// and records nothing (switchFilter resolves record:false), so a switch never
// moves this count — only reading forward does.
async function feedUnread(ch: IFeed, seenIdx: number | undefined): Promise<number> {
   const map = new Map([[ch.id, ch.add_idx ?? 0]])
   if (seenIdx === undefined) return data.countAll(map)
   const upTo = Math.min(seenIdx + 1, data.db.total_art)
   return Math.max(0, data.countAll(map) - (await data.countLeft(upTo, map)))
}

// The one tally body shared by the badges and the pill: the batched latest-tail
// pass (data.unreadTally) with the per-feed feedUnread oracle as the `rare`
// fallback, parameterized on the seen accessor so pendingRight can floor each
// frontier at the cursor while unreadCounts reads the map verbatim. Keeping
// both callers on one body is what makes badge↔pill drift structurally
// impossible — they can only differ by the seenOf they pass.
async function tallyWith(chs: IFeed[], seenOf: (id: number) => number | undefined): Promise<Map<number, number>> {
   const { counts, rare } = data.unreadTally(chs, seenOf)
   await Promise.all(rare.map(async (ch) => counts.set(ch.id, await feedUnread(ch, seenOf(ch.id)))))
   return counts
}

// The reader's pending readout: what the next pill displays. ★ Saved counts its
// queue by save-index (the saves still AHEAD of pos — a front-to-back countdown);
// search counts hits strictly after pos (its set is chronIdx-ordered). Both are
// peek modes with no unread badge to agree with (they never touch the frontier).
// Feed/tag/[ALL] count what is UNREAD AND AHEAD: the members'
// live unread through the same tally the picker rows use (tallyWith →
// tagUnreadFromCounts), with each member's frontier floored at the cursor so
// everything at or below pos — the article on screen included — is excluded.
//
// The floor is what reconciles the two properties that used to fight:
//  - Badge parity: on every RECORDED landing recordSeen has already raised
//    every member's frontier to pos, so the floor is a no-op and the pill is
//    exactly the picker badge — the read-ahead articles a positional
//    (countAll − countLeft(pos+1)) count wrongly included stay excluded, and
//    re-reading a caught-up lane reads an honest steady 0 (Next stays armed
//    off has_right), never a phantom backlog (#2810).
//  - Steady −1 ticks: on an UNRECORDED landing (a switch resume, a restored
//    #pos — landings that must not consume unread) the pill reads one below
//    the badge: the badge counts the not-yet-consumed article on screen, the
//    pill counts what → still has. Without the floor the first recorded step
//    dropped the pill by 2 at once (the entry article AND the landing are
//    both marked on ENTER); with it, the first step ticks −1 like every other.
// The last article reads 0 — nothing is ahead, recorded or not. pos −1 (the
// armed not-started placeholder) floors nothing: the pill is the members'
// whole backlog, the badge itself.
async function pendingRight(seenMap?: Record<string, number>): Promise<number> {
   if (filter.saved) {
      const order = savedOrder()
      const i = order.indexOf(pos)
      if (i < 0) return savedGhost?.chron === pos ? savedGhost.ahead : 0
      return order.length - 1 - i
   }
   if (filter.search) {
      await ensureSearchSet()
      return searchSorted.filter((c) => c > pos).length
   }
   const members: IFeed[] = []
   for (const id of filter.feeds.keys()) {
      const ch = data.db.feeds[id]
      if (ch) members.push(ch)
   }
   // Reuse the seen map the caller already parsed (recordSeen's, on a recorded
   // landing — the map it just persisted, so it equals a fresh read) instead of
   // re-parsing srr-seen in the same navigation tick; else read it fresh (an
   // unrecorded landing, probeCurrent, the not-started placeholder).
   const seen = seenMap ?? readSeen()
   const eff = (id: number): number | undefined => {
      const s = seen["feed:" + id]
      if (pos < 0) return s
      return Math.max(s ?? -1, pos)
   }
   return tagUnreadFromCounts(members, await tallyWith(members, eff))
}

async function showFeed(article: IArticle, seenMap?: Record<string, number>): Promise<IShowFeed> {
   // has_left/has_right only need to know whether a neighbor exists under the
   // active filter, which is exactly what neighborOlder/neighborNewer answer —
   // the same seam navigation steps through (raised bounds in unseen-only, the
   // explicit set in saved/search). So the prev/next buttons enable precisely
   // when a step would move. resolve() awaited loadArticle(pos), so the pos idx pack is
   // resident; a same-pack neighbor costs no fetch, and a cross-pack one is the
   // very lookup the neighbor prefetch makes next anyway. A cold-pack fetch for a
   // boundary neighbor can blip (offline/evicted); .catch degrades to "no
   // neighbor" (button disabled, retried on the next render) rather than failing
   // the already-loaded article into the error popup. right_count rides the
   // resident latest tail (unreadCounts) plus at most the warm packs a rare
   // long-behind frontier needs, and degrades the same way (-1 = digits hidden).
   // Computed even when has_right is false: on the LAST article the pill shows
   // an explicit "0" — the readout answers "how much is unread", and at the end
   // the honest answer is zero, not silence. (In show-read mode "0" with Next
   // still armed is likewise normal: read articles remain ahead, nothing unread.)
   // The three probes are independent reads of the already-committed pos/filter/
   // seen state — none mutates nav state and each keeps its own .catch(()=>-1), so
   // Promise.all yields a byte-identical IShowFeed. Running them concurrently
   // overlaps the up-to-three cold idx-pack fetches (feedLeft/feedRight neighbors +
   // pendingRight's rare long-behind frontiers, disjoint packs on a >50k store)
   // into one round-trip window instead of chaining them; same-pack fetches still
   // join via cachedPromise. pendingRight reuses recordSeen's seen map (seenMap).
   const [left, right, right_count] = await Promise.all([
      neighborOlder(pos).catch(() => -1),
      neighborNewer(pos).catch(() => -1),
      pendingRight(seenMap).catch(() => -1),
   ])
   return {
      article,
      has_left: left !== -1,
      has_right: right !== -1,
      right_count,
   }
}

// `record` gates the seen-frontier advance (recordSeen). Reading navigation
// (step/left/right, opening a list row, a restored #pos) records = true — the
// default. A FILTER SWITCH passes false: clicking or cycling (W/S / ↑↓ /
// two-finger) onto a lane is a resume, not a read, so it must never mark its
// landing article seen — merely visiting a tag/feed can't decrement its unread
// count. The switch still resumes at the last-seen position (a no-op raise for a
// read feed anyway); for a never-seen feed/tag it lands on the oldest article
// and leaves it unread until the reader actually steps forward.
async function resolve(target: number, replace = false, record = true): Promise<IShowFeed> {
   // Load first; commit pos only on success so a Retry replays the same chron.
   const article = await data.loadArticle(target)
   pos = target
   currentFeed = article.f
   // A landing the raised unseen-only bounds do NOT cover is an entry anchor
   // (isValidSeen accepted it by true add_idx: switchFilter's resume position,
   // a restored/shared #pos). Remember it so feedLeft/feedRight keep it in the
   // navigable sequence — ← must be able to return to the first article shown
   // after → steps into the unseen. A matching landing leaves the anchor alone:
   // stepping forward must not orphan the entry it came from.
   if (unseenActive() && !filter.matches(article.f, target)) filter.anchor = target
   // Any real landing moves off the just-unsaved ghost article onto a genuine
   // member (or another article entirely), so the saved ghost is spent.
   savedGhost = null
   next.left = next.right = undefined
   // Arriving at the article being prefetched must NOT abort it: its in-flight
   // loads are exactly what the rendered content is about to attach to (same-URL
   // image loads coalesce within a document — aborting here restarted every
   // image from scratch, which made the prefetch useless for any neighbor whose
   // images hadn't all finished). Drop the refs instead; the rendered elements
   // own the loads from here. Any other navigation aborts as before.
   if (currentPrefetch?.target === target) currentPrefetch = null
   else abortPrefetch()
   updateHash(replace)
   const seen = record ? recordSeen(article) : undefined
   return showFeed(article, seen)
}

// Caps on the neighbor prefetch. Uncapped, an image-stuffed neighbor (live
// store measured articles with 300+ <img> tags) floods the connection with
// low-priority downloads that split bandwidth so thin none completes before
// the user steps — and competes with the on-screen article's own lazy loads.
// The rendered article only needs its first viewport immediately (its images
// are loading=lazy), so warm just that many; a capped prefetch actually
// finishes within a normal reading dwell. Videos are metadata-only fetches
// (duration/dimensions/first frame — cheap for faststart assets), 2 is plenty.
const PREFETCH_IMAGES = 6
const PREFETCH_VIDEOS = 2

// Holds refs to the last neighbor's prefetched media so we can both abort
// their in-flight loads (src = "" — the WHATWG image-update steps for <img>,
// the media-load algorithm's abort for <video>) and drop the references,
// bounding memory to one neighbor at a time. `target` lets resolve() tell
// arrival at the prefetched article apart from navigating elsewhere. Object
// identity also acts as the freshness token: a pending idle callback that
// finds `my !== currentPrefetch` bails instead of pushing into a stale record.
interface Prefetch {
   target: number
   imgs: HTMLImageElement[]
   vids: HTMLVideoElement[]
}
let currentPrefetch: Prefetch | null = null

function abortPrefetch() {
   if (currentPrefetch) {
      for (const img of currentPrefetch.imgs) img.src = ""
      for (const vid of currentPrefetch.vids) vid.src = ""
   }
   currentPrefetch = null
}

function schedulePrefetch(target: number) {
   if (target === -1) return
   const my: Prefetch = { target, imgs: [], vids: [] }
   currentPrefetch = my
   const run = async () => {
      if (my !== currentPrefetch) return
      try {
         const art = await data.loadArticle(target)
         if (my !== currentPrefetch) return
         const media = extractPrefetchMedia(art.c, data.activeStore().base)
         for (const url of media.images.slice(0, PREFETCH_IMAGES)) {
            const img = new Image()
            img.fetchPriority = "low"
            img.decoding = "async"
            img.src = url
            my.imgs.push(img)
         }
         for (const url of media.videos.slice(0, PREFETCH_VIDEOS)) {
            // preload must be set before src: assigning src invokes the media
            // load algorithm, which reads the preload hint.
            const vid = document.createElement("video")
            vid.preload = "metadata"
            vid.src = url
            my.vids.push(vid)
         }
      } catch {
         // Best-effort; errors surface on user nav.
      }
   }
   // WebKit has no requestIdleCallback — without the timeout fallback every
   // iOS reader would stall at each data-pack boundary instead of prefetching.
   if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 500 })
   else setTimeout(run, 200)
}

function readSeen(): Record<string, number> {
   try {
      const raw = localStorage.getItem(seenK())
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// Persist a mutated seen map and stamp the per-key ordering timestamps
// (srr-seen-ts, profile.ts's `st`) for the keys this mutation touched — the
// unix-second that lets sync order a key's latest local action (raise or
// explicit rewind) against other devices. Every seen write goes through here
// so no mutation ships unordered.
function writeSeen(seen: Record<string, number>, touched: string[]): void {
   localStorage.setItem(seenK(), JSON.stringify(seen))
   try {
      const raw = localStorage.getItem(seenTsK())
      const st: Record<string, number> = raw ? JSON.parse(raw) : {}
      const now = Math.floor(Date.now() / 1000)
      for (const k of touched) st[k] = now
      localStorage.setItem(seenTsK(), JSON.stringify(st))
   } catch {}
}

// A feed stores its own seen position — its read high-water (the newest chron
// ever marked seen for it; recordSeen only raises it, markUnreadFrom is the
// explicit rewind). A tag has no position of its own: it resumes from the oldest seen
// position (min seen chronIdx) among its member feeds, so opening the tag
// drops you at the least-recently-read member and no member's unread (each of
// which sits at or after that member's own seen position) is skipped to the
// left. Reading on still advances the tag, since the min only rises once that
// furthest-behind member is read on. undefined === never seen on this device
// (feed) / no member feed seen yet (tag).
function getSeen(token: string): number | undefined {
   const seen = readSeen()
   const n = Number(token)
   if (Number.isFinite(n)) return seen["feed:" + n]
   let min: number | undefined
   for (const ch of Object.values(data.db.feeds))
      if (ch.tag === token) {
         const s = seen["feed:" + ch.id]
         if (s !== undefined && (min === undefined || s < min)) min = s
      }
   return min
}

// Returns the parsed (and, when anything moved, persisted) seen map so the caller
// (resolve → showFeed → pendingRight) can reuse it without re-reading srr-seen in
// the same tick; undefined when nothing was read (a peek mode or an unknown feed)
// or the read threw, in which case pendingRight falls back to a fresh read.
function recordSeen(article: IArticle): Record<string, number> | undefined {
   // Peek modes never touch the seen frontier. Search (q:) jumps to hits, not a
   // contiguous read-through — advancing here would mark everything up to the
   // hit as seen. ★ Saved is the same shape: re-reading an archived item is not
   // resuming its feed. A saved/search article you peek at stays unread until
   // you actually read it in its feed.
   if (filter.search || filter.saved) return
   const ch = data.db.feeds[article.f]
   if (!ch) return
   try {
      const seen = readSeen()
      const touched: string[] = []
      // Opening an article marks every OLDER article in the navigation list as
      // seen: for the article's own feed AND each other feed in the active
      // filter (the list you're reading), raise its seen frontier to pos so
      // all of its articles at-or-below pos read as seen — the chronological
      // "everything before here is caught up" the reader expects. A one-way
      // raise for EVERY feed, the current one included: stepping back to an
      // older article re-reads it without un-marking anything — read progress
      // only rewinds through the explicit markUnreadFrom gesture. (The own feed
      // is raised outside the loop because a deep-linked article's feed can
      // sit outside the filter membership.) Search and saved both returned
      // above, so this only fires for feed/tag/[ALL] navigation — the
      // contiguous read-throughs where a "previous = seen" frontier across
      // feeds is meaningful.
      const raise = (feedId: number) =>
         writeFrontier(seen, touched, feedId, (prev) => prev === undefined || prev < pos, pos)
      raise(article.f)
      for (const feedId of filter.feeds.keys()) if (feedId !== article.f) raise(feedId)
      if (touched.length > 0) {
         writeSeen(seen, touched)
         sync.pushSoon()
      }
      return seen
   } catch {}
}

// One feed's seen-frontier write: set seen[key]=value and record the key in
// `touched` when shouldMove(prev) holds. The shared primitive behind BOTH
// recordSeen's per-feed raise and the two explicit frontier gestures below, so
// the seen-write discipline (key shape, touched bookkeeping) lives in one place.
function writeFrontier(
   seen: Record<string, number>,
   touched: string[],
   feedId: number,
   shouldMove: (prev: number | undefined) => boolean,
   value: number,
): void {
   const key = "feed:" + feedId
   const prev = seen[key]
   if (shouldMove(prev)) {
      seen[key] = value
      touched.push(key)
   }
}

// The loop-and-commit body shared by markAllRead/markUnreadFrom: move every
// filter member's frontier to `value` where shouldMove(prev) holds, then persist
// + push. Peek modes (saved/search) have no frontier to move. Returns whether
// anything actually changed (the caller only rebuilds / re-counts when it did).
function moveFrontier(shouldMove: (prev: number | undefined) => boolean, value: number): boolean {
   if (filter.search || filter.saved) return false
   try {
      const seen = readSeen()
      const touched: string[] = []
      for (const feedId of filter.feeds.keys()) writeFrontier(seen, touched, feedId, shouldMove, value)
      if (touched.length === 0) return false
      writeSeen(seen, touched)
      sync.pushSoon()
      return true
   } catch {
      return false
   }
}

// Mark the whole current feed/tag/[ALL] selection read: raise every filter
// member's seen frontier to the newest chron in the store — the same one-way
// high-water recordSeen writes for "other" feeds, so a foreign chron as the
// frontier is the established shape. Pure raise ⇒ trivially compatible with
// sync's merge. Peek modes (saved/search) have no frontier to move and return
// untouched. Returns whether anything actually changed (the caller only
// rebuilds the list / re-counts when it did).
export function markAllRead(): boolean {
   if (data.db.total_art === 0) return false
   const top = data.db.total_art - 1
   return moveFrontier((prev) => prev === undefined || prev < top, top)
}

// The explicit unread rewind — the ONLY path that lowers a seen frontier:
// mark everything from `chron` (inclusive) to the latest article unread under
// the current selection, by lowering every filter member's frontier to
// chron−1 (members already below stay put — their older unread is untouched).
// −1 (chron 0) is stored, not deleted: a stored −1 reads exactly like
// never-seen everywhere, and keeping the key preserves the per-key timestamp
// that lets this rewind outrank older raises on other devices (writeSeen
// stamps it; profile.ts's per-key LWW propagates it). Peek modes are exempt,
// mirroring recordSeen. Returns whether anything changed.
export function markUnreadFrom(chron: number): boolean {
   if (chron < 0) return false
   const floor = chron - 1
   return moveFrontier((prev) => prev !== undefined && prev > floor, floor)
}

// Batched per-feed unread: reads the seen map once and tallies EVERY feed in
// one synchronous latest-tail pass (data.unreadTally — the old path re-scanned
// the same resident pack once per feed, O(feeds × tail) on every lane-cycle
// keypress in unread-only mode and every picker open). Feeds whose seen
// frontier predates the latest pack come back in `rare` and fall back to the
// per-feed feedUnread oracle — the exact formula the pass mirrors, kept as
// the in-code source of truth (and the differential test's anchor) so the
// badge↔pill agreement can't drift. Maps feed id → unread (a never-seen feed
// maps to its full backlog).
export function unreadCounts(chs: IFeed[]): Promise<Map<number, number>> {
   const seenMap = readSeen()
   return tallyWith(chs, (id) => seenMap["feed:" + id])
}

// The tag-header aggregate the dropdown displays as the tag badge: the sum of
// its members' per-feed unread, read straight from the `unreadCounts` map
// already computed for the row badges (no recount — the previous async
// tagUnreadCount re-ran feedUnread for every tag member, so tagged feeds were
// scanned twice per menu open). feedUnread already counts a never-seen member as
// its full backlog and (in unseen-only mode) the unread article you're sitting
// on as still-unread, so the badge is a plain sum and the row badges beneath the
// header add up to it. A tag has no count of its own; this derives it from its
// members. Synchronous: the counts are already resolved. Returns ≥ 0 (0 =
// nothing unseen). The Math.max guards any stray negative / a member missing
// from the map down to 0.
export function tagUnreadFromCounts(group: IFeed[], counts: Map<number, number>): number {
   return group.reduce((sum, ch) => sum + Math.max(0, counts.get(ch.id) ?? 0), 0)
}

export function pruneSeen() {
   try {
      const seen = readSeen()
      let changed = false
      for (const key of Object.keys(seen)) {
         // tag: entries are legacy — a tag's position now derives from its
         // member feeds, so any stored tag: key is dead weight. A feed: key
         // for a deleted feed goes too.
         const stale = key.startsWith("tag:") || (key.startsWith("feed:") && !data.db.feeds[Number(key.slice(5))])
         if (stale) {
            delete seen[key]
            changed = true
         }
      }
      if (changed) localStorage.setItem(seenK(), JSON.stringify(seen))
      // The per-key ordering timestamps shadow the seen map — any st key whose
      // seen entry is gone (pruned above, or never existed) is dead weight too.
      const rawSt = localStorage.getItem(seenTsK())
      const st: Record<string, number> = rawSt ? JSON.parse(rawSt) : {}
      let stChanged = false
      for (const key of Object.keys(st))
         if (seen[key] === undefined) {
            delete st[key]
            stChanged = true
         }
      if (stChanged) localStorage.setItem(seenTsK(), JSON.stringify(st))
   } catch {}
}

// The reader's no-article state. `notStarted` picks which unread-only message the
// empty state shows: true = a never-opened feed/tag (has unread, no resume point →
// "start from the list"); false = caught-up (nothing unread) or a plain no-match.
function resolveNoMatch(replace = false, notStarted = false): IShowFeed {
   pos = -1
   currentFeed = -1
   // Same cleanup as resolve(): the cached neighbor probes, the saved ghost, and
   // any in-flight media prefetch belong to the PREVIOUS filter's article and are
   // now stale.
   savedGhost = null
   next.left = next.right = undefined
   abortPrefetch()
   updateHash(replace)
   return {
      article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
      has_left: false,
      has_right: false,
      right_count: 0,
      placeholder: true,
      notStarted,
   }
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const posStr = hashPos(hash)

   const tokens = parseHashTokens(hash)
   if (tokens.length > 0) filter.set(tokens)
   else filter.clear()

   if (data.db.total_art === 0) throw new Error("no articles")

   // Empty posStr → Number("")=0 would land on the oldest article; treat it
   // as "no target" so a first-time visitor with no stored hash sees latest.
   let target = posStr === "" ? NaN : Number(posStr)
   if (!Number.isFinite(target) || target < 0 || target >= data.db.total_art) target = data.db.total_art - 1

   // Search mode's matching set must be fully loaded before isValidSeen/resolve
   // read it (matches() is synchronous). ensureSearchSet loads the full hit-set
   // for the active query so a #pos!q:… deep-link honors its position.
   if (filter.search) await ensureSearchSet()

   // Validate the explicit #pos against the feed's TRUE add_idx, not unseen-only's
   // raised (seen+1) bounds. A restored/shared hash position is an entry anchor, like
   // switchFilter's resume position — isValidSeen is exactly that predicate (true add_idx
   // in unseen-only mode, filter.matches otherwise).
   //
   // Both landings resolve with record = false: restoring a position (a reload,
   // back/forward, or a shared deep-link — this is the sole hash→reader path) is
   // not reading, so it must not advance the seen frontier. Recording here marked
   // the restored article AND (under [ALL]/a tag) raised every filter member's
   // cross-feed frontier to it, so a reload silently consumed other feeds' unread
   // — the same "a switch mustn't consume" rule switchFilter follows. Reading
   // forward (Right) records normally from the restored position.
   // Unread-only + a fully-read feed/tag (or [ALL] fully caught up): a reload
   // onto it shows the "All caught up" placeholder, the same as switching to it —
   // no unread to restore. (A feed/tag with unread proceeds to honor the #pos.)
   if (await noUnreadLeft()) return resolveNoMatch(true)
   if (!(await isValidSeen(target))) return last(true, false)
   return resolve(target, true, false)
}

// One directional navigation step. The post-navigation neighbor lookup is
// speculative, so it is stored as an un-awaited promise: findLeft/findRight
// may lazily fetch an idx pack, and that must neither delay the article
// already on screen nor reject a navigation that succeeded (a failed lookup
// just clears its slot; the next keypress retries on the critical path).
// The slot-identity checks keep a lookup superseded by a newer navigation
// from prefetching or clearing on its behalf.
async function step(dir: "left" | "right"): Promise<IShowFeed> {
   const lookup = () => (dir === "left" ? neighborOlder(pos) : neighborNewer(pos))
   const target = await (next[dir] ?? lookup())
   if (target === -1) throw new Error(`no ${dir} match`)
   const result = await resolve(target)
   const mine = (next[dir] = lookup())
   mine
      .then((t) => {
         if (next[dir] === mine) schedulePrefetch(t)
      })
      .catch(() => {
         if (next[dir] === mine) next[dir] = undefined
      })
   return result
}

export function left(): Promise<IShowFeed> {
   return step("left")
}

export function right(): Promise<IShowFeed> {
   return step("right")
}

// The smallest value in an iterable, computed WITHOUT a spread: Math.min(...it)
// overflows the JS engine's spread-argument limit and throws on a store
// approaching FEED_ID_CEILING (~65k feeds) — the same reason data.ts reduces
// instead of Math.max(...ids). Returns `fallback` for an empty iterable.
function minOf(values: Iterable<number>, fallback = 0): number {
   let m = Infinity
   for (const v of values) if (v < m) m = v
   return m === Infinity ? fallback : m
}

export async function first(record = true): Promise<IShowFeed> {
   // ★ Saved is a queue read front-to-back: "first" is the FRONT — the earliest
   // save (save-index 0), not the lowest chronIdx.
   if (filter.saved) {
      const front = savedOrder()[0]
      return front === undefined ? resolveNoMatch() : resolve(front, false, record)
   }
   // No article from a feed with add_idx N exists below chronIdx N, so the
   // earliest matching article is at or after the smallest add_idx in filter.
   const start = minOf(filter.feeds.values())
   return goTo(start, record)
}

export async function last(replace = false, record = true): Promise<IShowFeed> {
   // ★ Saved: the BACK of the queue is the newest save (highest save-index).
   let found: number
   if (filter.saved) {
      const order = savedOrder()
      found = order.length ? order[order.length - 1] : -1
   } else {
      found = await feedLeft(data.db.total_art - 1)
   }
   if (found === -1) return resolveNoMatch(replace)
   return resolve(found, replace, record)
}

async function isValidSeen(idx: number): Promise<boolean> {
   if (idx < 0 || idx >= data.db.total_art) return false
   const feedId = await data.getFeedId(idx)
   // Unseen-only tag mode raises each member's bound past its seen position
   // (read at filter-apply time), so filter.matches() would reject the tag's own resume (seen)
   // position and bounce switchFilter forward to the oldest unseen. Accept that
   // resume position anyway — the same current position a feed or a non-unseen
   // tag resumes to — by validating against the member's TRUE add_idx instead of
   // the raised bound. Right then steps to the first unseen, and resolve()
   // records the accepted landing as filter.anchor so ← can step back to it.
   if (unseenActive()) return filter.feeds.has(feedId) && idx >= (data.db.feeds[feedId]?.add_idx ?? 0)
   return filter.matches(feedId, idx)
}

// Does this filter token name a real feed (numeric id) or tag in the store?
// Used by switchFilter to tell a known-but-empty pick (→ placeholder) from a
// stale/bogus token (→ [ALL]).
function isKnownToken(token: string): boolean {
   const num = Number(token)
   if (Number.isFinite(num)) return data.db.feeds[num] !== undefined
   return Object.values(data.db.feeds).some((ch) => ch.tag === token)
}

// True when unread-only is on and the active feed/tag filter has no unread
// article left — every article sits below its raised (seen+1) bound, so nothing
// matches the walk. switchFilter/fromHash surface the directed "All caught up"
// placeholder (resolveNoMatch → the reader's empty state) in this case instead
// of resuming onto an already-read article: in unread-only mode a caught-up lane
// has nothing to show. Show-read mode (unseenActive false) returns false — you
// browse the read articles there, so the resume onto one is correct.
async function noUnreadLeft(): Promise<boolean> {
   if (!unseenActive() || filter.feeds.size === 0) return false
   const start = minOf(filter.feeds.values())
   try {
      return (await feedRight(start)) === -1
   } catch {
      // A cold finalized-pack fetch can blip. Don't strand the open on the
      // placeholder over a transient probe failure — assume there's unread and
      // resume normally (showFeed degrades the neighbor buttons on its own).
      return false
   }
}

// Opening a tag/feed resumes at its CURRENT position — the saved seen
// position (a feed's own; a tag's oldest member, see getSeen) — in every
// mode, including unseen-only: you land on the article you left off on, not the
// next unseen to the right. isValidSeen validates that resume position against
// the true add_idx, so unseen-only's raised bounds don't bounce you forward;
// Right then walks the unseen. Only a never-seen tag/feed (no resume
// position) or a stale/out-of-range one starts at first().
//
// Every landing resolves with record = false: a filter switch (this is the sole
// entry for a picker click AND the W/S / ↑↓ / two-finger cycle, via cycleFilter)
// is a resume, not a read, so it never advances the seen frontier — merely
// visiting a lane cannot decrement its unread count. Reading forward (Right)
// records normally from there.
export async function switchFilter(token: string): Promise<IShowFeed> {
   if (token === "") {
      filter.clear()
      // [ALL] opens at the oldest unseen article — the start of the global
      // unread backlog, the same anchor the list uses — NOT the newest. It lands
      // there but records nothing (record = false): opening [ALL] leaves the whole
      // backlog, the shown article included, unread until you step into it. Fully
      // caught up falls back to the newest available — or, in unread-only mode, the
      // "All caught up" placeholder (nothing unread anywhere to show).
      const idx = await oldestUnread()
      if (idx !== -1) return resolve(idx, false, false)
      return unseenActive() ? resolveNoMatch() : last(false, false)
   }
   filter.set([token])
   if (!filter.active) {
      // filter.set cleared to [ALL] because the token matched no articles. A real
      // feed/tag with total_art===0 is now pickable (the config picker lists empty
      // feeds when read items are shown): scope the filter to it and show the
      // empty-state placeholder rather than teleporting into [ALL]'s newest article.
      // An unrecognised token (not reachable from the picker today) still falls
      // back to [ALL].
      if (!isKnownToken(token)) return last(false, false)
      filter.tokens = [token]
      filter.feeds = new Map<number, number>()
      return resolveNoMatch()
   }
   // Search has no per-feed resume position; open at the newest hit (top of
   // the list), the same place selecting it on the list shows.
   if (filter.search) return last(false, false)
   // ★ Saved is a read-later queue consumed front-to-back: open at the OLDEST
   // saved article — the same landing the list anchors on — and read forward.
   // first() with an empty filter.feeds walks the saved set from chron 0.
   if (filter.saved) return first(false)
   // Oldest unread under the raised bounds — the ONE feedRight scan, reused for
   // both the caught-up test here and the not-started startFeed name below (was
   // two identical scans: noUnreadLeft's probe, then a re-tread for startFeed).
   // Guarded exactly like noUnreadLeft (fromHash still uses that — it has no probe
   // to reuse); unreadKnown tells a genuine -1 (caught up) from a cold-pack blip.
   let firstUnread = -1
   let unreadKnown = false
   if (unseenActive() && filter.feeds.size > 0) {
      try {
         firstUnread = await feedRight(minOf(filter.feeds.values()))
         unreadKnown = true
      } catch {
         // A cold finalized-pack fetch can blip. Don't strand the open on the
         // "All caught up" placeholder over a transient probe failure — assume
         // there's unread and resume normally (showFeed degrades on its own).
      }
   }
   // Unread-only + fully-read feed/tag: nothing unread to resume onto — show the
   // "All caught up" placeholder rather than opening an already-read article.
   if (unreadKnown && firstUnread === -1) return resolveNoMatch()
   const seenIdx = getSeen(token)
   if (seenIdx !== undefined && (await isValidSeen(seenIdx))) return resolve(seenIdx, false, false)
   // No already-read article to resume onto, but there IS unread (not caught up
   // above). In unread-only mode the reader is a resume surface: show the distinct
   // "not started" placeholder rather than dropping the reader onto an unread
   // article that a mere switch must not consume (a switch records nothing).
   // The placeholder itself keeps Next ARMED: reading begins right here with a
   // →-step onto the oldest unread (recorded, as any read step is), no detour
   // through the list. With pos at -1 the pill has no cursor to floor at, so
   // it reads the feed's whole unread backlog — exactly the picker badge.
   // Show-read mode opens the oldest article as before (you browse there).
   if (!unseenActive()) return first(false)
   const o = resolveNoMatch(false, true)
   o.has_right = true // the unread probe above found a right-match (a blip assumes one)
   o.right_count = await pendingRight().catch(() => -1)
   // Name WHICH feed the never-read backlog starts with: the oldest unread's own
   // feed — under a tag lane the label alone can't say which member feed is the
   // new one. Reuse the firstUnread chron already probed above (warm idx pack); a
   // blip left it -1, so startFeed stays unset and the message falls back to the
   // lane label.
   o.startFeed = firstUnread < 0 ? undefined : await Promise.resolve(data.getFeedId(firstUnread)).catch(() => undefined)
   return o
}

// Jump to chronIdx, snapping forward to next match if filter is active.
export async function goTo(idx: number, record = true): Promise<IShowFeed> {
   if (idx < 0 || idx >= data.db.total_art) return last(false, record)
   // ★ Saved has no value order to snap through: land on the exact saved article
   // (a list-row tap / deep-link always names a member), else fall back to the
   // front of the queue for a stale ~saved deep-link.
   if (filter.saved) return isSaved(idx) ? resolve(idx, false, record) : first(false)
   const found = await feedRight(idx)
   return found === -1 ? last(false, record) : resolve(found, false, record)
}

// Move the navigation cursor to an exact, already-known-matching chronIdx — the
// list surface's keyboard selection (A/D/←/→ step the highlighted row). The row
// is a rendered filter member and its feed is known from the row's data-feed,
// so there's no feed walk or idx fetch. Same cursor bookkeeping as resolve minus
// the article load: it does NOT update the hash or recordSeen, because moving
// the list cursor isn't reading the article — pos just tracks the highlight so
// opening it (tap) or re-anchoring the list later stays consistent.
export function select(chron: number, feedId: number): void {
   pos = chron
   currentFeed = feedId
   next.left = next.right = undefined
   abortPrefetch()
}

export function getFilterEntries(): string[] {
   const { sortedTags, untagged } = data.groupFeedsByTag()
   const entries = [""]
   // "★ Saved" joins the rotation (keyboard cycle / two-finger swipe) right
   // after [ALL], but only once there's something saved — no empty smart folder.
   if (savedCount() > 0) entries.push(SAVED_TOKEN)
   for (const tag of sortedTags) entries.push(tag)
   for (const ch of untagged) entries.push(String(ch.id))
   return entries
}

// Set the active filter from tokens WITHOUT moving pos or resolving an article
// — the list surface owns its own position (scroll), so it sets the filter then
// walks findLeft/findRight itself. Same token semantics as fromHash's filter
// segment (numeric feed ids and tag names; unseen-only's raised bounds apply
// in single-tag mode). Empty → clear (all feeds).
export function applyFilter(tokens: string[]): void {
   if (tokens.length === 0) {
      filter.clear()
      return
   }
   filter.set(tokens)
   // Symmetric with switchFilter: a known feed/tag that currently has zero
   // matching articles (an empty feed, pickable when read items are shown)
   // makes filter.set fall back to [ALL]. Re-scope it to itself so a reload/back
   // to `#!<token>` re-renders the empty-state placeholder under that scope
   // instead of silently showing [ALL]'s full list. A truly unknown/stale token
   // still falls back to [ALL].
   if (!filter.active && tokens.length === 1 && isKnownToken(tokens[0])) {
      filter.tokens = [tokens[0]]
      filter.feeds = new Map<number, number>()
   }
}

// A stable key for the active filter tokens — identifies the token SET
// (unlike getCurrentFilterKey, which collapses multi-token filters to ""),
// so the list can key its build/scroll memory on the exact filter.
// "" means [ALL].
export function filterKey(): string {
   return filter.tokens.join(" ")
}

// The `!tokens` hash suffix for the active filter ("" when inactive) — shared by
// updateHash (reader `#pos!tokens`) and the list surface (`#!tokens`, no pos).
// `+` joins tokens, so a literal `+` inside one (e.g. a search query "c++") is
// escaped to %2B — encodeURIComponent leaves `+` alone — and decoded back after
// the split on the read side (route/fromHash).
export function tokensSuffix(): string {
   return filter.active ? "!" + filter.tokens.map((t) => encodeURIComponent(t).replaceAll("+", "%2B")).join("+") : ""
}

// The position part of a `#pos[!tokens]` hash — everything before the first
// `!` (the whole hash when there is none). "" means no position (a list hash);
// an integer routes to the reader; anything else is a foreign hash (app.ts's
// boot guard drops those). parseHashTokens below is the suffix half.
export function hashPos(hash: string): string {
   const bang = hash.indexOf("!")
   return bang === -1 ? hash : hash.substring(0, bang)
}

// Parse the `!tokens` segment of a hash into an array of decoded token strings.
// Called by both app.ts route() (the list path) and fromHash() (the reader path).
// A malformed %-escape passes through verbatim rather than crashing navigation.
export function parseHashTokens(hash: string): string[] {
   const bang = hash.indexOf("!")
   if (bang === -1) return []
   return hash
      .substring(bang + 1)
      .split("+")
      .filter((t) => t.length > 0)
      .map((t) => {
         try {
            return decodeURIComponent(t)
         } catch {
            return t
         }
      })
}

// The parsed seen map (feed key → last-viewed chronIdx). Exposed for the
// list surface's per-row read/unread dot; nav owns the localStorage shape.
export function getSeenMap(): Record<string, number> {
   return readSeen()
}

// A row is unread when its feed was never seen on this device, or the row's
// chronIdx is strictly after the feed's seen high-water — the same rule
// unreadCount/feedUnread count by (never-seen = all unread).
export function isRowUnread(chronIdx: number, feedId: number, seenMap: Record<string, number>): boolean {
   const s = seenMap["feed:" + feedId]
   return s === undefined || chronIdx > s
}

// Map current filter state to a key matching getFilterEntries() format (""|"tagName"|"id")
export function getCurrentFilterKey(): string {
   if (!filter.active) return ""
   if (filter.tokens.length === 1) return filter.tokens[0]
   return ""
}

// Resolve a filter key (getCurrentFilterKey / getFilterEntries format) to its
// human label: [ALL] "" → "All", the saved smart-folder → "★ Saved", a numeric
// feed id → that feed's title, a tag name → itself. Tags are already names; only
// untagged single-feed filters carry a raw id, so this is what keeps the toolbar
// label, the document title, and the caught-up line from ever showing an id.
export function filterLabel(key: string): string {
   if (key === "") return "All"
   if (key === SAVED_TOKEN) return "★ Saved"
   return /^\d+$/.test(key) ? data.feedTitle(Number(key)) : key
}

// The cycle "origin": like getCurrentFilterKey, but a single-feed filter on a
// TAGGED feed resolves to its tag. getFilterEntries lists tagged feeds only
// by tag (never by id), so a raw id would miss indexOf and snap cycling to [ALL].
// Shared by the reader (cycleFilter) and the list (app.onCycle) so both surfaces
// cycle relative to the same current selection.
export function cycleOriginKey(): string {
   let current = getCurrentFilterKey()
   if (current !== "" && filter.tokens.length === 1) {
      const num = Number(current)
      if (Number.isFinite(num)) {
         const ch = data.db.feeds[num]
         if (ch?.tag) current = ch.tag
      }
   }
   return current
}

// The lanes W/S / ↑↓ / two-finger cycling may land on, out of getFilterEntries().
// ★ Saved is ALWAYS dropped — it's a deliberate pick from the picker, not a step
// in the unread sweep. [ALL] always stays. With read shown, every remaining lane
// qualifies; in unread-only mode a tag/feed lane survives only when it holds ≥1
// unread — mirroring the picker's fillUnread hiding, so the cycle visits exactly
// the lanes the picker lists (minus ★ Saved). Async because unread is idx-derived
// (unreadCounts).
async function cyclableLanes(entries: string[]): Promise<Set<string>> {
   const keep = new Set(entries)
   keep.delete(SAVED_TOKEN)
   if (!unreadOnly) return keep
   const { tagged, untagged } = data.groupFeedsByTag()
   const counts = await unreadCounts([...untagged, ...[...tagged.values()].flat()])
   for (const ch of untagged) if ((counts.get(ch.id) ?? 0) === 0) keep.delete(String(ch.id))
   for (const [tag, group] of tagged) if (tagUnreadFromCounts(group, counts) === 0) keep.delete(tag)
   return keep
}

// The token getFilterEntries() cycling lands on stepping `dir` from the current
// selection (cycleOriginKey): the nearest cyclableLanes entry in the `dir`
// direction, wrapping. Returns the origin (a no-op) when nothing else qualifies —
// [ALL] always survives cyclableLanes, so in practice the walk always lands.
// Shared by the reader (cycleFilter) and the list (app.onCycle), so both surfaces
// step relative to the same origin and skip alike.
export async function cycleToken(dir: number): Promise<string> {
   const entries = getFilterEntries()
   const n = entries.length
   let idx = entries.indexOf(cycleOriginKey())
   if (idx === -1) idx = 0
   const keep = await cyclableLanes(entries)
   for (let step = 1; step <= n; step++) {
      const cand = entries[(((idx + dir * step) % n) + n) % n]
      if (keep.has(cand)) return cand
   }
   return entries[idx]
}

export async function cycleFilter(dir: number): Promise<IShowFeed> {
   return switchFilter(await cycleToken(dir))
}

function updateHash(replace = false) {
   const hash = pos >= 0 ? `#${pos}${tokensSuffix()}` : `#${tokensSuffix()}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
