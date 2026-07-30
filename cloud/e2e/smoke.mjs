#!/usr/bin/env node
// SRR Cloud phase-1 smoke: a REAL srr store served through the REAL worker.
//   real `srr` fetch → seed local R2 (wrangler --local) → wrangler dev →
//   HTTP checks per route class (spec §5) with a forged sess cookie.
// Opt-in (`make smoke-cloud`); needs dist/srr and cloud/worker/public staged.
import { execFile, execFileSync, spawn } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
import { createServer } from "node:http"
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "../..")
const WORKER = join(REPO, "cloud/worker")
const SRR = process.env.SRR_BIN ? resolve(process.env.SRR_BIN) : join(REPO, "dist/srr")
const PORT = 8788

// Two things must match the config `wrangler dev` itself reads: the secret the
// forged cookie signs with, and identities the ROSTER authorizes. Both live in
// .dev.vars (gitignored). Absent ⇒ write a throwaway pair; present ⇒ use the
// operator's own, so the smoke exercises the real configuration.
const SMOKE_ROSTER =
   '{"smoke-t1@example.invalid":{"uid":"t1","active":true},"smoke-t2@example.invalid":{"uid":"t2","active":true}}'
const devVars = join(WORKER, ".dev.vars")
if (!existsSync(devVars)) writeFileSync(devVars, `SESSION_SECRET=smoke-secret\nROSTER=${SMOKE_ROSTER}\n`)
let vars = readFileSync(devVars, "utf8")
const SECRET = vars.match(/^SESSION_SECRET=(.*)$/m)?.[1]
if (!SECRET) throw new Error(".dev.vars has no SESSION_SECRET line")
// A .dev.vars written before the roster became config has no ROSTER line.
if (!/^ROSTER=/m.test(vars)) {
   appendFileSync(devVars, `ROSTER=${SMOKE_ROSTER}\n`)
   vars = readFileSync(devVars, "utf8")
}
const roster = JSON.parse(vars.match(/^ROSTER=(.*)$/m)[1])
const active = Object.entries(roster).filter(([, v]) => v?.active)
const owner = active[0]
const peer = owner && active.find(([, v]) => v.uid !== owner[1].uid)
// The cross-tenant check needs a SECOND authorized identity: an unknown email is
// anonymous (401), which is a different assertion than authorized-elsewhere (403).
if (!owner || !peer) throw new Error("ROSTER needs two active entries with different uids (cross-tenant check)")
const UID = owner[1].uid
const OWNER_EMAIL = owner[0]
const PEER_EMAIL = peer[0]
// The login destination is config too (wrangler.toml [vars]).
const LOGIN = readFileSync(join(WORKER, "wrangler.toml"), "utf8").match(/^LOGIN_URL\s*=\s*"([^"]+)"/m)?.[1]
if (!LOGIN) throw new Error("wrangler.toml has no LOGIN_URL var")

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

// 2. Seed the local R2 simulation under the owner's prefix (fresh state each run).
rmSync(join(WORKER, ".wrangler/state"), { recursive: true, force: true })
for (const f of walk(store)) {
   if (f.startsWith(".")) continue // .locked etc.
   execFileSync(
      "npx",
      ["wrangler", "r2", "object", "put", `srr-cloud/u/${UID}/${f}`, "--file", join(store, f), "--local"],
      { cwd: WORKER, stdio: "ignore" },
   )
}

// 3. wrangler dev against the seeded state.
// Refuse to start if the port is taken: a leftover dev server answers every
// probe below, so the run would grade STALE code and report it as green.
await new Promise((resolve, reject) => {
   const probe = createServer()
   probe.once("error", (e) =>
      reject(new Error(`port ${PORT} is busy (${e.code}) — a stale 'wrangler dev' is running; kill it and retry`)),
   )
   probe.listen(PORT, "127.0.0.1", () => probe.close(resolve))
})
// Spawn the local binary DETACHED rather than through npx: killing an npx
// wrapper leaves wrangler and its workerd children alive (that is how the stale
// server above survived), while a detached child owns a process group the
// teardown can signal whole.
const dev = spawn(join(WORKER, "node_modules/.bin/wrangler"), ["dev", "--port", String(PORT)], {
   cwd: WORKER,
   stdio: ["ignore", "pipe", "pipe"],
   detached: true,
   env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
})
dev.stderr.on("data", (d) => process.env.SMOKE_DEBUG && process.stderr.write(d))
dev.stdout.on("data", (d) => process.env.SMOKE_DEBUG && process.stdout.write(d))
// Signal the GROUP (negative pid), so wrangler's workerd children go with it.
const stopDev = () => {
   try {
      process.kill(-dev.pid, "SIGTERM")
   } catch {
      // already gone
   }
}
// Covers the exit paths a `finally` cannot: an uncaught throw above the try, and
// a Ctrl-C — both left the 9-hour orphan this guard exists to prevent.
process.on("exit", stopDev)
process.on("SIGINT", () => {
   stopDev()
   process.exit(130)
})

const base = `http://127.0.0.1:${PORT}`
for (let i = 0; ; i++) {
   try {
      await fetch(`${base}/`, { redirect: "manual" })
      break
   } catch {
      if (i > 60) {
         stopDev()
         throw new Error("wrangler dev never came up")
      }
      await new Promise((r) => setTimeout(r, 500))
   }
}

try {
   const t1 = await sessCookie(OWNER_EMAIL)
   const t2 = await sessCookie(PEER_EMAIL)
   const u = `${base}/u/${UID}`
   const nav = { "sec-fetch-mode": "navigate", accept: "text/html" }

   let r = await fetch(`${base}/`, { headers: nav, redirect: "manual" })
   check(
      "anon / → login redirect",
      r.status === 302 && r.headers.get("location").startsWith(LOGIN),
      `${r.status} ${r.headers.get("location")}`,
   )

   r = await fetch(`${u}/`, { headers: nav, redirect: "manual" })
   check("anon tenant root → login redirect", r.status === 302, String(r.status))

   r = await fetch(`${u}/db.gz`, { redirect: "manual" })
   check("anon db.gz → 401", r.status === 401, String(r.status))

   r = await fetch(`${u}/`, { headers: { ...nav, cookie: t1 } })
   const html = await r.text()
   check("owner tenant root → shell", r.status === 200 && html.includes("<script"), String(r.status))

   const js = html.match(/frontend\.[0-9a-f]+\.js/)?.[0]
   r = await fetch(`${u}/${js}`)
   check("shell js asset without cookie → 200", r.status === 200, `${js}: ${r.status}`)
   const sw = readdirSync(join(WORKER, "public")).find((f) => /^sw\.[0-9a-f]+\.js$/.test(f))
   r = await fetch(`${u}/${sw}`)
   check("sw script without cookie → 200 (SW-registration trap)", r.status === 200, `${sw}: ${r.status}`)

   r = await fetch(`${u}/db.gz`, { headers: { cookie: t1 } })
   const dbBytes = Buffer.from(await r.arrayBuffer())
   check("owner db.gz → 200 gzip", r.status === 200 && dbBytes[0] === 0x1f && dbBytes[1] === 0x8b, String(r.status))
   const root = JSON.parse(gunzipSync(dbBytes).toString())
   check("db.gz is a v3 root", root.v === 3 && root.m >= 1, JSON.stringify(root))

   r = await fetch(`${u}/manifest/${root.m}.gz`, { headers: { cookie: t1 } })
   check("manifest fetch → 200", r.status === 200, String(r.status))

   r = await fetch(`${u}/config.gz`, { headers: { cookie: t1 } })
   check("config.gz → 404 even for owner", r.status === 404, String(r.status))
   r = await fetch(`${u}/seen/1.gz`, { headers: { cookie: t1 } })
   check("seen/* → 404 even for owner", r.status === 404, String(r.status))

   r = await fetch(`${u}/db.gz`, { headers: { cookie: t2 } })
   check("cross-tenant read → 403", r.status === 403, String(r.status))

   r = await fetch(`${u}/sync.json`, { method: "PUT", headers: { cookie: t1 }, body: '{"v":2}' })
   check("sync PUT → 204", r.status === 204, String(r.status))
   r = await fetch(`${u}/sync.json`, { headers: { cookie: t1 } })
   check("sync GET round-trip", r.status === 200 && (await r.text()) === '{"v":2}', String(r.status))

   r = await fetch(`${u}/db.gz`, { method: "PUT", headers: { cookie: t1 }, body: "x" })
   check("PUT db.gz → 405", r.status === 405, String(r.status))
} finally {
   stopDev()
   rmSync(store, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILURES` : "\nsmoke: all checks passed")
process.exit(failures ? 1 : 0)
