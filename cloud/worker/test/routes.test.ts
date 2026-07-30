import { describe, expect, it } from "vitest"
import { SELF, env } from "cloudflare:test"
import { TEST_LOGIN_URL as LOGIN, TEST_REVOKED_EMAIL, TEST_T1_EMAIL, TEST_T2_EMAIL } from "./fixture-env"
import { sessCookie } from "./helpers"

// The roster behind these is bound by vitest.config.ts — see test/fixture-env.ts
// for why it cannot be declared in this file.
const t1email = TEST_T1_EMAIL
const t2email = TEST_T2_EMAIL

const BASE = "https://cloud.example.com"

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

   it("redirects anonymous visitors to the login app with next", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav())
      expect(res.status).toBe(302)
      const loc = new URL(res.headers.get("location")!)
      expect(loc.origin + loc.pathname).toBe(LOGIN)
      expect(loc.searchParams.get("next")).toBe(`${BASE}/`)
   })

   it("403s an authenticated non-member", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav({ cookie: await sessCookie("nobody@example.com") }))
      expect(res.status).toBe(403)
   })

   it("403s a deactivated member (revocation)", async () => {
      const res = await SELF.fetch(`${BASE}/`, nav({ cookie: await sessCookie(TEST_REVOKED_EMAIL) }))
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
         expect(res.headers.get("x-content-type-options")).toBe("nosniff")
         // NOT the store's sandbox policy — that would stop the reader running.
         expect(res.headers.get("content-security-policy")).not.toContain("sandbox")
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
      // nosniff BLOCKS a script that is not served as a JS MIME type, so the
      // type is load-bearing the moment the header is set — pin both together.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("content-type")).toMatch(/javascript/)
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

describe("store objects", () => {
   const gz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]) // gzip magic + junk

   it("serves an object with its stored metadata to its owner", async () => {
      await env.STORE.put("u/t1/db.gz", gz, {
         httpMetadata: { contentType: "application/gzip", cacheControl: "no-cache, must-revalidate" },
      })
      const res = await SELF.fetch(`${BASE}/u/t1/db.gz`, api({ cookie: await sessCookie(t1email) }))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("application/gzip")
      expect(res.headers.get("cache-control")).toBe("no-cache, must-revalidate")
      expect(res.headers.get("etag")).toBeTruthy()
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(gz)
   })

   it("404s a missing object", async () => {
      const res = await SELF.fetch(`${BASE}/u/t1/idx/999.gz`, api({ cookie: await sessCookie(t1email) }))
      expect(res.status).toBe(404)
   })

   it("cross-tenant reads 403 both ways", async () => {
      await env.STORE.put("u/t1/db.gz", gz)
      await env.STORE.put("u/t2/db.gz", gz)
      expect((await SELF.fetch(`${BASE}/u/t2/db.gz`, api({ cookie: await sessCookie(t1email) }))).status).toBe(403)
      expect((await SELF.fetch(`${BASE}/u/t1/db.gz`, api({ cookie: await sessCookie(t2email) }))).status).toBe(403)
   })

   it("anonymous object fetch 401s (JSON, not a redirect)", async () => {
      const res = await SELF.fetch(`${BASE}/u/t1/db.gz`, api())
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: string }).error).toBe("auth required")
   })

   it("answers If-None-Match with 304", async () => {
      await env.STORE.put("u/t1/db.gz", gz)
      const first = await SELF.fetch(`${BASE}/u/t1/db.gz`, api({ cookie: await sessCookie(t1email) }))
      const etag = first.headers.get("etag")!
      const res = await SELF.fetch(
         `${BASE}/u/t1/db.gz`,
         api({ cookie: await sessCookie(t1email), "if-none-match": etag }),
      )
      expect(res.status).toBe(304)
      // The guards are stamped on EGRESS, so even a bodyless answer carries them.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
   })

   it("412s a failed If-Match — a precondition is not a cache validator", async () => {
      await env.STORE.put("u/t1/db.gz", gz)
      const res = await SELF.fetch(
         `${BASE}/u/t1/db.gz`,
         api({ cookie: await sessCookie(t1email), "if-match": '"not-the-etag"' }),
      )
      expect(res.status).toBe(412)
   })

   // The store is served from the APP's origin here, so a feed-sourced object
   // that a browser would treat as a document must not be able to script it.
   it("stamps nosniff + sandbox on store bytes", async () => {
      await env.STORE.put("u/t1/assets/ab/0123456789abcdef.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", {
         httpMetadata: { contentType: "image/svg+xml" },
      })
      const res = await SELF.fetch(
         `${BASE}/u/t1/assets/ab/0123456789abcdef.svg`,
         api({ cookie: await sessCookie(t1email) }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("content-security-policy")).toBe("sandbox")
   })

   it("honors Range (media seeking)", async () => {
      const bytes = new Uint8Array(100).map((_, i) => i)
      await env.STORE.put("u/t1/assets/ab/0123456789abcdef.mp4", bytes, {
         httpMetadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000, immutable" },
      })
      const res = await SELF.fetch(
         `${BASE}/u/t1/assets/ab/0123456789abcdef.mp4`,
         api({ cookie: await sessCookie(t1email), range: "bytes=10-19" }),
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("content-range")).toBe("bytes 10-19/100")
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(10, 20))
   })

   it("denied backend-only classes 404 even for the owner", async () => {
      await env.STORE.put("u/t1/config.gz", gz)
      await env.STORE.put("u/t1/seen/441.gz", gz)
      await env.STORE.put("u/t1/inbox/gw.gz", gz)
      const cookie = await sessCookie(t1email)
      for (const key of ["config.gz", "seen/441.gz", "inbox/gw.gz"]) {
         const res = await SELF.fetch(`${BASE}/u/t1/${key}`, api({ cookie }))
         expect(res.status, key).toBe(404)
      }
   })
})

describe("sync.json", () => {
   it("GET 404s before the first push (sync.ts's seed signal)", async () => {
      await env.STORE.delete("u/t1/sync.json")
      const res = await SELF.fetch(`${BASE}/u/t1/sync.json`, api({ cookie: await sessCookie(t1email) }))
      expect(res.status).toBe(404)
   })

   it("PUT then GET round-trips the blob, no-cache", async () => {
      const blob = JSON.stringify({ v: 2, ts: 123, seen: {} })
      const cookie = await sessCookie(t1email)
      const put = await SELF.fetch(`${BASE}/u/t1/sync.json`, {
         method: "PUT",
         headers: { cookie, "content-type": "application/json" },
         body: blob,
      })
      expect(put.status).toBe(204)
      const get = await SELF.fetch(`${BASE}/u/t1/sync.json`, api({ cookie }))
      expect(get.status).toBe(200)
      expect(get.headers.get("cache-control")).toBe("no-cache")
      expect(get.headers.get("content-type")).toBe("application/json")
      expect(await get.text()).toBe(blob)
   })

   it("413s a declared oversize Content-Length, before the body is buffered", async () => {
      const res = await SELF.fetch(`${BASE}/u/t1/sync.json`, {
         method: "PUT",
         headers: { cookie: await sessCookie(t1email), "content-length": String(256 * 1024 + 1) },
         body: "{}",
      })
      expect(res.status).toBe(413)
   })

   it("413s an oversize body", async () => {
      const res = await SELF.fetch(`${BASE}/u/t1/sync.json`, {
         method: "PUT",
         headers: { cookie: await sessCookie(t1email) },
         body: "x".repeat(256 * 1024 + 1),
      })
      expect(res.status).toBe(413)
   })

   it("requires auth and the right tenant", async () => {
      expect((await SELF.fetch(`${BASE}/u/t1/sync.json`, { method: "PUT", body: "{}" })).status).toBe(401)
      expect(
         (
            await SELF.fetch(`${BASE}/u/t1/sync.json`, {
               method: "PUT",
               headers: { cookie: await sessCookie(t2email) },
               body: "{}",
            })
         ).status,
      ).toBe(403)
   })

   it("no-write invariant: PUT to every other route class is refused", async () => {
      const cookie = await sessCookie(t1email)
      for (const path of [
         "/u/t1/db.gz",
         "/u/t1/idx/0.gz",
         "/u/t1/",
         "/u/t1/config.gz",
         "/u/t1/frontend.abcdef12.js",
         "/",
      ]) {
         const res = await SELF.fetch(`${BASE}${path}`, {
            method: "PUT",
            headers: { cookie },
            body: "x",
            redirect: "manual",
         })
         expect(res.status, `PUT ${path}`).toBe(405)
      }
      // …and the store bytes did not change behind the 405s.
      expect(await env.STORE.get("u/t1/idx/0.gz")).toBeNull()
   })
})
