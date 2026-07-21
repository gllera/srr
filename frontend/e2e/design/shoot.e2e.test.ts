// shoot.e2e.test.ts — opt-in design-state screenshotter. Builds the design.html
// harness page (single entry → the SRR_CDN_URL injection's load order holds)
// pointed at a same-origin /packs/ path, serves it next to the curated
// design-store fixture, then drives it through every panel state in light + dark
// and writes a PNG per state to e2e/design/design-shots/. These PNGs are the
// artifacts Claude reads to ground a design round. Run via `make design-shots`
// (needs the design-store fixture + the puppeteer Chromium, same as
// `make test-browser`). Excluded from `npm test` (vitest.config.ts scans src/**).
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Page } from "puppeteer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { stateHash, TRANSIENTS, type DesignState, type DesignTargets } from "../../src/js/design"
import { launchBrowser } from "../browser/helpers"
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

// Two passes. Mobile is the primary target and gets every state; desktop —
// safely above the styles.css breakpoint — gets the three states whose layout
// actually differs there (list, reader, picker), which had never been grounded
// at all. Desktop shots carry a `.desktop` infix so the two sets never collide.
const VIEWPORTS = [
   { infix: "", size: { width: 420, height: 900, deviceScaleFactor: 2 }, full: true },
   { infix: "desktop.", size: { width: 1280, height: 900, deviceScaleFactor: 1 }, full: false },
] as const

// The states captured in the desktop pass (a subset of surfaceShots).
const DESKTOP_SURFACES = new Set(["list", "reader-newest"])

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
         ["build", "src/design.html", "--dist-dir", "../dist/srrf", "--no-cache", "--no-source-maps"],
         { cwd: CWD, env: { ...process.env, SRR_CDN_URL: "/packs/" } },
      )
      srv = await startStaticServer({ appDir: APP_DIR, packsDir: PACKS_DIR, indexFile: "design.html" })
   }, 120_000)

   afterAll(async () => {
      if (srv) await stopStaticServer(srv.server)
   })

   it("captures every panel + transient state in light + dark", async () => {
      const targets = JSON.parse(readFileSync(join(PACKS_DIR, "design.json"), "utf8")) as DesignTargets
      const browser = await launchBrowser()
      const taken: string[] = []

      // The harness's own control panel floats over the top-left of the app
      // chrome, so it has to be hidden before EVERY capture — not just the
      // picker's, which was the only shot that used to do it, leaving every
      // other grounding shot with dev chrome pasted over it. Hiding here (and
      // not once per page) is also what makes it survive navigation: each
      // page.goto rebuilds the DOM and brings the panel back.
      const shoot = async (page: Page, name: string) => {
         await page.evaluate(() => {
            const panel = document.getElementById("srr-design-panel")
            if (panel) panel.style.display = "none"
         })
         // The reader fades its content in (double-rAF + an opacity transition),
         // so an immediate capture catches it half-transparent — or, on the
         // faster desktop pass, entirely invisible. Wait for every transition on
         // the page to settle before the shutter.
         await page
            .waitForFunction(
               () =>
                  [...document.querySelectorAll(".srr-content, .srr-reader, .srr-list")].every(
                     (e) => getComputedStyle(e).opacity === "1",
                  ),
               { timeout: 3000 },
            )
            .catch(() => {})
         await page.screenshot({ path: join(SHOTS, `${name}.png`) })
         taken.push(name)
      }

      try {
         for (const scheme of ["light", "dark"] as const) {
            for (const vp of VIEWPORTS) {
               const sfx = `${vp.infix}${scheme}`
               const page = await browser.newPage()
               await page.setViewport(vp.size)
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
                  if (!vp.full && !DESKTOP_SURFACES.has(s.name)) continue
                  await page.goto(`${srv.baseUrl}/design.html${stateHash(s.state)}`, { waitUntil: "networkidle0" })
                  await waitReady(page)
                  await shoot(page, `${s.name}.${sfx}`)
               }

               // The filter-picker overlay and the settings menu aren't hash-routed —
               // open them the way a user does (tap the filter button / the
               // now-viewing readout over the list), then capture. Pin unread-only OFF for
               // the grounding shots (the app now defaults it on for first run, which
               // hides fully-read feed rows in this fixture) so the full filter list
               // is shown and clickable.
               await page.goto(`${srv.baseUrl}/design.html#`, { waitUntil: "networkidle0" })
               await page.evaluate(() => localStorage.setItem("srr-unread-only", "0"))
               await page.reload({ waitUntil: "networkidle0" })
               await waitReady(page)
               await page.click(".srr-filter")
               await shoot(page, `picker.${sfx}`)

               if (!vp.full) {
                  await page.close()
                  continue
               }

               // Feed info dialog — press the header Info (stats) toggle, then tap a
               // (visible, untagged) feed row: in stats mode the tap opens the row's
               // detail card instead of filtering. Let the async unread count fill,
               // capture, then close the dialog and the picker underneath (the
               // second Escape also drops the picker's stats mode with it).
               await page.click(".srr-picker-info")
               await page.click(".srr-feed-row:not(.srr-tag-item)")
               await page.waitForSelector(".srr-info-dialog.srr-open")
               await new Promise((r) => setTimeout(r, 250))
               await shoot(page, `picker-info-feed.${sfx}`)
               await page.evaluate(() => (document.querySelector(".srr-info-close") as HTMLElement | null)?.click())
               await page.keyboard.press("Escape")

               // Settings menu — the now-viewing readout's anchored card (search ·
               // the dialogs) with the status footer under the action rows.
               await page.click(".srr-feed")
               await page.waitForSelector(".srr-ctxmenu")
               await shoot(page, `settings-menu.${sfx}`)
               await page.keyboard.press("Escape")

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
                  await shoot(page, `transient-${t.id}.${sfx}`)
                  await page.evaluate(
                     (classes: string[]) =>
                        classes.forEach((c) =>
                           document.querySelectorAll("." + c).forEach((e) => e.classList.remove(c)),
                        ),
                     t.apply.map((a) => a.cls),
                  )
               }
               await page.close()
            }
         }
      } finally {
         await browser.close()
      }

      // Completeness, kept COARSE on purpose: the whole expected manifest must
      // exist and be non-trivial in size. Deliberately NOT a pixel diff — these
      // shots are grounding artifacts, and antialiasing/font-rendering drift
      // would make an exact comparison a false-positive machine.
      const expected: string[] = []
      for (const scheme of ["light", "dark"] as const) {
         for (const vp of VIEWPORTS) {
            const sfx = `${vp.infix}${scheme}`
            for (const s of surfaceShots(targets)) {
               if (vp.full || DESKTOP_SURFACES.has(s.name)) expected.push(`${s.name}.${sfx}`)
            }
            expected.push(`picker.${sfx}`)
            if (!vp.full) continue
            expected.push(`picker-info-feed.${sfx}`, `settings-menu.${sfx}`)
            for (const t of TRANSIENTS) expected.push(`transient-${t.id}.${sfx}`)
         }
      }
      expect(taken.slice().sort()).toEqual(expected.slice().sort())
      for (const name of expected) {
         const file = join(SHOTS, `${name}.png`)
         expect(existsSync(file), `${name}.png missing`).toBe(true)
         expect(statSync(file).size, `${name}.png is suspiciously small`).toBeGreaterThan(2000)
      }
   }, 480_000)
})
