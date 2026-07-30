// AUTHORIZATION — the SaaS's own half of the auth split. Authentication is
// 32b.io's (auth.ts verifies its cookie); this roster decides what an
// authenticated email may reach, and is the per-user revocation lever the
// never-expiring cookies don't have (deactivate the entry, keep the uid).
// Phase 2 replaces this hardcoded map with the control plane's roster.
export interface RosterEntry {
   uid: string
   active: boolean
}

export const ROSTER: Record<string, RosterEntry> = {
   "gabriellleragarcia@gmail.com": { uid: "t1", active: true },
   // Second test identity for cross-tenant isolation checks. Swap for a real
   // mailbox the operator controls before deploying (magic-link login needs it).
   "srr-t2@example.invalid": { uid: "t2", active: true },
   // Pins revocation semantics: present but deactivated ⇒ 403, same as unknown.
   "inactive@test.invalid": { uid: "t9", active: false },
}

export function rosterLookup(email: string): RosterEntry | null {
   const entry = ROSTER[email.toLowerCase()]
   return entry && entry.active ? entry : null
}
