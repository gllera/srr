// This worker's OWN session — the cookie it mints once the IdP has vouched for
// an identity, and the gate every request reads.
//
// It is deliberately NOT the IdP's session. That cookie carries the `__Host-`
// prefix, which forbids a Domain attribute and so pins it host-only to the IdP:
// no product can read it, and none is meant to. A consumer holding a cookie the
// IdP signed cannot tell a real session from a planted one, and making the
// cookie unreachable is exactly how that hole was closed. Speaking OIDC and
// minting our own is the whole answer; there is no second, cheaper one.
//
// KNOW THE LIMIT: verifying locally does not honour a sign-out at the IdP. Only
// this token's own `exp` ends it. That is the deliberate cost of a confidential
// client that does not talk to the IdP again until the session expires, and the
// number below is a statement about how long a stale sign-out may last.
import { b64u, isObject, unb64u, utf8, utf8decode } from "./bytes"
import { openJws, timeAndSubjectOk } from "./jws"
import { memoAsync } from "./memo"

// `__Host-` forbids Domain and pins Path=/, so a browser only ever returns this
// cookie to the exact host that set it and no other host can write the name.
export const SESSION_COOKIE = "__Host-srrsess"

// Who signed it, checked on the way in: one HMAC key is only a boundary if the
// issuer is checked too. A NAME rather than this deployment's hostname on
// purpose — the hostname is operator config that stays out of this public repo,
// and the claim's whole job is to stop a token minted by some other service
// that happens to share the key from verifying here.
// Historical and SHARED by both workers on purpose: a cloud-worker session also
// says `srr-reader`. What separates the two deployments is their distinct
// SESSION_HMAC_SECRET, not this claim — renaming it would sign out every live
// session for a label. The claim's job is to stop a token minted by some other
// service that happens to share the key from verifying here.
export const SESSION_ISS = "srr-reader"
export const SESSION_TYP = "srrsess+jwt"
// The third wire value, named rather than spelled twice (mint and verify).
export const SESSION_ALG = "HS256"

// Matches the IdP's own session length.
const MAX_AGE_S = 30 * 24 * 60 * 60

export interface SessionConfig {
   SESSION_HMAC_SECRET: string
}

export interface Identity {
   sub: string
   email: string | null
}

// Imports are a pure function of the secret text, so caching by it saves an
// import per gated request in a warm isolate.
const hmacKey = memoAsync((secret: string) =>
   crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
)

/** Mint this worker's session token for an identity the IdP has just vouched for. */
export async function mintSession(env: SessionConfig, { sub, email }: { sub: string; email: string }): Promise<string> {
   const now = Math.floor(Date.now() / 1000)
   const header = b64u(utf8.encode(JSON.stringify({ alg: SESSION_ALG, typ: SESSION_TYP })))
   const payload = b64u(
      utf8.encode(
         JSON.stringify({
            t: "sess",
            iss: SESSION_ISS,
            sub,
            email,
            iat: now,
            exp: now + MAX_AGE_S,
         }),
      ),
   )
   const input = `${header}.${payload}`
   const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_HMAC_SECRET), utf8.encode(input))
   return `${input}.${b64u(sig)}`
}

// ONE owner for the attribute string, because a `__Host-` cookie missing `Path=/`
// or `Secure` is SILENTLY DROPPED by the browser — no error, no warning, just a
// sign-in that cannot complete or a marker that never arrives. Six hand-written
// spellings of a rule whose violation is invisible is five too many.
export const setCookie = (name: string, value: string, maxAgeS: number) =>
   `${name}=${value}; Max-Age=${maxAgeS}; Path=/; HttpOnly; Secure; SameSite=Lax`

export const clearCookie = (name: string) => setCookie(name, "", 0)

export const sessionCookie = (token: string) => setCookie(SESSION_COOKIE, token, MAX_AGE_S)

export const clearSessionCookie = () => clearCookie(SESSION_COOKIE)

// One candidate, by construction: `__Host-` means no other host can write this
// name, so there is no plant to sort ahead of the real cookie.
export function cookieValue(header: string | null, name: string): string | null {
   for (const part of (header ?? "").split(";")) {
      const eq = part.indexOf("=")
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
   }
   return null
}

// Presence only — a marker cookie carries no value worth reading.
export function hasCookie(request: Request, name: string): boolean {
   return cookieValue(request.headers.get("cookie"), name) !== null
}

/** The identity behind the request's session cookie, or null. Never throws. */
export async function getSession(request: Request, env: SessionConfig): Promise<Identity | null> {
   if (!env.SESSION_HMAC_SECRET) {
      // Nothing sits behind this: an unset secret refuses every session on the
      // site. Name it, or the symptom reads as a site-wide sign-out with no cause.
      console.log("SESSION_HMAC_SECRET is not set — no session can be verified")
      return null
   }

   const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE)
   if (!token) return null

   try {
      // Pinned alg and typ, never the header's claim about itself.
      const jws = openJws(token, SESSION_ALG, SESSION_TYP)
      if (!jws) return null

      // Signature before claims: nothing a forged payload says is worth reading.
      const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_HMAC_SECRET), jws.sig, jws.signed)
      if (!ok) return null

      const claims: unknown = JSON.parse(utf8decode.decode(unb64u(jws.payload)))
      if (!isObject(claims)) return null

      // Who signed it, and that it is a session rather than some other token
      // this key might one day sign. The rest is the shared standard block.
      if (claims.iss !== SESSION_ISS) return null
      if (claims.t !== "sess") return null
      if (!timeAndSubjectOk(claims, Math.floor(Date.now() / 1000))) return null

      return {
         sub: claims.sub as string,
         email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
      }
   } catch {
      return null
   }
}
