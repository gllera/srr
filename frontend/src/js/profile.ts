// profile.ts — portable profile export/import.
// Bundles the device-local state that is meaningful on another device:
// srr-seen, srr-saved, srr-unread-only, srr-img-proxy.
// Explicitly EXCLUDES srr-hash (device-local reading cursor).
//
// This module reads/writes localStorage directly via keys.ts (a side-effect-free
// constants module) rather than importing nav.ts or fmt.ts — that avoids pulling
// in data.ts's eager db.gz fetch as a side effect, which makes the module
// unit-testable without a running pack server.
//
// Import strategy — two modes, sharing ONE per-key seen rule:
//   seen — per-key LWW by the `st` (seen-ts) side map, falling back to
//      Math.max() when either side lacks a key's timestamp. `st` stamps the
//      unix-second of each key's last LOCAL mutation (nav.ts writes it beside
//      every seen write), so a key whose incoming timestamp is strictly newer
//      wins IN EITHER DIRECTION — that's what lets an explicit "mark unread
//      from here" rewind (nav.markUnreadFrom) survive the next pull instead of
//      being re-raised by a max-merge. Keys without a timestamp on both sides
//      (v1 blobs, pre-upgrade v2 blobs, pre-upgrade local state) keep the
//      legacy raise-only max — an implicit rewind still cannot happen; only
//      the explicit, freshly-stamped kind propagates. Adopting a remote value
//      adopts its timestamp verbatim (never re-stamped to now — the ordering
//      belongs to the device where the person acted).
//   merge (default; always for v1 — file restores) —
//      seen  — the per-key rule above
//      saved — set union, re-sorted ascending
//      prefs — last-writer-wins, gated by opts.prefs (opt-in checkbox)
//   sync (mode:"sync" + v2 — a sync.ts pull) — the one-reader hybrid:
//      seen  — the per-key rule above, but WITHOUT stamping `ts`: the change
//              came from the remote, not from a local user action, and
//              stamping would make this device "newest" and steal the saved-LWW
//              ordering from the device where the person actually acted (same
//              reasoning as the prefs-don't-stamp rule on profileTs below).
//      saved+ts — last-write-wins by `ts`: a strictly newer blob replaces saved
//              wholesale (un-saves propagate) and `ts` takes the blob's value;
//              otherwise both stay local (a tie keeps local). Net effect: `ts`
//              converges to max(local, blob).
//      prefs — gated by opts.prefs exactly as in merge mode; sync.ts just
//      always passes prefs:false (see profileTs's comment below for why).
// The ONLY path that can LOWER seen is a strictly newer per-key `st` — the
// explicit rewind a person asked for on some device. Everything else stays
// raise-only: all devices belong to one reader, whose read state is the union
// of what they read anywhere plus their latest explicit rewinds.

import { IMG_PROXY_KEY, PROFILE_TS_KEY, SAVED_KEY, SEEN_KEY, SEEN_TS_KEY, UNREAD_ONLY_KEY } from "./keys"
import { isValidHttpish, normalizeHttpish } from "./urlish"

function lsGet(key: string): string {
   try {
      return localStorage.getItem(key) ?? ""
   } catch {
      return ""
   }
}

function lsSet(key: string, value: string): void {
   try {
      localStorage.setItem(key, value)
   } catch {}
}

function readSeen(): Record<string, number> {
   try {
      const raw = lsGet(SEEN_KEY)
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// The per-key seen timestamps (srr-seen-ts): unix-second of each seen key's
// last local mutation, written by nav.ts beside every seen write. Absent key
// == 0 == "no ordering information" (pre-upgrade state) — merges fall back to
// the legacy raise-only max for it.
function readSeenTs(): Record<string, number> {
   try {
      const raw = lsGet(SEEN_TS_KEY)
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// Parse an incoming st-shaped value (a blob's `st` field) into a clean map;
// anything malformed degrades to {} (every key then merges by legacy max).
function cleanTsMap(incoming: unknown): Record<string, number> {
   const out: Record<string, number> = {}
   if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return out
   for (const [k, v] of Object.entries(incoming as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v)
   return out
}

function readSavedSorted(): number[] {
   try {
      const raw = lsGet(SAVED_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return (Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []).sort((a: number, b: number) => a - b)
   } catch {
      return []
   }
}

// The LWW ordering field: unix seconds of the last local seen/saved mutation
// (0 = never). Pref changes deliberately do NOT stamp it — prefs are never
// applied on pull, so a mere pref flip must not make this device "newest" and
// cost another device its real progress on the next adoption.
export function profileTs(): number {
   const n = Number(lsGet(PROFILE_TS_KEY))
   return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function touchProfile(now = Math.floor(Date.now() / 1000)): void {
   lsSet(PROFILE_TS_KEY, String(now))
}

// The parsed local seen map — sync.ts's regression guard compares blobs by it.
export function localSeen(): Record<string, number> {
   return readSeen()
}

// The parsed per-key seen timestamps — sync.ts's behind/guard comparisons pair
// them with localSeen().
export function localSeenTs(): Record<string, number> {
   return readSeenTs()
}

export interface ImportResult {
   ok: boolean
   error?: string
   // seen or saved actually mutated. A ts-only convergence (newer blob with
   // identical saved and no seen raise) is NOT a change — nothing the UI shows
   // moved, so callers must not re-render or re-anchor on it.
   changed?: boolean
}

// seen — the per-key rule shared verbatim by both import modes: a key whose
// incoming `st` timestamp is strictly newer than the local one wins in either
// direction (raise or explicit rewind); a key without a timestamp on either
// side falls back to the legacy one-way max. Adopting an incoming value adopts
// its timestamp verbatim (or drops the local one when the incoming side has
// none — the value's ordering is then genuinely unknown). Returns whether any
// seen VALUE actually changed (timestamp-only convergence is not a change).
function mergeSeen(incoming: unknown, incomingTs: Record<string, number>): boolean {
   try {
      if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return false
      const existing = readSeen()
      const existingTs = readSeenTs()
      let changed = false
      let tsChanged = false
      for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
         if (typeof v !== "number" || !Number.isFinite(v)) continue
         const localV = existing[k]
         const localTs = existingTs[k] ?? 0
         const remoteTs = incomingTs[k] ?? 0
         // Both sides carry ordering info and disagree → strict LWW (this is
         // the one path that can lower a value: an explicit rewind). Otherwise
         // legacy raise-only max — and when the max ADOPTS the incoming value,
         // its timestamp (or lack of one) comes along.
         const adopt = localTs > 0 && remoteTs > 0 && remoteTs !== localTs ? remoteTs > localTs : v > (localV ?? -1) // tie or no ordering → one-way raise
         if (!adopt) continue
         if (v !== localV) {
            existing[k] = v
            changed = true
         }
         if (remoteTs !== localTs) {
            if (remoteTs > 0) existingTs[k] = remoteTs
            else delete existingTs[k]
            tsChanged = true
         }
      }
      if (changed) lsSet(SEEN_KEY, JSON.stringify(existing))
      if (tsChanged) lsSet(SEEN_TS_KEY, JSON.stringify(existingTs))
      return changed
   } catch {
      return false
   }
}

// exportProfile serialises all four portable keys plus the LWW `ts` and the
// per-key seen timestamps `st` into a v:2 blob (st is additive — old builds
// ignore it and keep their raise-only max, so the version needs no bump).
// srr-hash is never included.
export function exportProfile(): string {
   const seen = readSeen()
   const saved = readSavedSorted()
   const unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
   const imgProxy = lsGet(IMG_PROXY_KEY)
   return JSON.stringify({ v: 2, ts: profileTs(), seen, st: readSeenTs(), saved, unreadOnly, imgProxy })
}

// importProfile parses `json` and applies it to the current device's state.
// Returns {ok:false, error} without mutating anything if the blob is invalid.
// Two modes (see the "Import strategy" note above):
//   merge (default; always for v1) —
//      seen   — for each incoming key, take Math.max(existing ?? -1, incoming)
//      saved  — union of existing + incoming integers, sorted ascending
//      a merge that actually changed seen/saved stamps `ts` to now (it's a
//      local mutation like any other seen/save)
//   sync (opts.mode === "sync" && v2) — raise-only seen (same max-merge, but
//      never stamping `ts`); saved + `ts` adopt the blob's values only when the
//      blob's `ts` is strictly newer (LWW; the blob's ts is floored/validated,
//      NOT re-stamped to now — the point is to take the sender's ordering)
// prefs — only applied when opts.prefs is true (either mode); invalid
// imgProxy is ignored.
export function importProfile(json: string, opts: { prefs: boolean; mode?: "merge" | "sync" }): ImportResult {
   // ── parse + validate ──────────────────────────────────────────────────────
   let blob: unknown
   try {
      blob = JSON.parse(json)
   } catch {
      return { ok: false, error: "Invalid JSON" }
   }
   if (typeof blob !== "object" || blob === null || Array.isArray(blob)) {
      return { ok: false, error: "Expected a JSON object" }
   }
   const obj = blob as Record<string, unknown>
   if (obj["v"] !== 1 && obj["v"] !== 2) {
      return { ok: false, error: `Unsupported profile version: ${obj["v"]}` }
   }

   let changed = false
   const incomingSt = cleanTsMap(obj["st"])
   if (opts.mode === "sync" && obj["v"] === 2) {
      // ── sync (one-reader hybrid pull) — NOT for file restores; those go
      // through the merge branch below even on a v2 blob (opts.mode unset).
      changed = mergeSeen(obj["seen"], incomingSt) // per-key rule, ts deliberately untouched
      const tsRaw = obj["ts"]
      const blobTs = typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : 0
      if (blobTs > profileTs()) {
         // saved + ts — the blob is strictly newer: its saved set is the
         // person's current intent (un-saves propagate). Identical content
         // still converges ts but is not a "change".
         try {
            // Only a well-formed array replaces saved wholesale. A newer blob
            // that OMITS/malforms `saved` (a truncated keepalive PUT, a
            // hand-edited endpoint) must NOT zero the local star collection — a
            // genuine un-save-everything still arrives as `saved:[]` (an array),
            // so that intent propagates while a missing field is left alone.
            const incoming = obj["saved"]
            if (Array.isArray(incoming)) {
               const cleaned = incoming
                  .filter((n) => Number.isInteger(n) && n >= 0)
                  .sort((a: number, b: number) => a - b)
               const next = JSON.stringify(cleaned)
               if (next !== JSON.stringify(readSavedSorted())) {
                  lsSet(SAVED_KEY, next)
                  changed = true
               }
            }
         } catch {}
         lsSet(PROFILE_TS_KEY, String(blobTs))
      }
   } else {
      // ── merge (v1, or v2 without mode:"sync" — a file restore) ─────────────

      // seen — the shared per-key rule (raise, or an st-ordered explicit
      // rewind). Only a real value change counts: a stale restore that moves
      // nothing must not stamp `ts` (see below).
      if (mergeSeen(obj["seen"], incomingSt)) changed = true

      // saved — union, sorted
      try {
         const incomingRaw = obj["saved"]
         if (Array.isArray(incomingRaw)) {
            const existingSet = new Set(readSavedSorted())
            let savedChanged = false
            for (const n of incomingRaw) {
               if (Number.isInteger(n) && n >= 0 && !existingSet.has(n as number)) {
                  existingSet.add(n as number)
                  savedChanged = true
               }
            }
            if (savedChanged) {
               lsSet(SAVED_KEY, JSON.stringify([...existingSet].sort((a, b) => a - b)))
               changed = true
            }
         }
      } catch {}

      if (changed) touchProfile()
   }

   // ── prefs (opt-in) ────────────────────────────────────────────────────────
   if (opts.prefs) {
      try {
         if (typeof obj["unreadOnly"] === "boolean") {
            // Store the off state explicitly ("0"), not by clearing the key — an
            // absent key is the first-run unread-only default (app.ts), so a
            // restored "off" must persist as "0" to override it.
            lsSet(UNREAD_ONLY_KEY, obj["unreadOnly"] ? "1" : "0")
         }
      } catch {}
      try {
         // The urlish helpers, not fmt.ts's proxy wrappers: importing fmt.ts
         // pulls base.ts's module-load `new URL(SRR_CDN_URL, …)` side effect
         // and would break this module's unit-testability. trailingSlash=true —
         // an imported proxy value is a prefix, same rule as the settings UI.
         const proxy = obj["imgProxy"]
         if (typeof proxy === "string" && isValidHttpish(proxy)) {
            lsSet(IMG_PROXY_KEY, normalizeHttpish(proxy, true))
         }
      } catch {}
   }

   return { ok: true, changed }
}
