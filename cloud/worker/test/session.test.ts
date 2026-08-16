import { describe, expect, it } from "vitest"
import {
   SESSION_ALG,
   SESSION_COOKIE,
   SESSION_ISS,
   SESSION_TYP,
   clearSessionCookie,
   getSession,
   mintSession,
   sessionCookie,
} from "../src/session"
import { b64u, unb64u, utf8, utf8decode } from "../src/bytes"
import { byeCookie, clearByeCookie } from "../src/oidc"

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

   // EVERY cookie this product sets, not just the session's. They all run
   // through session.ts's setCookie now, and this is what that buys: the flow
   // cookie (whose loss is a sign-in that cannot complete) and the bye marker
   // (whose loss is a silent re-auth regression) used to spell the attribute
   // string by hand and were pinned by nothing. A `__Host-` cookie missing
   // Path=/ or Secure is DROPPED silently — no error, no warning.
   it.each([
      ["session", sessionCookie("tok")],
      ["session cleared", clearSessionCookie()],
      ["bye", byeCookie()],
      ["bye cleared", clearByeCookie()],
   ])("scopes the %s cookie host-only", (_name, set) => {
      expect(set).toContain("__Host-")
      expect(set).toContain("Path=/")
      expect(set).not.toContain("Domain")
      expect(set).toContain("HttpOnly")
      expect(set).toContain("Secure")
      expect(set).toContain("SameSite=Lax")
   })

   // The WIRE SHAPE, pinned because something outside this package rebuilds it:
   // cloud/e2e/smoke.mjs mints a session in plain Node (it cannot import this
   // module) and its comment claims this suite keeps the two byte-compatible.
   // That was not true of a round-trip test — mint and verify move together, so
   // every literal could change with the suite still green, and the smoke would
   // then fail with every check 401ing, the least diagnosable shape there is.
   it("mints the exact header and claim set the outside minter rebuilds", async () => {
      const token = await mintSession(env, { sub: "u_1", email: "a@b.c" })
      const [h, p] = token.split(".")
      expect(JSON.parse(utf8decode.decode(unb64u(h)))).toEqual({ alg: SESSION_ALG, typ: SESSION_TYP })
      const claims = JSON.parse(utf8decode.decode(unb64u(p))) as Record<string, unknown>
      expect(Object.keys(claims).sort()).toEqual(["email", "exp", "iat", "iss", "sub", "t"])
      expect(claims.iss).toBe(SESSION_ISS)
      expect(claims.t).toBe("sess")
   })

   it("clears by expiring rather than by emptying alone", () => {
      expect(clearSessionCookie()).toContain("Max-Age=0")
      expect(clearByeCookie()).toContain("Max-Age=0")
   })
})
