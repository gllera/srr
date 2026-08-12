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

// `__Host-` forbids Domain and pins Path=/, so a browser only ever returns this
// cookie to the exact host that set it and no other host can write the name.
export const SESSION_COOKIE = "__Host-srrsess"

// Who signed it, checked on the way in: one HMAC key is only a boundary if the
// issuer is checked too. A NAME rather than this deployment's hostname on
// purpose — the hostname is operator config that stays out of this public repo,
// and the claim's whole job is to stop a token minted by some other service
// that happens to share the key from verifying here.
const SESSION_ISS = "srr-reader"
const SESSION_TYP = "srrsess+jwt"

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
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
   let hit = keyCache.get(secret)
   if (hit === undefined) {
      hit = crypto.subtle
         .importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
         .catch((e: unknown) => {
            keyCache.delete(secret)
            throw e
         })
      keyCache.set(secret, hit)
   }
   return hit
}

/** Mint this worker's session token for an identity the IdP has just vouched for. */
export async function mintSession(env: SessionConfig, { sub, email }: { sub: string; email: string }): Promise<string> {
   const now = Math.floor(Date.now() / 1000)
   const header = b64u(utf8.encode(JSON.stringify({ alg: "HS256", typ: SESSION_TYP })))
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

export const sessionCookie = (token: string) =>
   `${SESSION_COOKIE}=${token}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`

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
      const parts = token.split(".")
      if (parts.length !== 3) return null
      const [h, p, s] = parts

      const header: unknown = JSON.parse(utf8decode.decode(unb64u(h)))
      if (!isObject(header)) return null
      // Pinned, never the header's claim about itself.
      if (header.alg !== "HS256") return null
      if (header.typ !== SESSION_TYP) return null
      if ("crit" in header) return null

      // Signature before claims: nothing a forged payload says is worth reading.
      const ok = await crypto.subtle.verify(
         "HMAC",
         await hmacKey(env.SESSION_HMAC_SECRET),
         unb64u(s),
         utf8.encode(`${h}.${p}`),
      )
      if (!ok) return null

      const claims: unknown = JSON.parse(utf8decode.decode(unb64u(p)))
      if (!isObject(claims)) return null

      const now = Math.floor(Date.now() / 1000)
      if (claims.iss !== SESSION_ISS) return null
      if (claims.t !== "sess") return null
      if (typeof claims.iat !== "number") return null
      // Dead ON its exp second, not after.
      if (typeof claims.exp !== "number" || now >= claims.exp) return null
      if ("nbf" in claims && (typeof claims.nbf !== "number" || claims.nbf > now)) return null
      if (typeof claims.sub !== "string" || claims.sub.length === 0) return null

      return {
         sub: claims.sub,
         email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
      }
   } catch {
      return null
   }
}
