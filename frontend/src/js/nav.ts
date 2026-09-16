import * as data from "./data"
import { UNREAD_ONLY_KEY } from "./keys"
import * as model from "./model"
import {
   firstUnreadProbe,
   labelFor,
   validResume,
   WATCH_PREFIX,
   type Lane,
   type LaneEntry,
   type LaneEnv,
} from "./nav/lane"
import { MembersLane } from "./nav/lane-members"
import type { SearchLane } from "./nav/lane-search"
import { makeLane } from "./nav/make-lane"
import { abortPrefetch, prefetchTarget, releasePrefetch, schedulePrefetch } from "./prefetch"
import {
   feedIdOf,
   hashPos,
   isPosInt,
   parseHashMount,
   parseHashTokens,
   tokensSuffix as encodeTokens,
   updateHash as writeHash,
} from "./route"
import { clearSavedGhost, isSaved, SAVED_TOKEN, savedCount, toggleSaved as toggleSavedSet } from "./saved"
import * as search from "./search"
import {
   markAllRead as raiseFilterRead,
   markUnreadFrom as lowerFilterFrom,
   recordSeen,
   tagUnreadFromCounts,
   unreadCounts,
   type FrontierScope,
} from "./seen"
import { batch, onChange, untracked } from "./signals"

// nav is the FACADE over the four modules split out of it (finding ENG3):
// ./seen (frontier persistence, the explicit gestures, the unread tallies),
// ./saved (the ★ Saved set and its queue arithmetic), ./prefetch (the neighbor
// media warm-up — the one DOM-touching concern, which is why nav itself is
// DOM-free), and ./route (the #pos[!tokens] grammar). Everything they used to
// export from here is re-exported unchanged, so no consumer moved; none of them
// imports nav back, so the module graph stays acyclic. The shared mutable state
// that stays here — pos, filter, unreadOnly — reaches them as explicit
// arguments (a FrontierScope, a toggle context, a token list), never by import.
export { getSavedSet, publishSaved } from "./saved"
export {
   clearFrontierUndo,
   frontierUndoSize,
   getSeenMap,
   isRowUnread,
   markFrontierUndoOffered,
   pendingFrontierUndo,
   pruneSeen,
   publishSeen,
   undoFrontierMove,
} from "./seen"
import { lsGet, lsSet } from "./storage"
export type { FrontierUndo } from "./seen"
export { SEARCH_PREFIX, WATCH_PREFIX } from "./nav/lane"
export { resetSearchStream, searchCard, searchTruncated } from "./nav/lane-search"
export {
   feedIdOf,
   hashPos,
   isPosInt,
   isSaved,
   parseHashMount,
   parseHashTokens,
   SAVED_TOKEN,
   savedCount,
   tagUnreadFromCounts,
   unreadCounts,
}

// The cursor lives in the model (model.cursor, written only by this module):
// the chron on screen and its feed (-1 = none). anchorChron pairs the two for
// the list anchor; unread counting never consults the feed — reading is
// accounted on ENTER (recordSeen). Read UNTRACKED: nav runs inside effect
// surfaces (probeCurrent, the tallies), and a nav read must never subscribe the
// effect that called it.
function cursorChron(): number {
   return untracked(() => model.cursor()).chron
}
function cursorFeed(): number {
   return untracked(() => model.cursor()).feedId
}
const next: { left?: Promise<number>; right?: Promise<number> } = {}

// Unseen-only navigation: when on, the active filter skips articles already
// seen (per the seen positions read at filter-apply time), so you glide past
// feeds you're caught up on. A device-local preference, not part of the
// shareable #pos!tokens hash. See setLane / a lane's applyUnseen and
// dropdown.ts's chip.
let unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
model.unreadOnly.set(unreadOnly)

// The active filter MODE. Every mode-dependent question is a method on it
// (nav/lane.ts); nav owns only WHICH lane is active and the cursor over it.
const env: LaneEnv = {
   unreadOnly: () => unreadOnly,
   searchKey: () => searchLane()?.searchKey ?? "",
}
// Not makeLane([]): the store is not loaded when this module evaluates, so the boot
// lane is an EMPTY [ALL] until fromHash/applyFilter resolves the real one — exactly
// the empty `filter` object it replaces.
// The lane's identity as the model sees it. Called at the END of every function
// that changes which lane is active, after its membership resolved, so no
// effect observes a lane whose bounds are not in place yet.
function publishLane(): void {
   model.laneTokens.set([...filter.tokens])
}

let lane: Lane = new MembersLane([], new Map(), env)

function setLane(tokens: readonly string[], opts: { keepKnownEmpty?: boolean } = {}): void {
   lane = makeLane(tokens, env, opts)
   publishLane()
}

export function isUnreadOnly(): boolean {
   return unreadOnly
}
export function setUnreadOnly(on: boolean) {
   unreadOnly = on
   // Persist BOTH states explicitly ("1"/"0"): an absent key means "never
   // chosen", which app.ts treats as the unread-only default on first run — so a
   // user who turns it off must store "0", not clear the key, or it'd revert.
   lsSet(UNREAD_ONLY_KEY, on ? "1" : "0")
   model.unreadOnly.set(on)
}

// Toggle one article's saved state; returns the new state (./saved owns the set
// and the queue arithmetic). The two nav facts it needs are passed in: the
// active MODE and the article on screen, for the unsave-of-current ghost — and
// the neighbor-cache drop, since the saved queue's neighbors may have shifted.
export function toggleSaved(chron: number): boolean {
   return toggleSavedSet(chron, {
      savedMode: lane.kind === "saved",
      pos: cursorChron(),
      onQueueChange: () => {
         next.left = next.right = undefined
      },
   })
}

// The chronIdx of the article currently in the reader (-1 = none), so app.ts can
// reflect its saved state on the star toggle without threading pos into IShowFeed.
export function currentChron(): number {
   return cursorChron()
}

// Where the list surface should anchor when (re)built: the article currently in
// the reader (pos) when it still matches the active filter — so opening the list
// drops you back at the article you were reading, with newer ("next") articles
// above and older below — else -1, meaning "newest" (a fresh boot, or a filter
// change that left the prior article behind). The lane's matches() consults the
// same state navigation does — raised bounds (unseen-only), the explicit set
// (saved/search) — so the list anchors exactly where the reader sits.
function anchorChron(): number {
   // The unseen-only entry anchor counts as a member (it renders as a list row
   // via the feedLeft/feedRight walks), so returning to the list from it lands
   // on it instead of losing the position to the oldest-unread fallback.
   if (
      cursorChron() >= 0 &&
      cursorFeed() >= 0 &&
      (lane.matches(cursorFeed(), cursorChron()) || cursorChron() === lane.entryAnchor())
   )
      return cursorChron()
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
//     transiently here without touching the lane's members, so the list still
//     SHOWS every article (read rows below the anchor, unread above). [ALL] runs
//     this identical scan across every feed (the [ALL] lane's members are every
//     feed); on a fresh device with nothing read it lands at the oldest
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
   return live >= 0 ? live : lane.anchor()
}

// ── Search filter mode ───────────────────────────────────────────────────────
// The mode itself — the hit-set snapshot, the RDR8 scope, the supersession guard —
// lives in nav/lane-search.ts. These accessors read the active lane.
function searchLane(): SearchLane | null {
   return lane.kind === "search" ? (lane as SearchLane) : null
}

// The lane an active query is scoped to — "" when it searches everything (RDR8).
export function searchScope(): string {
   return searchLane()?.scope[0] ?? ""
}
export function isSearchFilter(): boolean {
   return lane.kind === "search"
}
export function searchQuery(): string {
   return searchLane()?.query ?? ""
}
export function searchAvailable(): boolean {
   return search.available()
}
export function searchShort(q: string): boolean {
   return search.shortQuery(q)
}

// The value seam (nearest member ≤ / ≥ `from`) and the strict-neighbour seam of
// a member — the ONE place the reader's prev/next and the list's row walk ask
// "what is next", answered by the active lane.
export function feedLeft(from: number): Promise<number> {
   return lane.atOrBelow(from)
}
export function feedRight(from: number): Promise<number> {
   return lane.atOrAbove(from)
}
export function neighborOlder(chron: number): Promise<number> {
   return lane.older(chron)
}
export function neighborNewer(chron: number): Promise<number> {
   return lane.newer(chron)
}

// The pre-lane `filter` object's shape, kept ONLY as a seeding surface for the
// unit and e2e suites (nav.test.ts; e2e/contract navigation, summary, refresh,
// edges, multistore; e2e/stress). Every member forwards to the active lane, so it
// is not a second source of truth; production code reads the accessors below.
export const filter = {
   get feeds(): ReadonlyMap<number, number> {
      return lane.members
   },
   get tokens(): string[] {
      return lane.tokens as string[]
   },
   get active(): boolean {
      return lane.tokens.length > 0
   },
   get anchor(): number {
      return lane.entryAnchor()
   },
   get saved(): boolean {
      return lane.kind === "saved"
   },
   get search(): boolean {
      return lane.kind === "search"
   },
   matches(feedId: number, chron: number): boolean {
      return lane.matches(feedId, chron)
   },
   set(tokens: string[]): void {
      setLane(tokens)
   },
   clear(): void {
      setLane([])
   },
}

// ── Filter read accessors (finding ENG4) ─────────────────────────────────────
// Every production consumer reads the mode through these — never through the
// `filter` facade above, and never through a lane's `kind`.
export function isSavedFilter(): boolean {
   return lane.kind === "saved"
}
// True when a feed/tag/★ Saved/search filter is active — [ALL] is inactive.
export function isFilterActive(): boolean {
   return lane.tokens.length > 0
}
// The active filter's tokens. Returned `readonly` so a consumer that wants to
// hand them back to applyFilter (the "re-snapshot the current filter" move, in
// app.ts's boot-merge re-anchor and menus.ts's post-frontier-gesture rebuild)
// must copy them first — spreading a live nav array straight back into the
// setter would otherwise read as safe while aliasing nav's own state.
export function filterTokens(): readonly string[] {
   return lane.tokens
}
// The active filter's members (feed id → lower bound). A ReadonlyMap: this is
// nav's live map, not a copy — callers only ever read `.size` or walk it, and
// copying on every call would cost real work on the pin path at [ALL] scale.
// The type is what makes the no-write contract enforceable at zero runtime cost.
export function filterFeeds(): ReadonlyMap<number, number> {
   return lane.members
}

// The lane reads the list surface consumes: the question it means ("does this
// lane draw day strata", "is this a peek lane", "is display order chron order")
// instead of a list of mode names that a new lane would silently fall outside of.
export function laneDividers(): boolean {
   return lane.dividers
}
export function lanePeek(): boolean {
   return lane.peek
}
export function laneChronOrdered(): boolean {
   return lane.chronOrdered
}

// The picker's badge for one watch rule: the lane's own count over its whole
// coverage, from a lane built for the question alone — a watch lane carries no
// state a speculative construction could disturb (unlike a search lane, whose
// snapshot is shared). 0 for a rule the store no longer lists.
export function watchLaneCount(rule: string): Promise<number> {
   const l = makeLane([WATCH_PREFIX + rule], env)
   return l.kind === "watch" ? l.ahead(-1) : Promise.resolve(0)
}

// After data.refresh() swapped the store snapshot: reconcile the filter and the
// navigation caches WITHOUT re-snapshotting the walk. Bounds only ever rise by
// a grown add_idx (expiration) — never re-derived from seen, which would yank
// the unseen-only sequence mid-session (articles read this session would drop
// out from under ←). New members (a new feed under [ALL], a feed newly tagged
// into the active tag) join with the same bound a fresh lane's construction
// would give them; members gone from the store leave. New articles need no bound work at
// all — they sit above every existing bound, so matches()/findRight see them
// automatically. pos is untouched: chronIdx is a permanent address and
// total_art only ever grows. ★ Saved and an UNSCOPED query have no per-feed
// bounds (a peek lane's members stays empty for them) — skipped here; a SCOPED
// query (RDR8) does, and reconciles through the same path as any feed/tag lane.
export async function onStoreRefreshed(): Promise<void> {
   // Cached neighbour probes are exactly what new content invalidates, and an
   // in-flight prefetch may target stale content: drop both, then let the lane
   // reconcile (bounds only rise; an active query reloads its snapshot).
   next.left = next.right = undefined
   abortPrefetch()
   await lane.refreshed()
}

// Recompute the reader chrome (has_left/has_right/right_count) for the article
// already on screen — after a store refresh, without re-rendering the content
// (no fade, no scroll: the silent-refresh contract). null when nothing is
// showing. data.loadArticle(pos) is cache-warm (the article itself didn't
// change), so this costs idx/meta probes at most, no re-fetch of the article.
export async function probeCurrent(): Promise<IShowFeed | null> {
   if (cursorChron() < 0) return null
   const article = await data.loadArticle(cursorChron())
   return showFeed(article)
}

// True only in unseen-only mode with a feed/tag filter active (not saved, not
// search). Matches the exact conditions under which applyUnseen raises bounds,
// so feedUnread and isValidSeen can branch on the same predicate.
function unseenActive(): boolean {
   return unreadOnly && !lane.peek
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
// The last article reads 0 — nothing is ahead, recorded or not. A floor of −1
// (the armed not-started placeholder) floors nothing: the pill is the members'
// whole backlog, the badge itself.
//
// `floor` defaults to the cursor but is EXPLICIT for restingState, which needs
// the whole-backlog answer under a cursor the list has already seeded. Reading
// `pos` directly made that answer a race: the split view's resting pane got 31
// at boot only because it painted before the list's anchor seed landed, and 30
// after any repaint — a backlog count that quietly dropped an article for no
// reason the user could see.
async function pendingRight(seenMap?: Record<string, number>, floor = cursorChron()): Promise<number> {
   return await lane.ahead(floor, seenMap)
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
      neighborOlder(cursorChron()).catch(() => -1),
      neighborNewer(cursorChron()).catch(() => -1),
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
// How a landing should be recorded. Two independent axes that every landing
// function takes, as a named object rather than positionally — `resolve`,
// `first`, `last` and `goTo` used to take these same two booleans in three
// different ORDERS (goTo was the odd one out), so app.ts had two adjacent calls
// expressing one intent with the arguments swapped. Both default the way the
// common case wants: a landing is recorded and pushes history.
//   record  — advance the seen frontier (recordSeen). false for a RESUME: a
//             filter switch, a restored #pos, the mini-player's jump back.
//   replace — replaceState instead of pushState, so the landing does not leave
//             a history entry of its own.
export interface Landing {
   record?: boolean
   replace?: boolean
}

async function resolve(target: number, o: Landing = {}): Promise<IShowFeed> {
   const { replace = false, record = true } = o
   // Load first; commit pos only on success so a Retry replays the same chron.
   const article = await data.loadArticle(target)
   let seen: Record<string, number> | undefined = undefined
   // One landing is ONE flush: the cursor and the seen write recordSeen makes
   // reach the model together, so no effect sees the new article with the old
   // frontier (state-store spec, "What the commands become").
   batch(() => {
      model.cursor.set({ chron: target, feedId: article.f })
      // A landing the raised unseen-only bounds do NOT cover is an entry anchor
      // (isValidSeen accepted it by true add_idx: switchFilter's resume position,
      // a restored/shared #pos). Remember it so feedLeft/feedRight keep it in the
      // navigable sequence — ← must be able to return to the first article shown
      // after → steps into the unseen. A matching landing leaves the anchor alone:
      // stepping forward must not orphan the entry it came from.
      lane.landed(target, article.f)
      // Any real landing moves off the just-unsaved ghost article onto a genuine
      // member (or another article entirely), so the saved ghost is spent. Not a
      // lane hook: the ghost is saved.ts state that outlives a lane switch, so every
      // landing clears it, whatever lane it lands in.
      clearSavedGhost()
      next.left = next.right = undefined
      // Arriving at the article being prefetched must NOT abort it: its in-flight
      // loads are exactly what the rendered content is about to attach to (same-URL
      // image loads coalesce within a document — aborting here restarted every
      // image from scratch, which made the prefetch useless for any neighbor whose
      // images hadn't all finished). Drop the refs instead; the rendered elements
      // own the loads from here. Any other navigation aborts as before.
      if (prefetchTarget() === target) releasePrefetch()
      else abortPrefetch()
      updateHash(replace)
      seen = record ? recordSeen(article.f, target, frontierScope()) : undefined
   })
   return showFeed(article, seen)
}

// What ./seen's frontier writes need to know about the ACTIVE FILTER, which nav
// owns: the peek modes (★ Saved / search) never move a frontier at all, and a
// raise applies across the filter's whole membership — the "navigation list"
// you are reading. Passed as an argument rather than imported back, so ./seen
// stays independent of nav.
function frontierScope(): FrontierScope {
   return { peek: lane.peek, members: lane.members.keys() }
}

// Mark the whole current feed/tag/[ALL] selection read (./seen owns the write).
// Batched: raiseFilterRead writes model.seen (and flushes) and bumpFrontierEpoch
// writes model.frontierEpoch — one flush instead of two, so readerChrome starts
// exactly one probe per gesture instead of racing two (the newer always wins,
// via the resource's token guard, but the second was pure waste).
export function markAllRead(): boolean {
   let moved = false
   batch(() => {
      moved = raiseFilterRead(frontierScope())
      if (moved) bumpFrontierEpoch()
   })
   return moved
}

// The explicit unread rewind — the ONLY path that lowers a seen frontier
// (./seen owns the write). Batched for the same reason as markAllRead above.
export function markUnreadFrom(chron: number): boolean {
   let moved = false
   batch(() => {
      moved = lowerFilterFrom(chron, frontierScope())
      if (moved) bumpFrontierEpoch()
   })
   return moved
}

// A filter-scoped bulk frontier move happened (D1) — the one signal that the
// unread-only bounds must be re-derived. Deliberately NOT bumped by recordSeen
// or by a row swipe: ordinary reading never re-derives bounds (onStoreRefreshed
// documents why). Exported for the frontier-undo button and the boot re-anchor.
export function bumpFrontierEpoch(): void {
   model.frontierEpoch.update((n) => n + 1)
}

// The reader's no-article state. `notStarted` picks which unread-only message the
// empty state shows: true = a never-opened feed/tag (has unread, no resume point →
// "start from the list"); false = caught-up (nothing unread) or a plain no-match.
function resolveNoMatch(o: Landing & { notStarted?: boolean } = {}): IShowFeed {
   const { replace = false, notStarted = false } = o
   model.cursor.set({ chron: -1, feedId: -1 })
   // Same cleanup as resolve(): the cached neighbor probes, the saved ghost, and
   // any in-flight media prefetch belong to the PREVIOUS filter's article and are
   // now stale.
   clearSavedGhost()
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

// The split view's resting pane (reader.renderResting): what the reader shows
// while the LIST surface holds focus and nothing is open. Same placeholder shape
// resolveNoMatch builds, with NONE of its side effects — this is a paint, not a
// navigation: pos stays where it is, the hash stays the list's, no prefetch is
// aborted and no saved ghost cleared.
//
// It answers with the lane's own state, so the panel can't contradict the list
// beside it: an unread backlog reads "Not started" (Next armed, and startFeed
// names the feed it would open, exactly as switchFilter's placeholder does),
// while a caught-up unseen-only lane falls through to "All caught up" — the
// same line the empty list shows. Show-read mode has no unread to point at, so
// a non-empty store still counts as not-started rather than claiming the filter
// is empty.
export async function restingState(): Promise<IShowFeed> {
   const anchor = await listAnchor().catch(() => -1)
   const notStarted = anchor >= 0 || (!unseenActive() && data.db.total_art > 0)
   return {
      article: { f: 0, a: 0, p: 0, t: "", l: "", c: "" },
      has_left: false,
      // Next is the "start reading" affordance here: armed whenever the store
      // has anything at all, since a →-step from pos = -1 resolves the first
      // match itself (and reports its own no-match placeholder if there is none).
      has_right: data.db.total_art > 0,
      // Floored at -1, NOT at pos: the pill reads the lane's whole unread
      // backlog — the picker badge, the right readout for "here is what is
      // waiting". The floor is passed rather than inherited because this panel's
      // premise ("nothing is open, so there is no cursor") is exactly what the
      // split view breaks: the LIST seeds the shared cursor at its anchor long
      // before anyone opens anything, and an inherited floor then hid the
      // highlighted article from its own backlog count.
      right_count: await pendingRight(undefined, -1).catch(() => -1),
      placeholder: true,
      notStarted,
      startFeed: anchor >= 0 ? await Promise.resolve(data.getFeedId(anchor)).catch(() => undefined) : undefined,
   }
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const posStr = hashPos(hash)

   // The hash carries the mount (§6.3): switch the active lane to it BEFORE
   // resolving the filter/position, so every data.* call below (which defaults
   // to the active store) targets the right store. setActive fails softly when
   // the named mount is unmounted/errored — the link then resolves against the
   // current lane rather than blanking (MS4).
   const { mid, tokens } = parseHashMount(parseHashTokens(hash))
   if (mid !== data.activeStore().mid) data.setActive(mid)
   setLane(tokens)

   if (data.db.total_art === 0) throw new Error("no articles")

   // Empty posStr → Number("")=0 would land on the oldest article; treat it
   // as "no target" so a first-time visitor with no stored hash sees latest.
   let target = posStr === "" ? NaN : Number(posStr)
   if (!Number.isFinite(target) || target < 0 || target >= data.db.total_art) target = data.db.total_art - 1

   // Search mode's matching set must be fully loaded before isValidSeen/resolve
   // read it (matches() is synchronous). The search lane's prepare() loads the
   // full hit-set for the active query so a #pos!q:… deep-link honors its position.
   await lane.prepare()

   // Validate the explicit #pos against the feed's TRUE add_idx, not unseen-only's
   // raised (seen+1) bounds. A restored/shared hash position is an entry anchor, like
   // switchFilter's resume position — isValidSeen is exactly that predicate (true add_idx
   // in unseen-only mode, the lane's matches() otherwise).
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
   if (await noUnreadLeft()) return resolveNoMatch({ replace: true })
   if (!(await isValidSeen(target))) return last({ replace: true, record: false })
   return resolve(target, { replace: true, record: false })
}

// One directional navigation step. The post-navigation neighbor lookup is
// speculative, so it is stored as an un-awaited promise: findLeft/findRight
// may lazily fetch an idx pack, and that must neither delay the article
// already on screen nor reject a navigation that succeeded (a failed lookup
// just clears its slot; the next keypress retries on the critical path).
// The slot-identity checks keep a lookup superseded by a newer navigation
// from prefetching or clearing on its behalf.
async function step(dir: "left" | "right"): Promise<IShowFeed> {
   const lookup = () => (dir === "left" ? neighborOlder(cursorChron()) : neighborNewer(cursorChron()))
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

export async function first(o: Landing = {}): Promise<IShowFeed> {
   const { record = true } = o
   // The lane's own start: ★ Saved's queue front, a membership's first article at
   // or after its smallest bound (else its newest), a query's oldest hit.
   const target = await lane.oldest()
   return target === -1 ? resolveNoMatch() : resolve(target, { record })
}

export async function last(o: Landing = {}): Promise<IShowFeed> {
   const { replace = false, record = true } = o
   const found = await lane.newest()
   if (found === -1) return resolveNoMatch({ replace })
   return resolve(found, { replace, record })
}

async function isValidSeen(idx: number): Promise<boolean> {
   return validResume(lane, idx, unreadOnly)
}

// True when unread-only is on and the active feed/tag filter has no unread
// article left — every article sits below its raised (seen+1) bound, so nothing
// matches the walk. switchFilter/fromHash surface the directed "All caught up"
// placeholder (resolveNoMatch → the reader's empty state) in this case instead
// of resuming onto an already-read article: in unread-only mode a caught-up lane
// has nothing to show. Show-read mode (unseenActive false) returns false — you
// browse the read articles there, so the resume onto one is correct.
// The oldest-unread scan, once. `known` distinguishes a genuine -1 (the lane is
// caught up) from a cold finalized-pack fetch that blipped — the callers must
// never strand an open on the "All caught up" placeholder over a transient probe
// failure, so an unknown answer resumes normally (showFeed degrades the neighbor
// buttons on its own).
async function noUnreadLeft(): Promise<boolean> {
   const { chron, known } = await firstUnreadProbe(lane, unreadOnly)
   return known && chron === -1
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
   token = resolveMountToken(token)
   setLane(token === "" ? [] : [token], { keepKnownEmpty: true })
   // A token that named nothing resolved to [ALL]: land on its newest, not on the
   // [ALL] lane's own entry (a stale token is not a pick of [ALL]).
   if (token !== "" && lane.tokens.length === 0) return last({ record: false })
   await lane.prepare()
   return actOnEntry(await lane.entry())
}

// Act on a lane's entry decision. A landing is a RESUME (record: false); `land: -1`
// is "nothing to land on" and takes the plain placeholder, as first()/last() do.
async function actOnEntry(e: LaneEntry): Promise<IShowFeed> {
   if ("land" in e) return e.land === -1 ? resolveNoMatch() : resolve(e.land, { record: false })
   const o = resolveNoMatch({ notStarted: e.notStarted })
   if (e.notStarted) {
      o.has_right = e.hasRight
      o.right_count = e.rightCount ?? -1
      o.startFeed = e.startFeed
   }
   return o
}

// Jump to chronIdx, snapping forward to next match if filter is active.
// `replace` is for a landing that FOLLOWS a navigation the caller already
// pushed — the split view's lane-change follow-up, which would otherwise cost a
// second history entry and make browser-back a visual no-op on the first press.
export async function goTo(idx: number, o: Landing = {}): Promise<IShowFeed> {
   const { record = true, replace = false } = o
   if (idx < 0 || idx >= data.db.total_art) return last({ replace, record })
   // A lane with no value order (★ Saved) cannot snap: land on the exact member a
   // row tap or deep link names (its matches() ignores the feed, hence -1), else
   // fall back to the front of the lane for a stale link.
   if (!lane.chronOrdered) return lane.matches(-1, idx) ? resolve(idx, { replace, record }) : first({ record: false })
   const found = await lane.atOrAbove(idx)
   return found === -1 ? last({ replace, record }) : resolve(found, { replace, record })
}

// The mini-player's "go to the episode" (PlayerDeps.openArticle): land on the
// EXACT article that owns the active media, never a snapped neighbor — the bar
// names one article, so showing any other breaks its promise. The active lane
// keeps the landing when it can address it (isValidSeen: TRUE add_idx under
// unread-only, the switchFilter-resume predicate — the raised bounds would
// bounce a just-listened episode off its own lane); a lane that cannot
// (another tag, ★ Saved without it, a search set it is not in) falls back to
// [ALL] first, the same containing lane a bare #pos deep link resolves under.
// record: false throughout — returning to an episode is a resume, not a read
// (fromHash's rule): recording a forward jump would raise every member's
// frontier over articles never shown.
export async function goToArticle(chron: number): Promise<IShowFeed> {
   if (chron >= 0 && chron < data.db.total_art) {
      let addressable = await isValidSeen(chron)
      if (!addressable) {
         setLane([])
         addressable = await isValidSeen(chron)
      }
      if (addressable) return resolve(chron, { record: false })
   }
   // Out of range, expired below add_idx, or a deleted feed: the exact article
   // is unaddressable — keep goTo's clamp (nearest live match, else last).
   return goTo(chron, { record: false })
}

// Move the navigation cursor to an exact, already-known-matching chronIdx — the
// list surface's keyboard selection (A/D/←/→ step the highlighted row). The row
// is a rendered filter member and its feed is known from the row's data-feed,
// so there's no feed walk or idx fetch. Same cursor bookkeeping as resolve minus
// the article load: it does NOT update the hash or recordSeen, because moving
// the list cursor isn't reading the article — pos just tracks the highlight so
// opening it (tap) or re-anchoring the list later stays consistent.
export function select(chron: number, feedId: number): void {
   model.cursor.set({ chron, feedId })
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
   // Empty = [ALL]. A KNOWN feed/tag with no articles stays scoped to itself so a
   // reload or back to `#!<token>` re-renders its empty state (makeLane's
   // keepKnownEmpty); an unknown token falls back to [ALL].
   setLane(tokens, { keepKnownEmpty: true })
}

// Re-derive the ACTIVE lane from its own tokens: fresh unread-only bounds, a reset
// entry anchor. What every "re-apply the current filter" caller used to spell as
// applyFilter([...filterTokens()]). Through applyFilter, so a known-but-empty lane
// stays scoped to itself (keepKnownEmpty) and publishLane runs; an unchanged token
// list publishes nothing (arrayEqual), and a search lane's module-scoped snapshot
// survives (Lanes N16).
export function reapplyLane(): void {
   applyFilter([...lane.tokens])
}

// A stable key for the active filter tokens — identifies the token SET
// (unlike getCurrentFilterKey, which collapses multi-token filters to ""),
// so the list can key its build/scroll memory on the exact filter.
// "" means [ALL].
export function filterKey(): string {
   return lane.tokens.join(" ")
}

// The `!tokens` hash suffix for the active filter ("" when inactive) — shared by
// updateHash (reader `#pos!tokens`) and the list surface (`#!tokens`, no pos).
// ./route owns the grammar; nav supplies the active tokens.
export function tokensSuffix(): string {
   return encodeTokens(lane.tokens)
}

// Map current filter state to a key matching getFilterEntries() format (""|"tagName"|"id")
export function getCurrentFilterKey(): string {
   return lane.key
}

// Resolve a filter key (getCurrentFilterKey / getFilterEntries format) to its
// human label: [ALL] "" → "All", the saved smart-folder → "★ Saved", a query
// token → "Search: <query>", a numeric feed id → that feed's title, a tag name →
// itself. Tags are already names; only untagged single-feed filters carry a raw
// id, so this is what keeps the toolbar label, the document title, and the
// caught-up line from ever showing an id — and, since getCurrentFilterKey hands
// back the raw `q:<query>` token for an unscoped query, from ever showing that
// either. A SCOPED query's key is its scope token (nav.searchScope), so the
// combined lane labels as the lane it is searching inside.
export function filterLabel(key: string): string {
   return labelFor(key)
}

// A mount-qualified token (`@<mid>` / `@<mid>:<tok>`, §6.3): switch the active
// lane to its mount and return the bare token ("" for a peer [ALL]) to resolve
// in that store's context. A bare token leaves the active mount as-is and comes
// back unchanged. The ONE owner of "consume the mount prefix" — switchFilter
// and app.ts's selectFilter both route through it, so the grammar's read side
// cannot drift between the two front doors.
export function resolveMountToken(token: string): string {
   if (!token.startsWith("@")) return token
   const { mid, tokens } = parseHashMount([token])
   data.setActive(mid)
   return tokens[0] ?? ""
}

// The cycle "origin": like getCurrentFilterKey, but a single-feed filter on a
// TAGGED feed resolves to its tag. getFilterEntries lists tagged feeds only
// by tag (never by id), so a raw id would miss indexOf and snap cycling to [ALL].
// Shared by the reader (cycleFilter) and the list (app.onCycle) so both surfaces
// cycle relative to the same current selection.
export function cycleOriginKey(): string {
   let current = getCurrentFilterKey()
   if (current !== "" && lane.tokens.length === 1) {
      const id = feedIdOf(current)
      if (id !== null) {
         const ch = data.db.feeds[id]
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
   writeHash(cursorChron(), lane.tokens, replace)
}

// Publish the CURRENT cursor + filter into the fragment WITHOUT navigating —
// the split view's focus-only re-entry (app.ts openArticle), where the pane is
// already mounted on the article being "opened" so nothing resolves, renders or
// records, but the URL and the stored restore key must still name what is on
// screen. Every other writer of the hash is a landing; this one is the landing
// that already happened.
export function publishHash(): void {
   updateHash(false)
}

// A backup restore may carry the unread-only preference, which profile.ts wrote
// to localStorage itself (S14). Adopt it — only when it differs, since flipping
// the mode re-applies the lane. A sync pull never touches prefs, so this is a
// no-op for it.
onChange(
   () => model.profileRev(),
   () => {
      const stored = lsGet(UNREAD_ONLY_KEY)
      if (stored !== null && (stored === "1") !== unreadOnly) setUnreadOnly(stored === "1")
   },
)

// A store switch leaves nothing under the cursor. chronIdx is only unique within
// a mount (S38), so the previous store's chron names an unrelated article here:
// the ★, the arrows, the pill and the list anchor would all describe it. The
// cached neighbour probes, the saved ghost and any in-flight prefetch belong to
// that article too. A landing in the new store (fromHash, a peer lane pick) sets
// its own cursor right after.
onChange(
   () => model.activeMid(),
   () => {
      model.cursor.set({ chron: -1, feedId: -1 })
      next.left = next.right = undefined
      clearSavedGhost()
      abortPrefetch()
   },
)

// Membership is derived (state-store spec rule 2, as amended by D1). The
// unread-only bounds re-derive when the MODE flips, and — under unread-only —
// when a filter-scoped bulk frontier move bumps model.frontierEpoch. Never on
// model.seen: every recorded landing writes seen, and re-deriving there would
// raise the bounds past the article just read and strand ←. A store refresh
// reconciles through onStoreRefreshed instead (bounds only rise). Created at
// module load, before any surface's effect, so a flush always re-derives the
// lane BEFORE the list or the chrome reads it.
onChange(
   () => [model.unreadOnly(), model.frontierEpoch()] as const,
   ([mode, epoch], [prevMode, prevEpoch]) => {
      const flipped = mode !== prevMode
      const moved = epoch !== prevEpoch
      if (flipped || (moved && mode)) reapplyLane()
   },
)
