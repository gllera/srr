import {
   IDX_HEADER_PREFIX,
   IDX_PACK_SIZE,
   idxDecodeEntries,
   idxDecodeFooter,
   idxDecodeHeader,
   idxHeaderEnd,
   idxValidate,
   type IIdxHeader,
} from "./format.gen"

export { IDX_PACK_SIZE }

// The decoded idx pack header: the pack/offset bases, the numSlots count, plus
// the cumulative per-feed counts of everything BEFORE the pack. The count array
// is variable-length — dense up to the high-water feed id when the pack was
// written (numSlots entries). Available for every pack without entry parsing —
// from the pack's own bytes at construction, or from the idx/h<N>.gz summary
// for packs not yet fetched.
//
// The SHAPE is generated (backend/idx_layout.go → format.gen.ts), together with
// the decoders below; this alias keeps the reader's own name for it, which is
// what data.ts and the tests import.
export type IdxHeader = IIdxHeader

// feedCounts/ownFeedCounts are sized to the pack's numSlots (dense up to the
// high-water id when the pack was written). A feed added later is absent
// → its count is 0.
export function countAt(arr: Uint32Array, id: number): number {
   return id < arr.length ? arr[id] : 0
}

export interface IdxPack {
   header: IdxHeader
   feedIds: Uint16Array
   ownFeedCounts: Uint32Array
   bounds: { packId: number; startChron: number }[]
   parse(): IdxPack
   countLeft(chronIdx: number, feeds: Map<number, number>, lookup: Int32Array, expired?: Uint32Array): number
   findLeft(chronFrom: number, feeds: Map<number, number>, lookup: Int32Array): number
   findRight(chronFrom: number, feeds: Map<number, number>, lookup: Int32Array): number
}

// Decodes idx/h<N>.gz: the verbatim concatenation of the finalized packs'
// variable-length headers. Each header's stride depends on its own numSlots,
// so the walk reads numSlots from each prefix to advance; it must consume the
// buffer exactly so a truncated body can't silently zero the tail packs' counts.
// The per-header decode and the stride are generated (idxDecodeHeader /
// idxHeaderEnd); what is the reader's own is the walk and its two guards.
export function parseIdxHeaders(buf: ArrayBuffer, count: number): IdxHeader[] {
   const out: IdxHeader[] = []
   let off = 0
   for (let k = 0; k < count; k++) {
      if (off + IDX_HEADER_PREFIX > buf.byteLength) {
         throw new Error(`idx summary: truncated header ${k}/${count}`)
      }
      const h = idxDecodeHeader(buf, off)
      out.push(h)
      off += idxHeaderEnd(h.numSlots)
   }
   if (off !== buf.byteLength) {
      throw new Error(`idx summary: ${buf.byteLength}B, consumed ${off}B for ${count} headers`)
   }
   return out
}

// lowerBound is the one binary-search primitive of the reader (the Go side's
// sort.Search): the smallest i in [0, n) for which isBelow(i) is false — n
// when none. Each caller supplies only its predicate, so the easy-to-fumble
// `(lo + hi) >>> 1` loop exists once.
export function lowerBound(n: number, isBelow: (i: number) => boolean): number {
   let lo = 0
   let hi = n
   while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (isBelow(mid)) lo = mid + 1
      else hi = mid
   }
   return lo
}

// A `slots`-entry typed array beats Map.get in the hot scan loops: no hashing,
// predictable cache locality, and the JIT can keep the loaded value in a
// register. -1 sentinel = "not in filter". `slots` is the store high-water+1
// (threaded from data.ts), so it is sized to the actual feed count rather
// than the format ceiling. data.ts builds it once per nav call and threads it
// into the per-pack scans (countLeft/findLeft/findRight), so a multi-pack walk
// reuses one allocation instead of rebuilding it per pack touched.
export function makeFeedsLookup(feeds: Map<number, number>, slots: number): Int32Array {
   const arr = new Int32Array(slots).fill(-1)
   for (const [feedId, addIdx] of feeds) arr[feedId] = addIdx
   return arr
}

// tallyUnread computes EVERY feed's unread count — visible articles strictly
// after its seen frontier — in one pass over the latest pack, replacing the
// per-feed countAll/countLeft fan-out that re-scanned the same tail once per
// feed (O(feeds × tail), per lane-cycle keypress in unread-only mode). Per
// feed the result is exactly `countAll − countLeft(min(seen+1, totalArt))`
// over its one-feed map — the feedUnread oracle; the differential test in
// idx.test.ts pins the equivalence across the seen matrix:
//  - never seen: the full visible backlog — the pre-tail term comes O(1) from
//    the latest header's all-time cumulative count minus the feed's expired
//    total (only when add_idx < base: otherwise everything before the tail is
//    logically deleted), plus the tail entries at chron ≥ add_idx. Idx-derived
//    on purpose (countAt(header), never feed.total_art) so db.gz drift can't
//    skew it — the same anti-drift stance as countLeft's header shortcut.
//  - seen in the tail (seen+1 ≥ base): the pre-tail contributions cancel in
//    the countAll − countLeft subtraction, leaving just the tail entries at
//    chron ≥ max(add_idx, seen+1). (A markUnreadFrom(0) frontier stores −1;
//    seen+1 = 0 lands here when base is 0 and rare below otherwise.)
//  - seen below the tail base: an exact count needs finalized-pack scans (and
//    possibly their fetches) — those feeds return in `rare` for the caller's
//    per-feed async oracle fallback. Structurally empty while
//    totalArt ≤ IDX_PACK_SIZE (no finalized pack to have been seen in).
export interface TallyFeed {
   id: number
   add_idx?: number
}

export function tallyUnread<T extends TallyFeed>(
   latest: IdxPack,
   base: number, // the latest pack's first chron (numFinalized × IDX_PACK_SIZE)
   totalArt: number,
   slots: number,
   chs: T[],
   seenOf: (id: number) => number | undefined,
   expired?: Uint32Array,
): { counts: Map<number, number>; rare: T[] } {
   const counts = new Map<number, number>()
   const rare: T[] = []
   const pack = latest.parse()
   const header = pack.header.feedCounts
   const threshold = new Int32Array(slots).fill(-1) // -1 = not tallied in the pass
   const pre = new Float64Array(slots) // never-seen feeds' O(1) pre-tail term

   for (const ch of chs) {
      const addIdx = ch.add_idx ?? 0
      const seen = seenOf(ch.id)
      if (seen !== undefined && seen + 1 < base) {
         rare.push(ch)
         continue
      }
      threshold[ch.id] = seen === undefined ? addIdx : Math.max(seen + 1, addIdx)
      if (seen === undefined && addIdx < base) {
         pre[ch.id] = Math.max(0, countAt(header, ch.id) - (expired ? countAt(expired, ch.id) : 0))
      }
      counts.set(ch.id, 0)
   }

   const feedIds = pack.feedIds
   const tally = new Uint32Array(slots)
   const limit = Math.min(totalArt - base, feedIds.length)
   for (let i = 0; i < limit; i++) {
      const id = feedIds[i]
      const th = id < slots ? threshold[id] : -1
      if (th !== -1 && base + i >= th) tally[id]++
   }
   for (const id of counts.keys()) counts.set(id, pre[id] + tally[id])
   return { counts, rare }
}

export function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number, slots: number): IdxPack {
   // header is decoded eagerly below so its numSlots is available before the
   // shape check (the header itself is variable-length).
   const header = idxDecodeHeader(buf, 0)
   // Refuse a short body so the caller can evict + retry — silently parsing
   // fewer bytes than packSize claims leaves the feedIds tail at default 0,
   // which findRight skips while showFeed still counts those slots — and a
   // ragged trailing footer, which means a corrupt pack. Both conditions and
   // their wording are generated (idxValidate), so the Go reader rejects the
   // very same bytes for the very same stated reason.
   const bad = idxValidate(buf.byteLength, header.numSlots, packSize)
   if (bad) throw new Error(`idx pack ${packIndex}: ${bad}`)
   let rawBuf: ArrayBuffer | null = buf
   const baseChron = packIndex * IDX_PACK_SIZE
   function hasCandidate(feeds: Map<number, number>, packEnd: number): boolean {
      for (const [feedId, addIdx] of feeds) {
         if (countAt(pack.ownFeedCounts, feedId) > 0 && addIdx < packEnd) return true
      }
      return false
   }
   const pack: IdxPack = {
      // Decoded eagerly: header-only consumers (countLeft cumulative counts,
      // pack-skip deltas, pack/offset bases) must not force the entry parse.
      header,
      feedIds: new Uint16Array(0),
      ownFeedCounts: new Uint32Array(0),
      bounds: [],
      parse() {
         if (!rawBuf) return pack
         let packId = pack.header.packIdBase
         const packOff = pack.header.packOffBase
         // Sized to the store high-water (slots), so ownFeedCount(id) reads 0
         // for an id beyond it. countAt guards the rare out-of-range read.
         const ownFeedCounts = new Uint32Array(slots)
         pack.ownFeedCounts = ownFeedCounts

         let lastPackId: number
         if (packOff > 0) {
            pack.bounds.push({ packId, startChron: baseChron - packOff })
            lastPackId = packId
         } else {
            lastPackId = -1
         }

         // The entry array and the boundary footer are decoded by the generated
         // readers (backend/idx_layout.go → format.gen.ts), the same
         // declaration the Go writer and Go reader run on; the entry decode is
         // capped at packSize, so an oversized body (e.g. a stale SW cache)
         // can't push ghost rows into ownFeedCounts/bounds. What is the
         // READER's own is this walk: the ownFeedCounts tally and the bounds
         // rebuild, which advances the packId at each footer boundary with the
         // same push condition the old per-entry delta_pack_id decode used.
         const feedIds = idxDecodeEntries(rawBuf, header.numSlots, packSize)
         pack.feedIds = feedIds
         const boundaries = idxDecodeFooter(rawBuf, header.numSlots, packSize)
         let bi = 0
         for (let i = 0; i < packSize; i++) {
            const feedId = feedIds[i]
            if (feedId < slots) ownFeedCounts[feedId]++
            if (bi < boundaries.length && boundaries[bi] === i) {
               packId++
               bi++
            }
            if (packId !== lastPackId) {
               pack.bounds.push({ packId, startChron: baseChron + i })
               lastPackId = packId
            }
         }
         rawBuf = null
         return pack
      },
      countLeft(chronIdx: number, feeds: Map<number, number>, lookup: Int32Array, expired?: Uint32Array): number {
         pack.parse()
         let count = 0
         for (const [feedId, addIdx] of feeds) {
            if (addIdx < baseChron) {
               // Finalized headers are immutable ALL-TIME cumulative counts;
               // expiration moves add_idx mid-history without rewriting them,
               // so subtract the feed's expired total (db.gz xp) to count only
               // visible entries. Clamped: a corrupt xp must not go negative.
               const prior = countAt(pack.header.feedCounts, feedId) - (expired ? countAt(expired, feedId) : 0)
               count += Math.max(0, prior)
            }
         }
         const limit = Math.min(chronIdx - baseChron, packSize)
         if (limit <= 0) return count
         const feedIds = pack.feedIds
         for (let i = 0; i < limit; i++) {
            const addIdx = lookup[feedIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) count++
         }
         return count
      },
      findLeft(chronFrom: number, feeds: Map<number, number>, lookup: Int32Array): number {
         pack.parse()
         const packEnd = baseChron + packSize
         if (!hasCandidate(feeds, packEnd)) return -1
         const feedIds = pack.feedIds
         const hi = Math.min(chronFrom, packEnd - 1) - baseChron
         for (let i = hi; i >= 0; i--) {
            const addIdx = lookup[feedIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) return baseChron + i
         }
         return -1
      },
      findRight(chronFrom: number, feeds: Map<number, number>, lookup: Int32Array): number {
         pack.parse()
         const packEnd = baseChron + packSize
         if (!hasCandidate(feeds, packEnd)) return -1
         const feedIds = pack.feedIds
         const lo = Math.max(chronFrom, baseChron) - baseChron
         for (let i = lo; i < packSize; i++) {
            const addIdx = lookup[feedIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) return baseChron + i
         }
         return -1
      },
   }
   return pack
}
