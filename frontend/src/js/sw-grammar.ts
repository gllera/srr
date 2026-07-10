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

// The one pack-name grammar: write-once names only — finalized numeric stems,
// L<seq> latest generations, and the idx/h<N> / meta/s<N> summaries. The regex
// captures any kind letter on any series; parsePackName then rejects a kind
// another series does not own. A pack is matched by its <series>/<stem>.gz
// SUFFIX, not a fixed /packs/ prefix (like RE_ASSET above): the self-hosted
// bundle (cdn-url=".") serves packs at the deployment root — e.g. /srr/idx/0.gz
// — so requiring /packs/ silently disabled all pack caching there.
const PACK_KINDS = [...new Set(Object.values(PACK_SERIES_KINDS).join(""))].join("") // "Lhs"
export const RE_PACK = new RegExp(`/(${Object.keys(PACK_SERIES_KINDS).join("|")})/([${PACK_KINDS}]?)(\\d+)\\.gz$`)
export const RE_DB = /\/db\.gz$/ // the store's only mutable key (any store root, not just /packs/)
export const RE_SHELL_HASHED = /\.[0-9a-f]{8,}\.(?:js|css)$/i // Parcel content-hashed bundles

// parsePackName decodes a pack path: the series, the stem kind ("" finalized,
// "l" latest generation, "h" idx header summary, "s" search bloom summary —
// lowercased for keying), and the numeric stem. Strict per-series; a kind
// letter another series owns (data/h3.gz) is not a pack name. Returns null for
// any non-pack path. The fetch route, the cache bound, and the manifest prunes
// all consume this one grammar.
export function parsePackName(path: string): { series: string; kind: string; n: number } | null {
   const m = RE_PACK.exec(path)
   if (!m || !PACK_SERIES_KINDS[m[1]].includes(m[2])) return null
   return { series: m[1], kind: m[2].toLowerCase(), n: Number(m[3]) }
}
