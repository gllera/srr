// nav/lane.ts — the contract every filter mode implements, and the pure helpers
// its implementations share (docs/superpowers/specs/2026-09-15-nav-lane-abstraction-design.md).
//
// A lane answers every question whose answer depends on the filter MODE: who is
// my neighbour, where does the lane start and end, does this article belong, how
// much is ahead, does reading here move a frontier, where does a switch land.
// nav.ts owns WHICH lane is active and the cursor over it, and it never asks a
// lane's `kind` to decide whether a method applies — every method is total.
//
// This file imports no implementation: make-lane.ts is the one module that knows
// them all, so lane.ts and the lane-*.ts files never import each other in a cycle.
import * as data from "../data"
import type { IMetaWire } from "../format.gen"
import { feedIdOf } from "../route"
import { SAVED_TOKEN } from "../saved"

export const SEARCH_PREFIX = "q:"

export type LaneKind = "all" | "members" | "saved" | "search" | "watch"
export type SeenMap = Record<string, number>

// What a lane needs to know about nav's own state — passed in, because nav
// imports the lanes and must never be imported back.
export interface LaneEnv {
   // The device-local unread-only preference.
   unreadOnly(): boolean
   // The search key of the ACTIVE lane ("" when it is not a search): what a late
   // hit-set load compares against before it may store its result.
   searchKey(): string
}

// switchFilter's landing decision. `land: -1` means the lane has nothing to land
// on and takes the plain no-match placeholder, exactly as first()/last() do.
export type LaneEntry =
   | { land: number; record: false }
   | { placeholder: true; notStarted: boolean; hasRight: boolean; rightCount?: number; startFeed?: number }

export interface Lane {
   readonly kind: LaneKind
   // The hash tokens that name this lane, verbatim.
   readonly tokens: readonly string[]
   // getCurrentFilterKey()'s answer: "", the single token, or "" for multi-token.
   readonly key: string
   // true = reading here never moves a seen frontier.
   readonly peek: boolean
   // feed id → lower chron bound — the frontier scope. EMPTY for the set lanes.
   readonly members: ReadonlyMap<number, number>
   // The list draws day strata (false where rows are not a walk down the days).
   readonly dividers: boolean
   // Display order is chronIdx order — false only for ★ Saved's save order.
   readonly chronOrdered: boolean
   label(): string
   // Synchronous, for the hot paths; valid once prepare() resolved for the
   // current store snapshot.
   matches(feedId: number, chron: number): boolean
   // The value seam: the nearest member ≤ from / ≥ from, -1 at the edge.
   atOrBelow(from: number): Promise<number>
   atOrAbove(from: number): Promise<number>
   // The strict-neighbour seam of MEMBER `chron` — prev/next and the list's walk.
   older(chron: number): Promise<number>
   newer(chron: number): Promise<number>
   // first()'s and last()'s targets, -1 when there is none.
   oldest(): Promise<number>
   newest(): Promise<number>
   // listAnchor()'s answer when no live cursor holds it.
   anchor(): Promise<number>
   // The next pill: what is ahead of `floor` (a passed seen map wins over storage).
   ahead(floor: number, seen?: SeenMap): Promise<number>
   entry(): Promise<LaneEntry>
   // Load whatever matches() needs.
   prepare(): Promise<void>
   // The lane's half of onStoreRefreshed: reconcile in place, never rebuild.
   refreshed(): Promise<void>
   // resolve() landed here.
   landed(chron: number, feedId: number): void
   // Fold unread-only into the bounds (a no-op for a peek lane).
   applyUnseen(seen: SeenMap): void
   // The unseen-only entry anchor, -1 for none.
   entryAnchor(): number
   // The meta card of a hit, for lanes that already hold them (search).
   card?(chron: number): IMetaWire | undefined
}

export type TokenClass = { kind: "saved" } | { kind: "search"; q: number } | { kind: "members" }

// The ONE classification of a token list. ★ Saved is a lone reserved token; a
// query is a `q:` token with at most one companion (its RDR8 scope); anything
// else resolves as feed/tag membership.
export function classifyTokens(tokens: readonly string[]): TokenClass {
   if (tokens.length === 1 && tokens[0] === SAVED_TOKEN) return { kind: "saved" }
   const q = tokens.findIndex((t) => t.startsWith(SEARCH_PREFIX))
   if (q >= 0 && tokens.length <= 2) return { kind: "search", q }
   return { kind: "members" }
}

export function keyOf(tokens: readonly string[]): string {
   return tokens.length === 1 ? tokens[0] : ""
}

// A filter key's human label — total over every key shape nav produces, so no
// surface can print a raw feed id or a raw `q:` token.
export function labelFor(key: string): string {
   if (key === "") return "All"
   if (key === SAVED_TOKEN) return "★ Saved"
   if (key.startsWith(SEARCH_PREFIX)) {
      const q = key.slice(SEARCH_PREFIX.length)
      return q ? `Search: ${q}` : "Search"
   }
   const id = feedIdOf(key)
   return id !== null ? data.feedTitle(id) : key
}

// The smallest value WITHOUT a spread: Math.min(...it) overflows the engine's
// argument limit on a store approaching FEED_ID_CEILING. 0 for an empty iterable.
export function minOf(values: Iterable<number>): number {
   let m = Infinity
   for (const v of values) if (v < m) m = v
   return m === Infinity ? 0 : m
}

// The oldest-unread scan behind "is this lane caught up". `known` tells a genuine
// -1 (caught up) from a cold pack fetch that blipped: a caller must never strand
// an open on "All caught up" over a transient failure.
export async function firstUnreadProbe(lane: Lane, unreadOnly: boolean): Promise<{ chron: number; known: boolean }> {
   if (!unreadOnly || lane.peek || lane.members.size === 0) return { chron: -1, known: false }
   try {
      return { chron: await lane.atOrAbove(minOf(lane.members.values())), known: true }
   } catch {
      return { chron: -1, known: false }
   }
}

// Is `idx` a legitimate landing — a resume position or a restored #pos? Under
// unread-only a membership lane validates against the member's TRUE add_idx, not
// the raised bound, so the lane's own resume (seen) position is accepted.
export async function validResume(lane: Lane, idx: number, unreadOnly: boolean): Promise<boolean> {
   if (idx < 0 || idx >= data.db.total_art) return false
   const feedId = await data.getFeedId(idx)
   if (unreadOnly && !lane.peek) return lane.members.has(feedId) && idx >= (data.db.feeds[feedId]?.add_idx ?? 0)
   return lane.matches(feedId, idx)
}

// first()'s target for a chron-ordered lane: nothing exists below the smallest
// bound, so walk from there; nothing at or after it falls back to the newest (the
// entry anchor can sit below the smallest raised bound).
export async function oldestByBounds(lane: Lane): Promise<number> {
   const start = minOf(lane.members.values())
   if (start >= data.db.total_art) return lane.newest()
   const found = await lane.atOrAbove(start)
   return found !== -1 ? found : lane.newest()
}
