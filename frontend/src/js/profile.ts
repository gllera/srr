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
// Import strategy:
//   seen  — per-key Math.max() merge (one-way raise; never lowers progress)
//   saved — set union, re-sorted ascending
//   prefs — last-writer-wins, gated by opts.prefs (opt-in checkbox)

import { IMG_PROXY_KEY, SAVED_KEY, SEEN_KEY, UNREAD_ONLY_KEY } from "./keys"

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

// exportProfile serialises all four portable keys into a v:1 blob.
// srr-hash is never included.
export function exportProfile(): string {
   const seen = readSeen()
   const saved = readSavedSorted()
   const unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
   const imgProxy = lsGet(IMG_PROXY_KEY)
   return JSON.stringify({ v: 1, seen, saved, unreadOnly, imgProxy })
}

// importProfile parses `json` and merges it into the current device's state.
// Returns {ok:false, error} without mutating anything if the blob is invalid.
// Merge rules:
//   seen   — for each incoming key, take Math.max(existing ?? -1, incoming)
//   saved  — union of existing + incoming integers, sorted ascending
//   prefs  — only applied when opts.prefs is true; invalid imgProxy is ignored
export function importProfile(json: string, opts: { prefs: boolean }): ImportResult {
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
   if (obj["v"] !== 1) {
      return { ok: false, error: `Unsupported profile version: ${obj["v"]}` }
   }

   // ── merge seen (one-way raise) ────────────────────────────────────────────
   try {
      const existing = readSeen()
      const incoming = obj["seen"]
      if (incoming !== null && typeof incoming === "object" && !Array.isArray(incoming)) {
         let changed = false
         for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v)) {
               existing[k] = Math.max(existing[k] ?? -1, v)
               changed = true
            }
         }
         if (changed) lsSet(SEEN_KEY, JSON.stringify(existing))
      }
   } catch {}

   // ── merge saved (union, sorted) ───────────────────────────────────────────
   try {
      const incomingRaw = obj["saved"]
      if (Array.isArray(incomingRaw)) {
         const existingSet = new Set(readSavedSorted())
         let changed = false
         for (const n of incomingRaw) {
            if (Number.isInteger(n) && n >= 0) {
               existingSet.add(n as number)
               changed = true
            }
         }
         if (changed) lsSet(SAVED_KEY, JSON.stringify([...existingSet].sort((a, b) => a - b)))
      }
   } catch {}

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
