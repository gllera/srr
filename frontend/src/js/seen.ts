// The seen frontier — persistence, the explicit gestures, one step of undo, and
// every unread tally derived from it. Split out of nav.ts (finding ENG3): nav
// owns the filter state machine and calls in here, never the reverse, so the
// module graph stays acyclic. Nothing in this file reads nav state; the two
// facts the frontier writes need — is this a PEEK mode, and which feeds are the
// active filter's members — arrive as an explicit `FrontierScope`.
//
// A feed's seen position is its read high-water: recordSeen only RAISES it,
// markUnreadFrom is the one explicit rewind, and every write goes through
// writeSeen so no mutation ships without its per-key ordering stamp.
import * as data from "./data"
import { seenKey, seenTsKey } from "./keys"
import * as sync from "./sync"

// Per-store keys (docs/MULTI-STORE-SPEC.md §4.2): namespaced by the ACTIVE
// store's mid, the lane nav is reading. For the home store (mid "0") these
// resolve to the bare legacy names (srr-seen / srr-seen-ts), so a single-store
// user's state is unchanged.
const seenK = () => seenKey(data.activeStore().mid)
const seenTsK = () => seenTsKey(data.activeStore().mid)

// What the frontier writes need to know about the ACTIVE FILTER, passed in by
// nav rather than read from it:
//   • `peek` — ★ Saved / search, the modes that never touch a frontier at all.
//   • `members` — the feed ids of the filter's membership (filter.feeds keys),
//     the "navigation list" a raise applies across. Iterated exactly once.
export interface FrontierScope {
   peek: boolean
   members: Iterable<number>
}

export function readSeen(): Record<string, number> {
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

// The parsed seen map (feed key → last-viewed chronIdx). Exposed for the
// list surface's per-row read/unread dot; this module owns the localStorage shape.
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

// A feed stores its own seen position — its read high-water (the newest chron
// ever marked seen for it; recordSeen only raises it, markUnreadFrom is the
// explicit rewind). A tag has no position of its own: it resumes from the oldest seen
// position (min seen chronIdx) among its member feeds, so opening the tag
// drops you at the least-recently-read member and no member's unread (each of
// which sits at or after that member's own seen position) is skipped to the
// left. Reading on still advances the tag, since the min only rises once that
// furthest-behind member is read on. undefined === never seen on this device
// (feed) / no member feed seen yet (tag).
export function getSeen(token: string): number | undefined {
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
export async function tallyWith(
   chs: IFeed[],
   seenOf: (id: number) => number | undefined,
): Promise<Map<number, number>> {
   const { counts, rare } = data.unreadTally(chs, seenOf)
   await Promise.all(rare.map(async (ch) => counts.set(ch.id, await feedUnread(ch, seenOf(ch.id)))))
   return counts
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

// Returns the parsed (and, when anything moved, persisted) seen map so the caller
// (resolve → showFeed → pendingRight) can reuse it without re-reading srr-seen in
// the same tick; undefined when nothing was read (a peek mode or an unknown feed)
// or the read threw, in which case pendingRight falls back to a fresh read.
export function recordSeen(article: IArticle, pos: number, scope: FrontierScope): Record<string, number> | undefined {
   // Peek modes never touch the seen frontier. Search (q:) jumps to hits, not a
   // contiguous read-through — advancing here would mark everything up to the
   // hit as seen. ★ Saved is the same shape: re-reading an archived item is not
   // resuming its feed. A saved/search article you peek at stays unread until
   // you actually read it in its feed.
   if (scope.peek) return
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
      const before: Record<string, number | undefined> = {}
      const raise = (feedId: number) => {
         const key = "feed:" + feedId
         if (!(key in before)) before[key] = seen[key]
         writeFrontier(seen, touched, feedId, (prev) => prev === undefined || prev < pos, pos)
      }
      raise(article.f)
      for (const feedId of scope.members) if (feedId !== article.f) raise(feedId)
      if (touched.length > 0) {
         writeSeen(seen, touched)
         snapshotRaise(before, touched, pos)
         sync.pushSoon()
      }
      return seen
   } catch {}
}

// RDR1/RDR2 — reversibility for the frontier RAISES.
//
// The frontier model is deliberate and stays: opening an article marks
// everything older across the filter as read, because that is what "I'm caught
// up to here" means. What erodes trust in the unread numbers is that the big
// version of it — tapping the newest headline on [ALL], or Mark all read —
// is silent AND irreversible: a backlog you meant to keep is gone with no
// signal that anything happened and no way back.
//
// So a raise snapshots the frontiers it moved. Nothing else changes: no
// per-article read set, no confirm dialog in the way of the common case. The
// caller (app.ts) asks how many articles the move actually consumed and, past a
// threshold, offers one Undo.
export interface FrontierUndo {
   // Previous value per touched key; undefined = the key did not exist. Only
   // touched keys are here — an untouched member's unread is identical before
   // and after, so it cannot contribute to the size of the move.
   prev: Record<string, number | undefined>
   // Where those frontiers were moved TO, so the size can be measured after the
   // fact without having counted anything on the hot path.
   to: number
}

let lastRaise: FrontierUndo | null = null
// Whether the caller has already had its chance to offer lastRaise. The
// snapshot OUTLIVES the offer — the snackbar's Undo fires seconds later, and
// undoFrontierMove still has to work then — so "offered" is a second bit rather
// than just clearing the snapshot.
let raiseOffered = false

// The raise still WAITING to be offered, if any — asked once per raise.
//
// It has to be once, because the caller asks on every render: a render that
// moved no frontier of its own (stepping BACKWARDS, a filter switch, any read
// in the peek modes, which never raise at all) leaves the previous snapshot in
// place, and without this bit each of those would re-measure and re-announce a
// jump that happened long ago. Reading still does not CONSUME the snapshot —
// markFrontierUndoOffered does — so the offer's own Undo can act on it after.
export function pendingFrontierUndo(): FrontierUndo | null {
   return raiseOffered ? null : lastRaise
}

// The caller has now had its chance at the pending raise: don't offer it again.
// Called whether or not the offer was actually shown — a move too small to
// mention is still a move already considered, and re-measuring it on every
// subsequent render is the same waste for none of the value.
export function markFrontierUndoOffered(): void {
   raiseOffered = true
}

// How many articles a raise actually consumed: the filter's unread before the
// move minus its unread after. Both sides go through the same tally the badges
// use, so the number the snackbar reports is the number the badges just lost.
// Async and deliberately OFF the navigation path — recordSeen stays a couple of
// localStorage writes.
export async function frontierUndoSize(u: FrontierUndo): Promise<number> {
   const chs = Object.keys(u.prev)
      .map((k) => data.db.feeds[Number(k.slice("feed:".length))])
      .filter(Boolean)
   if (chs.length === 0) return 0
   const before = await tallyWith(chs, (id) => u.prev["feed:" + id])
   const after = await tallyWith(chs, () => u.to)
   let n = 0
   for (const ch of chs) n += Math.max(0, (before.get(ch.id) ?? 0) - (after.get(ch.id) ?? 0))
   return n
}

// Put the snapshotted frontiers back. It writes through writeSeen like every
// other mutation, so the per-key `st` stamps are refreshed to NOW — an undo is
// itself the newest thing that happened to those keys, and only a newer stamp
// makes profile.ts's per-key LWW propagate a lowering instead of letting another
// device's stale raise win. (That is also why a key that did not exist is
// restored as -1 rather than deleted: markUnreadFrom's precedent — -1 reads as
// never-seen everywhere, and keeping the key keeps its stamp.)
//
// The snapshot is the CALLER'S, passed in rather than read from lastRaise: the
// offer is shown at one moment and answered at another, and a raise landing in
// between must not silently re-point the button. "Undo" undoes the move whose
// size it announced, or nothing.
//
// Either way it clears the pending state: those frontiers have just been
// rewritten, so any snapshot still waiting describes a store state that no
// longer exists, and replaying it would only raise them back.
export function undoFrontierMove(u: FrontierUndo): boolean {
   lastRaise = null
   raiseOffered = false
   if (!u) return false
   try {
      const seen = readSeen()
      const touched: string[] = []
      for (const [key, prev] of Object.entries(u.prev)) {
         const want = prev ?? -1
         if (seen[key] === want) continue
         seen[key] = want
         touched.push(key)
      }
      if (touched.length === 0) return false
      writeSeen(seen, touched)
      sync.pushSoon()
      return true
   } catch {
      return false
   }
}

// Drop the pending offer outright. Any newer raise replaces it anyway, so this
// exists for the callers that need a known-empty slot rather than for the normal
// lifecycle: the tests' per-case isolation, and any future caller that wants to
// abandon a raise instead of offering it (markFrontierUndoOffered is the
// "offered, don't repeat" half).
export function clearFrontierUndo(): void {
   lastRaise = null
   raiseOffered = false
}

// Record a raise as undoable, keeping only the keys it actually moved. Called
// after the write lands, so a failed write leaves no offer behind. A newer raise
// always replaces an older pending one: the offer is for the last thing that
// happened, and stacking them would let one Undo skip a step.
function snapshotRaise(before: Record<string, number | undefined>, touched: string[], to: number): void {
   const prev: Record<string, number | undefined> = {}
   for (const key of touched) prev[key] = before[key]
   lastRaise = { prev, to }
   raiseOffered = false
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
// `undoable` is set for the RAISES only. The rewind (markUnreadFrom) is already
// the explicit, deliberate gesture — it is what an undo would be — so offering
// to undo it would just be a second way to spend the same intent, and it would
// overwrite the raise snapshot the user actually wants back.
function moveFrontier(
   shouldMove: (prev: number | undefined) => boolean,
   value: number,
   undoable: boolean,
   scope: FrontierScope,
): boolean {
   if (scope.peek) return false
   try {
      const seen = readSeen()
      const touched: string[] = []
      const before: Record<string, number | undefined> = {}
      for (const feedId of scope.members) {
         before["feed:" + feedId] = seen["feed:" + feedId]
         writeFrontier(seen, touched, feedId, shouldMove, value)
      }
      if (touched.length === 0) return false
      writeSeen(seen, touched)
      if (undoable) snapshotRaise(before, touched, value)
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
export function markAllRead(scope: FrontierScope): boolean {
   if (data.db.total_art === 0) return false
   const top = data.db.total_art - 1
   return moveFrontier((prev) => prev === undefined || prev < top, top, true, scope)
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
export function markUnreadFrom(chron: number, scope: FrontierScope): boolean {
   if (chron < 0) return false
   const floor = chron - 1
   return moveFrontier((prev) => prev !== undefined && prev > floor, floor, false, scope)
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
