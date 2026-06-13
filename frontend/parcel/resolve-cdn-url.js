const { readConfigYaml, parseKey } = require("./srr-config")

// The CDN base every store key resolves against in the built bundle. Precedence
// mirrors the backend's flag/env/config order: $SRR_CDN_URL (explicit override)
// → `cdn-url:` from the active config → http://localhost:3000 (the dev pack
// server's default — see resolve-store.js / package.json `servep`).
function resolve() {
   if (process.env.SRR_CDN_URL) return process.env.SRR_CDN_URL
   return parseKey(readConfigYaml(), "cdn-url") || "http://localhost:3000"
}

const cached = resolve()
module.exports = () => cached
