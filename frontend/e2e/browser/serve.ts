// Browser-layer global setup: build the REAL production bundle and serve it next
// to real srrb-produced packs, so Puppeteer drives the actual SPA (Parcel build,
// app.ts render, hash routing, real browser fetch/DecompressionStream).
//
// The bundle is built with a RELATIVE SRR_CDN_URL=/packs/ so the app fetches
// packs from the same origin (no CORS, no port baked into the build). One HTTP
// server serves the built app at / and the per-run pack dir at /packs/. Tests
// write packs into packsDir (shared via the filesystem) and reload the page.

import { execFile } from "node:child_process"
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { extname, join, normalize, resolve } from "node:path"
import { promisify } from "node:util"
import type { GlobalSetupContext } from "vitest/node"

const execFileAsync = promisify(execFile)

const MIME: Record<string, string> = {
   ".html": "text/html; charset=utf-8",
   ".js": "text/javascript; charset=utf-8",
   ".mjs": "text/javascript; charset=utf-8",
   ".css": "text/css; charset=utf-8",
   ".svg": "image/svg+xml",
   ".json": "application/json",
   ".ico": "image/x-icon",
   ".gz": "application/octet-stream", // raw gzip — data.ts decompresses manually
}

declare module "vitest" {
   interface ProvidedContext {
      baseUrl: string
      packsDir: string
   }
}

export default async function setup({ provide }: GlobalSetupContext) {
   const cwd = process.cwd() // frontend/
   const appDir = resolve(cwd, "../dist/srrf") // Parcel's configured target dir
   const packsDir = mkdtempSync(join(tmpdir(), "srr-e2e-browser-"))

   // Build the real bundle pointed at the same-origin /packs/ path.
   await execFileAsync(resolve(cwd, "node_modules/.bin/parcel"), ["build", "--no-cache", "--no-source-maps"], {
      cwd,
      env: { ...process.env, SRR_CDN_URL: "/packs/" },
   })

   const serveFile = (res: import("node:http").ServerResponse, baseDir: string, rel: string) => {
      const file = join(baseDir, normalize(rel).replace(/^(\.\.([/\\]|$))+/, ""))
      if (!file.startsWith(baseDir) || !existsSync(file) || !statSync(file).isFile()) {
         res.statusCode = 404
         res.end("not found")
         return
      }
      res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream")
      createReadStream(file).pipe(res)
   }

   const server: Server = createServer((req, res) => {
      res.setHeader("Connection", "close") // avoid keep-alive sockets that stall server.close()
      let p = decodeURIComponent((req.url || "/").split("?")[0])
      if (p === "/") p = "/index.html"
      if (p.startsWith("/packs/")) serveFile(res, packsDir, p.slice("/packs/".length))
      else serveFile(res, appDir, p.slice(1))
   })
   await new Promise<void>((rs) => server.listen(0, "127.0.0.1", () => rs()))
   const port = (server.address() as AddressInfo).port

   provide("baseUrl", `http://127.0.0.1:${port}/`)
   provide("packsDir", packsDir)

   return async () => {
      server.closeAllConnections?.()
      await new Promise<void>((rs) => server.close(() => rs()))
      rmSync(packsDir, { recursive: true, force: true })
   }
}
