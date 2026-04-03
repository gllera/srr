import { makeLRU } from "./cache"

export const PACK_SIZE = 1000

const DB_URL = new URL(SRR_CDN_URL, window.location.href)
// Reuses the browser's preloaded response from <link rel="preload"> in the built HTML
const dbFetch = fetch(new URL("db.gz", DB_URL))

export let db: IDB
export let articles: IIdxEntry[] = []
export let idxPack = -1

const idxCache = makeLRU<IIdxEntry[]>(5)
const dataCache = makeLRU<string[]>(5)

export async function init() {
   const res = await dbFetch
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.subscriptions ??= []
   raw.subs_mapped = new Map(raw.subscriptions.map((sub) => [sub.id, sub]))
   db = raw
}

// Each finalized idx pack holds exactly 1000 entries; the remainder is in the latest pack
export function numFinalizedIdx(): number {
   return db.total_art > 0 ? Math.floor((db.total_art - 1) / PACK_SIZE) : 0
}

export function latestIdxCount(): number {
   return db.total_art - numFinalizedIdx() * PACK_SIZE
}

export async function streamSplit<T>(
   path: string,
   isFinalized: boolean,
   delimiter: string,
   parseFn: (segment: string) => T,
   skipEmpty = true,
): Promise<T[]> {
   const opts: RequestInit = {}
   if (isFinalized) opts.cache = "force-cache"
   const res = await fetch(new URL(path, DB_URL), opts)
   const reader = res
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream())
      .getReader()
   const result: T[] = []
   let remainder = ""
   while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = remainder ? remainder + value : value
      remainder = ""
      let start = 0
      let idx: number
      while ((idx = chunk.indexOf(delimiter, start)) !== -1) {
         const seg = chunk.substring(start, idx)
         start = idx + 1
         if (seg || !skipEmpty) result.push(parseFn(seg))
      }
      if (start < chunk.length) remainder = chunk.substring(start)
   }
   if (remainder.length > 0) result.push(parseFn(remainder))
   return result
}

export async function loadIdxPack(pack: number) {
   if (idxPack === pack) return

   let entries = idxCache.get(pack)
   if (!entries) {
      const isFinalized = pack < numFinalizedIdx()
      entries = await streamSplit(
         `idx/${isFinalized ? pack.toString() : String(db.data_tog)}.gz`,
         isFinalized,
         "\n",
         parseTsvLine,
      )
      idxCache.put(pack, entries)
   }
   articles = entries
   idxPack = pack
}

function parseTsvLine(line: string): IIdxEntry {
   const f = line.split("\t")
   return {
      fetched_at: Number(f[0]),
      pack_id: Number(f[1]),
      pack_offset: Number(f[2]),
      sub_id: Number(f[3]),
      published: Number(f[4]),
      title: f[5],
      link: f[6],
   }
}

async function loadDataPack(id: number): Promise<string[]> {
   let entries = dataCache.get(id)
   if (!entries) {
      const isFinalized = id < db.next_pid
      const name = isFinalized ? id.toString() : String(db.data_tog)
      entries = await streamSplit(`data/${name}.gz`, isFinalized, "\x00", (s: string) => s, false)
      dataCache.put(id, entries)
   }
   return entries
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

export function getContentSync(entry: IIdxEntry): string | undefined {
   const cached = dataCache.get(entry.pack_id)
   return cached?.[entry.pack_offset]
}

export async function getContent(entry: IIdxEntry): Promise<string> {
   const entries = await loadDataPack(entry.pack_id)
   return entries[entry.pack_offset]
}
