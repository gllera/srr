import { describe, expect, it } from "vitest"
import { SESSION_COOKIE, clearSessionCookie, getSession, mintSession, sessionCookie } from "../src/session"
import { b64u, unb64u, utf8, utf8decode } from "../src/bytes"

const env = { SESSION_HMAC_SECRET: "test-hmac-secret" }

const withCookie = (token: string) =>
   new Request("https://reader.example.com/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })

// Re-sign a mutated payload with the SAME key, so the case under test is the
// claim check rather than the signature check.
async function resign(token: string, mutate: (claims: Record<string, unknown>) => void): Promise<string> {
   const [h, p] = token.split(".")
   const claims = JSON.parse(utf8decode.decode(unb64u(p))) as Record<string, unknown>
   mutate(claims)
   const body = `${h}.${b64u(utf8.encode(JSON.stringify(claims)))}`
   const key = await crypto.subtle.importKey(
      "raw",
      utf8.encode(env.SESSION_HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
   )
   return `${body}.${b64u(await crypto.subtle.sign("HMAC", key, utf8.encode(body)))}`
}

describe("session", () => {
   it("round-trips an identity through mint and verify", async () => {
      const token = await mintSession(env, { sub: "u_01ABC", email: "reader@example.com" })
      const got = await getSession(withCookie(token), env)
      expect(got).toEqual({ sub: "u_01ABC", email: "reader@example.com" })
   })

   it("lowercases the email on the way out", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "Mixed.Case@Example.COM" })
      expect((await getSession(withCookie(token), env))?.email).toBe("mixed.case@example.com")
   })

   it("refuses a token signed with a different key", async () => {
      const token = await mintSession({ SESSION_HMAC_SECRET: "someone-elses-key" }, { sub: "u_1", email: "a@b.c" })
      expect(await getSession(withCookie(token), env)).toBeNull()
   })

   it("refuses a tampered payload", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      const [h, , s] = token.split(".")
      const forged = b64u(utf8.encode(JSON.stringify({ t: "sess", iss: "srr-reader", sub: "u_admin", exp: 2 ** 40 })))
      expect(await getSession(withCookie(`${h}.${forged}.${s}`), env)).toBeNull()
   })

   it("refuses a token whose issuer is not ours, however well signed", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      const other = await resign(token, (c) => (c.iss = "some-other-service"))
      expect(await getSession(withCookie(other), env)).toBeNull()
   })

   it("is dead ON its exp second, not after", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      const now = Math.floor(Date.now() / 1000)
      expect(await getSession(withCookie(await resign(token, (c) => (c.exp = now))), env)).toBeNull()
      expect(await getSession(withCookie(await resign(token, (c) => (c.exp = now + 5))), env)).not.toBeNull()
   })

   it("refuses a not-yet-valid token", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      const nbf = await resign(token, (c) => (c.nbf = Math.floor(Date.now() / 1000) + 60))
      expect(await getSession(withCookie(nbf), env)).toBeNull()
   })

   it("refuses a subject-less token", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      expect(await getSession(withCookie(await resign(token, (c) => (c.sub = ""))), env)).toBeNull()
   })

   it("refuses an alg the header renamed — the header gets no vote", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      const [, p, s] = token.split(".")
      const header = b64u(utf8.encode(JSON.stringify({ alg: "none", typ: "srrsess+jwt" })))
      expect(await getSession(withCookie(`${header}.${p}.${s}`), env)).toBeNull()
   })

   it("answers null with no cookie, a junk cookie, or no secret configured", async () => {
      expect(await getSession(new Request("https://reader.example.com/"), env)).toBeNull()
      expect(await getSession(withCookie("not-a-jwt"), env)).toBeNull()
      expect(await getSession(withCookie("a.b.c"), env)).toBeNull()
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      expect(await getSession(withCookie(token), { SESSION_HMAC_SECRET: "" })).toBeNull()
   })

   it("scopes its cookie host-only and clears it the same way", () => {
      const set = sessionCookie("tok")
      expect(set).toContain("__Host-")
      // `__Host-` is only honoured with Path=/ and no Domain, and a browser
      // silently ignores the whole Set-Cookie otherwise.
      expect(set).toContain("Path=/")
      expect(set).not.toContain("Domain")
      expect(set).toContain("HttpOnly")
      expect(set).toContain("Secure")
      expect(clearSessionCookie()).toContain("Max-Age=0")
   })
})
