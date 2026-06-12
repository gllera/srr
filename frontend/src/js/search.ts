// Title search over the search/ pack series (design: docs/search-design.md).
// Shards align 1:1 with idx packs: finalized search/<n>.gz =
// bloom[SEARCH_BLOOM_BYTES] ‖ JSONL, the latest search/L<seq>.gz tail is
// JSONL only (always scanned), and search/s<srch>.gz concatenates the
// finalized blooms so a query fetches only shards that can match. Matching is
// AND of folded substring tests per query word — the blooms only prune
// (false positives cost one shard fetch; false negatives are impossible), so
// the Go/TS folding parity below is a recall optimization, not a correctness
// gate, except for the query side which only ever folds in TS.
import { makeLRU } from "./cache"
import * as data from "./data"
import { IDX_PACK_SIZE, SEARCH_BLOOM_BYTES, SEARCH_BLOOM_K, SEARCH_GRAM, type ISearchEntryWire } from "./format.gen"

// One search result: the shard entry plus its global position (chron =
// shard base + line index; the existing nav addressing takes over from here).
export interface ISearchHit {
   chron: number
   s: number
   w: number
   t: string
}

function numFinalized(): number {
   return data.db.total_art > 0 ? Math.floor((data.db.total_art - 1) / IDX_PACK_SIZE) : 0
}

// The hdrs-style coverage gate: the backend publishes srch only after every
// shard + summary save succeeded, so equality with the finalized count means
// the whole series is consistent with this db.gz. The srcht>0 leg
// distinguishes a small store written by a search-aware backend (tail
// published, no finalized shards yet) from a pre-search store where both
// fields are absent.
export function available(): boolean {
   if (data.db.total_art === 0) return false
   const srch = data.db.srch ?? 0
   return srch === numFinalized() && (srch > 0 || (data.db.srcht ?? 0) > 0)
}

// fold mirrors the backend's foldSearchText (db_search.go) byte-for-byte —
// the parity is enforced by the e2e contract test. NFD before lowercasing
// neutralizes the Go-simple vs JS-full case-mapping divergences (İ, ẞ); ς→σ
// patches JS's context-sensitive final sigma; everything that isn't a letter
// or number separates words.
const KEEP = /^[\p{L}\p{N}]+$/u
export function fold(s: string): string {
   let out = ""
   let pending = false
   for (let r of s.normalize("NFD")) {
      if (/\p{Mn}/u.test(r)) continue
      r = r.toLowerCase()
      if (r === "ς") r = "σ"
      if (!KEEP.test(r)) {
         pending = out.length > 0
         continue
      }
      if (pending) {
         out += " "
         pending = false
      }
      out += r
   }
   return out
}

// wordGrams mirrors eachSearchGram for a single folded word: SEARCH_GRAM-rune
// sliding windows, never spanning word gaps.
function wordGrams(word: string): string[] {
   const runes = [...word]
   const out: string[] = []
   for (let i = 0; i + SEARCH_GRAM <= runes.length; i++) out.push(runes.slice(i, i + SEARCH_GRAM).join(""))
   return out
}

// bloomBits mirrors db_search.go bloomBits: FNV-1a-64 over the gram's UTF-8
// bytes, double-hashed as h1=low32 / h2=high32|1. The Go side reduces probe
// indices with uint32 wraparound then a power-of-two mask; 2^32 is a multiple
// of the bit count, so plain exact-integer % here lands on the same bits.
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn
const utf8 = new TextEncoder()
export function bloomBits(gram: string): number[] {
   let h = FNV_OFFSET
   for (const b of utf8.encode(gram)) {
      h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK64
   }
   const h1 = Number(h & 0xffffffffn)
   const h2 = Number(((h >> 32n) & 0xffffffffn) | 1n)
   const out: number[] = []
   for (let i = 0; i < SEARCH_BLOOM_K; i++) out.push((h1 + i * h2) % (SEARCH_BLOOM_BYTES * 8))
   return out
}

function bloomHas(blooms: Uint8Array, shardOff: number, gram: string): boolean {
   for (const bit of bloomBits(gram)) {
      if ((blooms[shardOff + (bit >> 3)] & (1 << (bit & 7))) === 0) return false
   }
   return true
}

interface Shard {
   entries: ISearchEntryWire[]
   folded: string[] // fold(entry.t), computed once at parse
}

function parseShard(buf: ArrayBuffer, skipBloom: boolean): Shard {
   const bytes = skipBloom ? new Uint8Array(buf, SEARCH_BLOOM_BYTES) : new Uint8Array(buf)
   const entries: ISearchEntryWire[] = []
   const folded: string[] = []
   for (const line of new TextDecoder().decode(bytes).split("\n")) {
      if (!line) continue
      const e = JSON.parse(line) as ISearchEntryWire
      entries.push(e)
      folded.push(fold(e.t ?? ""))
   }
   return { entries, folded }
}

// Everything below is lazy: nothing is fetched until the first query, so
// boot stays O(1). All three loaders follow data.ts's retry discipline —
// a rejected promise clears its slot so the next query refetches.

let summarySlot: Promise<Uint8Array> | null = null
function loadSummary(): Promise<Uint8Array> {
   if (summarySlot) return summarySlot
   const nf = numFinalized()
   const promise = data.fetchPackBytes(`search/s${data.db.srch}.gz`, false).then((buf) => {
      const blooms = new Uint8Array(buf)
      if (blooms.length !== nf * SEARCH_BLOOM_BYTES)
         throw new Error(`search summary: ${blooms.length} bytes for ${nf} shards`)
      return blooms
   })
   summarySlot = promise
   promise.catch(() => {
      if (summarySlot === promise) summarySlot = null
   })
   return promise
}

let latestSlot: Promise<Shard> | null = null
function loadLatest(): Promise<Shard> {
   if (latestSlot) return latestSlot
   const promise = data.fetchPackBytes(`search/L${data.db.seq}.gz`, false).then((buf) => parseShard(buf, false))
   latestSlot = promise
   promise.catch(() => {
      if (latestSlot === promise) latestSlot = null
   })
   return promise
}

const shardCache = makeLRU<Promise<Shard>>(8)
function loadShard(n: number): Promise<Shard> {
   const cached = shardCache.get(n)
   if (cached) return cached
   const promise = data.fetchPackBytes(`search/${n}.gz`, false).then((buf) => parseShard(buf, true))
   shardCache.put(n, promise)
   promise.catch(() => {
      if (shardCache.peek(n) === promise) shardCache.drop(n)
   })
   return promise
}

function matchShard(shard: Shard, baseChron: number, words: string[]): ISearchHit[] {
   const hits: ISearchHit[] = []
   // Newest-first within the shard, like the shard order of the outer scan.
   for (let i = shard.folded.length - 1; i >= 0; i--) {
      const folded = shard.folded[i]
      if (!words.every((w) => folded.includes(w))) continue
      const e = shard.entries[i]
      hits.push({ chron: baseChron + i, s: e.s, w: e.w, t: e.t ?? "" })
   }
   return hits
}

// shortQuery reports whether q has no word long enough to feed the blooms —
// such a query can't prune shards, so search() scans only the latest tail
// (the UI shows a hint instead of silently downloading the whole archive).
export function shortQuery(q: string): boolean {
   return !fold(q)
      .split(" ")
      .some((w) => [...w].length >= SEARCH_GRAM)
}

// search yields batches of hits, newest shard first (latest tail, then
// finalized nf-1..0), one batch per shard that matched. Matching is AND of
// folded substring tests per query word; candidate shards must hold every
// gram of every bloom-sized word. A missing/broken latest tail degrades to
// finalized-only (warn); a missing summary rejects — the caller decides how
// to surface that.
export async function* search(q: string): AsyncGenerator<ISearchHit[], void, void> {
   const words = fold(q)
      .split(" ")
      .filter((w) => w.length > 0)
   if (words.length === 0) return

   try {
      const latest = await loadLatest()
      const hits = matchShard(latest, numFinalized() * IDX_PACK_SIZE, words)
      if (hits.length > 0) yield hits
   } catch (e) {
      console.warn("search: latest tail unavailable, scanning finalized shards only", e)
   }

   const nf = numFinalized()
   const grams = words.filter((w) => [...w].length >= SEARCH_GRAM).flatMap(wordGrams)
   if (nf === 0 || grams.length === 0) return

   const blooms = await loadSummary()
   for (let p = nf - 1; p >= 0; p--) {
      if (!grams.every((g) => bloomHas(blooms, p * SEARCH_BLOOM_BYTES, g))) continue
      const hits = matchShard(await loadShard(p), p * IDX_PACK_SIZE, words)
      if (hits.length > 0) yield hits
   }
}
