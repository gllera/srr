// The store snapshot + tab router. The whole store (GET /api/overview) is
// fetched once into `state.snapshot`; every tab renders from it, so switching
// tabs never hits the store. The snapshot is re-read only on boot (a browser
// reload re-runs it), after a mutation via refresh(), and by the focus-refresh.

import { apiGet } from "./api"
import { banner, clearBanner } from "./banner"
import type { OverviewView } from "./types"

const EMPTY: OverviewView = {
   feeds: [],
   tags: [],
   recipes: {},
   out: [],
   m: 0,
   total_art: 0,
   fetched_at: 0,
   dedup_days: 30,
   version: "",
}

// Shared mutable state. A live object reference (not exported `let`s) so tabs
// read `state.snapshot` and applyFeedEvent can mutate it in place.
export const state = {
   snapshot: EMPTY,
   currentTab: "feeds",
   snapshotAt: 0,
}

// tab name -> sync render fn, drawing from state.snapshot. Tab modules register
// themselves here at import time (main.ts imports them for the side effect).
export const renderers: Record<string, () => void> = {}

// drawTab (re)renders the current tab from the cached snapshot — no fetch.
export function drawTab(): void {
   const r = renderers[state.currentTab]
   if (r) {
      try {
         r()
      } catch (e) {
         banner((e as Error).message)
      }
   }
}

export function showTab(name: string): void {
   state.currentTab = name
   history.replaceState(null, "", "#" + name) // deep-linkable; survives the reload-to-refresh model
   for (const b of document.querySelectorAll<HTMLElement>("#tabs button"))
      b.classList.toggle("active", b.dataset.tab === name)
   for (const s of document.querySelectorAll<HTMLElement>(".tab")) s.classList.toggle("active", s.id === name)
   clearBanner()
   drawTab()
}

// loadSnapshot re-pulls the whole-store snapshot without redrawing; snapshotAt
// drives the focus-refresh throttle below.
export async function loadSnapshot(): Promise<void> {
   state.snapshot = (await apiGet("/api/overview")) as OverviewView
   state.snapshotAt = Date.now()
   // The header's version label rides the snapshot (the running binary's
   // version) — set here so every snapshot path keeps it current.
   document.getElementById("ver")!.textContent = state.snapshot.version || ""
}

// refresh re-pulls the snapshot and redraws the current tab. It deliberately
// does NOT clear the banner, so a caller can set a success message and then
// refresh the data under it.
export async function refresh(): Promise<void> {
   await loadSnapshot()
   drawTab()
}

// A hidden tab drifts while the background --interval loop (or a cron fetch)
// writes the store, so a stale-enough snapshot is re-pulled when the operator
// comes back. Tools is not redrawn in place — that would wipe its streamed
// fetch/inspect logs; it re-reads the snapshot on its next render anyway.
const FOCUS_REFRESH_MS = 30000

export function wireTabRouter(): void {
   document
      .querySelectorAll<HTMLElement>("#tabs button")
      .forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab!)))

   // Same-document hash navigation (a bookmark or hand-edited #tab on an open
   // page) switches tabs too; boot handles the initial hash.
   window.addEventListener("hashchange", () => {
      const want = location.hash.slice(1)
      if (renderers[want] && want !== state.currentTab) showTab(want)
   })

   document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - state.snapshotAt < FOCUS_REFRESH_MS) return
      if (document.body.classList.contains("fetching")) return
      try {
         await loadSnapshot()
         if (state.currentTab !== "tools") drawTab()
      } catch {
         // transient — the next focus (or any mutation) retries
      }
   })
}

// boot: pull the whole-store snapshot once, then render the hash-addressed tab
// (default Feeds) from it. A browser reload re-runs this.
export async function boot(): Promise<void> {
   try {
      await loadSnapshot()
   } catch (e) {
      banner((e as Error).message)
   }
   const want = location.hash.slice(1)
   showTab(renderers[want] ? want : "feeds")
}
