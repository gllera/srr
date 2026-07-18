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
//   seen+st  — per-feed LWW by the per-key `st` timestamps (stamped by nav.ts
//              on every local seen mutation), falling back to per-feed max when
//              a key lacks ordering info on either side. Reading only ever
//              RAISES a frontier, so ordinary progress still merges as the
//              union of what the one person read anywhere; the ONE path that
//              lowers a frontier is an explicit rewind (nav.markUnreadFrom),
//              whose fresher `st` outranks the older raise on every device —
//              intent, ordered like saved, not lost progress.
//   saved+ts — last-write-wins by `ts` (profile.ts's ordering field, stamped on
//              every local seen/saved mutation): the saved set is the person's
//              current intent, so un-saves propagate.
// The push needs no guard: after the merge, local ⊒ the just-pulled remote on
// seen (per-key: the newer-ordered or higher value everywhere) and holds the
// LWW-newest saved/ts, so a PUT can never cost the endpoint state. And it
// fires whenever the endpoint is actually BEHIND (its seen missing local
// progress or ordering / its ts older / a 404 to seed) — derived from the
// pulled blob, not just the in-memory dirty flag, because a reload loses that
// flag and an endpoint regressed by a stale tab's flush or an old-build LWW
// device must heal on any device's next cycle. The one surviving guard
// (`flush`, below) only protects the endpoint from a stale tab's blind PUT —
// and flush fires on the same delta (not just `dirty`), so a page-hide still
// delivers progress the endpoint is missing when the flag was lost or a
// background push failed.
//
// A v1 remote (a pre-upgrade endpoint, or another device still on the old
// build) has no `ts` to order saved by, so it gets one legacy monotone merge
// (mode:"merge" — seen max + saved union) and always forces a push afterward so
// the endpoint upgrades to v2.
//
// Like profile.ts, this module imports only keys.ts + profile.ts (no data.ts /
// fmt.ts) so it unit-tests without a pack server or the base.ts URL side effect.

import { SYNC_URL_KEY } from "./keys"
import { exportProfile, importProfile, localSeen, localSeenTs, profileTs, touchProfile } from "./profile"
import { isValidHttpish, normalizeHttpish } from "./urlish"

// Push settles PUSH_DEBOUNCE_MS after the last seen/saved change (a reading
// burst is one PUT); background pulls (tab re-focus) are at most one per
// PULL_MIN_INTERVAL_MS so tab-switching doesn't hammer the endpoint.
const PUSH_DEBOUNCE_MS = 1000
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
let lastRemoteSt: Record<string, number> = {} // its per-key seen timestamps, paired with lastRemoteSeen

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
   lastRemoteSt = {}
}

export function enabled(): boolean {
   return getSyncUrl() !== ""
}

// isValidSyncUrl / normalizeSyncUrl are the shared urlish.ts helpers (scheme
// optional, https default, dangerous schemes rejected) with one difference from
// the image-proxy pair: no trailing "/" is appended — the sync URL is a full
// endpoint (".../profile"), not a prefix, and "/profile" vs "/profile/" can be
// two different routes to the server.
export function isValidSyncUrl(v: string): boolean {
   return isValidHttpish(v)
}

export function normalizeSyncUrl(v: string): string {
   return normalizeHttpish(v, false)
}

// The status readout consumed by the settings menu's status footer.
export interface SyncState {
   on: boolean
   okAt: number // unix seconds of the last completed cycle; 0 = never
   error: string // last cycle's failure ("" = healthy)
}

export function state(): SyncState {
   return { on: enabled(), okAt: lastOkAt, error: lastError }
}

// True when `b` is MISSING seen state that `a` holds: some feed key of `a` is
// absent from `b`, carries a strictly newer per-key timestamp on `a`'s side
// (a's value — raise OR explicit rewind — is newer intent), or, when either
// side lacks the key's timestamp, maps to a lower number on `b` (the legacy
// progress-only comparison). Two consumers, in both directions: the cycle's
// push trigger (the pulled remote is behind local → republish the endpoint)
// and flush()'s stale-tab guard (local behind the remembered remote → skip).
// Seen axis ONLY — saved-set deltas (including un-saves) are ordered by the
// blob-level ts, not by this.
export function seenBehind(
   a: Record<string, number>,
   aTs: Record<string, number>,
   b: Record<string, number>,
   bTs: Record<string, number>,
): boolean {
   for (const [k, v] of Object.entries(a)) {
      const bv = b[k]
      if (bv === undefined) return true
      const at = aTs[k] ?? 0
      const bt = bTs[k] ?? 0
      // profile.ts mergeSeen's adopt rule, asked from b's side: would merging
      // a into b move b's value or its ordering metadata? Yes ⇒ b is behind.
      // (A newer a-side timestamp counts even at equal values: the ordering
      // itself must propagate, or a rewind's precedence dies at the endpoint.)
      if (at > 0 && bt > 0 && at !== bt ? at > bt : v > bv) return true
   }
   return false
}

interface RemoteBlob {
   v: 1 | 2
   ts: number
   seen: Record<string, number>
   st: Record<string, number>
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
   // The per-key seen timestamps (absent on v1 / pre-upgrade v2 blobs → {} —
   // every comparison then degrades to the legacy progress-only rule).
   const st: Record<string, number> = {}
   const stRaw = obj["st"]
   if (stRaw !== null && typeof stRaw === "object" && !Array.isArray(stRaw))
      for (const [k, val] of Object.entries(stRaw as Record<string, unknown>))
         if (typeof val === "number" && Number.isFinite(val) && val > 0) st[k] = Math.floor(val)
   return { v: v as 1 | 2, ts, seen, st, raw }
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
         lastRemoteSt = remote.st
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
         lastRemoteSt = {}
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
            ? seenBehind(localSeen(), localSeenTs(), remote.seen, remote.st) || profileTs() > remote.ts
            : profileTs() > 0 || Object.keys(localSeen()).length > 0)
      if (wantPush) {
         await put(url)
         dirty = false
         clearTimeout(pushTimer)
         lastRemoteTs = profileTs()
         lastRemoteSeen = localSeen()
         lastRemoteSt = localSeenTs()
      }
      lastOkAt = Math.floor(Date.now() / 1000)
      lastError = ""
   } catch (e) {
      if (navigator.onLine !== false) lastError = e instanceof Error ? e.message : String(e)
   } finally {
      inflight = false
      onStatus?.() // okAt/error moved — let an open settings-menu footer refill
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
// normal push safe, so the guard below stands in for it.
//
// TRIGGER — fire whenever the endpoint is (or may be) BEHIND local, mirroring
// syncNow's delta-derived wantPush rather than trusting the in-memory `dirty`
// flag alone. `dirty` is set only by a local mutation (pushSoon), yet local can
// sit ahead of the endpoint with `dirty` false: a background push that FAILED
// (its catch never re-armed the flag, and a delta-driven push never set it) or
// a reload that lost it outright. So also push when local is provably ahead of
// the last remembered remote — its seen regressive against local, or a newer
// local ts. A tab that never pulled (lastRemoteTs < 0) has no remote to compare
// and so still needs `dirty` to have something worth sending; local == remote ⇒
// no PUT, so the common quiet tab-switch stays quiet.
//
// GUARD — a blind PUT from a stale tab could still LOWER the endpoint: its seen
// can sit below the endpoint's (nav.pruneSeen legitimately drops a deleted
// feed's key) and its saved/ts can predate a newer device's blob. So a tab that
// HAS pulled before (lastRemoteTs set) refuses to publish a blob that regresses
// its remembered remote. A skip (or a failed PUT) leaves `dirty` set, so the
// next full cycle — which pulls first — resolves it. And even if a stale
// snapshot lets a regressive flush through, the raise-only merge means any
// device holding the higher value re-raises the endpoint next cycle — flush
// mistakes heal.
export function flush(): void {
   const url = getSyncUrl()
   if (!url) return
   const seen = localSeen()
   const seenTs = localSeenTs()
   if (lastRemoteTs >= 0) {
      if (profileTs() < lastRemoteTs) return
      if (lastRemoteSeen && seenBehind(lastRemoteSeen, lastRemoteSt, seen, seenTs)) return
   }
   const behind =
      dirty ||
      (lastRemoteTs >= 0 &&
         ((lastRemoteSeen !== null && seenBehind(seen, seenTs, lastRemoteSeen, lastRemoteSt)) ||
            profileTs() > lastRemoteTs))
   if (!behind) return
   clearTimeout(pushTimer)
   dirty = false
   void put(url, true).catch(() => {
      dirty = true
   })
}

// Wire the lifecycle: boot pull (when enabled), re-pull on tab re-focus
// (throttled) and on regaining connectivity, flush on hide/pagehide. `merged`
// is app.ts's refresh routine — rerender the list / badges after a pull
// changed local state; `status` refills an open settings-menu footer after every
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
