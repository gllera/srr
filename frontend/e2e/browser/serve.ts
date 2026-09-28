// Browser-layer global setup: build the REAL production bundle and serve it next
// to real srr-produced packs, so Puppeteer drives the actual SPA (Parcel build,
// app.ts render, hash routing, real browser fetch/DecompressionStream).
//
// The bundle is built with a RELATIVE SRR_CDN_URL=/packs/ so the app fetches
// packs from the same origin (no CORS, no port baked into the build). One HTTP
// server (e2e/static-serve.ts) serves the built app at / and the per-run pack dir
// at /packs/. Tests write packs into packsDir (shared via the filesystem) and
// reload the page.

import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { GlobalSetupContext } from "vitest/node"

import { startStaticServer, stopStaticServer } from "../static-serve"

const execFileAsync = promisify(execFile)

declare module "vitest" {
   interface ProvidedContext {
      baseUrl: string
      packsDir: string
   }
}

export default async function setup({ provide }: GlobalSetupContext) {
   const cwd = process.cwd() // frontend/
   const appDir = resolve(cwd, "../dist/srrf") // the `build` script's --dist-dir
   const packsDir = mkdtempSync(join(tmpdir(), "srr-e2e-browser-"))

   // Build through the package.json `build` script, which owns the output-dir
   // wipe and the entry-page list; `npm run` passes this env through to Parcel.
   // Point the bundle at the same-origin /packs/ path, and force
   // NODE_ENV=production: vitest sets NODE_ENV=test on this (global-setup)
   // process, and `parcel build` keeps an already-set NODE_ENV rather than
   // forcing production — without this override app.ts's
   // `process.env.NODE_ENV === "production"` SW-registration branch is
   // dead-code-eliminated (and the dev branch that UNregisters the SW is kept),
   // so the SW never controls the page and every SW e2e times out.
   await execFileAsync("npm", ["run", "build"], {
      cwd,
      env: { ...process.env, NODE_ENV: "production", SRR_CDN_URL: "/packs/" },
   })

   const { server, baseUrl } = await startStaticServer({ appDir, packsDir })
   provide("baseUrl", `${baseUrl}/`)
   provide("packsDir", packsDir)

   return async () => {
      await stopStaticServer(server)
      rmSync(packsDir, { recursive: true, force: true })
   }
}
