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
// Import strategy — two modes:
//   merge (v1, or v2 without opts.adopt — file restores) —
//      seen  — per-key Math.max() merge (one-way raise; never lowers progress)
//      saved — set union, re-sorted ascending
//      prefs — last-writer-wins, gated by opts.prefs (opt-in checkbox)
//   adopt (v2 + opts.adopt — a sync.ts LWW pull) —
//      seen/saved are replaced wholesale with the blob's, and the local `ts`
//      is set from the blob's `ts` — this device becomes exactly the blob.
//      prefs stay gated by opts.prefs exactly as in merge mode; sync.ts just
//      always passes prefs:false (see profileTs's comment below for why).

import { IMG_PROXY_KEY, PROFILE_TS_KEY, SAVED_KEY, SEEN_KEY, UNREAD_ONLY_KEY } from "./keys"

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

// isValidProxy / normalizeProxy mirror fmt.ts's behaviour exactly. profile.ts
// deliberately does not import fmt.ts (which pulls base.ts's module-load
// `new URL(SRR_CDN_URL, …)` side effect and would break this module's
// unit-testability), so the small proxy helpers are duplicated here — keep them in
// sync. Scheme is optional (https default); a host/path gets a trailing "/".
function isValidProxy(v: string): boolean {
   const s = v.trim()
   if (s === "") return true
   if (/^https?:\/\//i.test(s)) return true
   if (/^\s*(?:javascript|data|vbscript|file)\s*:/i.test(s)) return false
   return !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

function normalizeProxy(v: string): string {
   let s = v.trim()
   if (s === "") return ""
   if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "")
   if (/[a-z0-9]$/i.test(s)) s += "/"
   return s
}

export interface ImportResult {
   ok: boolean
   error?: string
}

// exportProfile serialises all four portable keys plus the LWW `ts` into a
// v:2 blob. srr-hash is never included.
export function exportProfile(): string {
   const seen = readSeen()
   const saved = readSavedSorted()
   const unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
   const imgProxy = lsGet(IMG_PROXY_KEY)
   return JSON.stringify({ v: 2, ts: profileTs(), seen, saved, unreadOnly, imgProxy })
}

// importProfile parses `json` and applies it to the current device's state.
// Returns {ok:false, error} without mutating anything if the blob is invalid.
// Two modes (see the "Import strategy" note above):
//   merge (default; always for v1) —
//      seen   — for each incoming key, take Math.max(existing ?? -1, incoming)
//      saved  — union of existing + incoming integers, sorted ascending
//      a merge that actually changed seen/saved stamps `ts` to now (it's a
//      local mutation like any other seen/save)
//   adopt (opts.adopt && v2) — seen/saved are replaced wholesale with the
//      blob's, and `ts` is set from the blob's `ts` (floored/validated, NOT
//      re-stamped to now — the point is to take the sender's ordering, not
//      overwrite it)
// prefs — only applied when opts.prefs is true (either mode); invalid
// imgProxy is ignored.
export function importProfile(json: string, opts: { prefs: boolean; adopt?: boolean }): ImportResult {
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

   if (opts.adopt && obj["v"] === 2) {
      // ── adopt (whole-blob LWW pull) — replace seen/saved, take the blob's ts.
      // NOT for file restores — those go through the merge branch below even
      // on a v2 blob (opts.adopt is unset).
      try {
         const incoming = obj["seen"]
         const cleaned: Record<string, number> = {}
         if (incoming !== null && typeof incoming === "object" && !Array.isArray(incoming))
            for (const [k, v] of Object.entries(incoming as Record<string, unknown>))
               if (typeof v === "number" && Number.isFinite(v)) cleaned[k] = v
         lsSet(SEEN_KEY, JSON.stringify(cleaned))
      } catch {}
      try {
         const incoming = obj["saved"]
         const cleaned = Array.isArray(incoming)
            ? incoming.filter((n) => Number.isInteger(n) && n >= 0).sort((a: number, b: number) => a - b)
            : []
         lsSet(SAVED_KEY, JSON.stringify(cleaned))
      } catch {}
      const ts = obj["ts"]
      lsSet(PROFILE_TS_KEY, String(typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0))
   } else {
      // ── merge (v1, or v2 without adopt — a file restore) ───────────────────
      let changed = false

      // seen — one-way raise
      try {
         const existing = readSeen()
         const incoming = obj["seen"]
         if (incoming !== null && typeof incoming === "object" && !Array.isArray(incoming)) {
            let seenChanged = false
            for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
               if (typeof v === "number" && Number.isFinite(v)) {
                  // Only a real raise counts as a change — a stale restore that
                  // moves nothing must not stamp `ts` (see below).
                  const nv = Math.max(existing[k] ?? -1, v)
                  if (nv !== existing[k]) {
                     existing[k] = nv
                     seenChanged = true
                  }
               }
            }
            if (seenChanged) {
               lsSet(SEEN_KEY, JSON.stringify(existing))
               changed = true
            }
         }
      } catch {}

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
         const proxy = obj["imgProxy"]
         if (typeof proxy === "string" && isValidProxy(proxy)) {
            lsSet(IMG_PROXY_KEY, normalizeProxy(proxy))
         }
      } catch {}
   }

   return { ok: true }
}
