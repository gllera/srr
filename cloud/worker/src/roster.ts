// AUTHORIZATION — the SaaS's own half of the auth split. Authentication belongs
// to the login app (auth.ts verifies its cookie); this roster decides what an
// authenticated email may reach, and is the per-user revocation lever the
// never-expiring cookies don't have (deactivate the entry, keep the uid).
//
// It arrives as the ROSTER binding — a JSON object of email → {uid, active} —
// rather than a literal in this file, for two reasons: a tenant list is
// DEPLOYMENT configuration, not source (this repo is public, and the mapping is
// personal data), and onboarding a user must not require a code change. Set it
// as a wrangler secret in production, in .dev.vars for local runs. Phase 2
// replaces it with the control plane's roster.
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
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
         for (const [email, v] of Object.entries(obj as Record<string, unknown>)) {
            // Fail CLOSED per row: a malformed entry is DROPPED, never defaulted.
            // `active: "false"` is truthy, so accepting a non-boolean here would
            // turn a typo into a live tenant.
            if (!v || typeof v !== "object") continue
            const { uid, active } = v as { uid?: unknown; active?: unknown }
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

export function rosterLookup(raw: string | undefined, email: string): RosterEntry | null {
   const entry = parseRoster(raw)[email.toLowerCase()]
   return entry && entry.active ? entry : null
}
