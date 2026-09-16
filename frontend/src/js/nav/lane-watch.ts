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

// The highest add_idx any feed carries. At or above it no article is expired,
// so live() needs no idx lookup there.
function maxAddIdx(): number {
   let m = 0
   for (const f of Object.values(data.db.feeds)) m = Math.max(m, f.add_idx ?? 0)
   return m
}

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
   // Bumped by refreshed(): a region load that started against the previous
   // snapshot must not overwrite what the refresh just installed.
   private gen = 0
   // maxAddIdx() for the snapshot this lane last saw; refreshed() is the only
   // place a feed's add_idx can move under an open lane.
   private liveFrom = maxAddIdx()

   constructor(tokens: readonly string[], rule: string) {
      this.tokens = tokens
      this.key = keyOf(tokens)
      this.rule = rule
   }

   // A rule the store no longer lists covers nothing — an open lane whose rule
   // was removed goes empty rather than widening to every chron its stale bits
   // mark.
   private floor(): number {
      const rules = data.watchRules()
      return Object.hasOwn(rules, this.rule) ? rules[this.rule] : Infinity
   }

   private end(): number {
      return data.watchCovered()
   }

   private async plane(p: number): Promise<WatchPlane> {
      const resident = this.planes.get(p)
      if (resident) return resident
      const my = this.gen
      const loaded = await data.loadWatchPlane(p)
      if (my === this.gen) this.planes.set(p, loaded)
      return loaded
   }

   // Expired articles (chron < their feed's add_idx) are logically deleted
   // everywhere else; they are here too. A deleted feed keeps the tombstone
   // status quo, as search does.
   private async live(chron: number): Promise<boolean> {
      if (chron >= this.liveFrom) return true
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

   // Set bits in (floor, wc) ∩ [wf, wc). The whole-coverage badge (floor -1) is
   // the spec's count and does not subtract expiration. A cursor-relative count
   // (the pending pill) must agree with the Next button, so it drops the expired
   // hits the walk skips — which only exist below liveFrom, where a reader's
   // cursor rarely sits.
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
      const expiredHi = Math.min(hi, this.liveFrom)
      if (floor >= 0 && lo < expiredHi) n -= await this.expiredIn(lo, expiredHi)
      return n
   }

   private async expiredIn(lo: number, hi: number): Promise<number> {
      let n = 0
      for (let c = lo; c < hi; ) {
         const p = Math.floor(c / WATCH_PACK_SIZE)
         const plane = await this.plane(p)
         const bits = plane.bits.get(this.rule)
         if (bits) {
            const stop = Math.min(hi, plane.base + WATCH_PACK_SIZE) - plane.base
            for (let i = nextSet(bits, c - plane.base, stop); i !== -1; i = nextSet(bits, i + 1, stop))
               if (!(await this.live(plane.base + i))) n++
         }
         c = (p + 1) * WATCH_PACK_SIZE
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
   // partial now finalized below it — is dropped. matches()/anchorChron would
   // misread a dropped position as "no match" until something faults it back in,
   // so the new tail and every dropped position — a stale former-tail included,
   // never just the new tail — are reloaded together in the one pass below.
   async refreshed(): Promise<void> {
      this.gen++
      this.liveFrom = maxAddIdx()
      const end = this.end()
      if (end <= this.floor()) return
      const tail = Math.floor((end - 1) / WATCH_PACK_SIZE)
      const reload = new Set([tail])
      for (const [p, plane] of this.planes)
         if (p >= tail || plane.n < WATCH_PACK_SIZE) {
            this.planes.delete(p)
            reload.add(p)
         }
      await Promise.all([...reload].map((p) => this.plane(p)))
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
