// nav/lane-members.ts — the feed-membership lanes: [ALL] (no tokens, kind "all"),
// one feed, one tag, or a multi-token union (kind "members"). The only NON-peek
// lanes: reading here moves seen frontiers, unread-only raises their bounds, and
// a switch onto one resumes rather than reads (entry()).
import * as data from "../data"
import { feedIdOf } from "../route"
import { feedKey, getSeen, readSeen, tagUnreadFromCounts, tallyWith } from "../seen"
import {
   firstUnreadProbe,
   keyOf,
   labelFor,
   minOf,
   oldestByBounds,
   validResume,
   type Lane,
   type LaneEntry,
   type LaneEnv,
   type SeenMap,
} from "./lane"

// Resolve a token list to its feed membership at natural add_idx bounds — a
// numeric token is that feed, anything else a tag's members; only feeds with
// articles join. Empty tokens = every feed ([ALL]). The ONE copy of the rule:
// makeLane, the scoped search and refreshed() must never drift on what a token means.
export function resolveMembership(tokens: readonly string[]): Map<number, number> {
   const feeds = new Map<number, number>()
   if (tokens.length === 0) {
      for (const ch of Object.values(data.db.feeds)) if (ch.total_art) feeds.set(ch.id, ch.add_idx ?? 0)
      return feeds
   }
   for (const token of tokens) {
      const id = feedIdOf(token)
      if (id !== null) {
         const ch = data.db.feeds[id]
         if (ch?.total_art && !feeds.has(id)) feeds.set(id, ch.add_idx ?? 0)
      } else
         for (const ch of Object.values(data.db.feeds))
            if (ch.tag === token && ch.total_art && !feeds.has(ch.id)) feeds.set(ch.id, ch.add_idx ?? 0)
   }
   return feeds
}

// Does this token name a real feed (numeric id) or tag in the store? Tells a
// known-but-empty pick (an empty lane under its own token) from a stale one ([ALL]).
export function isKnownToken(token: string): boolean {
   const id = feedIdOf(token)
   if (id !== null) return data.db.feeds[id] !== undefined
   return Object.values(data.db.feeds).some((ch) => ch.tag === token)
}

// After a store refresh: bounds only ever RISE, by a grown add_idx — never
// re-derived from seen, which would yank the unseen-only walk mid-session
// (articles read this session would drop out from under ←). A new member joins
// with the bound a fresh construction would give it (raised past its seen
// high-water only when `fold`); a member gone from the store leaves.
export function reconcileMembers(members: Map<number, number>, fresh: Map<number, number>, fold: boolean): void {
   const seenMap = readSeen()
   for (const [id, addIdx] of fresh) {
      const old = members.get(id)
      if (old !== undefined) {
         if (addIdx > old) members.set(id, addIdx)
      } else {
         const s = fold ? (seenMap[feedKey(id)] ?? -1) : -1
         members.set(id, Math.max(addIdx, s + 1))
      }
   }
   for (const id of [...members.keys()]) if (!fresh.has(id)) members.delete(id)
}

export class MembersLane implements Lane {
   readonly kind: "all" | "members"
   readonly tokens: readonly string[]
   readonly key: string
   readonly peek = false
   readonly dividers = true
   readonly chronOrdered = true
   private readonly feeds: Map<number, number>
   private readonly env: LaneEnv
   // The unseen-only ENTRY ANCHOR: a SEEN article the reader landed on under
   // raised bounds (a switch's resume position, a restored #pos). The bounds
   // exclude it, so both walks slot it back in — ← must return to the first
   // article shown after → stepped into the unseen. Navigation-only: matches()
   // and every count ignore it. A new lane (any re-apply) starts without one.
   private anchorChron = -1

   constructor(tokens: readonly string[], members: Map<number, number>, env: LaneEnv) {
      this.kind = tokens.length === 0 ? "all" : "members"
      this.tokens = tokens
      this.key = keyOf(tokens)
      this.feeds = members
      this.env = env
   }

   get members(): ReadonlyMap<number, number> {
      return this.feeds
   }

   label(): string {
      return labelFor(this.key)
   }

   matches(feedId: number, chron: number): boolean {
      const bound = this.feeds.get(feedId)
      return bound !== undefined && chron >= bound
   }

   atOrBelow(from: number): Promise<number> {
      const a = this.anchorChron
      // No anchor (the usual case): the walk's promise untouched — an
      // unconditional .then would add a microtask to every neighbour lookup.
      if (a < 0) return data.findLeft(from, this.feeds)
      return data.findLeft(from, this.feeds).then((found) => (a <= from && a > found ? a : found))
   }

   atOrAbove(from: number): Promise<number> {
      const a = this.anchorChron
      if (a < 0) return data.findRight(from, this.feeds)
      return data.findRight(from, this.feeds).then((found) => (a >= from && (found === -1 || a < found) ? a : found))
   }

   older(chron: number): Promise<number> {
      return this.atOrBelow(chron - 1)
   }

   newer(chron: number): Promise<number> {
      return this.atOrAbove(chron + 1)
   }

   oldest(): Promise<number> {
      return oldestByBounds(this)
   }

   newest(): Promise<number> {
      return this.atOrBelow(data.db.total_art - 1)
   }

   // The OLDEST UNREAD member: each bound raised past its seen high-water
   // (idempotent with unread-only's raised bounds; a never-seen feed keeps its
   // bound, so its whole backlog counts), evaluated transiently — the lane's own
   // bounds are untouched, so the list still SHOWS every article.
   async anchor(): Promise<number> {
      if (this.feeds.size === 0) return -1
      const seen = readSeen()
      const unread = new Map<number, number>()
      for (const [id, bound] of this.feeds) {
         const s = seen[feedKey(id)]
         unread.set(id, s === undefined ? bound : Math.max(bound, s + 1))
      }
      return data.findRight(minOf(unread.values()), unread)
   }

   // Unread AND ahead: the members' live unread through the picker badges' own
   // tally, each frontier floored at `floor`. On a recorded landing recordSeen has
   // already raised every member to the cursor, so the floor is a no-op and the
   // pill IS the badge; a floor of -1 is the whole backlog.
   async ahead(floor: number, seenMap?: SeenMap): Promise<number> {
      const members: IFeed[] = []
      for (const id of this.feeds.keys()) {
         const ch = data.db.feeds[id]
         if (ch) members.push(ch)
      }
      const seen = seenMap ?? readSeen()
      const eff = (id: number): number | undefined => {
         const s = seen[feedKey(id)]
         if (floor < 0) return s
         return Math.max(s ?? -1, floor)
      }
      return tagUnreadFromCounts(members, await tallyWith(members, eff))
   }

   // switchFilter's decision for this lane. Every landing is a RESUME (record:
   // false): merely visiting a lane must not consume its unread.
   async entry(): Promise<LaneEntry> {
      const unreadOnly = this.env.unreadOnly()
      if (this.kind === "all") {
         // [ALL] opens at the oldest unread; fully caught up, the placeholder
         // (unread-only) or the newest article (show-read).
         const idx = await this.anchor()
         if (idx !== -1) return { land: idx, record: false }
         if (unreadOnly) return { placeholder: true, notStarted: false, hasRight: false }
         return { land: await this.newest(), record: false }
      }
      // A KNOWN feed/tag with no articles (makeLane's keepKnownEmpty).
      if (this.feeds.size === 0) return { placeholder: true, notStarted: false, hasRight: false }
      // One oldest-unread scan, reused for the caught-up test and startFeed.
      const { chron: firstUnread, known } = await firstUnreadProbe(this, unreadOnly)
      if (known && firstUnread === -1) return { placeholder: true, notStarted: false, hasRight: false }
      const seenIdx = this.tokens.length === 1 ? getSeen(this.tokens[0]) : undefined
      if (seenIdx !== undefined && (await validResume(this, seenIdx, unreadOnly)))
         return { land: seenIdx, record: false }
      if (!unreadOnly) return { land: await this.oldest(), record: false }
      // Unread-only and never opened: the reader is a resume surface, so show the
      // not-started placeholder with Next ARMED, its pill the whole backlog, naming
      // the feed the backlog starts with (a tag's label alone cannot say which).
      return {
         placeholder: true,
         notStarted: true,
         hasRight: true,
         rightCount: await this.ahead(-1).catch(() => -1),
         startFeed:
            firstUnread < 0 ? undefined : await Promise.resolve(data.getFeedId(firstUnread)).catch(() => undefined),
      }
   }

   prepare(): Promise<void> {
      return Promise.resolve()
   }

   refreshed(): Promise<void> {
      reconcileMembers(this.feeds, resolveMembership(this.tokens), this.env.unreadOnly())
      return Promise.resolve()
   }

   landed(chron: number, feedId: number): void {
      // A landing the raised bounds do NOT cover is an entry anchor; a matching
      // one leaves it alone (stepping forward must not orphan the entry).
      if (this.env.unreadOnly() && !this.matches(feedId, chron)) this.anchorChron = chron
   }

   applyUnseen(seen: SeenMap): void {
      if (!this.env.unreadOnly()) return
      for (const [id, addIdx] of this.feeds) this.feeds.set(id, Math.max(addIdx, (seen[feedKey(id)] ?? -1) + 1))
   }

   entryAnchor(): number {
      return this.anchorChron
   }
}
