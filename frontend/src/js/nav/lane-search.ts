// nav/lane-search.ts — the title-search lane: `q:<query>`, optionally beside ONE
// feed/tag token, its scope (RDR8). A peek mode walking the explicit hit set.
//
// The hit-set snapshot lives at MODULE scope, not on the instance: a lane is
// re-created on every re-apply of the same tokens (a Show-read flip, the list
// re-applying its filter), and the snapshot must survive that exactly as it did
// when it was nav's state — `searchKey !== searchLoadedFor` is the one rule that
// drops it. search.ts's loadHits cache stays warm underneath, so a returning query
// re-resolves without re-scanning.
import type { IMetaWire } from "../format.gen"
import { lowerBound } from "../idx"
import * as search from "../search"
import { oldestByBounds, PeekLane, SEARCH_PREFIX, type LaneEnv } from "./lane"
import { reconcileMembers, resolveMembership } from "./lane-members"

// Capped so a broad query cannot fetch the whole archive; searchTruncated() flags it.
const SEARCH_CAP = 500
let searchSorted: number[] = [] // ascending matching chronIdxs
let searchSet = new Set<number>() // the same hits, for matches()
let searchCards = new Map<number, IMetaWire>() // {f,w,t} per hit chron
let searchTruncatedFlag = false
// The key the snapshot was loaded for — distinct from the active key when a query
// changes before its load resolves (A→B→A).
let searchLoadedFor: string | null = null

export function resetSearchStream(): void {
   searchSorted = []
   searchSet = new Set<number>()
   searchCards = new Map()
   searchTruncatedFlag = false
   searchLoadedFor = null
}

export function searchTruncated(): boolean {
   return searchTruncatedFlag
}

// The {f,w,t} card captured during the scan, so the list renders search rows
// without re-reading meta packs. Undefined for a chron not in the snapshot.
export function searchCard(chron: number): IMetaWire | undefined {
   return searchCards.get(chron)
}

// Largest entry ≤ from / smallest ≥ from in an ascending array (-1 = none), and
// how many sit strictly above `floor` — three questions, one binary search.
function setLeft(sorted: number[], from: number): number {
   return sorted[lowerBound(sorted.length, (i) => sorted[i] <= from) - 1] ?? -1
}
function setRight(sorted: number[], from: number): number {
   return sorted[lowerBound(sorted.length, (i) => sorted[i] < from)] ?? -1
}
function countAbove(sorted: number[], floor: number): number {
   return sorted.length - lowerBound(sorted.length, (i) => sorted[i] <= floor)
}

export class SearchLane extends PeekLane {
   readonly kind = "search" as const
   readonly chronOrdered = true
   readonly query: string
   readonly scope: readonly string[]
   // The snapshot's identity: the query AND its scope. JSON rather than a
   // separator join — a tag name may contain any separator.
   readonly searchKey: string
   // The scope's membership at natural add_idx bounds (no applyUnseen: a peek
   // mode, so a query inside a lane must still find that lane's read articles);
   // empty for an unscoped query.
   private readonly feeds: Map<number, number>
   override readonly members: ReadonlyMap<number, number>
   private readonly env: LaneEnv

   constructor(tokens: readonly string[], q: number, env: LaneEnv) {
      super(tokens)
      this.env = env
      this.query = tokens[q].slice(SEARCH_PREFIX.length)
      this.scope = tokens.filter((_, i) => i !== q)
      this.feeds = this.scope.length > 0 ? resolveMembership(this.scope) : new Map()
      this.members = this.feeds
      this.searchKey = JSON.stringify([this.query, ...this.scope])
      if (this.searchKey !== searchLoadedFor) resetSearchStream()
   }

   matches(_feedId: number, chron: number): boolean {
      return searchSet.has(chron)
   }

   // Load (or confirm) the hit set. A result for a key that is no longer the
   // ACTIVE lane's is discarded — the concurrent load for the newer key stores its own.
   override async prepare(): Promise<void> {
      const key = this.searchKey
      if (searchLoadedFor === key) return
      if (!this.query) {
         resetSearchStream()
         searchLoadedFor = key
         return
      }
      // A scope reaches search.ts as the membership map itself, so the scan applies
      // this lane's own rule; its key rides along for search.ts's hit cache.
      const scope = this.scope.length > 0 ? { key: JSON.stringify(this.scope), feeds: this.feeds } : undefined
      const { chrons, truncated, cards } = await search.loadHits(this.query, SEARCH_CAP, scope)
      if (key !== this.env.searchKey()) return
      searchSorted = chrons
      searchSet = new Set(chrons)
      // `cards` is absent only from a stubbed loadHits.
      searchCards = cards ?? new Map()
      searchTruncatedFlag = truncated
      searchLoadedFor = key
   }

   atOrBelow(from: number): Promise<number> {
      return this.prepare().then(() => setLeft(searchSorted, from))
   }

   atOrAbove(from: number): Promise<number> {
      return this.prepare().then(() => setRight(searchSorted, from))
   }

   oldest(): Promise<number> {
      return oldestByBounds(this)
   }

   async ahead(floor: number): Promise<number> {
      await this.prepare()
      return countAbove(searchSorted, floor)
   }

   // The snapshot was computed against the old store: reconcile the scope's
   // bounds (never from seen — a peek mode), drop the snapshot, reload it.
   override async refreshed(): Promise<void> {
      if (this.scope.length > 0) reconcileMembers(this.feeds, resolveMembership(this.scope), false)
      resetSearchStream()
      await this.prepare()
   }
}
