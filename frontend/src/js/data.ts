import { makeLRU } from "./cache"

export const IDX_PACK_SIZE = 50000

let fetchController = new AbortController()
export function abortPending() {
   fetchController.abort()
   fetchController = new AbortController()
}

const DB_URL = new URL(SRR_CDN_URL, window.location.href)
// Reuses the browser's preloaded response from <link rel="preload"> in the built HTML
const dbFetch = fetch(new URL("db.gz", DB_URL))

export let db: IDB

// Compact navigation index — built at init from all idx packs
export let subIds = new Uint32Array(0)
export let fetchedAts = new Uint32Array(0)

// Data pack boundaries: packBounds[i] = { packId, startChron }
let packBounds: { packId: number; startChron: number }[] = []

const dataCache = makeLRU<IArticle[]>(5)

export async function init() {
   const res = await dbFetch
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.subscriptions ??= []
   raw.subs_mapped = new Map(raw.subscriptions.map((sub) => [sub.id, sub]))
   db = raw

   if (db.total_art === 0) return

   // Build compact navigation index from all idx packs
   const nf = numFinalizedIdx()
   const hasLatest = db.total_art - nf * IDX_PACK_SIZE > 0
   const totalPacks = nf + (hasLatest ? 1 : 0)

   const sIds = new Uint32Array(db.total_art)
   const fAt = new Uint32Array(db.total_art)
   const bounds: { packId: number; startChron: number }[] = []

   let globalOffset = 0
   for (let p = 0; p < totalPacks; p++) {
      const isFinalized = p < nf
      const path = `idx/${isFinalized ? p.toString() : String(db.data_tog)}.gz`
      const entries = await streamSplitIdx(path, isFinalized)

      let packId = 0
      let fetchedAt = 0
      for (let i = 0; i < entries.length; i++) {
         const e = entries[i]
         if (i === 0) {
            packId = e.packId
            fetchedAt = e.fetchedAt
         } else {
            if (e.delta > 0) packId += e.delta
            fetchedAt += e.fetchedAt // delta
         }

         sIds[globalOffset] = e.subId
         fAt[globalOffset] = fetchedAt

         if (bounds.length === 0 || bounds[bounds.length - 1].packId !== packId) {
            bounds.push({ packId, startChron: globalOffset })
         }

         globalOffset++
      }
   }

   subIds = sIds
   fetchedAts = fAt
   packBounds = bounds
}

interface IdxRaw {
   subId: number
   packId: number
   packOffset: number
   delta: number
   fetchedAt: number
}

async function streamSplitIdx(path: string, isFinalized: boolean): Promise<IdxRaw[]> {
   const opts: RequestInit = {}
   if (isFinalized) opts.cache = "force-cache"
   const res = await fetch(new URL(path, DB_URL), opts)
   const reader = res
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream())
      .getReader()
   const result: IdxRaw[] = []
   let remainder = ""
   let lineNum = 0
   while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = remainder ? remainder + value : value
      remainder = ""
      let start = 0
      let idx: number
      while ((idx = chunk.indexOf("\n", start)) !== -1) {
         const line = chunk.substring(start, idx)
         start = idx + 1
         if (line) {
            result.push(parseIdxLine(line, lineNum++))
         }
      }
      if (start < chunk.length) remainder = chunk.substring(start)
   }
   if (remainder.length > 0) result.push(parseIdxLine(remainder, lineNum))
   return result
}

function parseIdxLine(line: string, lineNum: number): IdxRaw {
   const f = line.split("\t")
   if (lineNum === 0) {
      return { subId: Number(f[0]), packId: Number(f[1]), packOffset: Number(f[2]), delta: 0, fetchedAt: Number(f[3]) }
   }
   return { subId: Number(f[0]), packId: 0, packOffset: 0, delta: Number(f[1]), fetchedAt: Number(f[2]) }
}

export function numFinalizedIdx(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / IDX_PACK_SIZE) : 0
}

// Binary search on fetchedAts for rightmost entry where fetchedAts[i] <= ts
export function findChronForTimestamp(ts: number): number {
   let lo = 0
   let hi = fetchedAts.length
   while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (fetchedAts[mid] <= ts) lo = mid + 1
      else hi = mid
   }
   return lo > 0 ? lo - 1 : 0
}

function getPackRef(chronIdx: number): { packId: number; offset: number } {
   // Binary search packBounds for largest startChron <= chronIdx
   let lo = 0
   let hi = packBounds.length
   while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (packBounds[mid].startChron <= chronIdx) lo = mid + 1
      else hi = mid
   }
   const bound = packBounds[lo - 1]
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
   activeSubsCache = Array.from(db.subs_mapped.values())
      .filter((sub) => (sub.total_art ?? 0) > 0)
      .sort((a, b) => (a.title < b.title ? -1 : 1))
   return activeSubsCache
}
