// schema.ts — the device localStorage SHAPE version gate (finding ENG6).
//
// Everything else this reader persists is versioned only by the tolerance of its
// readers. profile.ts's export blob carries `v:2` because it travels BETWEEN
// devices, but the localStorage keys themselves carry no version at all, so
// every shape change so far has been absorbed implicitly: parsers that shrug at
// anything unexpected (profile.ts's v1/v2 interop, every `try { JSON.parse } catch
// { return {} }`) plus nav.pruneSeen's sweeps of keys that stopped meaning
// anything. That has worked because no change has ever been BREAKING. This
// module is the hook for the first one that is: one global `srr-schema` key,
// read once at boot, and a migration ladder with an obvious place to put it.
//
// It is deliberately NOT a validator and NOT a reset. Nothing here inspects,
// repairs, wipes or rewrites any stored value — the only writes it makes are to
// its own key, plus whatever a registered migration does. The tolerant-reader
// contract stays exactly as it is; this just gives a breaking change somewhere
// to hang a real migration instead of another tolerance branch.
//
// Side-effect-free at import (the gate runs only when ensureSchema() is called),
// and it imports keys.ts alone — the same rule profile.ts and urlish.ts follow,
// so it unit-tests without a pack server.

import { SCHEMA_KEY } from "./keys"

// The shape every key in keys.ts has today. Bump it in the SAME commit that
// changes a stored shape, and add the rung that carries the old one forward.
export const SCHEMA_VERSION = 1

// The version an UNSTAMPED device is at: the shape as it stood when this gate
// shipped. An absent key means "never ran a build carrying the gate", which is
// precisely that shape — NOT "whatever is current" — so the ladder stays correct
// once SCHEMA_VERSION moves past it. Today the two are equal, which is why the
// absent case is a plain stamp and no migration runs on any existing device.
// Never bump this; it is a historical fact, not a setting.
const LEGACY_VERSION = 1

export interface Migration {
   // The SCHEMA_VERSION this rung produces. It is applied when the device's
   // version is BELOW it, rungs ascending, so a device two versions behind walks
   // every rung in between.
   to: number
   // Must be idempotent. Two ways it gets re-run: the stamp write can fail
   // (quota, a private-mode storage that reads but won't write), and a corrupt
   // stamp is read as LEGACY_VERSION rather than as current — re-running an
   // idempotent migration is recoverable, skipping a needed one is not.
   run: () => void
}

// EMPTY BUT REAL. The first breaking shape change adds its rung here —
//
//    const MIGRATIONS: Migration[] = [
//       { to: 2, run: () => { /* rewrite the old key into the new one */ } },
//    ]
//
// — and bumps SCHEMA_VERSION to 2 in the same commit. Keep them ascending by
// `to` (ensureSchema sorts a copy, but a reader should not have to check).
const MIGRATIONS: Migration[] = []

export type SchemaAction =
   // The key was absent (or held unreadable garbage) and the device is already
   // at the current shape: stamped, nothing migrated. The case that runs on
   // every device shipping today, exactly once.
   | "stamped"
   // The stamp already equals SCHEMA_VERSION — no read, no write, no work.
   | "current"
   // The stamp was lower: the ladder ran and the stamp advanced.
   | "migrated"
   // The stamp is HIGHER — an older build meeting state a newer one wrote. See
   // ensureSchema: warn, change nothing.
   | "ahead"
   // localStorage is not usable at all (Safari private mode, storage disabled by
   // policy). Nothing was read or written; boot continues untouched.
   | "unavailable"

export interface SchemaResult {
   action: SchemaAction
   // The version found in storage; 0 when absent, corrupt or unavailable.
   from: number
   // The version in storage when ensureSchema returned. Equals the target
   // version except on "ahead" (left alone on purpose), "unavailable", or a
   // migration that threw partway (stamped at the last rung that completed).
   to: number
}

function readRaw(): { ok: boolean; raw: string | null } {
   try {
      return { ok: true, raw: localStorage.getItem(SCHEMA_KEY) }
   } catch {
      // Storage disabled outright. Distinguished from an absent key because
      // there is nothing to stamp and nothing to migrate.
      return { ok: false, raw: null }
   }
}

function writeVersion(v: number): boolean {
   try {
      localStorage.setItem(SCHEMA_KEY, String(v))
      return true
   } catch {
      return false
   }
}

// A stored stamp is a positive integer decimal or it is nothing. Anything else
// (a truncated write, a hand-edited value, a key some other tool squatted on)
// carries no usable version information — 0, the same answer as absent.
function parseVersion(raw: string | null): number {
   if (raw === null || raw === "") return 0
   const n = Number(raw)
   return Number.isInteger(n) && n > 0 ? n : 0
}

// ensureSchema is the boot gate. Four branches, none of which may break boot and
// none of which destroys state:
//
//   absent  → stamp. Every device shipping today is by definition at the current
//             shape, so this is a stamp, not a migration.
//   equal   → nothing.
//   lower   → run the registered migrations in ascending order, then stamp.
//   higher  → an older build opened after a newer one wrote this device's state.
//             WARN and leave everything alone. Wiping or resetting would throw
//             away a real person's read frontiers and ★-Saved queue for the
//             crime of opening a stale tab, and this codebase's answer to
//             unexpected stored shapes has always been to read them tolerantly
//             (profile.ts's v1/v2 interop, nav.pruneSeen). The stamp is left at
//             the higher value too — writing it down would make the newer build
//             re-run its own migrations on its next boot.
//
// `opts` exists so the ladder is testable while it is still empty (and so a
// future rung can be exercised in isolation); production calls this bare.
export function ensureSchema(opts: { version?: number; migrations?: Migration[] } = {}): SchemaResult {
   const target = opts.version ?? SCHEMA_VERSION
   const migrations = opts.migrations ?? MIGRATIONS

   const { ok, raw } = readRaw()
   if (!ok) return { action: "unavailable", from: 0, to: 0 }

   const stored = parseVersion(raw)
   if (stored === 0 && raw !== null && raw !== "")
      console.warn(
         `srr: unreadable ${SCHEMA_KEY} value ${JSON.stringify(raw)} — treating this device as v${LEGACY_VERSION}`,
      )

   // An unstamped (or unreadable) device is at the shape the gate shipped with.
   const from = stored || LEGACY_VERSION

   if (from > target) {
      console.warn(
         `srr: device state is v${from}, this build understands v${target} — leaving it alone (reload to get the newer build)`,
      )
      return { action: "ahead", from: stored, to: stored }
   }

   // Walk the rungs above the device's version, ascending.
   let done = from
   let failed = false
   for (const m of [...migrations].sort((a, b) => a.to - b.to)) {
      if (m.to <= from || m.to > target) continue
      try {
         m.run()
      } catch (e) {
         // A rung that throws stops the walk, and the stamp records the last one
         // that COMPLETED — so the next boot resumes exactly there instead of
         // recording work that never happened.
         console.warn(`srr: ${SCHEMA_KEY} migration to v${m.to} failed`, e)
         failed = true
         break
      }
      done = m.to
   }
   // Every applicable rung ran ⇒ the device is at `target`, even if no rung
   // names it (a version bump whose last step needed no data change is legal,
   // and stamping the last rung instead would leave the device one behind
   // forever, re-walking a ladder with nothing left to do on every boot).
   const reached = failed ? done : target

   const persisted = reached === stored ? stored : writeVersion(reached) ? reached : stored
   return {
      action: from === target ? (stored === target ? "current" : "stamped") : "migrated",
      from: stored,
      to: persisted,
   }
}
