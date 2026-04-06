export const IDX_PACK_SIZE = 50000
const IDX_HEADER_SIZE = 259 * 4 // 3 state uint32 + 256 subCounts uint32

export interface IdxPack {
   subIds: Uint8Array
   fetchedAts: Uint16Array
   subCounts: Uint32Array
   bounds: { packId: number; startChron: number }[]
   parse(): IdxPack
   countLeft(chronIdx: number, subs: Map<number, number>): number
}

export function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number): IdxPack {
   let rawBuf: ArrayBuffer | null = buf
   const pack: IdxPack = {
      subIds: new Uint8Array(0),
      subCounts: new Uint32Array(0),
      fetchedAts: new Uint16Array(0),
      bounds: [],
      parse() {
         if (!rawBuf) return pack
         const h = new Uint32Array(rawBuf, 0, IDX_HEADER_SIZE / 4)
         let fetchedAt = h[0]
         let packId = h[1]
         const packOff = h[2]
         pack.subCounts = new Uint32Array(rawBuf, 3 * 4, 256)
         const baseChron = packIndex * IDX_PACK_SIZE

         if (packOff > 0) {
            pack.bounds.push({ packId, startChron: baseChron - packOff })
         }

         pack.subIds = new Uint8Array(packSize)
         pack.fetchedAts = new Uint16Array(packSize)
         let localOff = 0
         const view = new DataView(rawBuf)
         for (let off = IDX_HEADER_SIZE; off + 2 <= rawBuf.byteLength; off += 2) {
            const packed = view.getUint8(off + 1)
            if (packed >> 7) packId++
            fetchedAt += packed & 0x7f

            pack.subIds[localOff] = view.getUint8(off)
            pack.fetchedAts[localOff] = fetchedAt
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
   }
   return pack
}
