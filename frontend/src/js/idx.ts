import { DELTA_FETCHED_MAX, IDX_ENTRY_SIZE, IDX_HEADER_PREFIX, IDX_PACK_SIZE } from "./format.gen"

export { IDX_PACK_SIZE }

// The decoded idx pack header: state bases, the numSlots count, plus the
// cumulative per-feed counts of everything BEFORE the pack. The count array
// is variable-length — dense up to the high-water feed id when the pack was
// written (numSlots entries). Available for every pack without entry parsing —
// from the pack's own bytes at construction, or from the idx/h<N>.gz summary
// for packs not yet fetched.
export interface IdxHeader {
   fetchedAtBase: number
   packIdBase: number
   packOffBase: number
   numSlots: number
   feedCounts: Uint32Array
}

// feedCounts/ownFeedCounts are sized to the pack's numSlots (dense up to the
// high-water id when the pack was written). A feed added later is absent
// → its count is 0.
export function countAt(arr: Uint32Array, id: number): number {
   return id < arr.length ? arr[id] : 0
}

export interface IdxPack {
   header: IdxHeader
   feedIds: Uint16Array
   fetchedAts: Uint16Array
   ownFeedCounts: Uint32Array
   bounds: { packId: number; startChron: number }[]
   parse(): IdxPack
   countLeft(chronIdx: number, feeds: Map<number, number>, lookup: Int32Array): number
   findLeft(chronFrom: number, feeds: Map<number, number>, lookup: Int32Array): number
   findRight(chronFrom: number, feeds: Map<number, number>, lookup: Int32Array): number
   findChronForBlocks(tsBlocks: number): number
}

function parseIdxHeader(buf: ArrayBuffer, byteOff: number): IdxHeader {
   const h = new Uint32Array(buf, byteOff, 4)
   const numSlots = h[3]
   return {
      fetchedAtBase: h[0],
      packIdBase: h[1],
      packOffBase: h[2],
      numSlots,
      // Copy out so the source buffer can be GC'd independently. The count
      // array is variable-length (numSlots entries).
      feedCounts: new Uint32Array(new Uint32Array(buf, byteOff + IDX_HEADER_PREFIX, numSlots)),
   }
}

// Decodes idx/h<N>.gz: the verbatim concatenation of the finalized packs'
// variable-length headers. Each header's stride depends on its own numSlots,
// so the walk reads numSlots from each prefix to advance; it must consume the
// buffer exactly so a truncated body can't silently zero the tail packs' counts.
export function parseIdxHeaders(buf: ArrayBuffer, count: number): IdxHeader[] {
   const out: IdxHeader[] = []
   let off = 0
   for (let k = 0; k < count; k++) {
      if (off + IDX_HEADER_PREFIX > buf.byteLength) {
         throw new Error(`idx summary: truncated header ${k}/${count}`)
      }
      const h = parseIdxHeader(buf, off)
      out.push(h)
      off += IDX_HEADER_PREFIX + h.numSlots * 4
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

// Pack-level step of findChronForTimestamp: headers[k] is pack k's header
// with the latest pack's at the end, so pack k's LAST entry value equals
// headers[k+1].fetchedAtBase (validated by the backend's fetched-ats
// continuity check). Returns the first pack whose last entry >= tsBlocks —
// the pack holding the global leftmost qualifying entry — clamped to the
// latest pack (whose end is unbounded).
export function findPackForBlocks(headers: IdxHeader[], tsBlocks: number): number {
   return lowerBound(headers.length - 1, (i) => headers[i + 1].fetchedAtBase < tsBlocks)
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

export function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number, slots: number): IdxPack {
   // header is decoded eagerly below so its numSlots is available before the
   // short-body guard (the header itself is variable-length).
   const header = parseIdxHeader(buf, 0)
   const headerEnd = IDX_HEADER_PREFIX + header.numSlots * 4
   // Refuse a short body so the caller can evict + retry. Silently parsing
   // fewer bytes than packSize claims leaves the feedIds tail at default 0,
   // which findRight skips while showFeed still counts those slots.
   const expected = headerEnd + packSize * IDX_ENTRY_SIZE
   if (buf.byteLength < expected) {
      throw new Error(`idx pack ${packIndex}: short body, got ${buf.byteLength}B, want ${expected}B`)
   }
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
      // pack-skip deltas, timestamp bases) must not force the entry parse.
      header,
      feedIds: new Uint16Array(0),
      ownFeedCounts: new Uint32Array(0),
      fetchedAts: new Uint16Array(0),
      bounds: [],
      parse() {
         if (!rawBuf) return pack
         let fetchedAt = pack.header.fetchedAtBase
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

         const feedIds = new Uint16Array(packSize)
         // fetchedAt is 8h-blocks since first_fetched. Uint16 caps at 65535
         // blocks ≈ 60y of calendar time from the first fetch — far past any
         // real horizon, so the wrap it would eventually cause is acceptable.
         const fetchedAts = new Uint16Array(packSize)
         pack.feedIds = feedIds
         pack.fetchedAts = fetchedAts
         const bytes = new Uint8Array(rawBuf)
         // Cap at packSize so an oversized body (e.g. stale SW cache with
         // entries from a newer total_art than db.gz claims) can't push ghost
         // rows into ownFeedCounts/bounds and skew countLeft/findLeft/Right.
         const limit = headerEnd + packSize * IDX_ENTRY_SIZE
         for (let off = headerEnd; off < limit; off += IDX_ENTRY_SIZE) {
            const feedId = bytes[off] | (bytes[off + 1] << 8)
            const packed = bytes[off + 2]
            if (packed >> 7) packId++
            fetchedAt += packed & DELTA_FETCHED_MAX

            const i = (off - headerEnd) / IDX_ENTRY_SIZE
            feedIds[i] = feedId
            fetchedAts[i] = fetchedAt
            if (feedId < slots) ownFeedCounts[feedId]++
            if (packId !== lastPackId) {
               pack.bounds.push({ packId, startChron: baseChron + i })
               lastPackId = packId
            }
         }
         rawBuf = null
         return pack
      },
      countLeft(chronIdx: number, feeds: Map<number, number>, lookup: Int32Array): number {
         pack.parse()
         let count = 0
         for (const [feedId, addIdx] of feeds) {
            if (addIdx < baseChron) count += countAt(pack.header.feedCounts, feedId)
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
      // Entry-level step of findChronForTimestamp (the pack-level step is
      // findPackForBlocks): global chronIdx of the leftmost entry with
      // fetchedAt >= tsBlocks, or one past the pack's end when none
      // qualifies (global like every other IdxPack member; the caller's
      // total_art clamp handles the overflow).
      findChronForBlocks(tsBlocks: number): number {
         pack.parse()
         const fetchedAts = pack.fetchedAts
         return baseChron + lowerBound(fetchedAts.length, (i) => fetchedAts[i] < tsBlocks)
      },
   }
   return pack
}
