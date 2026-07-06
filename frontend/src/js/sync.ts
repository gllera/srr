// sync.ts — optional cross-device sync of the portable profile over a
// user-supplied HTTP endpoint (off by default, like the image proxy).
//
// The endpoint is anything that answers GET (the last-stored profile JSON, or
// 404 when none exists yet) and PUT (store the body verbatim) at one URL — a
// tiny key-value worker, a WebDAV file, an authenticated route behind the same
// access layer as the packs. The reader stays server-agnostic: the URL lives in
// localStorage (keys.ts SYNC_URL_KEY) and no request is made until one is set.
//
// The synced payload IS the backup blob (profile.ts exportProfile, v:2), so the
// endpoint's content doubles as a restorable backup. The cycle is whole-blob
// last-write-wins by `ts` (profile.ts's LWW ordering field, stamped on every
// seen/saved mutation): the newest push simply wins. That's a step down from
// v1's monotone merge in one respect — a merge could never lower progress, so
// a bad PUT was always recoverable (the next merge just re-raised it); LWW can
// genuinely erase progress if it adopts or publishes the wrong blob. The
// progress-regression guard is the replacement safety net: a BACKGROUND cycle
// (tab re-focus, `online`, the debounced pushSoon timer) may never DECREASE
// read progress in either direction — it won't adopt a remote that would
// rewind local seen positions, and it won't publish a local blob that would
// rewind the endpoint's. Either case PARKS the cycle (no adopt, no push,
// `state().parked` flagged) instead of resolving it silently, and waits for a
// human decision. A MANUAL cycle (`syncNow({manual:true})`, wired to the sync
// dialog's Save) applies pure LWW with no guard at all — the tap IS the
// authorization to rewind (e.g. discarding a device's bogus state on purpose).
//
// A v1 remote (a pre-upgrade endpoint, or another device still on the old
// build) has no `ts` to LWW-compare, so it gets one legacy monotone merge via
// importProfile instead of an adopt, and — regardless of manual/background —
// always forces a push afterward so the endpoint upgrades to v2. That forced
// push still runs through the same guard machinery, but it can never actually
// park: a one-way-raising merge can't end up regressive against the very blob
// it was merged from.
//
// Like profile.ts, this module imports only keys.ts + profile.ts (no data.ts /
// fmt.ts) so it unit-tests without a pack server or the base.ts URL side effect.

import { SYNC_URL_KEY } from "./keys"
import { exportProfile, importProfile, localSeen, profileTs, touchProfile } from "./profile"

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
let lastRemoteTs = -1 // ts of the last successfully pulled remote (-1 = never pulled)
let lastRemoteSeen: Record<string, number> | null = null // its seen map, for the regression guard
let parkedFlag = false // last BACKGROUND cycle parked on a would-be progress regression

export function getSyncUrl(): string {
   try {
      return localStorage.getItem(SYNC_URL_KEY) ?? ""
   } catch {
      return ""
   }
}

// Dumb setter (the dialog validates + normalizes first). Changing the endpoint
// resets the status readout, the pull throttle, and the guard's remembered
// remote state, so the next cycle runs fresh against the new endpoint.
export function setSyncUrl(value: string): void {
   try {
      if (value) localStorage.setItem(SYNC_URL_KEY, value)
      else localStorage.removeItem(SYNC_URL_KEY)
   } catch {}
   lastOkAt = 0
   lastError = ""
   lastPullAt = 0
   lastRemoteTs = -1
   lastRemoteSeen = null
   parkedFlag = false
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
   parked: boolean // last BACKGROUND cycle parked on a would-be progress regression
}

export function state(): SyncState {
   return { on: enabled(), okAt: lastOkAt, error: lastError, parked: parkedFlag }
}

// True when publishing/adopting `incoming` over `cur` would DECREASE read
// progress: some feed key of `cur` is absent from `incoming` or maps to a
// lower number. Seen axis ONLY — saved-set changes (including un-saves) never
// park a cycle; letting deletions propagate is the whole point of LWW.
export function regressiveSeen(cur: Record<string, number>, incoming: Record<string, number>): boolean {
   for (const [k, v] of Object.entries(cur)) {
      const inc = incoming[k]
      if (inc === undefined || inc < v) return true
   }
   return false
}

interface RemoteBlob {
   v: 1 | 2
   ts: number
   seen: Record<string, number>
   raw: string
}

// GET + parse. null = 404 (nothing stored yet — the next push seeds it).
// Validation here is minimal (version + the seen map the guard needs);
// importProfile re-validates before mutating anything, so a blob this parser
// accepts but importProfile rejects still fails safely. credentials:"include"
// lets an access-cookie-protected endpoint (the packs' auth layer) authenticate
// the request.
async function pullRemote(url: string): Promise<RemoteBlob | null> {
   const res = await fetch(url, { cache: "no-store", credentials: "include" })
   if (res.status === 404) return null
   if (!res.ok) throw new Error(`HTTP ${res.status}`)
   const raw = await res.text()
   let obj: Record<string, unknown>
   try {
      obj = JSON.parse(raw) as Record<string, unknown>
   } catch {
      throw new Error("invalid profile")
   }
   if (typeof obj !== "object" || obj === null) throw new Error("invalid profile")
   const v = obj["v"] === 2 ? 2 : obj["v"] === 1 ? 1 : 0
   if (v === 0) throw new Error(`unsupported profile version: ${obj["v"]}`)
   const tsRaw = obj["ts"]
   const ts = typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : 0
   const seen: Record<string, number> = {}
   const seenRaw = obj["seen"]
   if (seenRaw !== null && typeof seenRaw === "object" && !Array.isArray(seenRaw))
      for (const [k, val] of Object.entries(seenRaw as Record<string, unknown>))
         if (typeof val === "number" && Number.isFinite(val)) seen[k] = val
   return { v: v as 1 | 2, ts, seen, raw }
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

// One full cycle under whole-blob LWW. Background cycles are progress-monotone:
// any adoption or publication that would DECREASE read progress (regressiveSeen)
// parks the cycle instead — no adopt, no push, status flagged — and waits for a
// manual Sync now, which applies pure LWW in both directions (the human tap is
// the authorization to rewind). A pull failure skips the push (never PUT over a
// remote we failed to read); offline failures stay silent — the SW makes
// offline reading a supported state, not a sync fault.
export async function syncNow(opts: { manual?: boolean } = {}): Promise<void> {
   const url = getSyncUrl()
   if (!url || inflight) return
   inflight = true
   lastPullAt = Date.now()
   try {
      const remote = await pullRemote(url)
      let adopted = false
      let parked = false
      if (remote) {
         lastRemoteTs = remote.ts
         lastRemoteSeen = remote.seen
         if (remote.v === 1) {
            // One-time legacy path: monotone-merge the v1 blob (old rules), then
            // force a push so the endpoint upgrades to v2.
            const before = exportProfile()
            const r = importProfile(remote.raw, { prefs: false })
            if (!r.ok) throw new Error(r.error ?? "invalid profile")
            adopted = exportProfile() !== before
            dirty = true
         } else if (remote.ts > profileTs()) {
            if (!opts.manual && regressiveSeen(localSeen(), remote.seen)) {
               parked = true // newer remote would rewind local read progress
            } else {
               const before = exportProfile()
               const r = importProfile(remote.raw, { prefs: false, adopt: true })
               if (!r.ok) throw new Error(r.error ?? "invalid profile")
               adopted = exportProfile() !== before
               dirty = false // local state IS the remote state now
               // A debounce timer armed before the adopt would only fire one
               // redundant GET-only cycle later — nothing left to push.
               clearTimeout(pushTimer)
            }
         }
      } else {
         // 404 — the endpoint holds nothing NOW (wiped or reset since any
         // earlier pull), so forget the guard snapshot: per the contract a push
         // after a 404 is unguarded (nothing to regress against). A stale
         // snapshot from before the 404 could otherwise spuriously park the
         // seeding PUT below.
         lastRemoteTs = -1
         lastRemoteSeen = null
      }
      if (adopted) onMerged?.()
      const wantPush = opts.manual || dirty
      if (wantPush && !opts.manual && !parked && lastRemoteSeen && regressiveSeen(lastRemoteSeen, localSeen())) {
         parked = true // publishing local would rewind the endpoint's progress
      }
      if (wantPush && !parked) {
         await put(url)
         dirty = false
         clearTimeout(pushTimer)
         lastRemoteTs = profileTs()
         lastRemoteSeen = localSeen()
      }
      parkedFlag = parked
      lastOkAt = Math.floor(Date.now() / 1000)
      lastError = ""
   } catch (e) {
      if (navigator.onLine !== false) lastError = e instanceof Error ? e.message : String(e)
   } finally {
      inflight = false
      onStatus?.() // okAt/error/parked moved — let an open config footer repaint
   }
}

// Debounced push, called from nav.ts's two mutation seams (recordSeen /
// toggleSaved) — every seen/saved change on any surface schedules a push.
// pushSoon doubles as the ts-stamping seam: touchProfile runs unconditionally,
// even before a sync URL is configured, because the LWW ordering field must
// track every mutation from the start, not just from whenever sync happens to
// get turned on afterward.
export function pushSoon(): void {
   touchProfile()
   if (!enabled()) return
   dirty = true
   clearTimeout(pushTimer)
   pushTimer = setTimeout(() => void syncNow(), PUSH_DEBOUNCE_MS)
}

// Last-chance PUT when the page hides/unloads: keepalive lets the request
// outlive the page; there's no time for a pre-push pull, so the guard below
// stands in for it. LWW makes a bare PUT dangerous in ways v1's monotone merge
// wasn't — a stale tab could replace a newer remote blob, or rewind the
// endpoint's progress — so a tab that HAS pulled before (lastRemoteTs set)
// checks its remembered remote before publishing; a tab that never pulled
// flushes unguarded, as before (nothing to regress against yet). A skip (or a
// failed PUT) leaves `dirty` set, so the next full cycle — which pulls first —
// resolves it.
export function flush(): void {
   if (!dirty) return
   const url = getSyncUrl()
   if (!url) return
   if (lastRemoteTs >= 0) {
      if (profileTs() < lastRemoteTs) return
      if (lastRemoteSeen && regressiveSeen(lastRemoteSeen, localSeen())) return
   }
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
