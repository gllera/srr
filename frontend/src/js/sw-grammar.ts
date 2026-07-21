// Pure pack-name grammar shared by the service worker (sw.ts) and its unit
// tests. Extracted from sw.ts so it can be imported WITHOUT the worker global
// scope (sw.ts's `self`/`registration` access) — that module-load dependency on
// `sw.registration.scope` is what previously made this grammar untestable and
// forced hand-copied regexes in the tests. The reader side of the pack-name
// contract is now verified in `make verify` like the writer side.
//
// Built from the generated PACK_SERIES_KINDS table (backend store.PackSeries),
// strict per-series exactly like the store's packKeyRe: a kind letter another
// series owns (e.g. data/h3.gz) is NOT a pack name.
import { PACK_SERIES_KINDS } from "./format.gen"

// Content-hash assets: assets/<2hex>/<16hex><ext>. Matched anywhere in the path
// so it holds whatever prefix the cdn-url adds.
export const RE_ASSET = /\/assets\/[0-9a-f]{2}\/[0-9a-f]{16}(?:\.\w+)?$/i

// The one object-name grammar: write-once names only. Every stem is an OPAQUE
// bare digit run — the kind letters were retired with the derived names — but
// the table still drives the letter class, so a future series that wants one
// needs no change here. parsePackName then rejects a kind another series does
// not own. An object is matched by its <series>/<stem>.gz SUFFIX, not a fixed
// /packs/ prefix (like RE_ASSET above): the self-hosted bundle (cdn-url=".")
// serves packs at the deployment root — e.g. /srr/idx/0.gz — so requiring
// /packs/ silently disabled all pack caching there.
const PACK_KINDS = [...new Set(Object.values(PACK_SERIES_KINDS).join(""))].join("")
const KIND_CLASS = PACK_KINDS ? `[${PACK_KINDS}]?` : ""
export const RE_PACK = new RegExp(`/(${Object.keys(PACK_SERIES_KINDS).join("|")})/(${KIND_CLASS})(\\d+)\\.gz$`)
export const RE_DB = /\/db\.gz$/ // the store's only mutable key (any store root, not just /packs/)
export const RE_SHELL_HASHED = /\.[0-9a-f]{8,}\.(?:js|css)$/i // Parcel content-hashed bundles

// parsePackName decodes an object path: the series, the (now always empty)
// stem kind, and the numeric stem. Strict per-series. Returns null for any
// non-object path. The fetch route, the cache bound, and the manifest
// reconciliation all consume this one grammar.
export function parsePackName(path: string): { series: string; kind: string; n: number } | null {
   const m = RE_PACK.exec(path)
   if (!m || !PACK_SERIES_KINDS[m[1]].includes(m[2])) return null
   return { series: m[1], kind: m[2].toLowerCase(), n: Number(m[3]) }
}
