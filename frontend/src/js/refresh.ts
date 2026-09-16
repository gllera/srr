// refresh.ts — live content sync: an open tab silently adopts a newer store
// snapshot (spec: docs/superpowers/specs/2026-07-06-frontend-content-sync-design.md).
// Owns the TRIGGERS only, mirroring sync.ts's shape (lifecycle wiring +
// throttle, no DOM): the state swap is data.refresh(), the downstream
// reconciliation is search.invalidate() + nav.onStoreRefreshed() + the UI
// routine app.ts injects. Every check is one conditional GET of db.gz (a 304
// when the store hasn't moved), so the cadence is cheap by design.
//
// Runs under app's guard mutex (injected as `exclusive`) so the swap can never
// interleave with a navigation; a busy mutex SKIPS the tick — the next trigger
// retries — rather than queueing. The mutex deliberately spans the db.gz fetch
// as well as the swap: a dropped tick just retries, whereas splitting fetch
// from swap would reintroduce the interleave the mutex exists to prevent.
import * as data from "./data"
import * as model from "./model"
import * as nav from "./nav"
import * as search from "./search"
import { batch, untracked } from "./signals"

const FOCUS_MIN_INTERVAL_MS = 60_000 // at most one check per minute on re-focus
const POLL_INTERVAL_MS = 300_000 // plus a 5-minute heartbeat while visible

let lastAttempt = 0 // ms; attempt-based like sync.ts, so failures aren't hammered
// Fails CLOSED until init() wires the real guard — a pre-init trigger acts
// busy and skips, mirroring sync.ts's inert-before-init posture.
let runExclusive: (fn: () => Promise<void>) => Promise<boolean> = async () => false

// The last cycle's failure ("" = healthy) — the settings footer reads it.
export function lastRefreshError(): string {
   return untracked(() => model.refreshError())
}

// Announce an adopted snapshot to the model (D2). Only ever called AFTER
// search.invalidate() and nav.onStoreRefreshed() reconciled to it: effects flush
// synchronously, so a write any earlier would run them against stale bounds and
// a stale search snapshot. `grown` = the store gained articles — the reader's
// arrivals pulse keys on storeGrown, the list's growth on snapshot (S21).
export function publishSnapshot(grown: boolean): void {
   batch(() => {
      model.snapshot.update((n) => n + 1)
      if (grown) model.storeGrown.update((n) => n + 1)
   })
}

// One refresh cycle. Resolves to "" on success or a skipped (busy) tick, else
// the error message; the background triggers ignore the return and leave the
// failure on the config status line (there is no manual button — a page reload
// is the manual gesture, and it re-fetches everything anyway). Offline failures
// stay silent, like sync.ts — the SW makes offline reading a supported state.
export async function refreshNow(): Promise<string> {
   let result = ""
   await runExclusive(async () => {
      // Stamped only once the guard is acquired: a busy-skipped tick must not
      // consume the throttle window — the next trigger retries (the docblock
      // contract above; sync.ts likewise stamps after its inflight guard).
      lastAttempt = Date.now()
      try {
         const before = data.db?.total_art ?? 0
         if ((await data.refresh()) === "updated") {
            try {
               search.invalidate()
               await nav.onStoreRefreshed()
            } finally {
               // The swap already happened — the snapshot must still be
               // published even when the downstream reload half-failed (its
               // error still surfaces via the catch below); without this the
               // next cycle sees "unchanged" and the stranded UI never
               // reconciles.
               publishSnapshot((data.db?.total_art ?? 0) > before)
            }
         }
         model.refreshError.set("")
      } catch (e) {
         if (navigator.onLine !== false) {
            result = e instanceof Error ? e.message : String(e)
            model.refreshError.set(result)
         }
      }
      // Background poll of every OTHER mounted store (docs/MULTI-STORE-SPEC.md
      // §6.3). Independent of the active lane: a peer failure never sets
      // lastError (peers surface their own per-mount chip via data.mountStatus)
      // and never reconciles the active nav state. Only a peer that CHANGED
      // shape bumps model.mountsRev, which repaints the picker's rollups.
      // Single-store (home only) makes this a no-op — there are no peers.
      try {
         await data.refreshPeers()
      } catch {
         // peer errors are per-mount, already recorded in data.mountStatus
      }
   })
   return result
}

function due(): boolean {
   return Date.now() - lastAttempt >= FOCUS_MIN_INTERVAL_MS
}

// Wire the lifecycle: throttled re-check on tab re-focus, immediate on regained
// connectivity, a slow heartbeat while visible. `exclusive` = app's background
// guard (false = busy, skip). What follows an adopted snapshot is the model's:
// publishSnapshot here, and data.ts's mountsRev for a peer that changed shape.
export function init(exclusive: (fn: () => Promise<void>) => Promise<boolean>): void {
   runExclusive = exclusive
   document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && due()) void refreshNow()
   })
   window.addEventListener("online", () => {
      // Regained connectivity resets every mount's backoff so a dead peer is
      // retried immediately (§8.3), then runs a cycle.
      data.resetMountBackoff()
      void refreshNow()
   })
   setInterval(() => {
      if (document.visibilityState === "visible" && due()) void refreshNow()
   }, POLL_INTERVAL_MS)
}
