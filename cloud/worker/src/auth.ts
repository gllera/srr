// Verify-only port of the 32b.io token scheme (~/ws/32b/functions/_lib/auth.js):
// HMAC-SHA256, token = b64u(JSON payload) + "." + b64u(sig), sess payloads
// {t:'sess', e:<email>} with no expiry. This module only VERIFIES — the SaaS
// never mints sessions; login lives on www.32b.io. Same SESSION_SECRET.
const enc = new TextEncoder()

const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

export interface Session {
   e: string
}

export async function readSession(secret: string, token: string | null): Promise<Session | null> {
   if (!token) return null
   const [body, sig] = token.split(".")
   if (!body || !sig) return null
   try {
      const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
         "verify",
      ])
      if (!(await crypto.subtle.verify("HMAC", key, unb64u(sig), enc.encode(body)))) return null
      const payload = JSON.parse(new TextDecoder().decode(unb64u(body))) as Record<string, unknown>
      if (payload.t !== "sess") return null
      // Sess tokens omit x, but honor it when present — parity with readToken.
      if (payload.x !== undefined && (typeof payload.x !== "number" || payload.x < Date.now())) return null
      if (typeof payload.e !== "string" || !payload.e) return null
      return { e: payload.e }
   } catch {
      return null
   }
}

export function sessionToken(request: Request): string | null {
   const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sess=([^;]+)/)
   return m ? m[1] : null
}
