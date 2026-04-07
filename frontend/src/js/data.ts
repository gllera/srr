import { makeLRU } from "./cache"
import { IDX_PACK_SIZE, makeIdxPack, type IdxPack } from "./idx"

export { IDX_PACK_SIZE }

let fetchController = new AbortController()
export function abortPending() {
   fetchController.abort()
   fetchController = new AbortController()
}

const DB_URL = new URL(SRR_CDN_URL, window.location.href)
// Reuses the browser's preloaded response from <link rel="preload"> in the built HTML
const dbFetch = fetch(new URL("db.gz", DB_URL))

export let db: IDB

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

function numFinalizedIdx(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / IDX_PACK_SIZE) : 0
}

function packIdx(chronIdx: number): number {
   return Math.min(Math.floor(chronIdx / IDX_PACK_SIZE), idxPacks.length - 1)
}

export function getSubId(chronIdx: number): number {
   const n = packIdx(chronIdx)
   const subIds = idxPacks[n].parse().subIds
   return subIds[chronIdx - n * IDX_PACK_SIZE]
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

export function countLeft(chronIdx: number, subs: Map<number, number>): number {
   const n = packIdx(chronIdx)
   return idxPacks[n].countLeft(chronIdx, subs)
}

export function findLeft(from: number, floor: number, subs: Map<number, number>): number {
   if (from < floor || idxPacks.length === 0) return -1
   for (let p = packIdx(from); p >= 0; p--) {
      const found = idxPacks[p].findLeft(from, floor, subs)
      if (found !== -1) return found
      if (p * IDX_PACK_SIZE <= floor) return -1
   }
   return -1
}

export function findRight(from: number, subs: Map<number, number>): number {
   const end = db.total_art - 1
   if (from > end || idxPacks.length === 0) return -1
   for (let p = packIdx(from); p < idxPacks.length; p++) {
      const found = idxPacks[p].findRight(from, end, subs)
      if (found !== -1) return found
   }
   return -1
}

function getPackRef(chronIdx: number): { packId: number; offset: number } {
   const n = packIdx(chronIdx)
   const bounds = idxPacks[n].parse().bounds
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
function activeSubs(): ISub[] {
   if (activeSubsCache) return activeSubsCache
   activeSubsCache = Object.values(db.subscriptions)
      .filter((sub) => sub.total_art > 0)
      .sort((a, b) => (a.title < b.title ? -1 : 1))
   return activeSubsCache
}

export function groupSubsByTag(): { tagged: Map<string, ISub[]>; sortedTags: string[]; untagged: ISub[] } {
   const tagged = new Map<string, ISub[]>()
   const untagged: ISub[] = []
   for (const sub of activeSubs()) {
      if (sub.tag) {
         let group = tagged.get(sub.tag)
         if (!group) {
            group = []
            tagged.set(sub.tag, group)
         }
         group.push(sub)
      } else {
         untagged.push(sub)
      }
   }
   return { tagged, sortedTags: Array.from(tagged.keys()).sort(), untagged }
}
