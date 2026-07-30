import { describe, expect, it } from "vitest"
import { SELF } from "cloudflare:test"
import { ROSTER } from "../src/roster"
import { sessCookie } from "./helpers"

const t1email = Object.entries(ROSTER).find(([, v]) => v.uid === "t1")![0]

const BASE = "https://cloud.32b.io"

// A browser navigation (Sec-Fetch-Mode: navigate) vs a programmatic fetch.
const nav = (extra: Record<string, string> = {}) => ({
   headers: { "sec-fetch-mode": "navigate", accept: "text/html", ...extra },
   redirect: "manual" as const,
})
const api = (extra: Record<string, string> = {}) => ({ headers: { ...extra }, redirect: "manual" as const })

describe("GET /", () => {
   it("redirects an authenticated roster member to their tenant root", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav({ cookie: await sessCookie(t1email) }))
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe(`${BASE}/u/t1/`)
   })

   it("redirects anonymous visitors to the www login with next", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav())
      expect(res.status).toBe(302)
      const loc = new URL(res.headers.get("location")!)
      expect(loc.origin + loc.pathname).toBe("https://www.32b.io/login")
      expect(loc.searchParams.get("next")).toBe(`${BASE}/`)
   })

   it("403s an authenticated non-member", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav({ cookie: await sessCookie("nobody@example.com") }))
      expect(res.status).toBe(403)
   })

   it("403s a deactivated member (revocation)", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav({ cookie: await sessCookie("inactive@test.invalid") }))
      expect(res.status).toBe(403)
   })
})

describe("shell", () => {
   it("redirects /u/t1 to /u/t1/", async () => {
      const res = await SELF.fetch(`${BASE}/u/t1`, nav({ cookie: await sessCookie(t1email) }))
      expect(res.status).toBe(301)
      expect(res.headers.get("location")).toBe(`${BASE}/u/t1/`)
   })

   it("serves index.html at the tenant root to its owner, no-cache + CSP", async () => {
      for (const path of ["/u/t1/", "/u/t1/index.html"]) {
         const res = await SELF.fetch(`${BASE}${path}`, nav({ cookie: await sessCookie(t1email) }))
         expect(res.status).toBe(200)
         const body = await res.text()
         expect(body).toContain("<script")
         expect(res.headers.get("cache-control")).toBe("no-cache")
         expect(res.headers.get("content-security-policy")).toContain("script-src 'self'")
      }
   })

   it("login-redirects an anonymous navigation to the tenant root", async () => {
      const res = await SELF.fetch(`${BASE}/u/t1/`, nav())
      expect(res.status).toBe(302)
      expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe(`${BASE}/u/t1/`)
   })

   it("403s the index for the WRONG tenant's owner", async () => {
      const res = await SELF.fetch(`${BASE}/u/t2/`, nav({ cookie: await sessCookie(t1email) }))
      expect(res.status).toBe(403)
   })

   it("serves shell sub-resource assets WITHOUT a cookie (the SW-script trap)", async () => {
      // Discover the real hashed names from the staged bundle via index.html.
      const idx = await SELF.fetch(`${BASE}/u/t1/index.html`, nav({ cookie: await sessCookie(t1email) }))
      const html = await idx.text()
      const js = html.match(/frontend\.[0-9a-f]+\.js/)![0]
      const res = await SELF.fetch(`${BASE}/u/t1/${js}`, api())
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toContain("immutable")
      const mf = await SELF.fetch(`${BASE}/u/t1/manifest.webmanifest`, api())
      expect(mf.status).toBe(200)
      expect(mf.headers.get("cache-control")).toBe("no-cache")
   })

   it("404s unknown top-level paths and bad uids", async () => {
      expect((await SELF.fetch(`${BASE}/favicon.ico`, api())).status).toBe(404)
      expect((await SELF.fetch(`${BASE}/u/T1/db.gz`, api())).status).toBe(404)
   })
})

describe("method gate", () => {
   it("405s non-GET on non-sync routes even when authenticated", async () => {
      const cookie = await sessCookie(t1email)
      for (const [method, path] of [
         ["POST", "/u/t1/"],
         ["DELETE", "/u/t1/db.gz"],
         ["PUT", "/u/t1/db.gz"],
         ["POST", "/"],
      ] as const) {
         const res = await SELF.fetch(`${BASE}${path}`, { method, headers: { cookie }, redirect: "manual" })
         expect(res.status, `${method} ${path}`).toBe(405)
      }
   })
})
