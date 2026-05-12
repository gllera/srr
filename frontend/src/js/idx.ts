export const IDX_PACK_SIZE = 50000
const IDX_HEADER_SIZE = 259 * 4 // 3 state uint32 + 256 subCounts uint32

export interface IdxPack {
   subIds: Uint8Array
   fetchedAts: Uint16Array
   subCounts: Uint32Array
   ownSubCounts: Uint32Array
   bounds: { packId: number; startChron: number }[]
   parse(): IdxPack
   countLeft(chronIdx: number, subs: Map<number, number>): number
   findLeft(chronFrom: number, subs: Map<number, number>): number
   findRight(chronFrom: number, subs: Map<number, number>): number
}

// Sub IDs are uint8 (0..255), so a 256-entry typed array beats Map.get in the
// hot scan loops: no hashing, predictable cache locality, and the JIT can
// keep the loaded value in a register. -1 sentinel = "not in filter".
function subsToLookup(subs: Map<number, number>): Int32Array {
   const arr = new Int32Array(256).fill(-1)
   for (const [subId, addIdx] of subs) arr[subId] = addIdx
   return arr
}

export function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number): IdxPack {
   // Refuse a short body so the caller can evict + retry. Silently parsing
   // fewer bytes than packSize claims leaves the subIds tail at default 0,
   // which findRight skips while showFeed still counts those slots.
   const expected = IDX_HEADER_SIZE + packSize * 2
   if (buf.byteLength < expected) {
      throw new Error(`idx pack ${packIndex}: short body, got ${buf.byteLength}B, want ${expected}B`)
   }
   let rawBuf: ArrayBuffer | null = buf
   const baseChron = packIndex * IDX_PACK_SIZE
   function hasCandidate(subs: Map<number, number>, packEnd: number): boolean {
      for (const [subId, addIdx] of subs) {
         if (pack.ownSubCounts[subId] > 0 && addIdx < packEnd) return true
      }
      return false
   }
   const pack: IdxPack = {
      subIds: new Uint8Array(0),
      subCounts: new Uint32Array(0),
      ownSubCounts: new Uint32Array(0),
      fetchedAts: new Uint16Array(0),
      bounds: [],
      parse() {
         if (!rawBuf) return pack
         const h = new Uint32Array(rawBuf, 0, IDX_HEADER_SIZE / 4)
         let fetchedAt = h[0]
         let packId = h[1]
         const packOff = h[2]
         // Copy out so the raw buffer can be GC'd after parse() returns
         pack.subCounts = new Uint32Array(new Uint32Array(rawBuf, 3 * 4, 256))
         const ownSubCounts = new Uint32Array(256)
         pack.ownSubCounts = ownSubCounts

         let lastPackId: number
         if (packOff > 0) {
            pack.bounds.push({ packId, startChron: baseChron - packOff })
            lastPackId = packId
         } else {
            lastPackId = -1
         }

         const subIds = new Uint8Array(packSize)
         const fetchedAts = new Uint16Array(packSize)
         pack.subIds = subIds
         pack.fetchedAts = fetchedAts
         const bytes = new Uint8Array(rawBuf)
         // Cap at packSize so an oversized body (e.g. stale SW cache with
         // entries from a newer total_art than db.gz claims) can't push ghost
         // rows into ownSubCounts/bounds and skew countLeft/findLeft/Right.
         const limit = IDX_HEADER_SIZE + packSize * 2
         for (let off = IDX_HEADER_SIZE; off < limit; off += 2) {
            const subId = bytes[off]
            const packed = bytes[off + 1]
            if (packed >> 7) packId++
            fetchedAt += packed & 0x7f

            const i = (off - IDX_HEADER_SIZE) >> 1
            subIds[i] = subId
            fetchedAts[i] = fetchedAt
            ownSubCounts[subId]++
            if (packId !== lastPackId) {
               pack.bounds.push({ packId, startChron: baseChron + i })
               lastPackId = packId
            }
         }
         rawBuf = null
         return pack
      },
      countLeft(chronIdx: number, subs: Map<number, number>): number {
         pack.parse()
         let count = 0
         for (const [subId, addIdx] of subs) {
            if (addIdx < baseChron) count += pack.subCounts[subId]
         }
         const limit = Math.min(chronIdx - baseChron, packSize)
         if (limit <= 0) return count
         const lookup = subsToLookup(subs)
         const subIds = pack.subIds
         for (let i = 0; i < limit; i++) {
            const addIdx = lookup[subIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) count++
         }
         return count
      },
      findLeft(chronFrom: number, subs: Map<number, number>): number {
         pack.parse()
         const packEnd = baseChron + packSize
         if (!hasCandidate(subs, packEnd)) return -1
         const lookup = subsToLookup(subs)
         const subIds = pack.subIds
         const hi = Math.min(chronFrom, packEnd - 1) - baseChron
         for (let i = hi; i >= 0; i--) {
            const addIdx = lookup[subIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) return baseChron + i
         }
         return -1
      },
      findRight(chronFrom: number, subs: Map<number, number>): number {
         pack.parse()
         const packEnd = baseChron + packSize
         if (!hasCandidate(subs, packEnd)) return -1
         const lookup = subsToLookup(subs)
         const subIds = pack.subIds
         const lo = Math.max(chronFrom, baseChron) - baseChron
         for (let i = lo; i < packSize; i++) {
            const addIdx = lookup[subIds[i]]
            if (addIdx !== -1 && baseChron + i >= addIdx) return baseChron + i
         }
         return -1
      },
   }
   return pack
}
