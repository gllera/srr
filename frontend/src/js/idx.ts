import { CHAN_ID_SLOTS, DELTA_FETCHED_MAX, IDX_HEADER_SIZE, IDX_PACK_SIZE, IDX_STATE_SIZE } from "./format.gen"

export { IDX_PACK_SIZE }

export interface IdxPack {
   chanIds: Uint8Array
   fetchedAts: Uint16Array
   chanCounts: Uint32Array
   ownChanCounts: Uint32Array
   bounds: { packId: number; startChron: number }[]
   parse(): IdxPack
   countLeft(chronIdx: number, channels: Map<number, number>): number
   findLeft(chronFrom: number, channels: Map<number, number>): number
   findRight(chronFrom: number, channels: Map<number, number>): number
}

// Channel IDs are uint8 (0..255), so a CHAN_ID_SLOTS-entry typed array beats
// Map.get in the hot scan loops: no hashing, predictable cache locality, and
// the JIT can keep the loaded value in a register. -1 sentinel = "not in filter".
function channelsToLookup(channels: Map<number, number>): Int32Array {
   const arr = new Int32Array(CHAN_ID_SLOTS).fill(-1)
   for (const [chanId, addIdx] of channels) arr[chanId] = addIdx
   return arr
}

export function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number): IdxPack {
   // Refuse a short body so the caller can evict + retry. Silently parsing
   // fewer bytes than packSize claims leaves the chanIds tail at default 0,
   // which findRight skips while showFeed still counts those slots.
   const expected = IDX_HEADER_SIZE + packSize * 2
   if (buf.byteLength < expected) {
      throw new Error(`idx pack ${packIndex}: short body, got ${buf.byteLength}B, want ${expected}B`)
   }
   let rawBuf: ArrayBuffer | null = buf
   const baseChron = packIndex * IDX_PACK_SIZE
   function hasCandidate(channels: Map<number, number>, packEnd: number): boolean {
      for (const [chanId, addIdx] of channels) {
         if (pack.ownChanCounts[chanId] > 0 && addIdx < packEnd) return true
      }
      return false
   }
   const pack: IdxPack = {
      chanIds: new Uint8Array(0),
      chanCounts: new Uint32Array(0),
      ownChanCounts: new Uint32Array(0),
      fetchedAts: new Uint16Array(0),
      bounds: [],
      parse() {
         if (!rawBuf) return pack
         const h = new Uint32Array(rawBuf, 0, IDX_HEADER_SIZE / 4)
         let fetchedAt = h[0]
         let packId = h[1]
         const packOff = h[2]
         // Copy out so the raw buffer can be GC'd after parse() returns
         pack.chanCounts = new Uint32Array(new Uint32Array(rawBuf, IDX_STATE_SIZE, CHAN_ID_SLOTS))
         const ownChanCounts = new Uint32Array(CHAN_ID_SLOTS)
         pack.ownChanCounts = ownChanCounts

         let lastPackId: number
         if (packOff > 0) {
            pack.bounds.push({ packId, startChron: baseChron - packOff })
            lastPackId = packId
         } else {
            lastPackId = -1
         }

         const chanIds = new Uint8Array(packSize)
         // fetchedAt is 8h-blocks since first_fetched. Uint16 caps at 65535
         // blocks ≈ 60y of calendar time from the first fetch — far past any
         // real horizon, so the wrap it would eventually cause is acceptable.
         const fetchedAts = new Uint16Array(packSize)
         pack.chanIds = chanIds
         pack.fetchedAts = fetchedAts
         const bytes = new Uint8Array(rawBuf)
         // Cap at packSize so an oversized body (e.g. stale SW cache with
         // entries from a newer total_art than db.gz claims) can't push ghost
         // rows into ownChanCounts/bounds and skew countLeft/findLeft/Right.
         const limit = IDX_HEADER_SIZE + packSize * 2
         for (let off = IDX_HEADER_SIZE; off < limit; off += 2) {
            const chanId = bytes[off]
            const packed = bytes[off + 1]
            if (packed >> 7) packId++
            fetchedAt += packed & DELTA_FETCHED_MAX

            const i = (off - IDX_HEADER_SIZE) >> 1
            chanIds[i] = chanId
            fetchedAts[i] = fetchedAt
            ownChanCounts[chanId]++
            if (packId !== lastPackId) {
               pack.bounds.push({ packId, startChron: baseChron + i })
               lastPackId = packId
            }
         }
         rawBuf = null
         return pack
      },
      countLeft(chronIdx: number, channels: Map<number, number>): number {
         pack.parse()
         let count = 0
         for (const [chanId, addIdx] of channels) {
            if (addIdx < baseChron) count += pack.chanCounts[chanId]
         }
         const limit = Math.min(chronIdx - baseChron, packSize)
         if (limit <= 0) return count
         const lookup = channelsToLookup(channels)
         const chanIds = pack.chanIds
         for (let i = 0; i < limit; i++) {
            const addIdx = lookup[chanIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) count++
         }
         return count
      },
      findLeft(chronFrom: number, channels: Map<number, number>): number {
         pack.parse()
         const packEnd = baseChron + packSize
         if (!hasCandidate(channels, packEnd)) return -1
         const lookup = channelsToLookup(channels)
         const chanIds = pack.chanIds
         const hi = Math.min(chronFrom, packEnd - 1) - baseChron
         for (let i = hi; i >= 0; i--) {
            const addIdx = lookup[chanIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) return baseChron + i
         }
         return -1
      },
      findRight(chronFrom: number, channels: Map<number, number>): number {
         pack.parse()
         const packEnd = baseChron + packSize
         if (!hasCandidate(channels, packEnd)) return -1
         const lookup = channelsToLookup(channels)
         const chanIds = pack.chanIds
         const lo = Math.max(chronFrom, baseChron) - baseChron
         for (let i = lo; i < packSize; i++) {
            const addIdx = lookup[chanIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) return baseChron + i
         }
         return -1
      },
   }
   return pack
}
