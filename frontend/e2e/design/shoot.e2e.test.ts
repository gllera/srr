// shoot.e2e.test.ts — opt-in design-state screenshotter. Builds the design.html
// harness page (single entry → the SRR_CDN_URL injection's load order holds)
// pointed at a same-origin /packs/ path, serves it next to the curated
// design-store fixture, then drives it through every panel state in light + dark
// and writes a PNG per state to e2e/design/design-shots/. These PNGs are the
// artifacts Claude reads to ground a design round. Run via `make design-shots`
// (needs the design-store fixture + the puppeteer Chromium, same as
// `make test-browser`). Excluded from `npm test` (vitest.config.ts scans src/**).
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import puppeteer, { type Page } from "puppeteer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { stateHash, TRANSIENTS, type DesignState, type DesignTargets } from "../../src/js/design"
import { startStaticServer, stopStaticServer, type StaticServer } from "../static-serve"

declare global {
   interface Window {
      __srrReady?: boolean
   }
}

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url)) // frontend/e2e/design
const CWD = resolve(HERE, "../..") // frontend/
const APP_DIR = resolve(CWD, "../dist/srrf")
const PACKS_DIR = resolve(CWD, "e2e/fixtures/design-store")
const SHOTS = resolve(HERE, "design-shots")
const READER_NEWEST: DesignState = { kind: "reader", pos: 2147483647 } // clamps to last

// Surface states reached by setting the real hash (design.ts owns the grammar).
function surfaceShots(t: DesignTargets): { name: string; state: DesignState }[] {
   const shots: { name: string; state: DesignState }[] = [
      { name: "list", state: { kind: "list" } },
      { name: "reader-newest", state: READER_NEWEST },
      { name: "saved", state: { kind: "saved" } },
      { name: "search", state: { kind: "search", query: "a" } },
   ]
   if (t.sampleTag) shots.push({ name: "tag", state: { kind: "filter", token: t.sampleTag } })
   if (t.ferrToken) shots.push({ name: "feed-error", state: { kind: "filter", token: t.ferrToken } })
   if (t.longTitlePos != null) shots.push({ name: "long-title", state: { kind: "reader", pos: t.longTitlePos } })
   return shots
}

const waitReady = (page: Page) =>
   page.waitForFunction(() => window.__srrReady === true, { timeout: 15_000 }).catch(() => {})

let srv: StaticServer

describe("design-state screenshots", () => {
   beforeAll(async () => {
      if (!existsSync(join(PACKS_DIR, "db.gz")))
         throw new Error(`no design-store fixture at ${PACKS_DIR} — run \`make design-fixture\` first`)
      rmSync(SHOTS, { recursive: true, force: true })
      mkdirSync(SHOTS, { recursive: true })

      // Build the harness page alone (single entry; the production `npm run build`
      // excludes design.html) with a same-origin /packs/ CDN path.
      await execFileAsync(
         resolve(CWD, "node_modules/.bin/parcel"),
         ["build", "src/design.html", "--no-cache", "--no-source-maps"],
         { cwd: CWD, env: { ...process.env, SRR_CDN_URL: "/packs/" } },
      )
      srv = await startStaticServer({ appDir: APP_DIR, packsDir: PACKS_DIR, indexFile: "design.html" })
   }, 120_000)

   afterAll(async () => {
      if (srv) await stopStaticServer(srv.server)
   })

   it("captures every panel + transient state in light + dark", async () => {
      const targets = JSON.parse(readFileSync(join(PACKS_DIR, "design.json"), "utf8")) as DesignTargets
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      try {
         for (const scheme of ["light", "dark"] as const) {
            const page = await browser.newPage()
            await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }])
            // Runs on every navigation (before app scripts): flag srr:ready so the
            // wait can't miss the event, and seed the tombstoned saved article so
            // ★ Saved isn't empty — no extra round-trip to set localStorage.
            await page.evaluateOnNewDocument((saved: number | null) => {
               window.__srrReady = false
               document.addEventListener("srr:ready", () => (window.__srrReady = true), { once: true })
               if (saved != null) localStorage.setItem("srr-saved", JSON.stringify([saved]))
            }, targets.savedDeletedChron ?? null)

            for (const s of surfaceShots(targets)) {
               await page.goto(`${srv.baseUrl}/design.html${stateHash(s.state)}`, { waitUntil: "networkidle0" })
               await waitReady(page)
               await page.screenshot({ path: join(SHOTS, `${s.name}.${scheme}.png`) })
            }

            // Transients need a populated surface — capture them all over a reader
            // article, applying/clearing each via its TRANSIENTS recipe (the same
            // table design.ts forces from, so no class lists are duplicated here).
            await page.goto(`${srv.baseUrl}/design.html${stateHash(READER_NEWEST)}`, { waitUntil: "networkidle0" })
            await waitReady(page)
            for (const t of TRANSIENTS) {
               await page.evaluate((tr: (typeof TRANSIENTS)[number]) => {
                  if (tr.text) {
                     const el = document.querySelector(tr.text.sel)
                     if (el) el.textContent = tr.text.value
                  }
                  for (const a of tr.apply) document.querySelector(a.sel)?.classList.add(a.cls)
               }, t)
               await page.screenshot({ path: join(SHOTS, `transient-${t.id}.${scheme}.png`) })
               await page.evaluate(
                  (classes: string[]) =>
                     classes.forEach((c) => document.querySelectorAll("." + c).forEach((e) => e.classList.remove(c))),
                  t.apply.map((a) => a.cls),
               )
            }
            await page.close()
         }
      } finally {
         await browser.close()
      }
      expect(existsSync(join(SHOTS, "list.light.png"))).toBe(true)
      expect(existsSync(join(SHOTS, "transient-error.dark.png"))).toBe(true)
   }, 240_000)
})
