// -----------------------------------------------------------------------------
// The relying party: this worker as an OpenID Connect client. Web Crypto only,
// no dependencies — the runtime has everything a confidential client needs, and
// a library here would be a supply-chain surface in front of the sign-in.
//
// Shape: authorization code + PKCE, exchanged server-side once, after which
// session.ts mints this worker's own cookie and nothing here talks to the IdP
// again until it expires.
//
// Only the ISSUER is pinned in config. Endpoints and keys are read from the
// discovery document beneath it, so the IdP can move an endpoint or rotate a key
// without a deploy here — which a client holding its own copy of the signing key
// could never notice.
//
// The id_token verification is hand-rolled and follows one rule: **the algorithm
// is pinned, and the token's own header gets no vote.**
// -----------------------------------------------------------------------------
import { b64u, isObject, random, unb64u, utf8, utf8decode } from "./bytes"
import { clearSessionCookie, hasCookie, mintSession, sessionCookie, type SessionConfig } from "./session"

const SCOPE = "openid email"

// Pinned. The tenant's jwks_uri publishes RS256 too and this application is
// registered for EdDSA: one algorithm, one code path, no negotiation with a
// string an attacker controls.
const ALG = "EdDSA"

const FLOW_COOKIE = "__Host-srrlogin"
const FLOW_MAX_AGE_S = 15 * 60

// -----------------------------------------------------------------------------
// The "somebody just signed out here" marker, and why it has to exist.
//
// Log out ends THIS site's session and then hands the browser to the IdP's
// logout page, whose button ends the estate session. That second press is a
// human action on ANOTHER ORIGIN and cannot be made to happen: the IdP
// same-origin-checks it precisely so no other site can sign a visitor out.
//
// So the press can simply not happen — the user reads the signed-out page here,
// considers themselves logged out, and closes the tab. What follows is the bug:
// the next Sign in finds a live estate session, and /authorize issues a code for
// the SAME account with no form and no prompt. The user is silently signed back
// in as the person they just logged out of, with no way to reach anybody else —
// this provider refuses `select_account` on purpose (there is one session and no
// account picker).
//
// `prompt=login` is the parameter that exists for exactly this, and it is the
// one thing a relying party can do about a session it does not own. So a logout
// plants this marker and the next sign-in spends it.
//
// An hour, not a day: it covers "log out, then sign in as someone else" without
// turning every later visit into a forced login ceremony for somebody who has
// meanwhile signed in elsewhere on the estate and is entitled to SSO. `?switch=1`
// is the escape hatch with no clock on it at all.
const BYE_COOKIE = "__Host-srrbye"
const BYE_MAX_AGE_S = 60 * 60

export const byeCookie = () => `${BYE_COOKIE}=1; Max-Age=${BYE_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`

export const clearByeCookie = () => `${BYE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`

export interface OidcConfig {
   OIDC_ISSUER: string
   OIDC_CLIENT_ID: string
   OIDC_CLIENT_SECRET: string
}

interface Discovery {
   authorization_endpoint: string
   token_endpoint: string
   jwks_uri: string
}

interface VerifyKey {
   kid: string | null
   key: CryptoKey
}

const s256 = async (v: string) => b64u(await crypto.subtle.digest("SHA-256", utf8.encode(v)))

// ---------------------------------------------------------------- discovery --

// Cached for the life of the isolate. The document changes about as often as the
// IdP is redeployed, and a cold isolate paying one fetch on its first login is
// the entire cost of not hardcoding endpoints. A rejection is evicted so a
// transient failure does not persist for the life of the isolate.
const discoveryCache = new Map<string, Promise<Discovery>>()
const jwksCache = new Map<string, Promise<VerifyKey[]>>()

/** Test-only: drop the isolate-lifetime caches so a suite can re-stub the IdP. */
export function resetOidcCaches(): void {
   discoveryCache.clear()
   jwksCache.clear()
}

function discover(issuer: string): Promise<Discovery> {
   let hit = discoveryCache.get(issuer)
   if (hit === undefined) {
      hit = (async () => {
         const r = await fetch(`${issuer}/.well-known/openid-configuration`)
         if (!r.ok) throw new Error(`discovery ${r.status}`)
         const doc: unknown = await r.json()
         if (!isObject(doc) || doc.issuer !== issuer) throw new Error("issuer mismatch")
         for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
            if (typeof doc[k] !== "string") throw new Error(`discovery missing ${k}`)
         }
         return doc as unknown as Discovery
      })().catch((e: unknown) => {
         discoveryCache.delete(issuer)
         throw e
      })
      discoveryCache.set(issuer, hit)
   }
   return hit
}

// The Ed25519 verification keys the IdP publishes. Rebuilt from only the members
// that matter, so a stray `alg`/`use`/`key_ops` cannot ride along into the
// import — and a private JWK is refused rather than quietly making this worker
// an issuer.
function verifyKeys(uri: string): Promise<VerifyKey[]> {
   let hit = jwksCache.get(uri)
   if (hit === undefined) {
      hit = (async () => {
         const r = await fetch(uri)
         if (!r.ok) throw new Error(`jwks ${r.status}`)
         const doc: unknown = await r.json()
         if (!isObject(doc) || !Array.isArray(doc.keys)) throw new Error("jwks shape")
         const out: VerifyKey[] = []
         for (const jwk of doc.keys as unknown[]) {
            if (!isObject(jwk)) continue
            if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") continue
            if (jwk.d !== undefined) throw new Error("refusing a private JWK from jwks_uri")
            try {
               out.push({
                  kid: typeof jwk.kid === "string" ? jwk.kid : null,
                  key: await crypto.subtle.importKey(
                     "jwk",
                     { crv: "Ed25519", kty: "OKP", x: jwk.x },
                     { name: "Ed25519" },
                     false,
                     ["verify"],
                  ),
               })
            } catch {
               // One unusable key must not take the whole key set down.
            }
         }
         if (out.length === 0) throw new Error("no usable EdDSA keys")
         return out
      })().catch((e: unknown) => {
         jwksCache.delete(uri)
         throw e
      })
      jwksCache.set(uri, hit)
   }
   return hit
}

// --------------------------------------------------------------- the flow ----

interface Flow {
   state: string
   nonce: string
   verifier: string
   next: string
}

// Deliberately NOT signed. A signature would defend a tampered `next`, and
// `next` is validated on the way in instead; against anything else it buys
// nothing, because whoever can write a cookie on this host can also start a real
// login and be handed a validly signed one. `__Host-` plus the `state` check is
// what carries the weight.
const packFlow = (f: Flow) => b64u(utf8.encode(JSON.stringify(f)))

function readFlow(request: Request): Flow | null {
   for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=")
      if (eq === -1 || part.slice(0, eq).trim() !== FLOW_COOKIE) continue
      try {
         const f: unknown = JSON.parse(utf8decode.decode(unb64u(part.slice(eq + 1).trim())))
         if (
            isObject(f) &&
            typeof f.state === "string" &&
            typeof f.nonce === "string" &&
            typeof f.verifier === "string"
         ) {
            return {
               state: f.state,
               nonce: f.nonce,
               verifier: f.verifier,
               next: safeNext(f.next),
            }
         }
      } catch {
         // an unreadable flow cookie is no flow cookie
      }
   }
   return null
}

const flowCookie = (f: Flow) =>
   `${FLOW_COOKIE}=${packFlow(f)}; Max-Age=${FLOW_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`

const clearFlow = () => `${FLOW_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`

// Where to land afterwards. Caller-controlled and destined for a Location
// header, so it is validated here rather than trusted later: a same-origin
// absolute path, and nothing a browser could read as an authority. `//evil` and
// `/\evil` are the two spellings that turn a path into a host.
export function safeNext(raw: unknown): string {
   if (typeof raw !== "string" || !raw.startsWith("/")) return "/"
   if (raw.startsWith("//") || raw.startsWith("/\\")) return "/"
   if (raw.includes("\\")) return "/"
   return raw
}

// The redirect URI must match the registered string EXACTLY — the IdP compares
// it un-normalized, on purpose. Deriving it from this request's own origin means
// a login started on any other hostname builds a URI the IdP refuses to redirect
// to, which is the correct failure rather than a silent one.
const redirectUri = (request: Request) => `${new URL(request.url).origin}/auth/callback`

export async function beginLogin(request: Request, env: OidcConfig): Promise<Response> {
   const url = new URL(request.url)
   const flow: Flow = {
      state: random(16),
      nonce: random(16),
      // RFC 7636 wants 43-128 unreserved characters; 32 random bytes base64url is 43.
      verifier: random(32),
      next: safeNext(url.searchParams.get("next")),
   }

   // Two ways to demand a fresh authentication, and the difference is who asked.
   // The marker is this site remembering that the browser signed out here;
   // `switch=1` is the user saying so out loud, from a link that keeps working
   // after the marker has expired. Either means the same thing to the IdP.
   //
   // NOT sent on an ordinary sign-in, deliberately: `prompt=login` costs a login
   // ceremony every time, and a visitor arriving with a live estate session is
   // entitled to the SSO this design exists to provide.
   const reauth = url.searchParams.get("switch") === "1" || hasCookie(request, BYE_COOKIE)

   const doc = await discover(env.OIDC_ISSUER)
   const authorize = new URL(doc.authorization_endpoint)
   authorize.searchParams.set("response_type", "code")
   authorize.searchParams.set("client_id", env.OIDC_CLIENT_ID)
   authorize.searchParams.set("redirect_uri", redirectUri(request))
   authorize.searchParams.set("scope", SCOPE)
   authorize.searchParams.set("state", flow.state)
   authorize.searchParams.set("nonce", flow.nonce)
   authorize.searchParams.set("code_challenge", await s256(flow.verifier))
   authorize.searchParams.set("code_challenge_method", "S256")
   if (reauth) authorize.searchParams.set("prompt", "login")

   // The marker is NOT cleared here. It is spent by a login that COMPLETES, so a
   // demand the user abandoned halfway is still a demand the next attempt makes.
   return new Response(null, {
      status: 302,
      headers: {
         location: authorize.toString(),
         "set-cookie": flowCookie(flow),
         "cache-control": "no-store",
      },
   })
}

// --------------------------------------------------------------- leg two ----

// Fixed sentences chosen by lookup, never interpolation. Nothing the IdP or the
// browser sent is echoed back.
const REASONS = {
   no_flow: "This sign-in has expired. Please start again.",
   state: "This sign-in could not be verified. Please start again.",
   denied: "Sign-in was not completed.",
   exchange: "Could not complete sign-in. Please try again.",
   token: "Could not verify the sign-in. Please try again.",
} as const

const fail = (reason: keyof typeof REASONS) =>
   new Response(
      `<!doctype html><meta charset="utf-8"><title>Sign in</title>` +
         `<p>${REASONS[reason]}</p><p><a href="/auth/login">Try again</a></p>`,
      {
         status: 400,
         headers: {
            "content-type": "text/html; charset=utf-8",
            // Always cleared. A flow cookie left behind wedges every retry on a
            // state whose code has already been spent.
            "set-cookie": clearFlow(),
            "cache-control": "no-store",
            "x-robots-tag": "noindex",
         },
      },
   )

// Verify the id_token. Claims if it checks out, else null. Never throws, and
// never says which check rejected.
async function verifyIdToken(
   idToken: unknown,
   opts: { issuer: string; audience: string; jwksUri: string; nonce: string },
): Promise<Record<string, unknown> | null> {
   try {
      if (typeof idToken !== "string") return null
      const parts = idToken.split(".")
      if (parts.length !== 3) return null
      const [h, p, s] = parts

      const header: unknown = JSON.parse(utf8decode.decode(unb64u(h)))
      if (!isObject(header)) return null
      // The pinned algorithm, never the header's claim about it. `alg: none`
      // matches nothing here, which is the point.
      if (header.alg !== ALG) return null
      if ("crit" in header) return null

      const all = await verifyKeys(opts.jwksUri)
      // `kid` chooses WHICH key to ask, never whether to trust — the signature
      // decides that. An unknown kid falls back to trying them all, so a rotation
      // that adds a key is invisible.
      const named = typeof header.kid === "string" ? all.filter((k) => k.kid === header.kid) : []
      const candidates = named.length > 0 ? named : all

      // Signature before claims: nothing a forged payload says is worth reading.
      const sig = unb64u(s)
      const input = utf8.encode(`${h}.${p}`)
      let signed = false
      for (const { key } of candidates) {
         if (await crypto.subtle.verify({ name: "Ed25519" }, key, sig, input)) {
            signed = true
            break
         }
      }
      if (!signed) return null

      const claims: unknown = JSON.parse(utf8decode.decode(unb64u(p)))
      if (!isObject(claims)) return null

      const t = Math.floor(Date.now() / 1000)
      // A signature proves who minted a token, not who it was minted for.
      if (claims.iss !== opts.issuer) return null
      // `aud` may be a string or an array; either way it must name this client
      // and nothing this client has not been told about.
      const aud = Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [claims.aud]
      if (!aud.includes(opts.audience)) return null
      if (aud.length > 1 && claims.azp !== opts.audience) return null
      if (typeof claims.iat !== "number") return null
      if (typeof claims.exp !== "number" || t >= claims.exp) return null
      if ("nbf" in claims && (typeof claims.nbf !== "number" || claims.nbf > t)) return null
      if (typeof claims.sub !== "string" || claims.sub.length === 0) return null
      // OIDC Core §3.1.3.7 step 11. Without it, a token replayed from another
      // login verifies perfectly.
      if (claims.nonce !== opts.nonce) return null
      return claims
   } catch {
      return null
   }
}

export async function handleCallback(request: Request, env: OidcConfig & SessionConfig): Promise<Response> {
   const url = new URL(request.url)
   const flow = readFlow(request)
   if (!flow) return fail("no_flow")

   // The IdP reports failure by redirecting here with `error`; there is no code
   // to exchange and nothing to look up.
   if (url.searchParams.get("error")) return fail("denied")

   // Before anything is spent. This is what makes the callback belong to the
   // login this browser started rather than one an attacker started.
   if (url.searchParams.get("state") !== flow.state) return fail("state")

   const code = url.searchParams.get("code")
   if (typeof code !== "string" || code === "") return fail("state")

   let doc: Discovery
   let idToken: unknown
   try {
      doc = await discover(env.OIDC_ISSUER)
      // client_secret_basic. RFC 6749 §2.3.1 percent-encodes both halves before
      // base64 — a no-op for a base64url secret, but the rule is about the
      // format rather than about today's secret.
      const basic = btoa(`${encodeURIComponent(env.OIDC_CLIENT_ID)}:${encodeURIComponent(env.OIDC_CLIENT_SECRET)}`)
      const res = await fetch(doc.token_endpoint, {
         method: "POST",
         headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            authorization: `Basic ${basic}`,
         },
         body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri(request),
            code_verifier: flow.verifier,
         }).toString(),
      })
      if (!res.ok) return fail("exchange")
      const parsed: unknown = await res.json()
      if (!isObject(parsed) || typeof parsed.id_token !== "string") return fail("exchange")
      idToken = parsed.id_token
   } catch {
      return fail("exchange")
   }

   const claims = await verifyIdToken(idToken, {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_CLIENT_ID,
      jwksUri: doc.jwks_uri,
      nonce: flow.nonce,
   })
   if (claims === null) return fail("token")

   const email = typeof claims.email === "string" ? claims.email.toLowerCase() : ""
   if (!email) return fail("token")

   const token = await mintSession(env, { sub: claims.sub as string, email })

   const headers = new Headers({
      location: safeNext(flow.next),
      "cache-control": "no-store",
   })
   headers.append("set-cookie", sessionCookie(token))
   headers.append("set-cookie", clearFlow())
   // The sign-out has been answered by a sign-in, so the demand it planted must
   // not outlive it and force a re-authentication on the next visit too.
   headers.append("set-cookie", clearByeCookie())
   return new Response(null, { status: 302, headers })
}

// --------------------------------------------------------------- logout -----

// This site's own session ends HERE and unconditionally — that half is ours and
// always works — and the browser is then handed to the IdP's logout page, whose
// button ends the estate session. It cannot be done in one hop: that POST is
// same-origin-checked at the IdP precisely so another site cannot sign a visitor
// out, and this is another site. See BYE_COOKIE above for what the second press
// not happening costs, and what is planted against it.
//
// The IdP advertises no `end_session` endpoint, so this is a link to a page
// rather than a protocol step — hence the ORIGIN of the configured issuer
// (`/t/<tenant>` is the issuer path; `/logout` is not under it).
export function logout(request: Request, env: OidcConfig): Response {
   const origin = new URL(request.url).origin
   const idp = new URL(env.OIDC_ISSUER).origin
   const headers = new Headers({
      location: `${idp}/logout?next=${encodeURIComponent(`${origin}/`)}`,
      "cache-control": "no-store",
   })
   headers.append("set-cookie", clearSessionCookie())
   headers.append("set-cookie", byeCookie())
   return new Response(null, { status: 302, headers })
}
