#!/usr/bin/env node
// SRR Cloud phase-1 smoke: a REAL srr store served through the REAL worker.
//   real `srr` fetch → seed local R2 (wrangler --local) → wrangler dev →
//   HTTP checks per route class (spec §5) with a forged sess cookie.
// Opt-in (`make smoke-cloud`); needs dist/srr and cloud/worker/public staged.
import { execFile, execFileSync, spawn } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
import { createServer } from "node:http"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "../..")
const WORKER = join(REPO, "cloud/worker")
const SRR = process.env.SRR_BIN ? resolve(process.env.SRR_BIN) : join(REPO, "dist/srr")
const PORT = 8788

// The forged cookie must sign with the secret wrangler dev reads: reuse an
// existing .dev.vars, else write one with a throwaway smoke secret.
const devVars = join(WORKER, ".dev.vars")
if (!existsSync(devVars)) writeFileSync(devVars, "SESSION_SECRET=smoke-secret\n")
const SECRET = readFileSync(devVars, "utf8").match(/^SESSION_SECRET=(.*)$/m)?.[1]
if (!SECRET) throw new Error(".dev.vars has no SESSION_SECRET line")

const RSS = (n) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Smoke</title>
${Array.from(
   { length: n },
   (_, i) =>
      `<item><guid>g${i}</guid><title>Article ${i}</title><link>https://example.com/${i}</link><pubDate>Mon, 0${(i % 7) + 1} Jun 2026 0${i}:00:00 GMT</pubDate><description>body ${i}</description></item>`,
).join("\n")}
</channel></rss>`

const b64u = (buf) => Buffer.from(buf).toString("base64url")
async function sessCookie(email) {
   const body = b64u(JSON.stringify({ t: "sess", e: email }))
   const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
   )
   const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
   return `sess=${body}.${b64u(sig)}`
}

const walk = (dir) =>
   readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => statSync(join(dir, f)).isFile())

let failures = 0
const check = (name, ok, detail = "") => {
   console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`)
   if (!ok) failures++
}

// 1. Build a real store with the real binary.
const store = mkdtempSync(join(tmpdir(), "srr-cloud-smoke-"))
const feedSrv = createServer((req, res) => {
   res.setHeader("content-type", "application/rss+xml")
   res.end(RSS(5))
})
await new Promise((r) => feedSrv.listen(0, "127.0.0.1", r))
const feedUrl = `http://127.0.0.1:${feedSrv.address().port}/feed.xml`
// ASYNC on purpose (the harness.ts lesson): `srr feed add`/`fetch` dial the
// feed server running in THIS process — a synchronous spawn blocks the event
// loop and every probe times out.
const srrEnv = { ...process.env, SRR_ALLOW_PRIVATE_FETCH: "1", SRR_CONFIG_INLINE: "{}" }
await execFileAsync(SRR, ["-o", store, "feed", "add", "-t", "Smoke", "-u", feedUrl], { env: srrEnv })
await execFileAsync(SRR, ["-o", store, "fetch"], { env: srrEnv })
feedSrv.close()

// 2. Seed the local R2 simulation under u/t1/ (fresh state each run).
rmSync(join(WORKER, ".wrangler/state"), { recursive: true, force: true })
for (const f of walk(store)) {
   if (f.startsWith(".")) continue // .locked etc.
   execFileSync("npx", ["wrangler", "r2", "object", "put", `srr-cloud/u/t1/${f}`, "--file", join(store, f), "--local"], {
      cwd: WORKER,
      stdio: "ignore",
   })
}

// 3. wrangler dev against the seeded state.
const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
   cwd: WORKER,
   stdio: ["ignore", "pipe", "pipe"],
   env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
})
dev.stderr.on("data", (d) => process.env.SMOKE_DEBUG && process.stderr.write(d))
dev.stdout.on("data", (d) => process.env.SMOKE_DEBUG && process.stdout.write(d))
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; ; i++) {
   try {
      await fetch(`${base}/`, { redirect: "manual" })
      break
   } catch {
      if (i > 60) {
         dev.kill("SIGTERM")
         throw new Error("wrangler dev never came up")
      }
      await new Promise((r) => setTimeout(r, 500))
   }
}

try {
   const t1 = await sessCookie("gabriellleragarcia@gmail.com")
   const t2 = await sessCookie("srr-t2@example.invalid")
   const nav = { "sec-fetch-mode": "navigate", accept: "text/html" }

   let r = await fetch(`${base}/`, { headers: nav, redirect: "manual" })
   check(
      "anon / → login redirect",
      r.status === 302 && r.headers.get("location").startsWith("https://www.32b.io/login"),
      `${r.status} ${r.headers.get("location")}`,
   )

   r = await fetch(`${base}/u/t1/`, { headers: nav, redirect: "manual" })
   check("anon /u/t1/ → login redirect", r.status === 302, String(r.status))

   r = await fetch(`${base}/u/t1/db.gz`, { redirect: "manual" })
   check("anon db.gz → 401", r.status === 401, String(r.status))

   r = await fetch(`${base}/u/t1/`, { headers: { ...nav, cookie: t1 } })
   const html = await r.text()
   check("owner /u/t1/ → shell", r.status === 200 && html.includes("<script"), String(r.status))

   const js = html.match(/frontend\.[0-9a-f]+\.js/)?.[0]
   r = await fetch(`${base}/u/t1/${js}`)
   check("shell js asset without cookie → 200", r.status === 200, `${js}: ${r.status}`)
   const sw = readdirSync(join(WORKER, "public")).find((f) => /^sw\.[0-9a-f]+\.js$/.test(f))
   r = await fetch(`${base}/u/t1/${sw}`)
   check("sw script without cookie → 200 (SW-registration trap)", r.status === 200, `${sw}: ${r.status}`)

   r = await fetch(`${base}/u/t1/db.gz`, { headers: { cookie: t1 } })
   const dbBytes = Buffer.from(await r.arrayBuffer())
   check("owner db.gz → 200 gzip", r.status === 200 && dbBytes[0] === 0x1f && dbBytes[1] === 0x8b, String(r.status))
   const root = JSON.parse(gunzipSync(dbBytes).toString())
   check("db.gz is a v3 root", root.v === 3 && root.m >= 1, JSON.stringify(root))

   r = await fetch(`${base}/u/t1/manifest/${root.m}.gz`, { headers: { cookie: t1 } })
   check("manifest fetch → 200", r.status === 200, String(r.status))

   r = await fetch(`${base}/u/t1/config.gz`, { headers: { cookie: t1 } })
   check("config.gz → 404 even for owner", r.status === 404, String(r.status))
   r = await fetch(`${base}/u/t1/seen/1.gz`, { headers: { cookie: t1 } })
   check("seen/* → 404 even for owner", r.status === 404, String(r.status))

   r = await fetch(`${base}/u/t1/db.gz`, { headers: { cookie: t2 } })
   check("cross-tenant read → 403", r.status === 403, String(r.status))

   r = await fetch(`${base}/u/t1/sync.json`, { method: "PUT", headers: { cookie: t1 }, body: '{"v":2}' })
   check("sync PUT → 204", r.status === 204, String(r.status))
   r = await fetch(`${base}/u/t1/sync.json`, { headers: { cookie: t1 } })
   check("sync GET round-trip", r.status === 200 && (await r.text()) === '{"v":2}', String(r.status))

   r = await fetch(`${base}/u/t1/db.gz`, { method: "PUT", headers: { cookie: t1 }, body: "x" })
   check("PUT db.gz → 405", r.status === 405, String(r.status))
} finally {
   dev.kill("SIGTERM")
   rmSync(store, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILURES` : "\nsmoke: all checks passed")
process.exit(failures ? 1 : 0)
