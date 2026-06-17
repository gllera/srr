// Title search over the meta/ pack series (design: docs/search-design.md).
// Shards align 1:1 with idx packs (5,000 entries per meta shard):
// finalized meta/<n>.gz = bloom[SEARCH_BLOOM_BYTES] ‖ JSONL, the latest
// meta/L<seq>.gz tail is JSONL only (always scanned), and meta/s<mp>.gz
// concatenates the finalized blooms so a query fetches only shards that can
// match. Matching is AND of folded substring tests per query word — the blooms
// only prune (false positives cost one shard fetch; false negatives are
// impossible), so the Go/TS folding parity below is a recall optimization,
// not a correctness gate, except for the query side which only ever folds in TS.
import { cachedPromise, lazySlot, makeLRU } from "./cache"
import * as data from "./data"
import { META_PACK_SIZE, SEARCH_BLOOM_BYTES, SEARCH_BLOOM_K, SEARCH_GRAM, type IMetaWire } from "./format.gen"

// One search result: the shard entry plus its global position (chron =
// shard base + line index; the existing nav addressing takes over from here).
export interface ISearchHit {
   chron: number
   f: number
   w: number
   t: string
}

// The hdrs-style coverage gate: the backend publishes mp only after every
// meta shard + summary save succeeded, so metaReady() checks that mp and mt
// fully cover the store — meaning every meta shard (finalized + tail) is
// present and consistent with this db.gz.
export function available(): boolean {
   return data.metaReady()
}

// fold mirrors the backend's foldSearchText (db_search.go) byte-for-byte —
// the parity is enforced by the e2e contract test. Whole-string passes (a
// shard parse folds 50k titles, so per-rune regex calls add up): NFD before
// lowercasing neutralizes the Go-simple vs JS-full case-mapping divergences
// (İ, ẞ); ς→σ patches JS's only other context-sensitive mapping, the final
// sigma toLowerCase produces; everything that isn't a letter or number
// separates words, single-space joined.
const SEP = /[^\p{L}\p{N}]+/u
const MARKS = /\p{Mn}+/gu
export function fold(s: string): string {
   return s
      .normalize("NFD")
      .replace(MARKS, "")
      .toLowerCase()
      .replaceAll("ς", "σ")
      .split(SEP)
      .filter((w) => w.length > 0)
      .join(" ")
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

// bloomHas takes precomputed probe indices (one bloomBits result) so a query
// hashes each gram once, not once per scanned shard.
function bloomHas(blooms: Uint8Array, shardOff: number, bits: number[]): boolean {
   for (const bit of bits) {
      if ((blooms[shardOff + (bit >> 3)] & (1 << (bit & 7))) === 0) return false
   }
   return true
}

interface Shard {
   entries: IMetaWire[]
   folded: string[] // fold(entry.t), computed once at parse
}

function parseShard(buf: ArrayBuffer, skipBloom: boolean): Shard {
   const sliced = skipBloom ? buf.slice(SEARCH_BLOOM_BYTES) : buf
   const entries = data.parseJsonl<IMetaWire>(sliced)
   const folded = entries.map((e) => fold(e.t ?? ""))
   return { entries, folded }
}

// Everything below is lazy: nothing is fetched until the first query, so
// boot stays O(1). All three loaders follow data.ts's retry discipline —
// a rejected promise clears its slot so the next query refetches.

const loadSummary = lazySlot(async () => {
   const nf = data.numFinalizedMeta()
   const blooms = new Uint8Array(await data.fetchPackBytes(`meta/s${data.db.mp}.gz`, false))
   if (blooms.length !== nf * SEARCH_BLOOM_BYTES)
      throw new Error(`meta summary: ${blooms.length} bytes for ${nf} shards`)
   return blooms
})

const loadLatest = lazySlot(() =>
   data.fetchPackBytes(`meta/L${data.db.seq}.gz`, false).then((buf) => parseShard(buf, false)),
)

const shardCache = makeLRU<Promise<Shard>>(8)
function loadShard(n: number): Promise<Shard> {
   return cachedPromise(shardCache, n, () =>
      data.fetchPackBytes(`meta/${n}.gz`, false).then((buf) => parseShard(buf, true)),
   )
}

type Accept = (s: number, chron: number) => boolean

function matchShard(shard: Shard, baseChron: number, words: string[], max: number, accept: Accept): ISearchHit[] {
   const hits: ISearchHit[] = []
   // Newest-first within the shard, like the shard order of the outer scan —
   // and only accepted hits count toward `max`, so the first `max` collected
   // are exactly the `max` the consumer keeps (a frequent word against a full
   // shard would otherwise build tens of thousands of hit objects per
   // keystroke just to be discarded).
   for (let i = shard.folded.length - 1; i >= 0 && hits.length < max; i--) {
      const folded = shard.folded[i]
      if (!words.every((w) => folded.includes(w))) continue
      const e = shard.entries[i]
      const chron = baseChron + i
      if (!accept(e.f, chron)) continue
      hits.push({ chron, f: e.f, w: e.w, t: e.t ?? "" })
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
// finalized nf-1..0), one batch per shard that matched, stopping once
// `limit` hits passed `accept` — the caller's filter, applied here so the
// cap counts only hits the caller keeps. Matching is AND of folded substring
// tests per query word; candidate shards must hold every gram of every
// bloom-sized word. A missing/broken latest tail degrades to finalized-only
// (warn); a missing summary rejects — the caller decides how to surface
// that.
export async function* search(
   q: string,
   limit = Infinity,
   accept: Accept = () => true,
): AsyncGenerator<ISearchHit[], void, void> {
   const words = fold(q)
      .split(" ")
      .filter((w) => w.length > 0)
   if (words.length === 0) return

   const nf = data.numFinalizedMeta()
   // wordGrams already yields nothing for words shorter than SEARCH_GRAM.
   const gramBits = words.flatMap(wordGrams).map(bloomBits)
   // Kick the summary fetch off before the latest tail is awaited: the two
   // are independent, so the first query of a session overlaps their round
   // trips (lazySlot caches both afterwards; its catch keeps an early return
   // from leaving the rejection unhandled).
   const summary = nf > 0 && gramBits.length > 0 ? loadSummary() : null
   let remaining = limit

   try {
      const latest = await loadLatest()
      const hits = matchShard(latest, nf * META_PACK_SIZE, words, remaining, accept)
      remaining -= hits.length
      if (hits.length > 0) yield hits
   } catch (e) {
      console.warn("search: latest tail unavailable, scanning finalized shards only", e)
   }

   if (!summary || remaining <= 0) return
   const blooms = await summary
   for (let p = nf - 1; p >= 0 && remaining > 0; p--) {
      if (!gramBits.every((bits) => bloomHas(blooms, p * SEARCH_BLOOM_BYTES, bits))) continue
      const hits = matchShard(await loadShard(p), p * META_PACK_SIZE, words, remaining, accept)
      remaining -= hits.length
      if (hits.length > 0) yield hits
   }
}
