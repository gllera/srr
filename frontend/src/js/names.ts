// The store's object names — the ONE place a pack key is built.
//
// docs/MANIFEST-SPEC.md §4.5 ("names are listed, never derived"): the root
// db.gz is a ~60-byte pointer `{v, m, t}` and `manifest/<m>.gz` LISTS every
// live object explicitly, per series, positionally. Stems are OPAQUE — drawn
// from a per-series counter that is never reused — so `idx/812.gz` means
// "idx-series object #812" and nothing else; the ordered list says which chron
// region it holds. Nothing here reconstructs a name from a count.
//
// A LEGACY root (a store no post-cutover writer has committed yet — its first
// locked session migrates it) still carries the old counters, so `legacyNames`
// keeps deriving today's keys from them. That branch is the graceful
// degradation half of the version handshake, not a second naming model: it
// resolves into the same StoreNames every fetch site indexes.
//
// §4.6 constraint, honored: nothing below assumes there are exactly three
// series, that idx and meta are distinct, or that a stride is a particular
// number. The manifest's `names` object is parsed as a flat map and series are
// looked up BY NAME, so a future merged idx+meta series (ARC6) is a
// manifest-shape change and nothing else.
import {
   IDX_PACK_SIZE,
   type IDeltaNamesWire,
   type ISeriesNamesWire,
   type IStemRefWire,
   type ISummaryNameWire,
   type IManifestWire,
} from "./format.gen"

export type { IManifestWire }

// --- resolved names -------------------------------------------------------

export interface SeriesList {
   // keys[i] names the object holding this series' i-th stride region. Slots
   // below the series' base (data position 0, which the writer never produced)
   // are "".
   keys: string[]
   // Positional index of the write-once TAIL entry, -1 when the series has
   // none (an all-delta store never consolidated one; a meta projection whose
   // coverage is inexact never published one). The tail is the only entry the
   // backend GC can drop under a stale reader, so it is the one that takes
   // assertPackOk's guarded-reload path.
   tail: number
}

export interface SummaryRef {
   key: string
   covers: number
}

export interface StoreNames {
   idx: SeriesList
   data: SeriesList
   meta: SeriesList
   // The live delta chain, oldest first.
   deltas: string[]
   // The idx header summary and the meta bloom summary; null when the store
   // publishes none.
   hsum: SummaryRef | null
   ssum: SummaryRef | null
}

const EMPTY_SERIES = (): SeriesList => ({ keys: [], tail: -1 })

// Resolve one positional slot, failing loudly rather than misaddressing: under
// this model a name is LISTED, so an absent slot means the counters the reader
// navigates by and the names the store published disagree. There is
// deliberately no computed-name fallback (§4.5) — two ways to learn a name
// means two truths that can disagree, and every disagreement is a 404 storm.
export function keyAt(list: SeriesList, i: number, what: string): string {
   const key = list.keys[i]
   if (!key) throw new Error(`${what}: the store names no object at position ${i} (${list.keys.length} listed)`)
   return key
}

// expandSeries turns one RLE'd positional list of opaque stems into index→key.
export function expandSeries(s: ISeriesNamesWire, series: string): SeriesList {
   const keys: string[] = []
   for (let i = 0; i < (s.b ?? 0); i++) keys.push("") // positions below the base are not part of this series
   for (const run of s.r ?? []) {
      const [first, count] = run
      for (let i = 0; i < count; i++) keys.push(`${series}/${first + i}.gz`)
   }
   const tail = s.l ?? -1
   if (tail >= 0 && !keys[tail]) throw new Error(`${series}: tail position ${tail} is not listed`)
   return { keys, tail }
}

// manifestNames reads the names a manifest LISTS. Series are looked up by name
// out of the flat `names` map (§4.6): a series the manifest does not carry
// resolves to an empty list rather than throwing, so the reader's own coverage
// gates (metaReady, the tcEntries>0 test) decide what that means. Every
// singleton carries its OWN series, so nothing here hard-codes which directory
// a summary or a delta segment lives in.
export function manifestNames(man: IManifestWire): StoreNames {
   const raw = man.names
   if (!raw || typeof raw !== "object") throw new Error(`manifest ${man.m}: no names object`)
   const series = (name: string): SeriesList => {
      const row = raw[name]
      if (row === undefined || row === null) return EMPTY_SERIES()
      return expandSeries(row as ISeriesNamesWire, name)
   }
   const summary = (name: string): SummaryRef | null => {
      const row = raw[name] as ISummaryNameWire | undefined
      if (!row || typeof row.s !== "string" || typeof row.stem !== "number") return null
      return { key: stemKey(row), covers: row.covers ?? 0 }
   }
   const chain = raw.deltas as IDeltaNamesWire | undefined
   return {
      idx: series("idx"),
      data: series("data"),
      meta: series("meta"),
      deltas: (chain?.r ?? []).map((stem) => `${chain!.s}/${stem}.gz`),
      hsum: summary("hsum"),
      ssum: summary("ssum"),
   }
}

function stemKey(r: IStemRefWire | ISummaryNameWire): string {
   return `${r.s}/${r.stem}.gz`
}

// The counters a legacy (pre-cutover) root derives its names from.
export interface LegacyRoot {
   total_art: number
   seq: number
   nd?: number
   na?: number
   next_pid: number
   hdrs?: number
   mp?: number
}

// legacyNames rebuilds the pre-cutover derived names verbatim, so a store whose
// writer has not migrated it yet still reads correctly.
//
// Tail placement mirrors that writer exactly: with a consolidated tail
// (tailCovered > 0) each series' tail sits at the position immediately after
// its finalized region — idx at numFinalizedIdx (invariant I2 keeps the delta
// region inside one idx pack, so the seam never lands below that base), data
// at next_pid, meta at mp.
export function legacyNames(r: LegacyRoot): StoreNames {
   const total = r.total_art
   const tg = r.seq - (r.nd ?? 0)
   const tc = total - (r.na ?? 0)
   const nfIdx = total > 0 ? Math.floor((total - 1) / IDX_PACK_SIZE) : 0
   const mp = r.mp ?? 0
   const hdrs = r.hdrs ?? 0

   const idx = EMPTY_SERIES()
   for (let p = 0; p < nfIdx; p++) idx.keys.push(`idx/${p}.gz`)
   const data: SeriesList = { keys: [""], tail: -1 } // data position 0 was never written
   for (let id = 1; id < r.next_pid; id++) data.keys.push(`data/${id}.gz`)
   const meta = EMPTY_SERIES()
   for (let n = 0; n < mp; n++) meta.keys.push(`meta/${n}.gz`)

   if (tc > 0) {
      // The meta tail is named on tc alone — NOT on the exact-coverage test the
      // writer applied — because that is what this reader has always done:
      // every meta read is gated upstream by metaReady(), which is false
      // whenever the coverage is inexact, so the name is unreachable then and
      // the offline pin keeps pinning exactly the set it always pinned.
      for (const [list, prefix] of [
         [idx, "idx"],
         [data, "data"],
         [meta, "meta"],
      ] as const) {
         list.tail = list.keys.length
         list.keys.push(`${prefix}/L${tg}.gz`)
      }
   }

   const deltas: string[] = []
   for (let i = 0; i < (r.nd ?? 0); i++) deltas.push(`data/d${tg + 1 + i}.gz`)

   return {
      idx,
      data,
      meta,
      deltas,
      hsum: hdrs > 0 ? { key: `idx/h${hdrs}.gz`, covers: hdrs } : null,
      ssum: mp > 0 ? { key: `meta/s${mp}.gz`, covers: mp } : null,
   }
}
