import { beforeAll, describe, expect, it } from "vitest"
import { env as poolEnv } from "cloudflare:test"
import worker, { type ReaderEnv } from "../src/reader"
import { classifyReader } from "../src/router"
import { CSP } from "../src/shell"
import { SESSION_COOKIE, mintSession } from "../src/session"
import { TEST_OIDC } from "./fixture-env"
import { api, nav, sessCookie } from "./helpers"

const BASE = "https://reader.example.com"

// The ASSETS binding comes from the pool's wrangler.toml (the cloud worker's
// staged bundle). It is the same shell either way — what these cases are about
// is the GATE in front of it, not which cdn-url it was built with.
//
// The OIDC four come from fixture-env, the one place that owns them: the
// SESSION_HMAC_SECRET agreeing with the pool's is what lets a token minted here
// verify in the worker at all, and three separate literals made that agreement
// a coincidence.
const env: ReaderEnv = { ASSETS: poolEnv.ASSETS, ...TEST_OIDC }

const call = (path: string, init: RequestInit = {}, over: Partial<ReaderEnv> = {}) =>
   worker.fetch(new Request(`${BASE}${path}`, init), { ...env, ...over })

let signedIn: Record<string, string>

beforeAll(async () => {
   signedIn = { cookie: await sessCookie("reader@example.com", env) }
})

describe("classifyReader", () => {
   it("names the three sign-in routes, and only those three", () => {
      expect(classifyReader("/auth/login").kind).toBe("login")
      expect(classifyReader("/auth/callback").kind).toBe("callback")
      expect(classifyReader("/auth/logout").kind).toBe("logout")
      // Not a prefix: a route filed under /auth/ later is gated by default.
      expect(classifyReader("/auth/").kind).toBe("none")
      expect(classifyReader("/auth/whatever").kind).toBe("none")
      expect(classifyReader("/auth/login/extra").kind).toBe("none")
   })

   it("names the shell index at both of its addresses", () => {
      expect(classifyReader("/").kind).toBe("shell-index")
      expect(classifyReader("/index.html").kind).toBe("shell-index")
   })

   it("names the bundle's own content-hashed files and nothing else", () => {
      expect(classifyReader("/frontend.9f4ebec4.js")).toEqual({ kind: "shell-asset", name: "frontend.9f4ebec4.js" })
      expect(classifyReader("/sw.586aa705.js")).toEqual({ kind: "shell-asset", name: "sw.586aa705.js" })
      expect(classifyReader("/manifest.webmanifest")).toEqual({ kind: "shell-asset", name: "manifest.webmanifest" })
      expect(classifyReader("/icon-192.936dab90.png").kind).toBe("shell-asset")
      // An unhashed name is not this bundle's, so it is not public bytes.
      expect(classifyReader("/frontend.js").kind).toBe("none")
      expect(classifyReader("/db.gz").kind).toBe("none")
      expect(classifyReader("/data/1.gz").kind).toBe("none")
      expect(classifyReader("/sub/sw.586aa705.js").kind).toBe("none")
   })
})

describe("the gate", () => {
   it("sends an anonymous navigation to the login, carrying where it was headed", async () => {
      const res = await call("/", nav())
      expect(res.status).toBe(302)
      const loc = new URL(res.headers.get("location") ?? "")
      expect(loc.origin + loc.pathname).toBe(`${BASE}/auth/login`)
      expect(loc.searchParams.get("next")).toBe("/")
      expect(res.headers.get("cache-control")).toBe("no-store")
   })

   it("401s an anonymous programmatic fetch instead of redirecting it", async () => {
      const res = await call("/index.html", api())
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "unauthenticated" })
   })

   it("serves the shell to a signed-in reader, no-cache + CSP + nosniff", async () => {
      for (const path of ["/", "/index.html"]) {
         const res = await call(path, nav(signedIn))
         expect(res.status).toBe(200)
         expect(await res.text()).toContain("<script")
         expect(res.headers.get("cache-control")).toBe("no-cache")
         expect(res.headers.get("content-security-policy")).toContain("script-src 'self'")
         expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      }
   })

   it("refuses a session signed with somebody else's key", async () => {
      const forged = await mintSession({ SESSION_HMAC_SECRET: "not-our-key" }, { sub: "u_x", email: "x@y.z" })
      const res = await call("/", nav({ cookie: `${SESSION_COOKIE}=${forged}` }))
      expect(res.status).toBe(302)
   })

   it("serves the shell's assets WITHOUT a cookie — the service-worker trap", async () => {
      // Discover the real hashed names from the staged bundle rather than
      // hardcoding a hash the next build changes.
      const idx = await call("/index.html", nav(signedIn))
      const html = await idx.text()
      const js = html.match(/frontend\.[0-9a-f]+\.js/)?.[0]
      expect(js).toBeTruthy()

      const res = await call(`/${js}`, api())
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toContain("immutable")
      // nosniff BLOCKS a script that is not served as a JS MIME type, so the
      // type is load-bearing the moment the header is set — pin both together.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("content-type")).toMatch(/javascript/)

      const sw = html.match(/sw\.[0-9a-f]+\.js/)?.[0]
      if (sw) expect((await call(`/${sw}`, api())).status).toBe(200)

      const mf = await call("/manifest.webmanifest", api())
      expect(mf.status).toBe(200)
      expect(mf.headers.get("cache-control")).toBe("no-cache")
   })

   it("lets the sign-in routes through without a session — a gated callback is a loop", async () => {
      // No IdP is reachable from here, so login fails on its OWN terms (503,
      // the unreachable-IdP path) and the callback on its own (400, no flow
      // cookie). What this pins is that the GATE answered neither: no 302 to
      // the login, and no 401.
      expect((await call("/auth/login", nav())).status).toBe(503)
      expect((await call("/auth/callback", nav())).status).toBe(400)
      // Logout reaches nothing and always works.
      expect((await call("/auth/logout", nav())).status).toBe(302)
   })

   it("serves every file the shell actually references", async () => {
      // The regression this exists for: SHELL_ASSET_RE enumerates the bundle's
      // name shapes, so a Parcel version that emits a chunk under a shape it
      // does not list would be classified `none` and 404 — a reader that boots
      // to a blank page with every gate still green. Ask the shell what it
      // loads instead of trusting the list.
      const html = await (await call("/index.html", nav(signedIn))).text()
      const refs = new Set(
         [...html.matchAll(/(?:href|src)="\.?\/?([A-Za-z0-9._-]+\.(?:js|css|png|svg|webmanifest))"/g)].map((m) => m[1]),
      )
      // The manifest's icons are a second reference list, fetched by the
      // browser's install UI rather than by the document.
      const manifest = (await (await call("/manifest.webmanifest", api())).json()) as {
         icons?: { src: string }[]
      }
      for (const i of manifest.icons ?? []) refs.add(i.src.replace(/^\.?\//, ""))

      expect(refs.size).toBeGreaterThan(0)
      for (const name of refs) {
         expect(`${name} -> ${(await call(`/${name}`, api())).status}`).toBe(`${name} -> 200`)
      }
   })

   it("serves the same CSP the bundle carries as its own <meta> fallback", async () => {
      // Three hand-kept copies of one policy — shell.ts's CSP constant, the
      // <meta> in the shell, and frontend/_headers — each with a comment saying
      // it mirrors the others and nothing checking. A tightening that lands on
      // one and not the rest is silent, and so is a loosening. This holds the
      // two the worker can actually see against each other.
      const html = await (await call("/index.html", nav(signedIn))).text()
      const meta = html.match(/http-equiv=["']?Content-Security-Policy["']? content="([^"]+)"/i)
      expect(meta?.[1]).toBe(CSP)
   })

   it("404s everything it does not serve", async () => {
      for (const path of ["/favicon.ico", "/db.gz", "/data/1.gz", "/robots.txt"]) {
         expect((await call(path, api())).status).toBe(404)
      }
   })
})

describe("method and configuration gates", () => {
   it("allows POST on logout alone", async () => {
      expect((await call("/auth/logout", { method: "POST" })).status).toBe(302)
      for (const path of ["/", "/auth/login", "/auth/callback"]) {
         const res = await call(path, { method: "POST" })
         expect(res.status).toBe(405)
         expect(res.headers.get("allow")).toBe("GET")
      }
      expect((await call("/", { method: "DELETE" })).status).toBe(405)
   })

   it("answers HEAD with the headers and no body", async () => {
      const res = await call("/", { method: "HEAD", headers: signedIn })
      expect(res.status).toBe(200)
      expect(res.body).toBeNull()
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'")
   })

   it("500s rather than half-works when a deployment value is unset", async () => {
      for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_HMAC_SECRET"] as const) {
         const res = await call("/", nav(), { [k]: "" })
         expect(res.status).toBe(500)
      }
   })
})
