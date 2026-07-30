// Test-only token FORGER — the sign-side mirror of src/auth.ts's verify,
// byte-compatible with ~/ws/32b/functions/_lib/auth.js makeToken.
import { env } from "cloudflare:test"

const enc = new TextEncoder()

const b64u = (bytes: Uint8Array) =>
   btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

export async function makeToken(payload: unknown, secret: string = env.SESSION_SECRET): Promise<string> {
   const body = b64u(enc.encode(JSON.stringify(payload)))
   const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
   ])
   const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))
   return `${body}.${b64u(sig)}`
}

export const sessCookie = async (email: string) => `sess=${await makeToken({ t: "sess", e: email })}`
