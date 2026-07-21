// The store's object names — the ONE place a pack key is built.
//
// docs/MANIFEST-SPEC.md §4.5 ("names are listed, never derived") splits the
// reader in two:
//
//   • a LEGACY root (today's full db.gz) DERIVES every key from counters —
//     seq/nd (the tail generation), next_pid (finalized data packs), hdrs, mp;
//   • a MANIFEST root ({v, m, t}) reads them from `manifest/<m>.gz`, which
//     LISTS every live object explicitly, per series, positionally.
//
// Both shapes are resolved into the same StoreNames here, so every fetch site
// in data.ts/search.ts indexes one array and neither knows nor cares which
// root it came from. That is what makes S34's root cutover a no-op for an
// already-deployed S33 reader.
//
// §4.6 constraint, honored: nothing below assumes there are exactly three
// series, that idx and meta are distinct, or that a stride is a particular
// number. The manifest's `names` object is parsed as a flat map and series are
// looked up BY NAME, so a future merged idx+meta series (ARC6) is a
// manifest-shape change and nothing else.
import { IDX_PACK_SIZE, type IFeedWire, type IMetaWire } from "./format.gen"

// The manifest root's version — the value a v2 root and a manifest body both
// stamp in `v` (docs/MANIFEST-SPEC.md §4.1/§4.2, backend `manifestVersion`).
//
// Deliberately NOT generated: `gen-ts` emits DB_FORMAT_VERSION, which is what
// the current WRITER stamps on db.gz (1 until the S34 cutover). This reader
// already parses the v2 root that cutover will emit — reader-first deploy
// discipline (§11 step 2) requires exactly that asymmetry, so the two numbers
// cannot be one constant until S34 bumps dbFormatVersion to 2.
export const MANIFEST_ROOT_VERSION = 2

// --- manifest wire shapes -------------------------------------------------
//
// Hand-mirrored from backend/manifest.go (Manifest, ManifestNames,
// SeriesNames, SummaryName). `srr gen-ts` does not emit them yet — the
// manifest is not part of the writer↔reader contract until S34 makes it the
// only root — so keep these in sync with backend/manifest.go by hand until it
// does.

// One pack series' positional name list. Runs are RLE'd over BARE stems:
// `[[firstStem, count], …]`, resolved as `<series>/<stem>.gz`. `b` is the
// positional index of the first run's first entry (0 for idx/meta, 1 for data
// — the writer has always skipped data/0). `t` is the S32 deviation: the
// current tail pack still carries its legacy kind-lettered name
// (idx|data|meta/L<tailGen>.gz), which has no bare-stem form, and occupies the
// one position immediately after the last run. It disappears at S34 with the
// kind letters it exists to express.
export interface ISeriesNamesWire {
   b?: number
   r?: [number, number][]
   t?: string
}

// A derived summary object: its key plus the count of finalized packs it
// covers. `covers` rides next to the name so S34 can drop the count from the
// name without a redesign.
export interface ISummaryNameWire {
   key: string
   covers: number
}

export interface IManifestWire {
   v: number
   m: number
   fetched_at: number
   total_art: number
   mt?: number
   na?: number
   head?: IMetaWire[]
   hb?: number
   pack_off?: number
   // Series rows keyed by series name, flattened next to the singletons
   // ("deltas", "seen", "hsum", "ssum") — parsed generically, see above.
   names: Record<string, unknown>
   feeds: Record<number, IFeedWire> | null
}

// --- resolved names -------------------------------------------------------

export interface SeriesList {
   // keys[i] names the object holding this series' i-th stride region. Slots
   // below the series' base (data/0, which the writer never produced) are "".
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
   // The live delta chain, oldest first (the data series' `d` kind today).
   deltas: string[]
   // The idx header summary and the meta bloom summary; null when the store
   // publishes none.
   hsum: SummaryRef | null
   ssum: SummaryRef | null
}

const EMPTY_SERIES = (): SeriesList => ({ keys: [], tail: -1 })

// Resolve one positional slot, failing loudly rather than misaddressing: under
// the manifest model a name is LISTED, so an absent slot means the counters
// the reader navigates by and the names the store published disagree. There is
// deliberately no computed-name fallback (§4.5) — two ways to learn a name
// means two truths that can disagree, and every disagreement is a 404 storm.
export function keyAt(list: SeriesList, i: number, what: string): string {
   const key = list.keys[i]
   if (!key) throw new Error(`${what}: the store names no object at position ${i} (${list.keys.length} listed)`)
   return key
}

// expandSeries turns one RLE'd positional list into index→key.
export function expandSeries(s: ISeriesNamesWire, series: string): SeriesList {
   const keys: string[] = []
   for (let i = 0; i < (s.b ?? 0); i++) keys.push("") // positions below the base are not part of this series
   for (const run of s.r ?? []) {
      const [first, count] = run
      for (let i = 0; i < count; i++) keys.push(`${series}/${first + i}.gz`)
   }
   let tail = -1
   if (s.t) {
      tail = keys.length
      keys.push(s.t)
   }
   return { keys, tail }
}

// manifestNames reads the names a manifest LISTS. Series are looked up by name
// out of the flat `names` map (§4.6): a series the manifest does not carry
// resolves to an empty list rather than throwing, so the reader's own coverage
// gates (metaReady, the tcEntries>0 test) decide what that means.
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
      return row && typeof row.key === "string" ? { key: row.key, covers: row.covers ?? 0 } : null
   }
   return {
      idx: series("idx"),
      data: series("data"),
      meta: series("meta"),
      deltas: Array.isArray(raw.deltas) ? (raw.deltas as string[]) : [],
      hsum: summary("hsum"),
      ssum: summary("ssum"),
   }
}

// The counters a legacy root derives its names from.
export interface LegacyRoot {
   total_art: number
   seq: number
   nd?: number
   na?: number
   next_pid: number
   hdrs?: number
   mp?: number
}

// legacyNames rebuilds today's derived names verbatim — the same strings this
// reader has always fetched, so a legacy-complete root behaves byte-for-byte
// as it did before the dual path existed.
//
// Tail placement mirrors the writer exactly: with a consolidated tail
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
   const data: SeriesList = { keys: [""], tail: -1 } // data/0 was never written
   for (let id = 1; id < r.next_pid; id++) data.keys.push(`data/${id}.gz`)
   const meta = EMPTY_SERIES()
   for (let n = 0; n < mp; n++) meta.keys.push(`meta/${n}.gz`)

   if (tc > 0) {
      // The meta tail is named on tc alone — NOT on the exact-coverage test the
      // manifest writer applies — because that is what this reader has always
      // done: every meta read is gated upstream by metaReady(), which is false
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
