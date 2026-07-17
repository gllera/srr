// A tiny same-origin static file server shared by the browser e2e (serve.ts) and
// the design screenshotter (design/shoot.e2e.test.ts): serves a built app dir at
// / and a pack dir at /packs/, with the path-traversal guard and the
// Connection:close keep-alive workaround both layers need (without it
// server.close() stalls on Chrome's keep-alive sockets).
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, normalize } from "node:path"

export const MIME: Record<string, string> = {
   ".html": "text/html; charset=utf-8",
   ".js": "text/javascript; charset=utf-8",
   ".mjs": "text/javascript; charset=utf-8",
   ".css": "text/css; charset=utf-8",
   ".svg": "image/svg+xml",
   ".png": "image/png",
   ".json": "application/json",
   ".webmanifest": "application/manifest+json",
   ".ico": "image/x-icon",
   ".gz": "application/octet-stream", // raw gzip — data.ts decompresses manually
}

function serveFile(res: ServerResponse, baseDir: string, rel: string) {
   const file = join(baseDir, normalize(rel).replace(/^(\.\.([/\\]|$))+/, ""))
   if (!file.startsWith(baseDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      res.end("not found")
      return
   }
   res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream")
   createReadStream(file).pipe(res)
}

export interface StaticServer {
   server: Server
   baseUrl: string // no trailing slash
}

// Serve appDir at / (defaulting `/` to indexFile) and packsDir at /packs/,
// plus an in-memory same-origin sync endpoint under /sync/<name> (GET = stored
// blob or 404, PUT = store the body) — the minimal contract sync.ts asks of a
// user-supplied endpoint, keyed by path so scenarios isolate per name.
export async function startStaticServer(opts: {
   appDir: string
   packsDir: string
   indexFile?: string
}): Promise<StaticServer> {
   const indexFile = opts.indexFile ?? "index.html"
   const syncBlobs = new Map<string, Buffer>()
   const server = createServer((req, res) => {
      res.setHeader("Connection", "close") // avoid keep-alive sockets that stall server.close()
      let p = decodeURIComponent((req.url || "/").split("?")[0])
      if (p === "/") p = "/" + indexFile
      if (p.startsWith("/sync/")) {
         // Failure injection: names under /sync/fail… always 500, so scenarios
         // can pin how the reader surfaces and survives a broken endpoint.
         if (p.startsWith("/sync/fail")) {
            res.statusCode = 500
            res.end("injected failure")
            return
         }
         if (req.method === "PUT") {
            const chunks: Buffer[] = []
            req.on("data", (c: Buffer) => chunks.push(c))
            req.on("end", () => {
               syncBlobs.set(p, Buffer.concat(chunks))
               res.statusCode = 204
               res.end()
            })
            return
         }
         const blob = syncBlobs.get(p)
         if (!blob) {
            res.statusCode = 404
            res.end("not found")
            return
         }
         res.setHeader("Content-Type", "application/json")
         res.end(blob)
         return
      }
      if (p.startsWith("/packs/")) serveFile(res, opts.packsDir, p.slice("/packs/".length))
      else serveFile(res, opts.appDir, p.slice(1))
   })
   await new Promise<void>((rs) => server.listen(0, "127.0.0.1", () => rs()))
   return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

// Close the server, dropping keep-alive sockets first so close() doesn't hang.
export async function stopStaticServer(server: Server): Promise<void> {
   server.closeAllConnections?.()
   await new Promise<void>((rs) => server.close(() => rs()))
}
