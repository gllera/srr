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
   findLeft(chronFrom: number, chronFloor: number, subs: Map<number, number>): number
   findRight(chronFrom: number, chronTo: number, subs: Map<number, number>): number
}

export function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number): IdxPack {
   let rawBuf: ArrayBuffer | null = buf
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
         pack.ownSubCounts = new Uint32Array(256)
         const baseChron = packIndex * IDX_PACK_SIZE

         if (packOff > 0) {
            pack.bounds.push({ packId, startChron: baseChron - packOff })
         }

         pack.subIds = new Uint8Array(packSize)
         pack.fetchedAts = new Uint16Array(packSize)
         let localOff = 0
         const bytes = new Uint8Array(rawBuf)
         const limit = bytes.length - 1
         for (let off = IDX_HEADER_SIZE; off < limit; off += 2) {
            const packed = bytes[off + 1]
            if (packed >> 7) packId++
            fetchedAt += packed & 0x7f

            const subId = bytes[off]
            pack.subIds[localOff] = subId
            pack.fetchedAts[localOff] = fetchedAt
            pack.ownSubCounts[subId]++
            if (pack.bounds.length === 0 || pack.bounds[pack.bounds.length - 1].packId !== packId) {
               pack.bounds.push({ packId, startChron: baseChron + localOff })
            }
            localOff++
         }
         rawBuf = null
         return pack
      },
      countLeft(chronIdx: number, subs: Map<number, number>): number {
         pack.parse()
         const baseChron = packIndex * IDX_PACK_SIZE
         let count = 0
         for (const [subId, addIdx] of subs) {
            if (addIdx < baseChron) count += pack.subCounts[subId]
         }
         const limit = Math.min(chronIdx - baseChron, packSize)
         for (let i = 0; i < limit; i++) {
            const subId = pack.subIds[i]
            const addIdx = subs.get(subId)
            if (addIdx !== undefined && baseChron + i >= addIdx) count++
         }
         return count
      },
      findLeft(chronFrom: number, chronFloor: number, subs: Map<number, number>): number {
         pack.parse()
         const baseChron = packIndex * IDX_PACK_SIZE
         const packEnd = baseChron + packSize
         if (!hasCandidate(subs, packEnd)) return -1
         const hi = Math.min(chronFrom, packEnd - 1)
         const lo = Math.max(chronFloor, baseChron)
         for (let chron = hi; chron >= lo; chron--) {
            const subId = pack.subIds[chron - baseChron]
            const addIdx = subs.get(subId)
            if (addIdx !== undefined && chron >= addIdx) return chron
         }
         return -1
      },
      findRight(chronFrom: number, chronTo: number, subs: Map<number, number>): number {
         pack.parse()
         const baseChron = packIndex * IDX_PACK_SIZE
         const packEnd = baseChron + packSize
         if (!hasCandidate(subs, packEnd)) return -1
         const lo = Math.max(chronFrom, baseChron)
         const hi = Math.min(chronTo, packEnd - 1)
         for (let chron = lo; chron <= hi; chron++) {
            const subId = pack.subIds[chron - baseChron]
            const addIdx = subs.get(subId)
            if (addIdx !== undefined && chron >= addIdx) return chron
         }
         return -1
      },
   }
   return pack
}
