import { makeLRU } from "./cache"
import { IDX_PACK_SIZE, makeIdxPack, type IdxPack } from "./idx"

export { IDX_PACK_SIZE }

const DB_URL = new URL(SRR_CDN_URL, window.location.href)
// Reuses the browser's preloaded response from <link rel="preload"> in the built HTML
const dbFetch = fetch(new URL("db.gz", DB_URL))

export let db: IDB

let idxPacks: IdxPack[] = []

export async function init() {
   const res = await dbFetch
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.channels ??= {}
   for (const [k, ch] of Object.entries(raw.channels)) ch.id = Number(k)
   db = raw

   if (db.total_art === 0) return

   const nf = numFinalizedIdx()

   idxPacks = await Promise.all(
      Array.from({ length: nf + 1 }, (_, p) => {
         const isFinalized = p < nf
         const path = `idx/${isFinalized ? p.toString() : String(db.data_tog)}.gz`
         const size = isFinalized ? IDX_PACK_SIZE : db.total_art - p * IDX_PACK_SIZE
         const url = new URL(path, DB_URL)
         const opts: RequestInit = {}
         if (isFinalized) opts.cache = "force-cache"
         return fetch(url, opts)
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

export function getChannelId(chronIdx: number): number {
   const n = packIdx(chronIdx)
   const chanIds = idxPacks[n].parse().chanIds
   return chanIds[chronIdx - n * IDX_PACK_SIZE]
}

// Binary search for leftmost entry where fetchedAt >= ts.
export function findChronForTimestamp(ts: number): number {
   const tsBlocks = Math.trunc(ts / 28800) - Math.trunc(db.first_fetched / 28800)
   let lo = 0
   let hi = db.total_art
   while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const n = packIdx(mid)
      const p = idxPacks[n].parse()
      if (p.fetchedAts[mid - n * IDX_PACK_SIZE] < tsBlocks) lo = mid + 1
      else hi = mid
   }
   return lo < db.total_art ? lo : Math.max(0, db.total_art - 1)
}

export function countLeft(chronIdx: number, channels: Map<number, number>): number {
   if (idxPacks.length === 0) return 0
   const n = packIdx(chronIdx)
   return idxPacks[n].countLeft(chronIdx, channels)
}

export function findLeft(from: number, channels: Map<number, number>): number {
   if (from < 0 || idxPacks.length === 0) return -1
   for (let p = packIdx(from); p >= 0; p--) {
      const found = idxPacks[p].findLeft(from, channels)
      if (found !== -1) return found
   }
   return -1
}

export function findRight(from: number, channels: Map<number, number>): number {
   if (from < 0) from = 0
   if (from >= db.total_art || idxPacks.length === 0) return -1
   for (let p = packIdx(from); p < idxPacks.length; p++) {
      const found = idxPacks[p].findRight(from, channels)
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

const dataCache = makeLRU<Promise<IArticle[]>>(20)

function loadDataPack(packId: number): Promise<IArticle[]> {
   const cached = dataCache.get(packId)
   if (cached) return cached
   const entries = fetchDataPack(packId)
   dataCache.put(packId, entries)
   entries.catch(() => {
      if (dataCache.peek(packId) === entries) dataCache.drop(packId)
   })
   return entries
}

async function fetchDataPack(packId: number): Promise<IArticle[]> {
   const isFinalized = packId < db.next_pid
   const name = isFinalized ? packId.toString() : String(db.data_tog)
   const opts: RequestInit = {}
   if (isFinalized) opts.cache = "force-cache"
   const res = await fetch(new URL(`data/${name}.gz`, DB_URL), opts)
   const reader = res
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream())
      .getReader()
   try {
      const entries: IArticle[] = []
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
      return entries
   } finally {
      reader.cancel().catch(() => {})
   }
}

export async function loadArticle(chronIdx: number): Promise<IArticle> {
   const ref = getPackRef(chronIdx)
   const entries = await loadDataPack(ref.packId)
   if (ref.offset >= entries.length) {
      // Backend cron may have rewritten the pack; drop the cache so a retry refetches.
      dataCache.drop(ref.packId)
      throw new Error(`pack ${ref.packId} out of sync (offset ${ref.offset} of ${entries.length}); retry to refresh`)
   }
   return entries[ref.offset]
}

let activeChannelsCache: IChannel[] | null = null
function activeChannels(): IChannel[] {
   if (activeChannelsCache) return activeChannelsCache
   activeChannelsCache = Object.values(db.channels)
      .filter((ch) => ch.total_art > 0)
      .sort((a, b) => (a.title < b.title ? -1 : 1))
   return activeChannelsCache
}

type GroupResult = { tagged: Map<string, IChannel[]>; sortedTags: string[]; untagged: IChannel[] }
let groupCache: GroupResult | null = null

export function groupChannelsByTag(): GroupResult {
   if (groupCache) return groupCache
   const tagged = new Map<string, IChannel[]>()
   const untagged: IChannel[] = []
   for (const ch of activeChannels()) {
      if (ch.tag) {
         let group = tagged.get(ch.tag)
         if (!group) {
            group = []
            tagged.set(ch.tag, group)
         }
         group.push(ch)
      } else {
         untagged.push(ch)
      }
   }
   groupCache = { tagged, sortedTags: Array.from(tagged.keys()).sort(), untagged }
   return groupCache
}
