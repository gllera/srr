// The encoding primitives both token verifiers share.
//
// They live in their own module because there are TWO of them — session.ts
// verifies a token this worker minted, oidc.ts verifies one the IdP minted —
// and a base64url decoder that is strict in one and lax in the other is a
// difference nothing would ever notice until it mattered.
export const utf8 = new TextEncoder()
export const utf8decode = new TextDecoder()

export const isObject = (v: unknown): v is Record<string, unknown> =>
   typeof v === "object" && v !== null && !Array.isArray(v)

export const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
   let bin = ""
   for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
   return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Strict: the JWS alphabet only, no padding, none of plain base64's `+/=`
// smuggled in. Throws; every caller answers null.
export function unb64u(s: string): Uint8Array {
   if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url")
   const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
   const out = new Uint8Array(bin.length)
   for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
   return out
}

export const random = (n: number): string => b64u(crypto.getRandomValues(new Uint8Array(n)))
