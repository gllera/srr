// pane.ts — the split-view list pane's WIDTH and VISIBILITY.
//
// A leaf module, sibling to split.ts and scroller.ts: split.ts owns the
// breakpoint (body.srr-split), scroller.ts owns which box the list scrolls, and
// this owns how wide the pane is and whether it is on screen. Imports only
// keys.ts, so it stays unit-testable without a running pack server.
//
// STAGED, NOT YET WIRED: nothing calls this module and the CSS half lands with
// the layout task, so today it writes a property nothing reads and toggles a
// class nothing styles — no observable effect until both arrive. What that task
// owes, stated as the requirements they are rather than as description:
//   --split-pane-open-w  the width the pane is SET to. Written on <html> here,
//                        never zero. tokens.css MUST carry the default, because
//                        nothing writes this property before restorePane() runs
//                        (and nothing writes it at all if storage is blocked).
//   --split-pane-w       the width the page RESERVES. MUST be declared ON BODY,
//                        as `var(--split-pane-open-w)`, with the 0px override
//                        under body.srr-pane-hidden on that SAME element, so the
//                        cascade alone chooses between them. Body is where it
//                        belongs because body's own padding-left is what reserves
//                        the pane; keeping the derivation and its override
//                        together there is what makes hiding ONE class toggle —
//                        no JS layout pass, no re-measure. Today tokens.css
//                        instead hardcodes --split-pane-w at :root; replacing
//                        that is the layout task's job, not this module's.
// Every pre-existing split rule already reads --split-pane-w and stays untouched.
import { PANE_HIDDEN_KEY, PANE_WIDTH_KEY } from "./keys"

export const PANE_DEFAULT_W = 380
export const PANE_MIN_W = 280
// A drag BELOW this collapses the pane instead of stopping at PANE_MIN_W: the
// grip's exit gesture. Deliberately under the minimum so ordinary resizing near
// the floor cannot trip it.
export const PANE_COLLAPSE_W = 240
// The absolute ceiling; the viewport cap below can only lower it.
export const PANE_MAX_W = 560

const HIDDEN_CLASS = "srr-pane-hidden"

function lsSet(key: string, value: string | null): void {
   try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
   } catch {
      // private mode / quota — the layout still applies, it just won't survive a reload
   }
}

function lsGet(key: string): string {
   try {
      return localStorage.getItem(key) ?? ""
   } catch {
      return ""
   }
}

// The ceiling never drops below the floor: on a viewport so narrow that half of
// it is under PANE_MIN_W, clamp() would otherwise invert and return the max.
//
// TOTAL over its inputs, which is the point of routing every width through it:
// Math.min/max propagate NaN, so a grip handing us a coordinate-less event would
// otherwise reach setPaneW and write the string "NaNpx" — invalid, so the live
// layout silently snaps back to the token default mid-drag, and a persisted
// "NaN" then has to be caught again on the way back out.
export function clampPaneW(px: number, viewportW: number): number {
   const half = Number.isFinite(viewportW) ? Math.round(viewportW * 0.5) : PANE_MAX_W
   const max = Math.max(PANE_MIN_W, Math.min(PANE_MAX_W, half))
   const want = Number.isFinite(px) ? Math.round(px) : PANE_DEFAULT_W
   return Math.min(max, Math.max(PANE_MIN_W, want))
}

// Clamped on every READ, not just on every write: a width stored on a 2560
// monitor must not survive onto a 1280 laptop.
export function storedPaneW(viewportW: number = window.innerWidth): number {
   const raw = Number(lsGet(PANE_WIDTH_KEY))
   if (!Number.isFinite(raw) || raw <= 0) return clampPaneW(PANE_DEFAULT_W, viewportW)
   return clampPaneW(raw, viewportW)
}

// The RAW writer: it rounds but does NOT clamp, so a caller carrying a number
// the user chose (a drag, a keyboard step) goes through applyDragWidth or clamps
// first. Unclamped on purpose — a clamp here would silently swallow the collapse
// gesture, whose whole signal is a width below the floor.
export function setPaneW(px: number, opts: { persist?: boolean } = {}): void {
   // One rounding, used for both the property and the stored value — two
   // Math.round calls could only ever agree, never be provably identical.
   const w = Math.round(px)
   document.documentElement.style.setProperty("--split-pane-open-w", `${w}px`)
   if (opts.persist) lsSet(PANE_WIDTH_KEY, String(w))
}

export function isPaneHidden(): boolean {
   return document.body.classList.contains(HIDDEN_CLASS)
}

// The class toggle and the persist-write, independently drivable. They have to
// be: a drag calls the visibility path ONCE PER ANIMATION FRAME, and a version
// that always wrote would put a localStorage hit on every frame of every drag —
// exactly the write spam the `persist` flag exists to prevent. Callers below
// pick: the button/keyboard path persists, the drag path persists only at the
// end, and restore never does.
function applyHidden(on: boolean, persist: boolean): void {
   document.body.classList.toggle(HIDDEN_CLASS, on)
   if (persist) lsSet(PANE_HIDDEN_KEY, on ? "1" : null)
}

// The committed toggle — the button, the keyboard shortcut. Always persists:
// there is no transient form of this gesture.
export function setPaneHidden(on: boolean): void {
   applyHidden(on, true)
}

export function togglePane(force?: boolean): void {
   setPaneHidden(force ?? !isPaneHidden())
}

// One drag frame's worth of width — called per rAF while a pointer is down, and
// once more with `persist` on release. Below the collapse threshold it HIDES
// rather than clamping, and leaves the stored WIDTH alone even when persisting,
// so re-opening restores the last real width and not the 240px the pointer
// passed through. `persist` gates BOTH halves (see applyHidden): a mid-drag
// frame must touch storage zero times.
export function applyDragWidth(px: number, viewportW: number, opts: { persist?: boolean } = {}): void {
   const persist = !!opts.persist
   // A strict `<`: exactly PANE_COLLAPSE_W is still a resize. The threshold is
   // the first width that means "let go of the pane", not the last that doesn't.
   if (px < PANE_COLLAPSE_W) {
      applyHidden(true, persist)
      return
   }
   applyHidden(false, persist)
   setPaneW(clampPaneW(px, viewportW), opts)
}

// A READ, deliberately: nothing here persists. Restoring through the writing
// paths would put back the very defaults it just failed to find, freezing
// today's PANE_DEFAULT_W into storage as a preference the user never expressed.
export function restorePane(): void {
   setPaneW(storedPaneW())
   applyHidden(lsGet(PANE_HIDDEN_KEY) === "1", false)
}
