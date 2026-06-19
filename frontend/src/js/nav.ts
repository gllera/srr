import * as data from "./data"
import { extractImageUrls, getImgProxy, imgProxy } from "./fmt"
import * as search from "./search"

let pos = -1
// Feed id of the article currently on screen (-1 = none). feedUnread counts
// this feed's current article as still-unread while you sit on it, but only
// in unseen-only tag mode — see feedUnread.
let currentFeed = -1
const next: { left?: Promise<number>; right?: Promise<number> } = {}

// Unseen-only navigation: when on, the active filter skips articles already
// seen (per the seen positions read at filter-apply time), so you glide past
// feeds you're caught up on. A device-local preference, not part of the
// shareable #pos!tokens hash. See filter.set / filter.applyUnseen and
// dropdown.ts's chip.
const UNREAD_ONLY_KEY = "srr-unread-only"
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
      if (on) localStorage.setItem(UNREAD_ONLY_KEY, "1")
      else localStorage.removeItem(UNREAD_ONLY_KEY)
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
const SAVED_KEY = "srr-saved"

// Re-read on each access (no module-level cache): the set is small and
// user-curated, so the localStorage parse is cheap, and reading fresh stays
// correct across tabs and keeps tests/`vi.resetModules` free of stale state.
function readSavedSet(): Set<number> {
   try {
      const raw = localStorage.getItem(SAVED_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : [])
   } catch {
      return new Set()
   }
}
// Ascending chronIdx, for the neighbor walks and the showFeed left/right tally.
function savedSorted(): number[] {
   return [...readSavedSet()].sort((a, b) => a - b)
}

export function isSaved(chron: number): boolean {
   return readSavedSet().has(chron)
}
export function savedCount(): number {
   return readSavedSet().size
}
// Toggle one article's saved state; returns the new state. Clears the
// neighbor-prefetch slots since the saved feed's neighbors may have shifted.
export function toggleSaved(chron: number): boolean {
   const set = readSavedSet()
   const nowSaved = !set.has(chron)
   if (nowSaved) set.add(chron)
   else set.delete(chron)
   try {
      localStorage.setItem(SAVED_KEY, JSON.stringify([...set].sort((a, b) => a - b)))
   } catch {}
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
   if (pos >= 0 && currentFeed >= 0 && filter.matches(currentFeed, pos)) return pos
   return -1
}

// Where the LIST surface anchors when (re)built — and, since the list highlight
// tracks it (render's nav.select), the article the list SELECTS on a fresh
// filter. The reader's live article still wins when it matches the active filter
// (you tapped back from reading it — anchorChron). Otherwise:
//   • a feed/tag opens at its OLDEST UNREAD article — the start of the unread
//     backlog, to read forward (newer) from there — falling back to its newest
//     article (the -1 newest-default below) when nothing is unread. Computed by
//     raising each member's bound past its seen high-water (idempotent with
//     unseen-only's already-raised bounds; a never-seen feed keeps its bound, so
//     its full backlog counts as unread) and taking the OLDEST match under those
//     bounds — the same unread set unseen-only navigation walks, evaluated
//     transiently here without touching filter.feeds, so the list still SHOWS
//     every article (read rows below the anchor, unread above).
//   • [ALL], ★ Saved and search keep the newest-first default (-1): the latest
//     available article. A query in particular always shows its newest hit,
//     regardless of seen state.
// Async because findRight may touch an idx pack; anchorChron stays synchronous
// for the live-position callers.
export async function listAnchor(): Promise<number> {
   const live = anchorChron()
   if (live >= 0) return live
   if (!filter.active || filter.saved || filter.search) return -1
   const seen = readSeen()
   const unread = new Map<number, number>()
   for (const [id, bound] of filter.feeds) {
      const s = seen["feed:" + id]
      unread.set(id, s === undefined ? bound : Math.max(bound, s + 1))
   }
   // Oldest unread: the smallest matching chron under the raised bounds (scan up
   // from the smallest bound — nothing matches below it). -1 (newest-default,
   // latest available) when nothing is unread.
   const start = Math.min(...unread.values())
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
export function searchAvailable(): boolean {
   return search.available()
}
export function searchShort(q: string): boolean {
   return search.shortQuery(q)
}

// Largest entry <= from / smallest entry >= from in an ascending array (-1 =
// none) — the pure neighbor scan the saved and search sets walk. Both modes
// pass their sorted set; the walk never fetches an idx pack.
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
   // An empty query has no hits — mark it loaded without calling loadHits
   // (parity with search.loadHits's own `if (query)` guard; tests assert it).
   if (!term) {
      searchSorted = []
      searchSet = new Set()
      searchTruncatedFlag = false
      searchLoadedFor = term
      return
   }
   const { chrons, truncated } = await search.loadHits(term, SEARCH_CAP)
   if (term !== activeQuery()) return // superseded — discard stale result
   searchSorted = chrons
   searchSet = new Set(chrons)
   searchTruncatedFlag = truncated
   searchLoadedFor = term
}

// The current feed's neighbor walk — the ONE seam saved mode branches at. Every
// navigation primitive (step, first/last, goTo) and the list surface route
// their findLeft/findRight through these instead of data.* directly, so saved
// mode (the explicit set) vs feed mode (the idx packs) is decided in one
// place. Async to match data.findLeft/findRight; the saved branch is synchronous,
// wrapped in a resolved promise.
export function feedLeft(from: number): Promise<number> {
   if (filter.saved) return Promise.resolve(setLeft(savedSorted(), from))
   if (filter.search) return ensureSearchSet().then(() => setLeft(searchSorted, from))
   return data.findLeft(from, filter.feeds)
}
export function feedRight(from: number): Promise<number> {
   if (filter.saved) return Promise.resolve(setRight(savedSorted(), from))
   if (filter.search) return ensureSearchSet().then(() => setRight(searchSorted, from))
   return data.findRight(from, filter.feeds)
}

export const filter = {
   feeds: new Map<number, number>(),
   tokens: [] as string[],
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
      this.feeds = new Map<number, number>()
      this.saved = false
      this.search = false
      for (const ch of Object.values(data.db.feeds)) if (ch.total_art) this.feeds.set(ch.id, ch.add_idx ?? 0)
      this.tokens = []
      // [ALL] honours unseen-only too now (a global "only unread" catch-up view).
      this.applyUnseen(readSeen())
   },
   set(tokens: string[]) {
      this.tokens = tokens
      this.feeds = new Map<number, number>()
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
      for (const token of tokens) {
         const num = Number(token)
         if (Number.isFinite(num)) {
            const ch = data.db.feeds[num]
            if (ch?.total_art && !this.feeds.has(num)) this.feeds.set(num, ch.add_idx ?? 0)
         } else
            for (const ch of Object.values(data.db.feeds))
               if (ch.tag === token && ch.total_art && !this.feeds.has(ch.id)) this.feeds.set(ch.id, ch.add_idx ?? 0)
      }
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

// True only in unseen-only mode with a feed/tag filter active (not saved, not
// search). Matches the exact conditions under which applyUnseen raises bounds,
// so feedUnread and isValidSeen can branch on the same predicate.
function unseenActive(): boolean {
   return unreadOnly && !filter.saved && !filter.search
}

// One member's unread given an already-parsed seen map: its articles strictly
// after the feed's seen position, or — when the feed was NEVER seen on
// this device — its full backlog (countAll). A never-seen feed counts as
// fully unread so its row badge matches its tag header (tagUnreadFromCounts) and
// the unseen-only nav that would walk its whole history; a fresh device thus
// shows a count on every feed, not a blank. Both terms come from the same idx
// counting (countAll − countLeft) so db.gz total_art drift can't skew it, and
// the boundary pack is the resident latest pack whenever seen is recent (zero
// fetches; the never-seen branch is sync countAll — no fetch at all). Shared by
// unreadCount/unreadCounts.
//
// `onCurrent`: in unseen-only mode, recordSeen marks the article you're on seen
// the instant you arrive, so a live-seen-derived badge would tick this feed down
// by one before you actually move off it. Count that article back for the feed
// you're sitting on so its row badge (and its tag-header sum) stays put while you
// read it, then drops as you step away. Scoped to unseen-only mode, the current
// article's feed, and only while that article still matches the (raised) filter
// — i.e. it is one of the unread you're navigating, not the seen resume position
// you open on.
async function feedUnread(ch: IFeed, seenMap: Record<string, number>): Promise<number> {
   const map = new Map([[ch.id, ch.add_idx ?? 0]])
   const onCurrent =
      unseenActive() && ch.id === currentFeed && filter.matches(ch.id, pos) && (seenMap["feed:" + ch.id] ?? -1) === pos
         ? 1
         : 0
   const seenIdx = seenMap["feed:" + ch.id]
   if (seenIdx === undefined) return data.countAll(map) + onCurrent
   const upTo = Math.min(seenIdx + 1, data.db.total_art)
   return Math.max(0, data.countAll(map) - (await data.countLeft(upTo, map))) + onCurrent
}

async function showFeed(article: IArticle): Promise<IShowFeed> {
   // has_left/has_right only need to know whether a neighbor exists under the
   // active filter, which is exactly what feedLeft/feedRight answer — the same
   // seam navigation steps through (raised bounds in unseen-only, the explicit
   // set in saved/search). So the prev/next buttons enable precisely when a step
   // would move. resolve() awaited loadArticle(pos), so the pos idx pack is
   // resident; a same-pack neighbor costs no fetch, and a cross-pack one is the
   // very lookup the neighbor prefetch makes next anyway. A cold-pack fetch for a
   // boundary neighbor can blip (offline/evicted); .catch degrades to "no
   // neighbor" (button disabled, retried on the next render) rather than failing
   // the already-loaded article into the error popup.
   const has_left = (await feedLeft(pos - 1).catch(() => -1)) !== -1
   const has_right = (await feedRight(pos + 1).catch(() => -1)) !== -1
   return {
      article,
      has_left,
      has_right,
   }
}

async function resolve(target: number, replace = false): Promise<IShowFeed> {
   // Load first; commit pos only on success so a Retry replays the same chron.
   const article = await data.loadArticle(target)
   pos = target
   currentFeed = article.f
   next.left = next.right = undefined
   abortPrefetch()
   updateHash(replace)
   recordSeen(article)
   return showFeed(article)
}

// Holds refs to the last neighbor's prefetched Image objects so we can both
// abort their in-flight loads (img.src = "" per WHATWG image-update steps)
// and drop the references, bounding memory to one neighbor at a time. Array
// identity also acts as the freshness token: a pending idle callback that
// finds `my !== currentPrefetch` bails instead of pushing into a stale array.
let currentPrefetch: HTMLImageElement[] | null = null

function abortPrefetch() {
   if (currentPrefetch) for (const img of currentPrefetch) img.src = ""
   currentPrefetch = null
}

function schedulePrefetch(target: number) {
   if (target === -1) return
   const my: HTMLImageElement[] = []
   currentPrefetch = my
   const run = async () => {
      if (my !== currentPrefetch) return
      try {
         const art = await data.loadArticle(target)
         if (my !== currentPrefetch) return
         const proxyPrefix = getImgProxy()
         for (const raw of extractImageUrls(art.c)) {
            const img = new Image()
            img.fetchPriority = "low"
            img.decoding = "async"
            img.src = imgProxy(raw, proxyPrefix)
            my.push(img)
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

const SEEN_KEY = "srr-seen"

function readSeen(): Record<string, number> {
   try {
      const raw = localStorage.getItem(SEEN_KEY)
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// A feed stores its own seen position (chronIdx of the last article viewed
// from it). A tag has no position of its own: it resumes from the oldest seen
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

function recordSeen(article: IArticle) {
   // Search (q:) mode jumps to title-search hits, not a contiguous read-through:
   // advancing the seen frontier here would mark every article up to the hit as
   // seen, including ones never shown. So search navigations never touch the
   // seen frontier — a hit you peek at via search stays unread until you
   // actually read it in the feed. (This is the "unless in query mode" carve-out
   // for the mark-previous-as-seen rule below.)
   if (filter.search) return
   const ch = data.db.feeds[article.f]
   if (!ch) return
   try {
      const seen = readSeen()
      let changed = false
      // The article's OWN feed stores its resume position — the exact pos, so
      // stepping back to an older article moves the resume point with you. A
      // tag's position is derived from its feeds in getSeen, so bumping the
      // feed advances the tag too.
      const feedKey = "feed:" + article.f
      if (seen[feedKey] !== pos) {
         seen[feedKey] = pos
         changed = true
      }
      // Opening an article marks every OLDER article in the navigation list as
      // seen, not just ones from its own feed: for each OTHER feed in the
      // active filter (the list you're reading), raise its seen frontier to pos
      // so all of its articles at-or-below pos read as seen — the chronological
      // "everything before here is caught up" the reader expects. A one-way
      // raise (never lowers), so scrubbing back to an older article can't
      // un-mark a feed you'd already caught up on; only the current feed
      // (above) tracks an exact resume position. Saved mode keeps filter.feeds
      // empty (feed-agnostic) and search returned above, so this loop only
      // fires for feed/tag/[ALL] navigation — the contiguous read-throughs
      // where a "previous = seen" frontier across feeds is meaningful.
      for (const feedId of filter.feeds.keys()) {
         if (feedId === article.f) continue
         const key = "feed:" + feedId
         const prev = seen[key]
         if (prev === undefined || prev < pos) {
            seen[key] = pos
            changed = true
         }
      }
      if (changed) localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

// Batched per-feed unread (OPT-2): reads the seen map once for the whole
// batch instead of once per feed (a menu fill badges every visible row).
// Maps feed id → unread (a never-seen feed maps to its full backlog).
export async function unreadCounts(chs: IFeed[]): Promise<Map<number, number>> {
   const seenMap = readSeen()
   const out = new Map<number, number>()
   await Promise.all(chs.map(async (ch) => out.set(ch.id, await feedUnread(ch, seenMap))))
   return out
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
      if (changed) localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

function resolveNoMatch(replace = false): IShowFeed {
   pos = -1
   currentFeed = -1
   updateHash(replace)
   return {
      article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
      has_left: false,
      has_right: false,
      placeholder: true,
   }
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const bangIdx = hash.indexOf("!")
   const posStr = bangIdx === -1 ? hash : hash.substring(0, bangIdx)

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
   // in unseen-only mode, filter.matches otherwise). Using filter.matches() here let
   // unseen-only reject an already-seen #pos and bounce it to last(); recordSeen then
   // marked that seen, so each refresh drifted to a lower unseen article. From the
   // honored position, Right still walks the unseen.
   if (!(await isValidSeen(target))) return last(true)
   return resolve(target, true)
}

// One directional navigation step. The post-navigation neighbor lookup is
// speculative, so it is stored as an un-awaited promise: findLeft/findRight
// may lazily fetch an idx pack, and that must neither delay the article
// already on screen nor reject a navigation that succeeded (a failed lookup
// just clears its slot; the next keypress retries on the critical path).
// The slot-identity checks keep a lookup superseded by a newer navigation
// from prefetching or clearing on its behalf.
async function step(dir: "left" | "right"): Promise<IShowFeed> {
   const lookup = () => (dir === "left" ? feedLeft(pos - 1) : feedRight(pos + 1))
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

export async function first(): Promise<IShowFeed> {
   // No article from a feed with add_idx N exists below chronIdx N, so the
   // earliest matching article is at or after the smallest add_idx in filter.
   const start = filter.feeds.size > 0 ? Math.min(...filter.feeds.values()) : 0
   return goTo(start)
}

export async function last(replace = false): Promise<IShowFeed> {
   const found = await feedLeft(data.db.total_art - 1)
   if (found === -1) return resolveNoMatch(replace)
   return resolve(found, replace)
}

async function isValidSeen(idx: number): Promise<boolean> {
   if (idx < 0 || idx >= data.db.total_art) return false
   const feedId = await data.getFeedId(idx)
   // Unseen-only tag mode raises each member's bound past its seen position
   // (read at filter-apply time), so filter.matches() would reject the tag's own resume (seen)
   // position and bounce switchFilter forward to the oldest unseen. Accept that
   // resume position anyway — the same current position a feed or a non-unseen
   // tag resumes to — by validating against the member's TRUE add_idx instead of
   // the raised bound. Right then steps to the first unseen.
   if (unseenActive()) return filter.feeds.has(feedId) && idx >= (data.db.feeds[feedId]?.add_idx ?? 0)
   return filter.matches(feedId, idx)
}

// Opening a tag/feed resumes at its CURRENT position — the saved seen
// position (a feed's own; a tag's oldest member, see getSeen) — in every
// mode, including unseen-only: you land on the article you left off on, not the
// next unseen to the right. isValidSeen validates that resume position against
// the true add_idx, so unseen-only's raised bounds don't bounce you forward;
// Right then walks the unseen. Only a never-seen tag/feed (no resume
// position) or a stale/out-of-range one starts at first().
export async function switchFilter(token: string): Promise<IShowFeed> {
   if (token === "") {
      filter.clear()
      return last()
   }
   filter.set([token])
   if (!filter.active) return last()
   // Saved/search have no per-feed resume position; open at the newest member
   // (top of the list), the same place selecting them on the list shows.
   if (filter.saved || filter.search) return last()
   const seenIdx = getSeen(token)
   if (seenIdx !== undefined && (await isValidSeen(seenIdx))) return resolve(seenIdx)
   return first()
}

// Jump to chronIdx, snapping forward to next match if filter is active.
export async function goTo(idx: number): Promise<IShowFeed> {
   if (idx < 0 || idx >= data.db.total_art) return last()
   const found = await feedRight(idx)
   return found === -1 ? last() : resolve(found)
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
   if (tokens.length > 0) filter.set(tokens)
   else filter.clear()
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

// The token getFilterEntries() cycling lands on when stepping `dir` from the
// current selection (cycleOriginKey). Shared by the reader (cycleFilter) and the
// list (app.onCycle), so both surfaces step relative to the same origin and the
// indexOf+modulo lives in exactly one place.
export function cycleToken(dir: number): string {
   const entries = getFilterEntries()
   let idx = entries.indexOf(cycleOriginKey())
   if (idx === -1) idx = 0
   return entries[(idx + dir + entries.length) % entries.length]
}

export async function cycleFilter(dir: number): Promise<IShowFeed> {
   return switchFilter(cycleToken(dir))
}

function updateHash(replace = false) {
   const hash = pos >= 0 ? `#${pos}${tokensSuffix()}` : `#${tokensSuffix()}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
