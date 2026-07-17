// Shared e2e harness: build/locate the real `srr` binary, run it to produce
// real pack stores from canned feeds, and serve those feeds over HTTP so the
// built-in `#feed` ingest can fetch them. Used by both the contract (jsdom) and
// browser (puppeteer) layers.

import { execFile, execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"

import type { IDBWire } from "../src/js/format.gen"

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url)) // frontend/e2e
const REPO = resolve(HERE, "../..") // repo root

let cachedBin: string | null = null

// Resolve the srr binary. Honors $SRR_BIN (set by the Makefile, relative to the
// cwd npm runs in — i.e. frontend/); otherwise defaults to <repo>/dist/srr and
// builds it on demand so `npm run test-*` works without `make`.
export function srrBin(): string {
   if (cachedBin) return cachedBin
   const bin = process.env.SRR_BIN ? resolve(process.cwd(), process.env.SRR_BIN) : resolve(REPO, "dist/srr")
   if (!existsSync(bin)) {
      execFileSync("go", ["build", "-o", bin, "."], { cwd: resolve(REPO, "backend"), stdio: "inherit" })
   }
   cachedBin = bin
   return bin
}

// Run `srr -o <storeDir> <args...>` and return stdout. Async (execFile, not
// execFileSync) is REQUIRED: `art fetch` reaches back to feedServer() which runs
// in this same Node process — a synchronous spawn would block the event loop and
// the feed server could never answer, so every fetch would time out. Throws on
// non-zero exit, surfacing stderr so a CLI failure is legible.
export async function srr(storeDir: string, ...args: string[]): Promise<string> {
   try {
      // feedServer() binds loopback (127.0.0.1), which the production SSRF guard
      // refuses by default; opt out via the documented flag, exactly as a real
      // localhost/LAN-feed deployment would (feed add's discovery probe and the
      // fetch loop both dial the test server).
      //
      // SRR_CONFIG_INLINE={} keeps the run hermetic: without it the binary reads
      // the HOST's ~/.config/srr/srr.yaml, whose knobs leak into the store under
      // test (a configured asset-process, e.g., transcodes every self-hosted
      // asset — .png in, .avif out — so byte/key assertions diverge from CI).
      const { stdout } = await execFileAsync(srrBin(), ["-o", storeDir, ...args], {
         env: { ...process.env, SRR_ALLOW_PRIVATE_FETCH: "1", SRR_CONFIG_INLINE: "{}" },
      })
      return stdout
   } catch (e) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message: string }
      const stderr = err.stderr ? String(err.stderr) : ""
      const stdout = err.stdout ? String(err.stdout) : ""
      throw new Error(`srr ${args.join(" ")} failed:\n${stderr}${stdout}\n${err.message}`, { cause: e })
   }
}

// `srr inspect --validate` — the Go-side mirror of the frontend parser. Returns
// stdout; callers assert it contains "OK: all checks passed".
export function inspectValidate(storeDir: string): Promise<string> {
   return srr(storeDir, "inspect", "--validate")
}

// Fresh temp store directory. Caller is responsible for cleanup (see afterAll).
export function makeStore(): string {
   return mkdtempSync(join(tmpdir(), "srr-e2e-"))
}

// Parse a store's db.gz. The type param narrows the wire shape to just the
// fields the caller picks (defaults to the full generated IDBWire).
export function readDb<T = IDBWire>(dir: string): T {
   return JSON.parse(gunzipSync(readFileSync(join(dir, "db.gz"))).toString("utf8")) as T
}

// total_art read straight from a store's db.gz, or -1 if it isn't a readable
// store. Used to decide whether a cached stress store can be reused.
function storeTotalArt(dir: string): number {
   if (!existsSync(join(dir, "db.gz"))) return -1
   try {
      return readDb<{ total_art?: number }>(dir).total_art ?? 0
   } catch {
      return -1
   }
}

export interface StressStore {
   dir: string
   total: number
   generated: boolean
}

const DEFAULT_STRESS_N = 60000

// Resolve the large synthetic store the stress layer measures against. Three
// modes, in precedence order:
//   1. $SRR_STRESS_STORE — use an existing store as-is (e.g. one you generated
//      to serve to the reader). Never regenerated or wiped.
//   2. a per-N cache dir under the OS temp dir (srr-stress-store-<N>): reused
//      across runs when it already holds >= N articles.
//   3. otherwise generate one via the gated Go generator (genbig_test.go's
//      TestGenBigStore — the SAME production write path a real fetch loop uses),
//      sized by $SRR_STRESS_N (default 60,000, enough to cross the 50,000-entry
//      idx-pack boundary into a finalized pack + multiple meta shards).
// Unlike makeStore(), the result is a durable cache — callers must NOT delete it.
export function stressStore(): StressStore {
   const n = Number(process.env.SRR_STRESS_N) || DEFAULT_STRESS_N

   const override = process.env.SRR_STRESS_STORE
   if (override) {
      const dir = resolve(process.cwd(), override)
      const total = storeTotalArt(dir)
      if (total < 0) throw new Error(`SRR_STRESS_STORE=${dir} is not a readable srr store (no db.gz)`)
      return { dir, total, generated: false }
   }

   const dir = join(tmpdir(), `srr-stress-store-${n}`)
   const cached = storeTotalArt(dir)
   if (cached >= n) return { dir, total: cached, generated: false }

   // (Re)generate. stdio inherit so the generator's progress + the validate
   // sweep stream to the test output; FORCE wipes any short/partial cache.
   execFileSync("go", ["test", "-run", "TestGenBigStore", "-count=1", "-timeout", "1800s", "."], {
      cwd: resolve(REPO, "backend"),
      stdio: "inherit",
      env: { ...process.env, SRR_GENBIG_OUT: dir, SRR_GENBIG_N: String(n), SRR_GENBIG_FORCE: "1" },
   })

   const total = storeTotalArt(dir)
   if (total < n) throw new Error(`stress store generation reached only ${total}/${n} articles at ${dir}`)
   return { dir, total, generated: true }
}

// A non-XML route (e.g. an image #selfhost downloads): explicit body + type.
export interface FeedRoute {
   body: string | Buffer
   type: string
}

export interface FeedServer {
   url: string
   // Replace/add a route's body so a second `srr art fetch` sees new content.
   set(path: string, body: string | FeedRoute): void
   // Drop a route so subsequent fetches 404 (e.g. to provoke a ferr on a feed
   // that had to resolve validly at `feed add` time).
   remove(path: string): void
   close(): Promise<void>
}

// Ephemeral HTTP server (port 0) serving canned RSS XML keyed by path (a bare
// string body defaults to the RSS content type; pass a FeedRoute for anything
// else, e.g. media bytes for #selfhost). No ETag/Last-Modified, so every fetch
// is a 200 with the current body — re-fetch dedup is exercised purely through
// the backend's GUID/watermark logic.
export async function feedServer(routes: Record<string, string | FeedRoute>): Promise<FeedServer> {
   const norm = (b: string | FeedRoute): FeedRoute =>
      typeof b === "string" ? { body: b, type: "application/rss+xml; charset=utf-8" } : b
   const table: Record<string, FeedRoute> = {}
   for (const [path, body] of Object.entries(routes)) table[path] = norm(body)
   const server: Server = createServer((req, res) => {
      const path = (req.url || "/").split("?")[0]
      const route = table[path]
      if (route === undefined) {
         res.statusCode = 404
         res.end("not found")
         return
      }
      res.setHeader("Content-Type", route.type)
      res.end(route.body)
   })
   await new Promise<void>((rs) => server.listen(0, "127.0.0.1", () => rs()))
   const addr = server.address() as AddressInfo
   return {
      url: `http://127.0.0.1:${addr.port}`,
      set(path, body) {
         table[path] = norm(body)
      },
      remove(path) {
         delete table[path]
      },
      close() {
         return new Promise<void>((rs) => server.close(() => rs()))
      },
   }
}
