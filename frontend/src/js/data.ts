import { makeLRU } from "./cache"

export const IDX_PACK_SIZE = 50000
const IDX_HEADER_SIZE = 259 * 4 // 3 state uint32 + 256 subCounts uint32

let fetchController = new AbortController()
export function abortPending() {
   fetchController.abort()
   fetchController = new AbortController()
}

const DB_URL = new URL(SRR_CDN_URL, window.location.href)
// Reuses the browser's preloaded response from <link rel="preload"> in the built HTML
const dbFetch = fetch(new URL("db.gz", DB_URL))

export let db: IDB

interface IdxPack {
   subIds: Uint8Array
   fetchedAts: Uint16Array
   bounds: { packId: number; startChron: number }[]
   parse(): void
}

function makeIdxPack(buf: ArrayBuffer, packIndex: number, packSize: number): IdxPack {
   let rawBuf: ArrayBuffer | null = buf
   const pack: IdxPack = {
      subIds: new Uint8Array(0),
      fetchedAts: new Uint16Array(0),
      bounds: [],
      parse() {
         if (!rawBuf) return
         const h = new Uint32Array(rawBuf, 0, IDX_HEADER_SIZE / 4)
         let fetchedAt = h[0]
         let packId = h[1]
         const packOff = h[2]
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
      },
   }
   return pack
}

let idxPacks: IdxPack[] = []

const dataCache = makeLRU<IArticle[]>(5)

export async function init() {
   const res = await dbFetch
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.subscriptions ??= {}
   for (const [k, sub] of Object.entries(raw.subscriptions)) sub.id = Number(k)
   db = raw

   if (db.total_art === 0) return

   const nf = numFinalizedIdx()

   idxPacks = await Promise.all(
      Array.from({ length: nf + 1 }, (_, p) => {
         const isFinalized = p < nf
         const path = `idx/${isFinalized ? p.toString() : String(db.data_tog)}.gz`
         const opts: RequestInit = {}
         if (isFinalized) opts.cache = "force-cache"
         const size = isFinalized ? IDX_PACK_SIZE : db.total_art - p * IDX_PACK_SIZE
         return fetch(new URL(path, DB_URL), opts)
            .then((res) => new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
            .then((buf) => makeIdxPack(buf, p, size))
      }),
   )
}

export function numFinalizedIdx(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / IDX_PACK_SIZE) : 0
}

function packIdx(chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / IDX_PACK_SIZE), idxPacks.length - 1)
}

export function getSubId(chronIdx: number): number {
   const n = packIdx(chronIdx)
   const pack = idxPacks[n]
   pack.parse()
   return pack.subIds[chronIdx - n * IDX_PACK_SIZE]
}

// Binary search for rightmost entry where fetchedAt <= ts
export function findChronForTimestamp(ts: number): number {
   for (const p of idxPacks) p.parse()
   const tsBlocks = Math.trunc(ts / 28800) - Math.trunc(db.first_fetched / 28800)
   let lo = 0
   let hi = db.total_art
   while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const n = packIdx(mid)
      if (idxPacks[n].fetchedAts[mid - n * IDX_PACK_SIZE] <= tsBlocks) lo = mid + 1
      else hi = mid
   }
   return lo > 0 ? lo - 1 : 0
}

function getPackRef(chronIdx: number): { packId: number; offset: number } {
   const n = packIdx(chronIdx)
   const pack = idxPacks[n]
   pack.parse()
   const bounds = pack.bounds
   let lo = 0
   let hi = bounds.length
   while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bounds[mid].startChron <= chronIdx) lo = mid + 1
      else hi = mid
   }
   const bound = bounds[lo - 1]
   return { packId: bound.packId, offset: chronIdx - bound.startChron }
}

async function loadDataPack(packId: number): Promise<IArticle[]> {
   let entries = dataCache.get(packId)
   if (!entries) {
      const isFinalized = packId < db.next_pid
      const name = isFinalized ? packId.toString() : String(db.data_tog)
      const opts: RequestInit = {}
      if (isFinalized) opts.cache = "force-cache"
      opts.signal = fetchController.signal
      const res = await fetch(new URL(`data/${name}.gz`, DB_URL), opts)
      const reader = res
         .body!.pipeThrough(new DecompressionStream("gzip"))
         .pipeThrough(new TextDecoderStream())
         .getReader()
      entries = []
      let remainder = ""
      while (true) {
         const { done, value } = await reader.read()
         if (done) break
         const chunk = remainder ? remainder + value : value
         remainder = ""
         let start = 0
         let idx: number
         while ((idx = chunk.indexOf("\n", start)) !== -1) {
            const seg = chunk.substring(start, idx)
            start = idx + 1
            if (seg) entries.push(JSON.parse(seg) as IArticle)
         }
         if (start < chunk.length) remainder = chunk.substring(start)
      }
      if (remainder.length > 0) entries.push(JSON.parse(remainder) as IArticle)
      dataCache.put(packId, entries)
   }
   return entries
}

export function getArticleSync(chronIdx: number): IArticle | undefined {
   const ref = getPackRef(chronIdx)
   const cached = dataCache.peek(ref.packId)
   return cached?.[ref.offset]
}

export async function loadArticle(chronIdx: number): Promise<IArticle> {
   const ref = getPackRef(chronIdx)
   const entries = await loadDataPack(ref.packId)
   return entries[ref.offset]
}

// db is immutable after init(); cache is safe for the app's lifetime
let activeSubsCache: ISub[] | null = null
export function activeSubs(): ISub[] {
   if (activeSubsCache) return activeSubsCache
   activeSubsCache = Object.values(db.subscriptions)
      .filter((sub) => sub.total_art > 0)
      .sort((a, b) => (a.title < b.title ? -1 : 1))
   return activeSubsCache
}
