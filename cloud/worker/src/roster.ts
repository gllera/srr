// AUTHORIZATION — the SaaS's own half of the auth split. Authentication is OIDC
// against the estate's IdP (oidc.ts) plus this worker's own session cookie
// (session.ts); this roster decides what an authenticated email may reach.
//
// It is also the per-user revocation lever — and the ONLY one there is.
// Verifying a session locally cannot honour a sign-out at the IdP, so nothing
// but the token's own 30-day `exp` ends it (session.ts, KNOW THE LIMIT).
// Deactivating an entry here is what takes effect on the next request.
//
// It arrives as the ROSTER binding — a JSON object of email → {uid, active} —
// rather than a literal in this file, for two reasons: a tenant list is
// DEPLOYMENT configuration, not source (this repo is public, and the mapping is
// personal data), and onboarding a user must not require a code change. Set it
// as a wrangler secret in production, in .dev.vars for local runs. Phase 2
// replaces it with the control plane's roster.
import { isObject } from "./bytes"
import { UID_RE } from "./router"

export interface RosterEntry {
   uid: string
   active: boolean
}

// Parsed once per distinct raw string, not once per request: an isolate serves
// many requests and re-parsing the whole tenant list on each is pure waste.
let memoRaw: string | undefined
let memoParsed: Record<string, RosterEntry> = {}

export function parseRoster(raw: string | undefined): Record<string, RosterEntry> {
   if (raw === memoRaw) return memoParsed
   const out: Record<string, RosterEntry> = {}
   try {
      const obj: unknown = JSON.parse(raw || "{}")
      if (isObject(obj)) {
         for (const [email, v] of Object.entries(obj)) {
            // Fail CLOSED per row: a malformed entry is DROPPED, never defaulted.
            // `active: "false"` is truthy, so accepting a non-boolean here would
            // turn a typo into a live tenant.
            if (!isObject(v)) continue
            const { uid, active } = v
            if (typeof uid !== "string" || typeof active !== "boolean") continue
            // Authorization is an equality test against a uid the router already
            // validated, so a row failing this could never match a request — drop
            // it here as well, and the `/` redirect can't be handed one either.
            if (!UID_RE.test(uid)) continue
            out[email.toLowerCase()] = { uid, active }
         }
      }
   } catch {
      // An unparseable roster authorizes NOBODY (every request 401/403s) rather
      // than falling back to a previous value: silently serving a stale roster
      // would keep a revoked tenant alive, which is the one thing this file owns.
   }
   memoRaw = raw
   memoParsed = out
   return out
}

/**
 * The tenant an authenticated address owns, or null if it owns none — which is
 * the whole question a caller has. `active` is spent HERE rather than handed
 * out: a deactivated row and an absent row authorize exactly the same nothing,
 * so returning the entry would only give every caller a second chance to forget
 * the check.
 */
export function rosterUid(raw: string | undefined, email: string): string | null {
   const entry = parseRoster(raw)[email.toLowerCase()]
   return entry && entry.active ? entry.uid : null
}
