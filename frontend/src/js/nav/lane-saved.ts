// nav/lane-saved.ts — ★ Saved: the device-local read-later queue, walked in SAVE
// order. saved.ts owns the set, its queue arithmetic and the unsave-of-current
// ghost (which stays module state there: it must survive a re-apply of this lane,
// and nav clears it on every landing). Feed-agnostic and a peek mode: membership
// is the set, and the frontier scope is empty.
import * as data from "../data"
import { isSaved, savedAhead, savedNeighbor, savedOrder } from "../saved"
import { keyOf, labelFor, type Lane, type LaneEntry } from "./lane"

// ★ Saved has no chronIdx order to step by value, so the value seam
// (nav.feedLeft/feedRight) answers what it always answered in this mode: a walk
// over no feeds. goTo never relies on it — chronOrdered is false, so it tests
// membership directly.
const NO_FEEDS = new Map<number, number>()

export class SavedLane implements Lane {
   readonly kind = "saved" as const
   readonly tokens: readonly string[]
   readonly key: string
   readonly peek = true
   readonly dividers = false
   readonly chronOrdered = false
   readonly members: ReadonlyMap<number, number> = NO_FEEDS

   constructor(tokens: readonly string[]) {
      this.tokens = tokens
      this.key = keyOf(tokens)
   }

   label(): string {
      return labelFor(this.key)
   }

   matches(_feedId: number, chron: number): boolean {
      return isSaved(chron)
   }

   atOrBelow(from: number): Promise<number> {
      return data.findLeft(from, NO_FEEDS)
   }

   atOrAbove(from: number): Promise<number> {
      return data.findRight(from, NO_FEEDS)
   }

   older(chron: number): Promise<number> {
      return Promise.resolve(savedNeighbor(chron, "older"))
   }

   newer(chron: number): Promise<number> {
      return Promise.resolve(savedNeighbor(chron, "newer"))
   }

   // The FRONT of the queue: the earliest save, not the lowest chronIdx.
   oldest(): Promise<number> {
      return Promise.resolve(savedOrder()[0] ?? -1)
   }

   newest(): Promise<number> {
      const order = savedOrder()
      return Promise.resolve(order.length ? order[order.length - 1] : -1)
   }

   anchor(): Promise<number> {
      return this.oldest()
   }

   ahead(floor: number): Promise<number> {
      return Promise.resolve(savedAhead(floor))
   }

   async entry(): Promise<LaneEntry> {
      return { land: await this.oldest(), record: false }
   }

   prepare(): Promise<void> {
      return Promise.resolve()
   }

   refreshed(): Promise<void> {
      return Promise.resolve()
   }

   landed(): void {
      // The ghost is saved.ts state, cleared by nav on every landing (N15).
   }

   applyUnseen(): void {
      // A peek lane has no bounds to raise.
   }

   entryAnchor(): number {
      return -1
   }
}
