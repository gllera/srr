import * as data from "./data"
import { extractImageUrls, getImgProxy, imgProxy } from "./fmt"
import * as search from "./search"

let pos = -1
// Feed id of the article currently on screen (-1 = none). feedUnread counts
// this feed's current article as still-unread while you sit on it, but only
// in unseen-only tag mode — see feedUnread.
let currentFeed = -1
const next: { left?: Promise<number>; right?: Promise<number> } = {}

// Unseen-only navigation, tags only: when on, a single-tag filter skips
// articles already seen (per the snapshotted seen positions of its members), so
// you glide past feeds you're caught up on. A device-local preference, not
// part of the shareable #pos!tokens hash. See filter.set / showFeed /
// unreadTally and dropdown.ts's chip.
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

// Where the LIST surface anchors when (re)built — a superset of anchorChron that
// adds per-filter resume, mirroring how switchFilter opens a tag/feed in the
// reader. The reader's live article still wins when it matches the active filter
// (you tapped back from reading it — anchorChron). Otherwise, for a tag/feed
// filter:
//   • one you've opened before resumes at its remembered position (getSeen — a
//     feed's own seen high-water, a tag's oldest member), when that position
//     is still a row of the active filter. In unseen-only mode it isn't (seen
//     articles fall below the raised bound), so it drops through to the oldest
//     unread — the natural "start of the backlog" there too.
//   • one with NO navigation information (never opened on this device, or a
//     stale/foreign stored position) anchors at its OLDEST matching article, so
//     the list opens at the start of the backlog with the unread rows above it,
//     instead of at the newest.
// [ALL], ★ Saved and search keep the newest-first default (-1) — the same place
// switchFilter opens saved/search and where the home firehose belongs. Async
// because resolving the oldest match / a resume position's feed may touch an
// idx pack; anchorChron stays synchronous for the live-position callers.
export async function listAnchor(): Promise<number> {
   const live = anchorChron()
   if (live >= 0) return live
   if (!filter.active || filter.saved || filter.search) return -1
   if (filter.tokens.length === 1) {
      const resume = getSeen(filter.tokens[0])
      if (resume !== undefined && resume >= 0 && resume < data.db.total_art) {
         if (filter.matches(await data.getFeedId(resume), resume)) return resume
      }
   }
   // Oldest match: feedRight from the smallest filter bound (mirrors first()).
   const start = filter.feeds.size > 0 ? Math.min(...filter.feeds.values()) : 0
   return feedRight(start)
}

// ── Search filter mode ───────────────────────────────────────────────────────
// A third filter mode beside feed-membership and ★ Saved: when the single
// token is "q:<query>", navigation walks an explicit set of matching chronIdxs —
// the title-search hits — exactly as ★ Saved walks the saved set. The set is
// computed once per query from the search/ shards (search.ts) and cached; the
// list and the reader then step through it via feedLeft/feedRight with no idx
// walk. The query rides in the shareable #!q:<query> hash like any token, so
// reload / back / forward restore the search and it behaves like a tag filter
// (picking another filter, two-finger cycle, or arrow-cycling leaves it — search
// is not part of getFilterEntries). Capped at SEARCH_CAP newest hits so a broad
// query can't fetch the whole archive; searchTruncated() flags the cap for the UI.
export const SEARCH_PREFIX = "q:"
const SEARCH_CAP = 500
let searchTerm = "" // the active query (text after "q:")
let searchSorted: number[] = [] // ascending matching chronIdxs — the neighbor walk
let searchSet = new Set<number>() // the same hits, for matches()
let searchTruncatedFlag = false
let searchLoadedFor: string | null = null // term searchSorted/searchSet were built for
let searchLoad: Promise<void> | null = null // in-flight computation (dedupes concurrent walks)
let searchLoadingTerm = ""

export function isSearchFilter(): boolean {
   return filter.search
}
export function searchQuery(): string {
   return searchTerm
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

// Compute the search set for `term` from the shard generator (newest-first,
// capped). Commits only if `term` is still the active query when it resolves, so
// a superseded keystroke's late result can't overwrite fresher hits.
async function loadSearchSet(term: string): Promise<void> {
   const set = new Set<number>()
   const chrons: number[] = []
   let truncated = false
   if (term) {
      try {
         // Ask for one past the cap: search() stops at its limit, so without the
         // +1 a query with exactly SEARCH_CAP matches and one with thousands both
         // yield SEARCH_CAP hits and the break below never fires — truncation
         // would be invisible. The extra hit is the witness; we keep only SEARCH_CAP.
         outer: for await (const batch of search.search(term, SEARCH_CAP + 1)) {
            for (const h of batch) {
               if (chrons.length >= SEARCH_CAP) {
                  truncated = true
                  break outer
               }
               if (!set.has(h.chron)) {
                  set.add(h.chron)
                  chrons.push(h.chron)
               }
            }
         }
      } catch (e) {
         // A missing summary / shard rejects the generator; degrade to whatever
         // was collected rather than breaking list/reader navigation.
         console.warn("search filter: shard scan failed", e)
      }
   }
   if (term !== searchTerm) return // superseded by a newer query
   chrons.sort((a, b) => a - b)
   searchSorted = chrons
   searchSet = set
   searchTruncatedFlag = truncated
   searchLoadedFor = term
}

// Ensure the set matches the active term before a neighbor walk reads it.
// Concurrent walks within one render share the single in-flight load.
function ensureSearchSet(): Promise<void> {
   if (searchLoadedFor === searchTerm) return Promise.resolve()
   if (searchLoad && searchLoadingTerm === searchTerm) return searchLoad
   const term = (searchLoadingTerm = searchTerm)
   searchLoad = loadSearchSet(term).finally(() => {
      if (searchLoadingTerm === term) searchLoad = null
   })
   return searchLoad
}

// The current feed's neighbor walk — the ONE seam saved mode branches at. Every
// navigation primitive (step, peek, first/last, goTo) and the list surface route
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

// A snapshotted tag member: its true add_idx, its seen position at snapshot
// time (-1 = never seen on this device), the position-invariant total of its
// articles (`all`, the member's full countAll — cached because it's
// pos-invariant and recomputing it in unreadTally doubled the latest-pack
// scans per nav step), and its position-invariant unread contribution
// (computed once in filter.set: a never-seen member counts as fully unread,
// since unseen-only navigates its whole history). `all`/`unread` are -1 until
// memberUnread populates them (memberUnread always runs before either is read).
type UnreadMember = { id: number; addIdx: number; seen: number; all: number; unread: number }

export const filter = {
   feeds: new Map<number, number>(),
   feedTotal: 0,
   tokens: [] as string[],
   // Non-null only in unseen-only tag mode: the tag's members with their true
   // add_idx, a snapshot of each one's seen position, and the position-invariant
   // unread contribution (max(0, all − read)) precomputed once at set() time, for
   // the unread counter (showFeed/unreadTally). `feeds` then holds raised
   // bounds for nav.
   unreadMembers: null as UnreadMember[] | null,
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
   // feedTotal is derived from the idx scan so it matches findRight/findLeft
   // reachability — sum-of-total_art can overstate when idx and db.gz disagree.
   // countAll is synchronous (latest pack + its cumulative header), so the
   // filter object never waits on a pack fetch.
   clear() {
      this.feeds = new Map<number, number>()
      this.unreadMembers = null
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
      this.unreadMembers = null
      // "★ Saved" is a standalone mode, not a feed resolution: short-circuit
      // before the feed loop (which would find no feeds and clear() back
      // to [ALL]). feeds stays empty; feedLeft/feedRight/matches/showFeed all
      // branch on filter.saved.
      this.saved = tokens.length === 1 && tokens[0] === SAVED_TOKEN
      // "q:<query>" — title-search mode (see Search filter mode above). Like
      // ★ Saved it short-circuits the feed resolution; the matching set is
      // computed lazily by ensureSearchSet, which feedLeft/feedRight await.
      this.search = !this.saved && tokens.length === 1 && tokens[0].startsWith(SEARCH_PREFIX)
      if (this.saved) {
         this.feedTotal = 0
         return
      }
      if (this.search) {
         const term = tokens[0].slice(SEARCH_PREFIX.length)
         // New query: drop the stale set so matches()/showFeed can't read the
         // previous query's hits before ensureSearchSet recomputes. A returning
         // query (back/forward) keeps its cached set.
         if (term !== searchLoadedFor) {
            searchSorted = []
            searchSet = new Set<number>()
            searchTruncatedFlag = false
            // Also forget what the (now-emptied) set was loaded for. Without this,
            // a fast type→backspace (A → B → A, where B's reload is still in flight)
            // would leave searchLoadedFor === "A" while the set is empty; on the
            // return to A, ensureSearchSet would see searchLoadedFor === searchTerm
            // and short-circuit, stranding the list on an empty result for a query
            // that has matches. Nulling forces ensureSearchSet to recompute.
            searchLoadedFor = null
         }
         searchTerm = term
         this.feedTotal = 0
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
   // clear()). When on, raise EVERY member's lower bound past its snapshotted seen
   // high-water — so read articles fall below it for findLeft/findRight/matches/
   // peek — and snapshot the members for the unread counters (showFeed/unreadTally/
   // isValidSeen). Generalised from the old single-tag case: it now applies to any
   // filter, so [ALL]/a feed/a tag all become a "show only unread" view. When
   // off, just total the set (feedTotal). Saved/search short-circuit before this.
   applyUnseen(seenMap: Record<string, number>) {
      if (!unreadOnly) {
         this.unreadMembers = null
         this.feedTotal = data.countAll(this.feeds)
         return
      }
      const members: UnreadMember[] = []
      for (const [id, addIdx] of this.feeds)
         members.push({ id, addIdx, seen: seenMap["feed:" + id] ?? -1, all: -1, unread: -1 })
      for (const m of members) this.feeds.set(m.id, Math.max(m.addIdx, m.seen + 1))
      this.unreadMembers = members
      // feedTotal is unused in unread mode (showFeed tallies via unreadMembers);
      // 0 so a stale value from a prior filter can't leak through.
      this.feedTotal = 0
   },
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
// `onCurrent`: in unseen-only tag mode, while you sit ON an unread article the
// toolbar counts it (showFeed's +matchesPos, Option A). recordSeen marks that
// article seen the instant you arrive, so the live seen map would drop this
// feed's badge by one immediately — leaving the dropdown tag badge one below
// the toolbar counter. Add the article back for the feed you're sitting on so
// the row badge (and its tag-header sum) equals the toolbar counter and ticks
// down with it. Scoped exactly to when/where showFeed adds matchesPos: only in
// unseen-only tag mode, only the current article's feed, and only while that
// article actually matches the (raised) filter — i.e. it is one of the unread
// you're navigating, NOT the seen resume position you open a tag on (there
// matchesPos is 0 and the toolbar doesn't count it either, so the badge mustn't).
async function feedUnread(ch: IFeed, seenMap: Record<string, number>): Promise<number> {
   const map = new Map([[ch.id, ch.add_idx ?? 0]])
   const onCurrent = filter.unreadMembers !== null && ch.id === currentFeed && filter.matches(ch.id, pos) ? 1 : 0
   const seenIdx = seenMap["feed:" + ch.id]
   if (seenIdx === undefined) return data.countAll(map) + onCurrent
   const upTo = Math.min(seenIdx + 1, data.db.total_art)
   return Math.max(0, data.countAll(map) - (await data.countLeft(upTo, map))) + onCurrent
}

// The position-invariant unread of one member (max(0, all − read)). Depends only
// on the snapshot, never on pos, so unreadTally computes it once per member and
// caches it on the entry (m.unread === -1 means uncomputed). The member's total
// `all` (countAll, also pos-invariant) is cached alongside so unreadTally's
// `right` term doesn't rescan the latest pack for the same single-feed map.
// A never-seen member (seen < 0) counts as fully unread: unseen-only navigates
// its whole history.
async function memberUnread(m: UnreadMember): Promise<number> {
   if (m.unread >= 0) return m.unread
   const map = new Map([[m.id, m.addIdx]])
   m.all = data.countAll(map)
   // seen < 0 (unseen on this device): nothing read, skip the fetch → all unread.
   const read = m.seen < 0 ? 0 : await data.countLeft(Math.min(m.seen + 1, data.db.total_art), map)
   return (m.unread = Math.max(0, m.all - read))
}

// Unread tallies for a tag's snapshotted members: the tag's total unread (the
// position-invariant part, summed once and cached per member — OPT-1) and the
// part strictly right of `at` (the only pos-dependent term, one countLeft per
// member, run concurrently so cold packs don't serialize). countLeft's
// cumulative-header shortcut is only exact for true add_idx bounds, which is why
// this counts per member instead of over filter.feeds' raised bounds.
async function unreadTally(at: number, members: UnreadMember[]): Promise<{ total: number; right: number }> {
   const perMember = await Promise.all(
      members.map(async (m) => {
         // memberUnread populates m.all (pos-invariant countAll) before we read
         // it, so the `right` term reuses it instead of a second countAll scan.
         const unread = await memberUnread(m)
         const map = new Map([[m.id, m.addIdx]])
         const rightEnd = Math.min(Math.max(at, m.seen) + 1, data.db.total_art)
         const right = Math.max(0, m.all - (await data.countLeft(rightEnd, map)))
         return { unread, right }
      }),
   )
   let total = 0
   let right = 0
   for (const p of perMember) {
      total += p.unread
      right += p.right
   }
   return { total, right }
}

async function showFeed(article: IArticle): Promise<IShowFeed> {
   const matchesPos = filter.matches(article.f, pos) ? 1 : 0
   let filteredLeft: number
   // `right` is the count strictly to the right of pos — it drives has_right
   // (the next button) and, outside unseen-only mode, the toolbar counter too.
   let right: number
   if (filter.saved || filter.search) {
      // Saved/search count their explicit set directly (no idx fetch): the
      // toolbar counter is the set's members strictly to the right, like a feed.
      const sorted = filter.saved ? savedSorted() : searchSorted
      let l = 0
      let r = 0
      for (const c of sorted) {
         if (c < pos) l++
         else if (c > pos) r++
      }
      filteredLeft = l
      right = r
   } else if (filter.unreadMembers) {
      // Unseen-only tag mode: count only unread. `right` is the unread strictly
      // to the right; left is the remainder of the tag's total unread (mirrors
      // the all-mode identity right = feedTotal − left − pos).
      try {
         const tally = await unreadTally(pos, filter.unreadMembers)
         right = tally.right
         filteredLeft = tally.total - tally.right - matchesPos
      } catch {
         // A per-member countLeft keys on a snapshotted SEEN position that can
         // live in a cold finalized idx pack; if that fetch rejects (offline /
         // evicted / blip) the rejection would propagate up and replace the
         // ALREADY-LOADED article with the error popup while pos is advanced.
         // The article already loaded, so degrade to an approximate raised-bounds
         // count that provably never fetches: countAll is sync (resident latest
         // pack), and countLeft(pos) hits the resident pos pack (resolve awaited
         // loadArticle(pos) before showFeed) and reads finalized packs only via
         // cumulative headers — the same no-fetch guarantee the non-unread
         // branch below relies on. It counts over raised bounds with countLeft's
         // cumulative-header shortcut so it may differ slightly from exact
         // unread, which is acceptable for a non-blocking has_left/has_right.
         filteredLeft = await data.countLeft(pos, filter.feeds)
         right = data.countAll(filter.feeds) - filteredLeft - matchesPos
      }
   } else {
      // resolve() awaited loadArticle(pos) first, so the pos idx pack is
      // resident and this countLeft never fetches.
      filteredLeft = await data.countLeft(pos, filter.feeds)
      right = filter.feedTotal - filteredLeft - matchesPos
   }
   // Unseen-only tag mode lands you ON an unread article, so the toolbar counter
   // counts the one you're reading too (right + matchesPos): at open it equals
   // the tag's dropdown badge (total unseen) and counts down to 1 on the last
   // unseen — matching how a feed, which resumes on an already-read article,
   // shows its full unread count to the right. Every other filter ([ALL],
   // feed, unseen-only off) lands on a seen/resume position where the current
   // article isn't part of the unread set, so the counter is just `right`.
   const countRight = filter.unreadMembers ? right + matchesPos : right
   return {
      article,
      has_left: filteredLeft > 0,
      has_right: right > 0,
      filtered: filter.active,
      feed: data.db.feeds[article.f],
      countRight,
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

// Unread count for one feed: its articles strictly after the feed's seen
// position (recordSeen bumps that on every view, filtered or not, so reading
// via [ALL] clears badges too); its full backlog when never seen on this
// device. See feedUnread for the counting rationale.
export function unreadCount(ch: IFeed): Promise<number> {
   return feedUnread(ch, readSeen())
}

// Batched per-feed unread (OPT-2): same semantics as unreadCount applied to
// each feed, but the seen map is parsed once for the whole batch instead of
// once per feed (a menu fill badges every visible row). Maps feed id →
// unread (a never-seen feed maps to its full backlog, not a sentinel).
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
// its full backlog and (in unseen-only tag mode) the unread article you're
// sitting on as still-unread, so the badge is a plain sum: the row badges beneath
// the header add up to it, and it equals the unseen-only toolbar counter
// (showFeed's countRight) — the tag's full unseen total when you first open it
// (you open ON the seen resume position, which neither counts), ticking down in
// step with the counter as you read. A tag has no count of its own; this
// derives it from its members. Synchronous: the counts are already resolved.
// Returns ≥ 0 (0 = nothing unseen). The Math.max guards any stray negative / a
// member missing from the map down to 0.
//
// In DEFAULT (unseen-only OFF) navigation the toolbar counter is a position
// indicator, not genuine unread: opening a tag resumes at its oldest member's
// seen position and counts EVERY article to the right (including already-read
// ones re-shown there), so badge ≤ counter by design. Only in unseen-only mode,
// where read articles are skipped, does "articles to your right" equal this badge.
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
   currentFeed = -1
   updateHash(replace)
   return {
      article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
      has_left: false,
      has_right: false,
      filtered: filter.active,
      feed: undefined,
      countRight: 0,
      placeholder: true,
   }
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const bangIdx = hash.indexOf("!")
   const posStr = bangIdx === -1 ? hash : hash.substring(0, bangIdx)

   const tokens =
      bangIdx === -1
         ? []
         : hash
              .substring(bangIdx + 1)
              .split("+")
              .filter((t) => t.length > 0)
              .map((t) => {
                 // A malformed %-escape (e.g. a lone "%") makes decodeURIComponent
                 // throw; pass the raw token through instead of crashing navigation
                 // (an unrecoverable error popup + a hash that persists across reloads).
                 try {
                    return decodeURIComponent(t)
                 } catch {
                    return t
                 }
              })
   if (tokens.length > 0) filter.set(tokens)
   else filter.clear()

   if (data.db.total_art === 0) throw new Error("no articles")

   // Search mode's matching set must be loaded before isValidSeen/resolve read it
   // (matches() is synchronous), so a #pos!q:… deep-link honors its position.
   if (filter.search) await ensureSearchSet()

   // Empty posStr → Number("")=0 would land on the oldest article; treat it
   // as "no target" so a first-time visitor with no stored hash sees latest.
   let target = posStr === "" ? NaN : Number(posStr)
   if (!Number.isFinite(target) || target < 0 || target >= data.db.total_art) target = data.db.total_art - 1

   // Validate the explicit #pos against the feed's TRUE add_idx, not unseen-only's
   // raised (seen+1) bounds. A restored/shared hash position is an entry anchor, like
   // switchFilter's resume position — isValidSeen is exactly that predicate (true add_idx
   // in unseen-only mode, filter.matches otherwise). Using filter.matches() here let
   // unseen-only reject an already-seen #pos and bounce it to last(); recordSeen then
   // marked that seen, so each refresh drifted to a lower unseen article. From the
   // honored position, Right still walks the unseen.
   if (!(await isValidSeen(target))) return last(undefined, true)
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

// Peek the neighbor in `dir` without navigating: its chronIdx + (cached/
// prefetched) article, or null at the edge. Uses the SAME feedLeft/feedRight
// neighbor walk as step(), so it respects every filter mode (feed / tag /
// unseen-only / saved / search). For the reader's end-of-article "read on"
// preview — loadArticle is the deduped cache the neighbor prefetch already warms.
export async function peek(dir: "left" | "right"): Promise<{ chron: number; article: IArticle } | null> {
   const target = await (dir === "left" ? feedLeft(pos - 1) : feedRight(pos + 1))
   if (target === -1) return null
   return { chron: target, article: await data.loadArticle(target) }
}

export async function first(): Promise<IShowFeed> {
   // No article from a feed with add_idx N exists below chronIdx N, so the
   // earliest matching article is at or after the smallest add_idx in filter.
   const start = filter.feeds.size > 0 ? Math.min(...filter.feeds.values()) : 0
   return goTo(start)
}

export async function last(token?: string, replace = false): Promise<IShowFeed> {
   if (token !== undefined) {
      if (token === "") filter.clear()
      else filter.set([token])
   }
   const found = await feedLeft(data.db.total_art - 1)
   if (found === -1) return resolveNoMatch(replace)
   return resolve(found, replace)
}

async function isValidSeen(idx: number): Promise<boolean> {
   if (idx < 0 || idx >= data.db.total_art) return false
   const feedId = await data.getFeedId(idx)
   // Unseen-only tag mode raises each member's bound past its snapshotted seen
   // position, so filter.matches() would reject the tag's own resume (seen)
   // position and bounce switchFilter forward to the oldest unseen. Accept that
   // resume position anyway — the same current position a feed or a non-unseen
   // tag resumes to — by validating against the member's TRUE add_idx instead of
   // the raised bound. Right then steps to the first unseen.
   if (filter.unreadMembers) {
      const m = filter.unreadMembers.find((mm) => mm.id === feedId)
      return m !== undefined && idx >= m.addIdx
   }
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

// The current filter's tokens (copy) and a stable key for them. filterKey()
// identifies a token SET (unlike getCurrentFilterKey, which collapses
// multi-token filters to ""), so the list can key its build/scroll memory on
// the exact filter — "" means [ALL].
export function currentTokens(): string[] {
   return [...filter.tokens]
}
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

// "" guard: callers pass currentFeed.tag/id which can be empty when no feed is set;
// without it, an active filter on "" (impossible) or callers' "" would falsely match.
export function isSingleFilter(token: string): boolean {
   return token !== "" && filter.tokens.length === 1 && filter.tokens[0] === token
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

export async function cycleFilter(dir: number): Promise<IShowFeed> {
   const entries = getFilterEntries()
   let idx = entries.indexOf(cycleOriginKey())
   if (idx === -1) idx = 0
   idx = (idx + dir + entries.length) % entries.length
   return switchFilter(entries[idx])
}

function updateHash(replace = false) {
   const hash = `#${pos}${tokensSuffix()}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
