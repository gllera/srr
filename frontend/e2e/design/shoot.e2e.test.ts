// shoot.e2e.test.ts — opt-in design-state screenshotter. Builds BOTH Parcel
// entries (index + design) pointed at a same-origin /packs/ path, serves them
// next to the curated design-store fixture, then drives /design.html through
// every panel state in light + dark and writes a PNG per state to
// e2e/design/design-shots/. These PNGs are the artifacts Claude reads to ground
// a design round. Run via `make design-shots` (needs the design-store fixture +
// the puppeteer Chromium, same as `make test-browser`). Excluded from `npm test`
// (vitest.config.ts only scans src/**); driven by its own config.
import { execFile } from "node:child_process"
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import puppeteer from "puppeteer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url)) // frontend/e2e/design
const CWD = resolve(HERE, "../..") // frontend/
const APP_DIR = resolve(CWD, "../dist/srrf")
const PACKS_DIR = resolve(CWD, "e2e/fixtures/design-store")
const SHOTS = resolve(HERE, "design-shots")

const MIME: Record<string, string> = {
   ".html": "text/html; charset=utf-8",
   ".js": "text/javascript; charset=utf-8",
   ".css": "text/css; charset=utf-8",
   ".svg": "image/svg+xml",
   ".png": "image/png",
   ".json": "application/json",
   ".webmanifest": "application/manifest+json",
   ".gz": "application/octet-stream", // raw gzip — data.ts decompresses manually
}

interface Targets {
   sampleTag?: string
   ferrToken?: string
   longTitlePos?: number
   savedDeletedChron?: number
}

// Surface states reached by setting the real hash (design.ts's stateHash grammar).
function surfaceShots(t: Targets): { name: string; hash: string }[] {
   const shots = [
      { name: "list", hash: "#" },
      { name: "reader-newest", hash: "#2147483647" },
      { name: "saved", hash: "#!~saved" },
      { name: "search", hash: "#!" + encodeURIComponent("q:a") },
   ]
   if (t.sampleTag) shots.push({ name: "tag", hash: "#!" + encodeURIComponent(t.sampleTag) })
   if (t.ferrToken) shots.push({ name: "feed-error", hash: "#!" + encodeURIComponent(t.ferrToken) })
   if (t.longTitlePos != null) shots.push({ name: "long-title", hash: "#" + t.longTitlePos })
   return shots
}

let server: Server
let baseUrl: string

describe("design-state screenshots", () => {
   beforeAll(async () => {
      if (!existsSync(join(PACKS_DIR, "db.gz")))
         throw new Error(`no design-store fixture at ${PACKS_DIR} — run \`make design-fixture\` first`)
      rmSync(SHOTS, { recursive: true, force: true })
      mkdirSync(SHOTS, { recursive: true })

      // Build the harness page alone (single entry → the SRR_CDN_URL injection's
      // load order holds; the production `npm run build` excludes design.html) with
      // a same-origin /packs/ CDN path.
      await execFileAsync(
         resolve(CWD, "node_modules/.bin/parcel"),
         ["build", "src/design.html", "--no-cache", "--no-source-maps"],
         { cwd: CWD, env: { ...process.env, SRR_CDN_URL: "/packs/" } },
      )

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
      server = createServer((req, res) => {
         res.setHeader("Connection", "close") // avoid keep-alive sockets that stall server.close()
         let p = decodeURIComponent((req.url || "/").split("?")[0])
         if (p === "/") p = "/design.html"
         if (p.startsWith("/packs/")) serveFile(res, PACKS_DIR, p.slice("/packs/".length))
         else serveFile(res, APP_DIR, p.slice(1))
      })
      await new Promise<void>((rs) => server.listen(0, "127.0.0.1", () => rs()))
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
   }, 120_000)

   afterAll(async () => {
      server?.closeAllConnections?.()
      await new Promise<void>((rs) => server?.close(() => rs()))
   })

   it("captures every panel state in light + dark", async () => {
      const targets: Targets = JSON.parse(readFileSync(join(PACKS_DIR, "design.json"), "utf8")) as Targets
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      try {
         const shots = surfaceShots(targets)
         for (const scheme of ["light", "dark"] as const) {
            const page = await browser.newPage()
            await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }])
            // Flag srr:ready before the app boots so the wait can't miss the event.
            await page.evaluateOnNewDocument(() => {
               ;(window as unknown as { __srrReady?: boolean }).__srrReady = false
               document.addEventListener(
                  "srr:ready",
                  () => ((window as unknown as { __srrReady?: boolean }).__srrReady = true),
                  { once: true },
               )
            })
            // Seed a saved article (the tombstoned, since-deleted one) so ★ Saved isn't empty.
            if (targets.savedDeletedChron != null) {
               await page.goto(`${baseUrl}/design.html`, { waitUntil: "domcontentloaded" })
               await page.evaluate(
                  (c) => localStorage.setItem("srr-saved", JSON.stringify([c])),
                  targets.savedDeletedChron,
               )
            }

            for (const s of shots) {
               await page.goto(`${baseUrl}/design.html${s.hash}`, { waitUntil: "networkidle0" })
               await page
                  .waitForFunction(() => (window as unknown as { __srrReady?: boolean }).__srrReady === true, {
                     timeout: 15_000,
                  })
                  .catch(() => {})
               await page.screenshot({ path: join(SHOTS, `${s.name}.${scheme}.png`) })
            }

            // One transient: the error popup over the list.
            await page.goto(`${baseUrl}/design.html#`, { waitUntil: "networkidle0" })
            await page
               .waitForFunction(() => (window as unknown as { __srrReady?: boolean }).__srrReady === true, {
                  timeout: 15_000,
               })
               .catch(() => {})
            await page.evaluate(() => {
               const t = document.querySelector(".srr-popup-text")
               if (t) t.textContent = "Sample error: failed to load db.gz (HTTP 503)."
               document.querySelector(".srr-popup")?.classList.add("srr-open")
            })
            await page.screenshot({ path: join(SHOTS, `error-popup.${scheme}.png`) })
            await page.close()
         }
      } finally {
         await browser.close()
      }
      expect(existsSync(join(SHOTS, "list.light.png"))).toBe(true)
      expect(existsSync(join(SHOTS, "error-popup.dark.png"))).toBe(true)
   }, 240_000)
})
