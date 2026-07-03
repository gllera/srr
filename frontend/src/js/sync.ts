// sync.ts — optional cross-device sync of the portable profile over a
// user-supplied HTTP endpoint (off by default, like the image proxy).
//
// The endpoint is anything that answers GET (the last-stored profile JSON, or
// 404 when none exists yet) and PUT (store the body verbatim) at one URL — a
// tiny key-value worker, a WebDAV file, an authenticated route behind the same
// access layer as the packs. The reader stays server-agnostic: the URL lives in
// localStorage (keys.ts SYNC_URL_KEY) and no request is made until one is set.
//
// The synced payload IS the backup blob (profile.ts exportProfile, v:1), so the
// endpoint's content doubles as a restorable backup. Merging reuses
// importProfile's monotone rules — seen = per-feed max, saved = union — which is
// what makes the transport safe: a stale device pushing last still converges,
// because every device re-adds its own state on its next cycle and a merge can
// never lower another device's progress. Prefs (unread-only, image proxy) ride
// along in the blob for backup parity but are NOT applied on pull (prefs:false)
// — flipping a view mode on the phone shouldn't teleport to the laptop.
//
// Cycle shape (syncNow): pull-merge first, then push the merged result when
// local changes are pending — so a PUT always writes remote ∪ local, never
// clobbers. The one exception is flush() (pagehide/hidden): a last-chance
// keepalive PUT with no time for the pre-merge GET; an overwritten remote
// increment is re-added by that device's next cycle (see above).
//
// Like profile.ts, this module imports only keys.ts + profile.ts (no data.ts /
// fmt.ts) so it unit-tests without a pack server or the base.ts URL side effect.

import { SYNC_URL_KEY } from "./keys"
import { exportProfile, importProfile } from "./profile"

// Push settles PUSH_DEBOUNCE_MS after the last seen/saved change (a reading
// burst is one PUT); background pulls (tab re-focus) are at most one per
// PULL_MIN_INTERVAL_MS so tab-switching doesn't hammer the endpoint.
const PUSH_DEBOUNCE_MS = 5000
const PULL_MIN_INTERVAL_MS = 60_000

let onMerged: (() => void) | null = null
let onStatus: (() => void) | null = null
let pushTimer: ReturnType<typeof setTimeout> | undefined
let dirty = false // local seen/saved changes not yet pushed
let inflight = false
let lastPullAt = 0 // ms; attempt-based, so a dead endpoint isn't hammered
let lastOkAt = 0 // unix SECONDS of the last completed cycle (fmt.timeAgoProse scale)
let lastError = ""

export function getSyncUrl(): string {
   try {
      return localStorage.getItem(SYNC_URL_KEY) ?? ""
   } catch {
      return ""
   }
}

// Dumb setter (the dialog validates + normalizes first). Changing the endpoint
// resets the status readout and the pull throttle so the next cycle runs fresh.
export function setSyncUrl(value: string): void {
   try {
      if (value) localStorage.setItem(SYNC_URL_KEY, value)
      else localStorage.removeItem(SYNC_URL_KEY)
   } catch {}
   lastOkAt = 0
   lastError = ""
   lastPullAt = 0
}

export function enabled(): boolean {
   return getSyncUrl() !== ""
}

// isValidSyncUrl / normalizeSyncUrl follow profile.ts's proxy-URL helpers
// (scheme optional, https default, dangerous schemes rejected) with one
// difference: no trailing "/" is appended — the sync URL is a full endpoint
// (".../profile"), not a prefix, and "/profile" vs "/profile/" can be two
// different routes to the server.
export function isValidSyncUrl(v: string): boolean {
   const s = v.trim()
   if (s === "") return true
   if (/^https?:\/\//i.test(s)) return true
   if (/^\s*(?:javascript|data|vbscript|file)\s*:/i.test(s)) return false
   return !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

export function normalizeSyncUrl(v: string): string {
   let s = v.trim()
   if (s === "") return ""
   if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "")
   return s
}

// The status readout consumed by the config surface's freshness footer.
export interface SyncState {
   on: boolean
   okAt: number // unix seconds of the last completed cycle; 0 = never
   error: string // last cycle's failure ("" = healthy)
}

export function state(): SyncState {
   return { on: enabled(), okAt: lastOkAt, error: lastError }
}

// GET + merge. 404 = nothing stored remotely yet (not an error — the next push
// seeds it). Returns whether the merge changed local state, detected by
// comparing the serialized profile around importProfile — profile.ts reports
// only validity, and a re-export costs nothing at profile scale.
// credentials:"include" lets an access-cookie-protected endpoint (the packs'
// auth layer) authenticate the request.
async function pullMerge(url: string): Promise<boolean> {
   const res = await fetch(url, { cache: "no-store", credentials: "include" })
   if (res.status === 404) return false
   if (!res.ok) throw new Error(`HTTP ${res.status}`)
   const text = await res.text()
   const before = exportProfile()
   const r = importProfile(text, { prefs: false })
   if (!r.ok) throw new Error(r.error ?? "invalid profile")
   return exportProfile() !== before
}

async function put(url: string, keepalive = false): Promise<void> {
   const res = await fetch(url, {
      method: "PUT",
      body: exportProfile(),
      headers: { "content-type": "application/json" },
      credentials: "include",
      keepalive,
   })
   if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// One full cycle: pull-merge the remote profile (notifying the UI when it
// changed local state), then push the merged result when local changes are
// pending — `push` defaults to that pending flag; the sync dialog passes true
// so enabling sync seeds the endpoint immediately. A pull failure skips the
// push (never PUT over a remote we failed to read) and leaves `dirty` set, so
// the next trigger retries. Offline failures stay silent — the SW makes
// offline reading a supported state, not a sync fault.
export async function syncNow(push = dirty): Promise<void> {
   const url = getSyncUrl()
   if (!url || inflight) return
   inflight = true
   lastPullAt = Date.now()
   try {
      const changed = await pullMerge(url)
      if (changed) onMerged?.()
      if (push) {
         await put(url)
         dirty = false
         clearTimeout(pushTimer)
      }
      lastOkAt = Math.floor(Date.now() / 1000)
      lastError = ""
   } catch (e) {
      if (navigator.onLine !== false) lastError = e instanceof Error ? e.message : String(e)
   } finally {
      inflight = false
      onStatus?.() // okAt/error moved — let an open config footer repaint
   }
}

// Debounced push, called from nav.ts's two mutation seams (recordSeen /
// toggleSaved). No-op until a sync URL is configured.
export function pushSoon(): void {
   if (!enabled()) return
   dirty = true
   clearTimeout(pushTimer)
   pushTimer = setTimeout(() => void syncNow(), PUSH_DEBOUNCE_MS)
}

// Last-chance PUT when the page hides/unloads: keepalive lets the request
// outlive the page; the pre-merge GET is skipped (no time for two round
// trips). Failure re-arms `dirty` so a restored bfcache page retries.
export function flush(): void {
   if (!dirty) return
   const url = getSyncUrl()
   if (!url) return
   clearTimeout(pushTimer)
   dirty = false
   void put(url, true).catch(() => {
      dirty = true
   })
}

// Wire the lifecycle: boot pull (when enabled), re-pull on tab re-focus
// (throttled) and on regaining connectivity, flush on hide/pagehide. `merged`
// is app.ts's refresh routine — rerender the list / badges after a pull
// changed local state; `status` repaints an open config footer after every
// cycle (so enabling sync from the dialog confirms itself without a re-open).
export function init(merged: () => void, status?: () => void): void {
   onMerged = merged
   onStatus = status ?? null
   document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush()
      else if (Date.now() - lastPullAt >= PULL_MIN_INTERVAL_MS) void syncNow()
   })
   window.addEventListener("pagehide", flush)
   window.addEventListener("online", () => void syncNow())
   if (enabled()) void syncNow()
}
