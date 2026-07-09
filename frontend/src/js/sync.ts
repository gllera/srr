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
// endpoint's content doubles as a restorable backup. The model assumes ONE
// reader on every device, so every cycle — background and manual alike — is the
// same hybrid merge (profile.ts importProfile mode:"sync"):
//   seen     — per-feed max: read progress is the union of what the one person
//              read anywhere, so it only ever RISES, on this device and on the
//              endpoint. No timestamps, no guards, no parking — a lower remote
//              value is never newer information, just an older snapshot of the
//              same reader.
//   saved+ts — last-write-wins by `ts` (profile.ts's ordering field, stamped on
//              every local seen/saved mutation): the saved set is the person's
//              current intent, so un-saves propagate.
// The push needs no guard: after the merge, local ⊒ the just-pulled remote on
// seen and holds the LWW-newest saved/ts, so a PUT can never lower the
// endpoint. And it fires whenever the endpoint is actually BEHIND (its seen
// regressive against local / its ts older / a 404 to seed) — derived from the
// pulled blob, not just the in-memory dirty flag, because a reload loses that
// flag and an endpoint regressed by a stale tab's flush or an old-build LWW
// device must heal on any device's next cycle. There is deliberately NO path
// that lowers read progress; the one surviving guard (`flush`, below) only
// protects the endpoint from a stale tab's blind PUT.
//
// A v1 remote (a pre-upgrade endpoint, or another device still on the old
// build) has no `ts` to order saved by, so it gets one legacy monotone merge
// (mode:"merge" — seen max + saved union) and always forces a push afterward so
// the endpoint upgrades to v2.
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
let lastRemoteSeen: Record<string, number> | null = null // its seen map, for flush()'s stale-tab guard

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

// True when `incoming` holds LESS read progress than `cur`: some feed key of
// `cur` is absent from `incoming` or maps to a lower number. Two consumers:
// the cycle's push trigger (the pulled remote is behind local → re-raise the
// endpoint) and flush()'s stale-tab guard. Seen axis ONLY — saved-set deltas
// (including un-saves) are ordered by ts, not by progress.
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

// One full cycle of the one-reader hybrid merge (module docblock): pull, merge
// (seen max-raise + saved/ts LWW; a v1 remote gets the legacy monotone merge
// and a forced upgrade push), then push whenever the endpoint is behind.
// Returns whether the pull CHANGED local seen/saved — the caller's re-anchor
// signal (a ts-only convergence returns false; so do failures and no-ops).
// `manual` no longer changes the merge — it only forces the push (the Refresh
// tap republishes even a fully-converged blob). A pull failure skips the push
// (never PUT over a remote we failed to read); offline failures stay silent —
// the SW makes offline reading a supported state, not a sync fault.
export async function syncNow(opts: { manual?: boolean } = {}): Promise<boolean> {
   const url = getSyncUrl()
   if (!url || inflight) return false
   inflight = true
   lastPullAt = Date.now()
   let changed = false
   try {
      const remote = await pullRemote(url)
      if (remote) {
         lastRemoteTs = remote.ts
         lastRemoteSeen = remote.seen
         const r = importProfile(remote.raw, { prefs: false, mode: remote.v === 1 ? "merge" : "sync" })
         if (!r.ok) throw new Error(r.error ?? "invalid profile")
         changed = r.changed === true
         // A v1 remote always upgrade-pushes so the endpoint moves to v2.
         if (remote.v === 1) dirty = true
      } else {
         // 404 — the endpoint holds nothing NOW (wiped or reset since any
         // earlier pull), so forget flush()'s guard snapshot; the seeding push
         // below has nothing to regress against.
         lastRemoteTs = -1
         lastRemoteSeen = null
      }
      if (changed) onMerged?.()
      // Push whenever the endpoint is behind, derived from the pulled blob
      // itself (see the module docblock): `dirty` alone is an in-memory flag a
      // reload loses, and a transiently-regressed endpoint must heal on any
      // device's next cycle. A 404 endpoint is seeded — but only when local
      // holds any state (a fresh device against a fresh endpoint has nothing
      // to say). Safe unguarded — the merge above made local ⊒ remote on seen,
      // and local saved/ts is the LWW newest.
      const wantPush =
         opts.manual ||
         dirty ||
         (remote
            ? regressiveSeen(localSeen(), remote.seen) || profileTs() > remote.ts
            : profileTs() > 0 || Object.keys(localSeen()).length > 0)
      if (wantPush) {
         await put(url)
         dirty = false
         clearTimeout(pushTimer)
         lastRemoteTs = profileTs()
         lastRemoteSeen = localSeen()
      }
      lastOkAt = Math.floor(Date.now() / 1000)
      lastError = ""
   } catch (e) {
      if (navigator.onLine !== false) lastError = e instanceof Error ? e.message : String(e)
   } finally {
      inflight = false
      onStatus?.() // okAt/error moved — let an open config footer repaint
   }
   return changed
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
// outlive the page; there's no time for the pre-push pull whose merge makes a
// normal push safe, so the guard below stands in for it. A blind PUT from a
// stale tab could still lower the endpoint — its seen can sit below the
// endpoint's (nav.pruneSeen legitimately drops deleted feeds' keys), and its
// saved/ts can predate a newer device's blob — so a tab that HAS pulled before
// (lastRemoteTs set) checks its remembered remote before publishing; a tab
// that never pulled flushes unguarded, as before (nothing to regress against
// yet). A skip (or a failed PUT) leaves `dirty` set, so the next full cycle —
// which pulls first — resolves it. And even if a stale snapshot lets a
// regressive flush through, the raise-only merge means any device holding the
// higher value re-raises the endpoint on its next cycle — flush mistakes heal.
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
