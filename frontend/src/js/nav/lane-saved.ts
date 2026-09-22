// nav/lane-saved.ts — ★ Saved: the device-local read-later queue, walked in SAVE
// order. saved.ts owns the set, its queue arithmetic and the unsave-of-current
// ghost (which stays module state there: it must survive a re-apply of this lane,
// and nav clears it on every landing). Feed-agnostic and a peek mode: membership
// is the set, and the frontier scope is empty.
import { isSaved, savedAhead, savedNeighbor, savedOrder } from "../saved"
import { PeekLane, type LaneEntry } from "./lane"

export class SavedLane extends PeekLane {
   readonly kind = "saved" as const
   // No chronIdx order to step by value: goTo never relies on the value seam
   // (chronOrdered false — it tests membership directly), and the neighbours
   // step by save-INDEX below.
   readonly chronOrdered = false

   matches(_feedId: number, chron: number): boolean {
      return isSaved(chron)
   }

   atOrBelow(): Promise<number> {
      return Promise.resolve(-1)
   }

   atOrAbove(): Promise<number> {
      return Promise.resolve(-1)
   }

   override older(chron: number): Promise<number> {
      return Promise.resolve(savedNeighbor(chron, "older"))
   }

   override newer(chron: number): Promise<number> {
      return Promise.resolve(savedNeighbor(chron, "newer"))
   }

   // The FRONT of the queue: the earliest save, not the lowest chronIdx.
   oldest(): Promise<number> {
      return Promise.resolve(savedOrder()[0] ?? -1)
   }

   override newest(): Promise<number> {
      const order = savedOrder()
      return Promise.resolve(order.length ? order[order.length - 1] : -1)
   }

   // The queue is read front-to-back: land at its front.
   override anchor(): Promise<number> {
      return this.oldest()
   }

   ahead(floor: number): Promise<number> {
      return Promise.resolve(savedAhead(floor))
   }

   override async entry(): Promise<LaneEntry> {
      return { land: await this.oldest() }
   }
}
