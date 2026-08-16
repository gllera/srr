const { readConfigYaml, parseKey } = require("./srr-config")

// The CDN base every store key resolves against in the built bundle. Precedence
// mirrors the backend's flag/env/config order: $SRR_CDN_URL (explicit override)
// → `cdn-url:` from the active config → "." (relative: no cdn-url means the
// store sits next to index.html, so PACK_BASE resolves to the bundle's own
// directory via base.ts's `new URL(".", window.location.href)` — the bundle
// renders AND fetches packs from any store root it's installed into). The dev
// pack server does NOT rely on this fallback: `serve` (package.json) sets
// SRR_CDN_URL=http://localhost:3000 explicitly, which the env check below wins.
//
// Normalized with a trailing slash HERE, in the producer. A store base is a
// DIRECTORY, and every consumer that treats it as one was re-deriving that:
// the preload injector appended the slash itself, the SW and mounts.ts each
// normalize theirs — while base.ts's `new URL(SRR_CDN_URL, location)` did not,
// so a configured `cdn-url: https://cdn/store` had the app fetching
// https://cdn/db.gz while the preload from this same resolver warmed
// https://cdn/store/db.gz. Byte-identical for every slash-safe value ("." → "./",
// an origin, an already-slashed prefix) — it only settles the path-carrying case
// the two halves disagreed about.
function resolve() {
   const raw = process.env.SRR_CDN_URL || parseKey(readConfigYaml(), "cdn-url") || "."
   return raw.endsWith("/") ? raw : raw + "/"
}

// A value, not a thunk: Node's module cache already resolves this exactly once,
// so the memoizing wrapper only made both consumers LOOK like they did work.
module.exports = resolve()
