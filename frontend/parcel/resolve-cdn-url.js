const { readConfigYaml, parseKey } = require("./srr-config")

// The CDN base every store key resolves against in the built bundle. Precedence
// mirrors the backend's flag/env/config order: $SRR_CDN_URL (explicit override)
// → `cdn-url:` from the active config → "." (relative: no cdn-url means the
// store sits next to index.html, so PACK_BASE resolves to the bundle's own
// directory via base.ts's `new URL(".", window.location.href)` — the bundle
// renders AND fetches packs from any store root it's installed into). The dev
// pack server does NOT rely on this fallback: `serve` (package.json) sets
// SRR_CDN_URL=http://localhost:3000 explicitly, which the env check below wins.
function resolve() {
   if (process.env.SRR_CDN_URL) return process.env.SRR_CDN_URL
   return parseKey(readConfigYaml(), "cdn-url") || "."
}

const cached = resolve()
module.exports = () => cached
