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
// retries — rather than queueing.
import * as data from "./data"
import * as nav from "./nav"
import * as search from "./search"

const FOCUS_MIN_INTERVAL_MS = 60_000 // at most one check per minute on re-focus
const POLL_INTERVAL_MS = 300_000 // plus a 5-minute heartbeat while visible

let lastAttempt = 0 // ms; attempt-based like sync.ts, so failures aren't hammered
let lastError = ""
// Fails CLOSED until init() wires the real guard — a pre-init trigger acts
// busy and skips, mirroring sync.ts's inert-before-init posture.
let runExclusive: (fn: () => Promise<void>) => Promise<boolean> = async () => false
let onUpdated: () => void = () => {}

// The last cycle's failure ("" = healthy) — the config status line reads it.
export function lastRefreshError(): string {
   return lastError
}

// One refresh cycle. Resolves to "" on success or a skipped (busy) tick, else
// the error message — the manual Sync-now path popups it; background triggers
// ignore the return and leave it on the status line. Offline failures stay
// silent, like sync.ts — the SW makes offline reading a supported state.
export async function refreshNow(): Promise<string> {
   let result = ""
   await runExclusive(async () => {
      // Stamped only once the guard is acquired: a busy-skipped tick must not
      // consume the throttle window — the next trigger retries (the docblock
      // contract above; sync.ts likewise stamps after its inflight guard).
      lastAttempt = Date.now()
      try {
         if ((await data.refresh()) === "updated") {
            try {
               search.invalidate()
               await nav.onStoreRefreshed()
            } finally {
               // The swap already happened — the UI must reconcile even when
               // the downstream reload half-failed (its error still surfaces
               // via the catch below); without this the next cycle sees
               // "unchanged" and the stranded UI never reconciles.
               onUpdated()
            }
         }
         lastError = ""
      } catch (e) {
         if (navigator.onLine !== false) {
            lastError = e instanceof Error ? e.message : String(e)
            result = lastError
         }
      }
   })
   return result
}

function due(): boolean {
   return Date.now() - lastAttempt >= FOCUS_MIN_INTERVAL_MS
}

// Wire the lifecycle: throttled re-check on tab re-focus, immediate on regained
// connectivity, a slow heartbeat while visible. `exclusive` = app's background
// guard (false = busy, skip); `updated` = app's after-refresh UI routine.
export function init(exclusive: (fn: () => Promise<void>) => Promise<boolean>, updated: () => void): void {
   runExclusive = exclusive
   onUpdated = updated
   document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && due()) void refreshNow()
   })
   window.addEventListener("online", () => void refreshNow())
   setInterval(() => {
      if (document.visibilityState === "visible" && due()) void refreshNow()
   }, POLL_INTERVAL_MS)
}
