// Boot smoke: assert the PRODUCTION bundle would actually boot — the gap that
// let a dead build pass `make verify` and ship.
//
// The build-time define transformer (parcel/transformer-define.js) must
// substitute SRR_CDN_URL and process.env.NODE_ENV with string literals in the
// emitted JS. Parcel 2.16.4 once silently dropped both (it tree-shook the
// side-effect-only runtime entry and left process.env un-inlined), so the
// deployed app threw "SRR_CDN_URL is not defined" / "process is not defined" on
// boot and never rendered — while lint, format, unit tests and `parcel build`
// all stayed green. This is the cheap, Chrome-free guard that closes that gap:
// if either bare token survives into the entry bundle, the boot is dead.
//
// We check only the bundle index.html actually loads (Parcel doesn't clean
// dist/, so orphaned bundles from earlier builds accumulate and must be
// ignored). Runs after build-fe (Makefile `smoke-fe`, in verify-fe); npm runs
// it in frontend/, so the build output is one level up at ../dist/srrf.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIST = join(process.cwd(), "..", "dist", "srrf")
const indexPath = join(DIST, "index.html")

let html
try {
   html = readFileSync(indexPath, "utf8")
} catch {
   console.error(`boot-smoke: no build output at ${indexPath} — run 'make build-fe' first`)
   process.exit(1)
}

// The .js bundles index.html loads via <script src=…> (quotes optional — Parcel
// minifies them away). Basenames only; checking just these skips stale orphans.
const refs = [...new Set([...html.matchAll(/\bsrc=["']?([^"'\s>]+\.js)/g)].map((m) => m[1].split("/").pop()))]
if (refs.length === 0) {
   console.error(`boot-smoke: ${indexPath} loads no .js bundle — build looks broken`)
   process.exit(1)
}

// Bare tokens that MUST have been replaced by literals at build time. Their
// survival means the define transformer didn't run on that asset.
const FORBIDDEN = [
   ["SRR_CDN_URL", "CDN base global was not inlined — boot throws ReferenceError"],
   ["process.env.NODE_ENV", "NODE_ENV was not inlined — boot throws 'process is not defined'"],
]

let failed = false
for (const ref of refs) {
   const file = join(DIST, ref)
   if (!existsSync(file)) {
      console.error(`boot-smoke: index.html loads ${ref}, but it is missing from the build`)
      failed = true
      continue
   }
   const code = readFileSync(file, "utf8")
   for (const [token, why] of FORBIDDEN) {
      if (code.includes(token)) {
         console.error(`boot-smoke: ${ref} still references \`${token}\` — ${why}`)
         failed = true
      }
   }
}

if (failed) process.exit(1)
console.log(`boot-smoke: OK — ${refs.length} loaded bundle(s) inlined all build-time defines`)
