// Shared e2e harness: build/locate the real `srrb` binary, run it to produce
// real pack stores from canned feeds, and serve those feeds over HTTP so the
// built-in `#rss` ingest can fetch them. Used by both the contract (jsdom) and
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

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url)) // frontend/e2e
const REPO = resolve(HERE, "../..") // repo root

let cachedBin: string | null = null

// Resolve the srrb binary. Honors $SRR_BIN (set by the Makefile, relative to the
// cwd npm runs in — i.e. frontend/); otherwise defaults to <repo>/dist/srrb and
// builds it on demand so `npm run test-*` works without `make`.
export function srrBin(): string {
   if (cachedBin) return cachedBin
   const bin = process.env.SRR_BIN ? resolve(process.cwd(), process.env.SRR_BIN) : resolve(REPO, "dist/srrb")
   if (!existsSync(bin)) {
      execFileSync("go", ["build", "-o", bin, "."], { cwd: resolve(REPO, "backend"), stdio: "inherit" })
   }
   cachedBin = bin
   return bin
}

// Run `srrb -o <storeDir> <args...>` and return stdout. Async (execFile, not
// execFileSync) is REQUIRED: `art fetch` reaches back to feedServer() which runs
// in this same Node process — a synchronous spawn would block the event loop and
// the feed server could never answer, so every fetch would time out. Throws on
// non-zero exit, surfacing stderr so a CLI failure is legible.
export async function srr(storeDir: string, ...args: string[]): Promise<string> {
   try {
      const { stdout } = await execFileAsync(srrBin(), ["-o", storeDir, ...args])
      return stdout
   } catch (e) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message: string }
      const stderr = err.stderr ? String(err.stderr) : ""
      const stdout = err.stdout ? String(err.stdout) : ""
      throw new Error(`srr ${args.join(" ")} failed:\n${stderr}${stdout}\n${err.message}`)
   }
}

// `srrb inspect --validate` — the Go-side mirror of the frontend parser. Returns
// stdout; callers assert it contains "OK: all checks passed".
export function inspectValidate(storeDir: string): Promise<string> {
   return srr(storeDir, "inspect", "--validate")
}

// Fresh temp store directory. Caller is responsible for cleanup (see afterAll).
export function makeStore(): string {
   return mkdtempSync(join(tmpdir(), "srr-e2e-"))
}

// total_art read straight from a store's db.gz, or -1 if it isn't a readable
// store. Used to decide whether a cached stress store can be reused.
function storeTotalArt(dir: string): number {
   const f = join(dir, "db.gz")
   if (!existsSync(f)) return -1
   try {
      const db = JSON.parse(gunzipSync(readFileSync(f)).toString("utf8")) as { total_art?: number }
      return db.total_art ?? 0
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

export interface FeedServer {
   url: string
   // Replace/add a route's body so a second `srr art fetch` sees new content.
   set(path: string, xml: string): void
   close(): Promise<void>
}

// Ephemeral HTTP server (port 0) serving canned RSS XML keyed by path. No
// ETag/Last-Modified, so every fetch is a 200 with the current body — re-fetch
// dedup is exercised purely through the backend's GUID/watermark logic.
export async function feedServer(routes: Record<string, string>): Promise<FeedServer> {
   const table: Record<string, string> = { ...routes }
   const server: Server = createServer((req, res) => {
      const path = (req.url || "/").split("?")[0]
      const body = table[path]
      if (body === undefined) {
         res.statusCode = 404
         res.end("not found")
         return
      }
      res.setHeader("Content-Type", "application/rss+xml; charset=utf-8")
      res.end(body)
   })
   await new Promise<void>((rs) => server.listen(0, "127.0.0.1", () => rs()))
   const addr = server.address() as AddressInfo
   return {
      url: `http://127.0.0.1:${addr.port}`,
      set(path, xml) {
         table[path] = xml
      },
      close() {
         return new Promise<void>((rs) => server.close(() => rs()))
      },
   }
}
