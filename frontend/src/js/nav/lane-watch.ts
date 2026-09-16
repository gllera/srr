// nav/lane-watch.ts — a keyword-watchlist lane: `w:<rule>`, one lane per key of the
// manifest's `wf` (docs/MANIFEST-SPEC.md §4.8). The per-ARTICLE classification
// axis the writer publishes as bitmap planes; the reader walks the set bits.
//
// A PEEK mode, and for a structural reason, not taste: the seen model is one
// frontier per feed, and raising one marks every earlier article of that feed
// read — a lane over a sparse subset of a feed cannot raise frontiers without
// marking the articles it skipped. Search made the same call.
//
// Coverage is [wf[rule], wc): below the floor the rule did not exist, at or above
// wc the sync has not caught up. Both read as "no bit"; nothing here claims
// coverage the store did not publish.
import * as data from "../data"
import { WATCH_PACK_SIZE } from "../format.gen"
import { bitAt, nextSet, popcountRange, prevSet, type WatchPlane } from "../watch-plane"
import { keyOf, labelFor, type Lane, type LaneEntry } from "./lane"

const NO_FEEDS: ReadonlyMap<number, number> = new Map()

export class WatchLane implements Lane {
   readonly kind = "watch" as const
   readonly tokens: readonly string[]
   readonly key: string
   readonly rule: string
   readonly peek = true
   readonly dividers = false // strata over a sparse subset read as noise
   readonly chronOrdered = true
   readonly members = NO_FEEDS
   // Regions this lane has loaded, so matches() can answer synchronously. A region
   // that is not resident reads as "no match"; the walks are what fault regions
   // in, exactly as findLeft/findRight fault idx packs in for a membership lane.
   private readonly planes = new Map<number, WatchPlane>()

   constructor(tokens: readonly string[], rule: string) {
      this.tokens = tokens
      this.key = keyOf(tokens)
      this.rule = rule
   }

   private floor(): number {
      return data.watchRules()[this.rule] ?? 0
   }

   private end(): number {
      return data.watchCovered()
   }

   private async plane(p: number): Promise<WatchPlane> {
      const resident = this.planes.get(p)
      if (resident) return resident
      const loaded = await data.loadWatchPlane(p)
      this.planes.set(p, loaded)
      return loaded
   }

   // Expired articles (chron < their feed's add_idx) are logically deleted
   // everywhere else; they are here too. A deleted feed keeps the tombstone status
   // quo, as search does.
   private async live(chron: number): Promise<boolean> {
      const feed = data.db.feeds[await data.getFeedId(chron)]
      return !feed || chron >= (feed.add_idx ?? 0)
   }

   label(): string {
      return labelFor(this.key)
   }

   matches(feedId: number, chron: number): boolean {
      if (chron < this.floor() || chron >= this.end()) return false
      const plane = this.planes.get(Math.floor(chron / WATCH_PACK_SIZE))
      const bits = plane?.bits.get(this.rule)
      if (!plane || !bits || !bitAt(bits, chron - plane.base)) return false
      return chron >= (data.db.feeds[feedId]?.add_idx ?? 0)
   }

   async atOrAbove(from: number): Promise<number> {
      const end = this.end()
      for (let c = Math.max(from, this.floor(), 0); c < end; ) {
         const p = Math.floor(c / WATCH_PACK_SIZE)
         const plane = await this.plane(p)
         const bits = plane.bits.get(this.rule)
         if (bits) {
            const stop = Math.min(end, plane.base + WATCH_PACK_SIZE) - plane.base
            for (let i = nextSet(bits, c - plane.base, stop); i !== -1; i = nextSet(bits, i + 1, stop))
               if (await this.live(plane.base + i)) return plane.base + i
         }
         c = (p + 1) * WATCH_PACK_SIZE
      }
      return -1
   }

   async atOrBelow(from: number): Promise<number> {
      const lo = this.floor()
      for (let c = Math.min(from, this.end() - 1); c >= lo; ) {
         const p = Math.floor(c / WATCH_PACK_SIZE)
         const plane = await this.plane(p)
         const bits = plane.bits.get(this.rule)
         if (bits) {
            const min = Math.max(lo, plane.base) - plane.base
            for (let i = prevSet(bits, c - plane.base, min); i !== -1; i = prevSet(bits, i - 1, min))
               if (await this.live(plane.base + i)) return plane.base + i
         }
         c = p * WATCH_PACK_SIZE - 1
      }
      return -1
   }

   older(chron: number): Promise<number> {
      return this.atOrBelow(chron - 1)
   }

   newer(chron: number): Promise<number> {
      return this.atOrAbove(chron + 1)
   }

   oldest(): Promise<number> {
      return this.atOrAbove(0)
   }

   newest(): Promise<number> {
      return this.atOrBelow(this.end() - 1)
   }

   // Newest-first, like search: a scan of recent hits, not a backlog to consume.
   anchor(): Promise<number> {
      return Promise.resolve(-1)
   }

   // Set bits in (floor, wc) ∩ [wf, wc). Expiration is not subtracted (the spec's
   // count), so a badge can exceed what the walk reaches by the expired hits.
   async ahead(floor: number): Promise<number> {
      const lo = Math.max(floor + 1, this.floor())
      const hi = this.end()
      let n = 0
      for (let p = Math.floor(lo / WATCH_PACK_SIZE); lo < hi && p * WATCH_PACK_SIZE < hi; p++) {
         const plane = await this.plane(p)
         const bits = plane.bits.get(this.rule)
         if (!bits) continue
         const a = Math.max(lo, plane.base) - plane.base
         const b = Math.min(hi, plane.base + plane.n) - plane.base
         n += a === 0 && b === plane.n ? (plane.pop.get(this.rule) ?? 0) : popcountRange(bits, a, b)
      }
      return n
   }

   async entry(): Promise<LaneEntry> {
      return { land: await this.newest(), record: false }
   }

   // matches() must hold for the tail region, where a switch and a deep link land.
   async prepare(): Promise<void> {
      const end = this.end()
      if (end > this.floor()) await this.plane(Math.floor((end - 1) / WATCH_PACK_SIZE))
   }

   // A refresh can grow the tail region and move wc, but a FINALIZED region — one
   // strictly below the new tail position — is write-once (docs/MANIFEST-SPEC.md
   // §4.8: `srr store compact` leaves the watch series untouched) ONLY ONCE its
   // plane was already fully finalized when it was loaded (its stored `n` was
   // already a full pack). A plane loaded while its region WAS still the growing
   // tail carries a partial `n` — the region's real size at fetch time — and that
   // recorded size (and therefore the bitmap length matches()/the walk read
   // against) goes stale the moment the tail grows past it, even though the
   // region's position has since dropped below the new tail. So a resident plane
   // is kept only when it is strictly below the new tail AND was already a full
   // pack when fetched; anything else — at-or-above the new tail, or a stale
   // partial now finalized below it — is dropped. EVERY dropped position is
   // reloaded here, not just the new tail: a plane dropped for being a stale
   // former-tail (now finalized, below the new tail) would otherwise never be
   // refetched, since prepare() only ever fetches the new tail position — and
   // matches()/anchorChron would misread a genuine hit there as "no match" until
   // something else happened to fault that position back in.
   async refreshed(): Promise<void> {
      const tail = Math.floor((this.end() - 1) / WATCH_PACK_SIZE)
      const stale: number[] = []
      for (const [p, plane] of this.planes)
         if (p >= tail || plane.n < WATCH_PACK_SIZE) {
            this.planes.delete(p)
            stale.push(p)
         }
      await Promise.all(stale.map((p) => this.plane(p)))
      await this.prepare()
   }

   landed(): void {
      // A peek lane remembers nothing about a landing.
   }

   applyUnseen(): void {
      // A peek lane has no bounds to raise.
   }

   entryAnchor(): number {
      return -1
   }

   // matches() is only correct for a RESIDENT region. prepare() faults in the
   // tail alone (the switch/deep-link common case), so a restored #pos or a
   // shared link into an older region needs its own region faulted in before
   // validResume's synchronous matches() check can answer it — this is that
   // fault, keyed to the one chron the caller is validating.
   async ensureRegion(chron: number): Promise<void> {
      if (chron >= this.floor() && chron < this.end()) await this.plane(Math.floor(chron / WATCH_PACK_SIZE))
   }
}
