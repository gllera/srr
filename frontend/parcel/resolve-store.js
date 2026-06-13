// Resolves the local pack directory the dev pack server (package.json `servep`)
// should serve, from the active SRR storage configuration. Precedence mirrors
// the backend (backend/main.go): $SRR_STORE → `store:` from the active config
// → ../packs (the conventional dev location). Prints the directory to stdout so
// the npm script can do: serve --cors "$(node parcel/resolve-store.js)".
//
// Only a local-filesystem store has a directory to serve. An s3://… / sftp://…
// store, a missing config, or a configured path that doesn't exist all fall
// back to ../packs with a one-line note on stderr (kept off stdout so the
// command substitution stays clean). Pair with SRR_CONFIG to pick a store:
//   SRR_CONFIG=~/.config/srr/srr.tmp.yaml make dev-fe   # serve the dev store
const { existsSync } = require("fs")
const { resolve: resolvePath } = require("path")

const { readConfigYaml, parseKey } = require("./srr-config")

const FALLBACK = "../packs"

function fallback(reason) {
   process.stderr.write(`[dev] ${reason} — serving ${FALLBACK} instead.\n`)
   process.stdout.write(FALLBACK)
}

const raw = process.env.SRR_STORE || parseKey(readConfigYaml(), "store")

if (!raw) {
   fallback("no SRR_STORE or store: in config")
} else {
   // A bare path is the local backend (empty URL scheme); file:// is local too.
   // Anything with another scheme (s3://, sftp://) has no local directory.
   const scheme = (raw.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1]?.toLowerCase()
   if (scheme && scheme !== "file") {
      fallback(`store is a ${scheme}:// backend with no local directory`)
   } else {
      const dir = raw.replace(/^file:\/\//i, "") // no-op when there's no scheme
      if (existsSync(dir)) process.stdout.write(resolvePath(dir))
      else fallback(`configured store ${dir} does not exist`)
   }
}
