// The JWS checks both token verifiers make identically.
//
// Same argument as bytes.ts, one layer up: there are TWO verifiers — session.ts
// checks a token this worker minted, oidc.ts checks one the IdP minted — and a
// temporal check that is strict in one and lax in the other is a difference
// nothing would notice until it mattered. What stays per-verifier is what
// genuinely differs: the signature algorithm, and the claims that name the
// audience (`t`/`iss` here, `aud`/`azp`/`nonce` there).
import { isObject, unb64u, utf8decode } from "./bytes"

/**
 * Split a compact JWS and pin the header. Returns the still-ENCODED payload
 * alongside the signing input and signature — decoding the payload is the
 * caller's job, deliberately, so that nothing a forged payload says can be read
 * before the signature has been checked.
 */
export function openJws(
   token: string,
   alg: string,
   typ?: string,
): { header: Record<string, unknown>; payload: string; sig: Uint8Array; input: string } | null {
   const parts = token.split(".")
   if (parts.length !== 3) return null
   const [h, p, s] = parts

   const header: unknown = JSON.parse(utf8decode.decode(unb64u(h)))
   if (!isObject(header)) return null
   // The pinned algorithm, never the header's claim about it. `alg: none`
   // matches nothing here, which is the point.
   if (header.alg !== alg) return null
   if (typ !== undefined && header.typ !== typ) return null
   // An extension the verifier does not understand must not be ignored.
   if ("crit" in header) return null

   // `header` rides along for the ONE member a caller may legitimately read
   // before verifying: `kid`, which chooses which key to ask and never whether
   // to trust. The payload stays encoded.
   return { header, payload: p, sig: unb64u(s), input: `${h}.${p}` }
}

/**
 * The four standard claims both verifiers require identically: a numeric `iat`,
 * an `exp` that has not arrived (dead ON its exp second, not after), an `nbf`
 * that has, and a non-empty `sub`.
 */
export function timeAndSubjectOk(claims: Record<string, unknown>, now: number): boolean {
   if (typeof claims.iat !== "number") return false
   if (typeof claims.exp !== "number" || now >= claims.exp) return false
   if ("nbf" in claims && (typeof claims.nbf !== "number" || claims.nbf > now)) return false
   if (typeof claims.sub !== "string" || claims.sub.length === 0) return false
   return true
}
