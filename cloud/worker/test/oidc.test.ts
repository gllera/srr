import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { fetchMock } from "cloudflare:test"
import { SESSION_COOKIE, getSession } from "../src/session"
import { b64u, utf8 } from "../src/bytes"
import { beginLogin, byeCookie, handleCallback, logout, resetOidcCaches, safeNext } from "../src/oidc"

const BASE = "https://reader.example.com"
const IDP = "https://idp.example.com"
const ISSUER = `${IDP}/t/tenant`

const cfg = {
   OIDC_ISSUER: ISSUER,
   OIDC_CLIENT_ID: "srr",
   OIDC_CLIENT_SECRET: "s3cret",
   SESSION_HMAC_SECRET: "test-hmac-secret",
}

const DISCOVERY = {
   issuer: ISSUER,
   authorization_endpoint: `${ISSUER}/authorize`,
   token_endpoint: `${ISSUER}/token`,
   jwks_uri: `${ISSUER}/jwks.json`,
}

let keys: CryptoKeyPair
// `exportKey("jwk", …)` is typed as ArrayBuffer | JsonWebKey; the "jwk"
// overload only ever returns the latter.
let publicJwk: object

const stubDiscovery = () =>
   fetchMock.get(IDP).intercept({ path: "/t/tenant/.well-known/openid-configuration" }).reply(200, DISCOVERY)

const stubJwks = (jwk: object = publicJwk) =>
   fetchMock
      .get(IDP)
      .intercept({ path: "/t/tenant/jwks.json" })
      .reply(200, { keys: [jwk] })

const stubToken = (body: object, status = 200) =>
   fetchMock.get(IDP).intercept({ path: "/t/tenant/token", method: "POST" }).reply(status, body)

async function signIdToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
   const h = b64u(utf8.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", ...header })))
   const p = b64u(utf8.encode(JSON.stringify(claims)))
   const sig = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, utf8.encode(`${h}.${p}`))
   return `${h}.${p}.${b64u(sig)}`
}

const goodClaims = (nonce: string, over: Record<string, unknown> = {}) => ({
   iss: ISSUER,
   aud: cfg.OIDC_CLIENT_ID,
   sub: "u_01ABCDEF",
   email: "Reader@Example.com",
   nonce,
   iat: Math.floor(Date.now() / 1000),
   exp: Math.floor(Date.now() / 1000) + 300,
   ...over,
})

// Leg one, run for real: the flow cookie and the state a callback must echo
// are produced here rather than hand-written, so a change to either shape
// cannot pass these tests while breaking the live handshake.
async function startLogin(headers: Record<string, string> = {}, query = "?next=%2F") {
   stubDiscovery()
   const res = await beginLogin(new Request(`${BASE}/auth/login${query}`, { headers }), cfg)
   const setCookie = res.headers.get("set-cookie") ?? ""
   const loc = new URL(res.headers.get("location") ?? "")
   return {
      res,
      loc,
      cookie: setCookie.split(";")[0],
      state: loc.searchParams.get("state") ?? "",
      nonce: loc.searchParams.get("nonce") ?? "",
   }
}

const callback = (cookie: string, query: string) =>
   handleCallback(new Request(`${BASE}/auth/callback${query}`, { headers: { cookie } }), cfg)

const setCookies = (res: Response) => res.headers.getSetCookie()

beforeAll(async () => {
   keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
   publicJwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as object
   fetchMock.activate()
   fetchMock.disableNetConnect()
})

afterAll(() => fetchMock.deactivate())

beforeEach(() => {
   // The discovery and JWKS caches live for the isolate, which is the right
   // production behaviour and the wrong test behaviour: without this, every case
   // after the first would silently reuse the first one's stubs.
   resetOidcCaches()
   // And a clean slate of interceptors, which is the same trap from the other
   // side. undici serves them in REGISTRATION order, and a case that registers a
   // stub it never consumes — trivial here, since `startLogin` stubs discovery
   // and two logins in one case only fetch it once — shifts every later case's
   // queue by one. Not hypothetical: it made two adjacent cases swap answers,
   // each passing the other's assertion.
   // Real on the undici MockPool, absent from the `Interceptable` type the
   // pool re-exports — hence the cast rather than a helpful API.
   ;(fetchMock.get(IDP) as unknown as { cleanMocks: () => void }).cleanMocks()
})

describe("safeNext", () => {
   it("keeps a same-origin path and rejects everything that could name a host", () => {
      expect(safeNext("/reader?x=1")).toBe("/reader?x=1")
      expect(safeNext("//evil.example.com")).toBe("/")
      expect(safeNext("/\\evil.example.com")).toBe("/")
      expect(safeNext("https://evil.example.com")).toBe("/")
      expect(safeNext("relative")).toBe("/")
      expect(safeNext(undefined)).toBe("/")
      expect(safeNext(42)).toBe("/")
   })
})

describe("beginLogin", () => {
   it("redirects to the discovered authorize endpoint with code + PKCE S256", async () => {
      const { res, loc, cookie } = await startLogin()
      expect(res.status).toBe(302)
      expect(loc.origin + loc.pathname).toBe(`${ISSUER}/authorize`)
      expect(loc.searchParams.get("response_type")).toBe("code")
      expect(loc.searchParams.get("client_id")).toBe("srr")
      expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/callback`)
      expect(loc.searchParams.get("scope")).toBe("openid email")
      expect(loc.searchParams.get("code_challenge_method")).toBe("S256")
      expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(loc.searchParams.get("state")).toBeTruthy()
      expect(loc.searchParams.get("nonce")).toBeTruthy()
      // No re-authentication demanded on an ordinary sign-in: prompt=login costs
      // a login ceremony, and a live estate session is entitled to SSO.
      expect(loc.searchParams.get("prompt")).toBeNull()
      expect(cookie.startsWith("__Host-srrlogin=")).toBe(true)
   })

   it("mints a fresh state and verifier per attempt", async () => {
      const a = await startLogin()
      const b = await startLogin()
      expect(a.state).not.toBe(b.state)
      expect(a.loc.searchParams.get("code_challenge")).not.toBe(b.loc.searchParams.get("code_challenge"))
   })

   it("demands re-authentication after a sign-out, and on an explicit switch", async () => {
      const afterBye = await startLogin({ cookie: byeCookie().split(";")[0] })
      expect(afterBye.loc.searchParams.get("prompt")).toBe("login")
      const explicit = await startLogin({}, "?switch=1")
      expect(explicit.loc.searchParams.get("prompt")).toBe("login")
   })
})

describe("handleCallback", () => {
   it("completes the handshake and mints this worker's own session", async () => {
      const { cookie, state, nonce } = await startLogin()
      stubToken({ id_token: await signIdToken(goodClaims(nonce)) })
      stubJwks()

      const res = await callback(cookie, `?code=abc&state=${state}`)
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe("/")

      const cookies = setCookies(res)
      const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      expect(session).toBeTruthy()
      // The flow is spent and the sign-out demand is answered by a sign-in.
      expect(cookies.some((c) => c.startsWith("__Host-srrlogin=;"))).toBe(true)
      expect(cookies.some((c) => c.startsWith("__Host-srrbye=;"))).toBe(true)

      const token = session!.slice(`${SESSION_COOKIE}=`.length).split(";")[0]
      const identity = await getSession(new Request(BASE, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), cfg)
      expect(identity).toEqual({ sub: "u_01ABCDEF", email: "reader@example.com" })
   })

   it("lands on the validated next path, never on an attacker's origin", async () => {
      const withNext = await startLogin({}, "?next=%2Freader%3Fx%3D1")
      stubToken({ id_token: await signIdToken(goodClaims(withNext.nonce)) })
      stubJwks()
      expect((await callback(withNext.cookie, `?code=abc&state=${withNext.state}`)).headers.get("location")).toBe(
         "/reader?x=1",
      )

      const offsite = await startLogin({}, "?next=%2F%2Fevil.example.com")
      stubToken({ id_token: await signIdToken(goodClaims(offsite.nonce)) })
      stubJwks()
      expect((await callback(offsite.cookie, `?code=abc&state=${offsite.state}`)).headers.get("location")).toBe("/")
   })

   it("refuses a callback with no flow cookie", async () => {
      const res = await callback("", "?code=abc&state=whatever")
      expect(res.status).toBe(400)
      expect(setCookies(res).some((c) => c.startsWith("__Host-srrlogin=;"))).toBe(true)
   })

   it("refuses a state that is not the one this browser started with", async () => {
      const { cookie } = await startLogin()
      const res = await callback(cookie, "?code=abc&state=not-mine")
      expect(res.status).toBe(400)
   })

   it("refuses a callback carrying the IdP's error instead of a code", async () => {
      const { cookie, state } = await startLogin()
      expect((await callback(cookie, `?error=access_denied&state=${state}`)).status).toBe(400)
   })

   it("refuses a callback with a matching state but no code", async () => {
      const { cookie, state } = await startLogin()
      expect((await callback(cookie, `?state=${state}`)).status).toBe(400)
   })

   it("fails closed when the token exchange does", async () => {
      const { cookie, state } = await startLogin()
      stubToken({ error: "invalid_grant" }, 400)
      expect((await callback(cookie, `?code=abc&state=${state}`)).status).toBe(400)
   })

   it("fails closed when the exchange answers without an id_token", async () => {
      const { cookie, state } = await startLogin()
      stubToken({ access_token: "at" })
      expect((await callback(cookie, `?code=abc&state=${state}`)).status).toBe(400)
   })

   // Everything below is a well-formed exchange whose TOKEN is wrong in exactly
   // one way. Each of them verifies perfectly if its own check is deleted.
   const rejects: [string, () => Promise<Record<string, unknown>> | Record<string, unknown>][] = [
      ["a nonce from another login", () => goodClaims("some-other-login")],
      ["an issuer that is not the pinned one", () => goodClaims("", { iss: `${IDP}/t/somebody-else` })],
      ["an audience that is not this client", () => goodClaims("", { aud: "another-app" })],
      [
         "a multi-audience token that does not name us as the authorized party",
         () => goodClaims("", { aud: ["srr", "another-app"], azp: "another-app" }),
      ],
      ["an expired token", () => goodClaims("", { exp: Math.floor(Date.now() / 1000) - 1 })],
      ["a not-yet-valid token", () => goodClaims("", { nbf: Math.floor(Date.now() / 1000) + 300 })],
      ["a subject-less token", () => goodClaims("", { sub: "" })],
      ["a token with no email to key an identity on", () => goodClaims("", { email: undefined })],
   ]

   for (const [what, make] of rejects) {
      it(`refuses ${what}`, async () => {
         const { cookie, state, nonce } = await startLogin()
         const claims = await make()
         // The nonce cases carry their own; everything else gets the real one so
         // the nonce check is not what rejects it.
         if (claims.nonce === "") claims.nonce = nonce
         stubToken({ id_token: await signIdToken(claims) })
         stubJwks()
         expect((await callback(cookie, `?code=abc&state=${state}`)).status).toBe(400)
      })
   }

   it("refuses a token signed by a key the IdP does not publish", async () => {
      const { cookie, state, nonce } = await startLogin()
      const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
      stubToken({ id_token: await signIdToken(goodClaims(nonce)) })
      stubJwks((await crypto.subtle.exportKey("jwk", other.publicKey)) as object)
      expect((await callback(cookie, `?code=abc&state=${state}`)).status).toBe(400)
   })

   it("refuses an alg the header renamed — the header gets no vote", async () => {
      const { cookie, state, nonce } = await startLogin()
      stubToken({ id_token: await signIdToken(goodClaims(nonce), { alg: "none" }) })
      expect((await callback(cookie, `?code=abc&state=${state}`)).status).toBe(400)
   })

   it("tries every published key when the kid names none of them", async () => {
      const { cookie, state, nonce } = await startLogin()
      stubToken({ id_token: await signIdToken(goodClaims(nonce), { kid: "rotated-away" }) })
      stubJwks({ ...publicJwk, kid: "current" })
      expect((await callback(cookie, `?code=abc&state=${state}`)).status).toBe(302)
   })
})

describe("logout", () => {
   it("ends this site's session and hands the browser to the IdP's logout page", () => {
      const res = logout(new Request(`${BASE}/auth/logout`, { method: "POST" }), cfg)
      expect(res.status).toBe(302)
      const loc = new URL(res.headers.get("location") ?? "")
      // The issuer's ORIGIN: /logout is not under the tenant path.
      expect(loc.origin + loc.pathname).toBe(`${IDP}/logout`)
      expect(loc.searchParams.get("next")).toBe(`${BASE}/`)

      const cookies = setCookies(res)
      expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true)
      // The half we cannot do — the press on the IdP's own button — is what the
      // marker is planted against.
      expect(cookies.some((c) => c.startsWith("__Host-srrbye=1"))).toBe(true)
   })
})
