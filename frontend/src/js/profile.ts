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
//      saved — union preserving local save order, appending new incoming saves
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

import { HOME_MID, IMG_PROXY_KEY, profileTsKey, savedKey, seenKey, seenTsKey, UNREAD_ONLY_KEY } from "./keys"
import {
   loadMounts,
   mergeMountRecords,
   reconcileMounts,
   renameStoreState,
   saveMounts,
   type MountRecord,
} from "./mounts"
import { isValidHttpish, normalizeHttpish } from "./urlish"

// The portable profile is the HOME store's device state (the blob's top-level
// fields are mount 0's, per docs/MULTI-STORE-SPEC.md §4.4; peer-store substate
// rides the additive `ms` map that S38 adds). So the keys here resolve to the
// bare legacy names via HOME_MID — a single-store user's blob is unchanged.
const SEEN_KEY = seenKey(HOME_MID)
const SEEN_TS_KEY = seenTsKey(HOME_MID)
const SAVED_KEY = savedKey(HOME_MID)
const PROFILE_TS_KEY = profileTsKey(HOME_MID)

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

// Save order (insertion order as stored), NOT sorted: the ★ Saved queue is read
// front-to-back and new saves append, so the order is meaningful and travels in
// the blob. Deduped (first occurrence wins) to survive a hand-edited endpoint.
function readSavedOrder(): number[] {
   try {
      const raw = lsGet(SAVED_KEY)
      const arr = raw ? JSON.parse(raw) : []
      const ints = Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []
      return [...new Set(ints)]
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

// ── Multi-store: the mount table (`mnt`) + per-peer substate (`ms`), §4.4 ──────
// Both additive: an old build pulls the blob, ignores mnt/ms, and merges the
// HOME store exactly as today. The home store's wire shape (top-level
// seen/st/saved/ts) does NOT move — it stays mount 0's, so a single-store user's
// blob is byte-identical. `ms` carries the PEER stores' substate (mid != "0"),
// each merged by the SAME rules applied per store.

interface StoreSubstate {
   ts: number
   seen: Record<string, number>
   st: Record<string, number>
   saved: number[]
}

// Read one mount's substate from its namespaced keys (seen@mid / st@mid /
// saved@mid / profile-ts@mid). Returns null when the store holds nothing local.
function readSubstate(mid: string): StoreSubstate | null {
   const seen = parseMap(lsGet(seenKey(mid)))
   const st = cleanTsMap(parseAny(lsGet(seenTsKey(mid))))
   const saved = parseIntArray(lsGet(savedKey(mid)))
   const tsN = Number(lsGet(profileTsKey(mid)))
   const ts = Number.isFinite(tsN) && tsN > 0 ? Math.floor(tsN) : 0
   if (Object.keys(seen).length === 0 && saved.length === 0 && ts === 0) return null
   return { ts, seen, st, saved }
}

function parseMap(raw: string): Record<string, number> {
   try {
      const o = raw ? (JSON.parse(raw) as unknown) : {}
      if (o === null || typeof o !== "object" || Array.isArray(o)) return {}
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(o as Record<string, unknown>))
         if (typeof v === "number" && Number.isFinite(v)) out[k] = v
      return out
   } catch {
      return {}
   }
}
function parseAny(raw: string): unknown {
   try {
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}
function parseIntArray(raw: string): number[] {
   try {
      const a = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(a)
         ? [...new Set(a.filter((n) => Number.isInteger(n) && (n as number) >= 0) as number[])]
         : []
   } catch {
      return []
   }
}

// Merge one incoming peer substate into a mount's namespaced keys, by the SAME
// rules as the home store: seen+st per-key LWW (mergeSeenMid), saved+ts LWW in
// sync mode / union in merge mode. `mid` is never HOME_MID here (home rides the
// top-level fields). Returns whether anything actually changed.
function mergeSubstate(mid: string, sub: unknown, mode: "merge" | "sync"): boolean {
   if (!sub || typeof sub !== "object" || Array.isArray(sub)) return false
   const o = sub as Record<string, unknown>
   const incomingSt = cleanTsMap(o["st"])
   let changed = mergeSeenMid(mid, o["seen"], incomingSt)
   const tsRaw = o["ts"]
   const blobTs = typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : 0
   const localTs = readSubstate(mid)?.ts ?? 0
   const incoming = Array.isArray(o["saved"])
      ? [...new Set((o["saved"] as unknown[]).filter((n) => Number.isInteger(n) && (n as number) >= 0) as number[])]
      : null
   if (mode === "sync") {
      if (blobTs > localTs) {
         if (incoming && JSON.stringify(incoming) !== JSON.stringify(parseIntArray(lsGet(savedKey(mid))))) {
            lsSet(savedKey(mid), JSON.stringify(incoming))
            changed = true
         }
         lsSet(profileTsKey(mid), String(blobTs))
      }
   } else if (incoming) {
      // merge (file restore): union, preserving local save order.
      const order = parseIntArray(lsGet(savedKey(mid)))
      const seen = new Set(order)
      let savedChanged = false
      for (const n of incoming)
         if (!seen.has(n)) {
            seen.add(n)
            order.push(n)
            savedChanged = true
         }
      if (savedChanged) {
         lsSet(savedKey(mid), JSON.stringify(order))
         changed = true
      }
   }
   return changed
}

// mergeSeenMid is mergeSeen for a mount id's namespaced keys — the same per-key
// LWW rule (strictly-newer st wins in either direction, else raise-only max).
function mergeSeenMid(mid: string, incoming: unknown, incomingTs: Record<string, number>): boolean {
   try {
      if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return false
      const existing = parseMap(lsGet(seenKey(mid)))
      const existingTs = cleanTsMap(parseAny(lsGet(seenTsKey(mid))))
      let changed = false
      let tsChanged = false
      for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
         if (typeof v !== "number" || !Number.isFinite(v)) continue
         const localV = existing[k]
         const localTs = existingTs[k] ?? 0
         const remoteTs = incomingTs[k] ?? 0
         const adopt = localTs > 0 && remoteTs > 0 && remoteTs !== localTs ? remoteTs > localTs : v > (localV ?? -1)
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
      if (changed) lsSet(seenKey(mid), JSON.stringify(existing))
      if (tsChanged) lsSet(seenTsKey(mid), JSON.stringify(existingTs))
      return changed
   } catch {
      return false
   }
}

// The peer substate map for export: every non-home mount (tombstones included,
// so unmounted-not-forgotten state still propagates — §3.4) that holds any local
// state. `mnt` is the whole mount table (records + tombstones).
function exportMountState(): { mnt: MountRecord[]; ms: Record<string, StoreSubstate> } {
   const mnt = loadMounts()
   const ms: Record<string, StoreSubstate> = {}
   for (const m of mnt) {
      if (m.id === HOME_MID) continue
      const sub = readSubstate(m.id)
      if (sub) ms[m.id] = sub
   }
   return { mnt, ms }
}

// True when this device holds any MULTI-STORE state to propagate — a live peer
// mount or peer substate. sync.ts uses it to decide the one-time upgrade push
// against an mnt-less (old-build) endpoint: a pure single-store device has
// nothing to add and stays quiet (§4.4).
export function hasPeerState(): boolean {
   const { mnt, ms } = exportMountState()
   return mnt.some((m) => m.id !== HOME_MID && !m.del) || Object.keys(ms).length > 0
}

// exportProfile serialises all four portable keys plus the LWW `ts` and the
// per-key seen timestamps `st` into a v:2 blob (st is additive — old builds
// ignore it and keep their raise-only max, so the version needs no bump). The
// multi-store `mnt`/`ms` (§4.4) ride along, also additive. srr-hash is never
// included.
export function exportProfile(): string {
   const seen = readSeen()
   const saved = readSavedOrder()
   const unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
   const imgProxy = lsGet(IMG_PROXY_KEY)
   const { mnt, ms } = exportMountState()
   return JSON.stringify({ v: 2, ts: profileTs(), seen, st: readSeenTs(), saved, unreadOnly, imgProxy, mnt, ms })
}

// Merge the incoming blob's mount table + peer substate (§4.4). Applied by
// importProfile after the HOME store merge. Returns whether anything changed
// (so the caller re-adopts the mount table + repaints). mnt merges FIRST (per
// §3.4) so a rename tombstone renames the peer's `…@mid` state before its `ms`
// is merged onto the new id.
function mergeMountState(obj: Record<string, unknown>, mode: "merge" | "sync"): boolean {
   let changed = false
   if (Array.isArray(obj["mnt"])) {
      const incoming = (obj["mnt"] as unknown[]).map(coerceMountRecord).filter((r): r is MountRecord => r !== null)
      const merged = mergeMountRecords(loadMounts(), incoming)
      const { records, renames } = reconcileMounts(merged)
      for (const r of renames) renameStoreState(r.from, r.to)
      saveMounts(records)
      changed = true
   }
   const ms = obj["ms"]
   if (ms && typeof ms === "object" && !Array.isArray(ms)) {
      for (const [mid, sub] of Object.entries(ms as Record<string, unknown>)) {
         if (mid === HOME_MID) continue
         if (mergeSubstate(mid, sub, mode)) changed = true
      }
   }
   return changed
}

// A lenient coercion of one untrusted mnt record (mirrors mounts.ts's internal
// one, which is not exported). Strict on id/url; tolerant elsewhere.
function coerceMountRecord(r: unknown): MountRecord | null {
   if (typeof r !== "object" || r === null || Array.isArray(r)) return null
   const o = r as Record<string, unknown>
   if (typeof o["id"] !== "string" || !o["id"] || typeof o["url"] !== "string" || !o["url"]) return null
   const rec: MountRecord = {
      id: o["id"],
      url: o["url"],
      label: typeof o["label"] === "string" ? o["label"] : "",
      ord: typeof o["ord"] === "number" && Number.isFinite(o["ord"]) ? o["ord"] : 0,
      role: o["role"] === "home" ? "home" : "peer",
      cred: o["cred"] === true,
      added: typeof o["added"] === "number" && Number.isFinite(o["added"]) ? Math.floor(o["added"] as number) : 0,
      ts: typeof o["ts"] === "number" && Number.isFinite(o["ts"]) ? Math.floor(o["ts"] as number) : 0,
      del: o["del"] === true,
   }
   if (typeof o["moved_to"] === "string" && o["moved_to"]) rec.moved_to = o["moved_to"]
   return rec
}

// importProfile parses `json` and applies it to the current device's state.
// Returns {ok:false, error} without mutating anything if the blob is invalid.
// Two modes (see the "Import strategy" note above):
//   merge (default; always for v1) —
//      seen   — for each incoming key, take Math.max(existing ?? -1, incoming)
//      saved  — union preserving local save order, appending new incoming saves
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
               // Adopt the blob's save ORDER verbatim (deduped, not sorted) — the
               // sender's queue order is the intent that propagates under LWW.
               const cleaned = [...new Set(incoming.filter((n) => Number.isInteger(n) && n >= 0))]
               const next = JSON.stringify(cleaned)
               if (next !== JSON.stringify(readSavedOrder())) {
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

      // saved — union that PRESERVES local save order and APPENDS restored saves
      // not already present (in the blob's order), keeping the queue's
      // front-to-back meaning instead of re-sorting by chronIdx.
      try {
         const incomingRaw = obj["saved"]
         if (Array.isArray(incomingRaw)) {
            const order = readSavedOrder()
            const existingSet = new Set(order)
            let savedChanged = false
            for (const n of incomingRaw) {
               if (Number.isInteger(n) && n >= 0 && !existingSet.has(n as number)) {
                  existingSet.add(n as number)
                  order.push(n as number)
                  savedChanged = true
               }
            }
            if (savedChanged) {
               lsSet(SAVED_KEY, JSON.stringify(order))
               changed = true
            }
         }
      } catch {}

      if (changed) touchProfile()
   }

   // ── multi-store: the mount table + peer substate (§4.4) ────────────────────
   // Kept OUT of the home `changed`/touchProfile above — a peer store's change
   // must never stamp the HOME store's ts. Merged for both modes; folded into
   // the RETURNED changed so the caller re-adopts the mount table + repaints.
   const storeMode = opts.mode === "sync" && obj["v"] === 2 ? "sync" : "merge"
   if (mergeMountState(obj, storeMode)) changed = true

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
