// pane.ts — the split-view list pane's WIDTH and VISIBILITY.
//
// A leaf module, sibling to split.ts and scroller.ts: split.ts owns the
// breakpoint (body.srr-split), scroller.ts owns which box the list scrolls, and
// this owns how wide the pane is and whether it is on screen. Imports only
// keys.ts, so it stays unit-testable without a running pack server.
//
// Four things change the pane's VISIBILITY, and only three of them are a press:
// the rail's .srr-pane-toggle button (wired here), the grip's Enter/Space,
// app.ts's `L` — and a DRAG past the collapse threshold, which puts the pane
// away without anybody aiming at a hide control at all. That fourth one is why
// the button's label is synced from applyHidden below rather than from the
// committed setter.
// Two custom properties, one written here and one derived in CSS:
//   --split-pane-open-w  the width the pane is SET to. Written on <html> here,
//                        never zero. tokens.css carries the default, because
//                        nothing writes this property before restorePane() runs
//                        (and nothing writes it at all if storage is blocked).
//   --split-pane-w       the width the page RESERVES: `var(--split-pane-open-w)`
//                        on body.srr-split, 0px on body.srr-split.srr-pane-hidden.
//                        Both states are declared on BODY — not because :root
//                        could not reach it (custom properties inherit, so a
//                        body-level override would still win over an inherited
//                        :root value), but because body's own padding-left is
//                        what reserves the pane, and keeping the derivation and
//                        its override in one rule scope beside that declaration
//                        is what makes the whole hidden state readable in one
//                        place instead of split across tokens.css and styles.css.
//                        That is also what makes hiding ONE class toggle — no JS
//                        layout pass, no re-measure.
// Scoping matters in the other direction too: restorePane() stamps the hidden
// class at ANY viewport (it is state independent of the breakpoint, which split.ts
// owns on its own schedule), so a phone can legitimately carry it over from a
// desktop session — which is why the 0px override is scoped under body.srr-split.
// Every pre-existing split rule already reads --split-pane-w and stays untouched.
import { PANE_HIDDEN_KEY, PANE_WIDTH_KEY } from "./keys"

export const PANE_DEFAULT_W = 380
export const PANE_MIN_W = 280
// A drag BELOW this collapses the pane instead of stopping at PANE_MIN_W: the
// grip's exit gesture. Deliberately under the minimum so ordinary resizing near
// the floor cannot trip it.
export const PANE_COLLAPSE_W = 240
// The FLOOR of the ceiling: every viewport at or under 1600 gets exactly this,
// and the viewport cap below can only lower it.
export const PANE_MAX_W = 560
// The ceiling of the ceiling. Past here a wider monitor buys no more pane: at
// some point the list stops being a list of headlines and becomes a second
// article column, and 900px is where titles already have more room than the
// measure beside them.
export const PANE_MAX_CEIL = 900
// Why the ceiling moves at all: the reading column centres in what the pane
// LEAVES, so the emptier the remainder the further the text drifts away from the
// pane. At 2560 a 380px pane leaves ~750px of nothing on both sides of a 680px
// measure, and the pane reads marooned rather than docked. Letting it grow with
// the screen closes that gap from the side that has the room, without jamming
// the measure against the pane (which would only move the imbalance).
// 0.35 is not arbitrary: 35% of 1600 is 560 EXACTLY, so this rule meets the old
// constant at the seam and nothing at or below 1600 moves by a pixel.
const PANE_WIDE_FRACTION = 0.35

// Internal: clampPaneW is the only caller, and deliberately so — the grip's
// aria-valuemax has to go through the clamp rather than this, because the
// half-viewport cap below can still lower the answer.
// Total over a NaN viewport for the same reason clampPaneW is (see below).
function paneCeiling(viewportW: number): number {
   if (!Number.isFinite(viewportW)) return PANE_MAX_W
   const wide = Math.round(viewportW * PANE_WIDE_FRACTION)
   return Math.min(PANE_MAX_CEIL, Math.max(PANE_MAX_W, wide))
}

const HIDDEN_CLASS = "srr-pane-hidden"

// The rail's toggle button, cached at initPane. CACHED rather than looked up
// per call because the sync below hangs off applyHidden, which a drag runs once
// per animation frame — a querySelector there is a DOM query per frame for a
// node that never moves. Null is a legal state, not an error: most of this
// module's unit tests drive it with no markup at all, and the design harness
// mounts panes without a toolbar, so the sync no-ops instead of the callers
// having to remember a guard.
let toggleBtn: HTMLButtonElement | null = null

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
   const max = Math.max(PANE_MIN_W, Math.min(paneCeiling(viewportW), half))
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
   syncToggle()
}

// The button discloses a REGION, so aria-expanded (not aria-pressed) is its
// state, and its accessible name has to say what the press will DO — "Hide list"
// while the list is there, "Show list" while it is not. That name is the half
// nothing else on screen carries: a sighted user reads the pane's presence off
// the layout, which is exactly what a screen-reader user cannot do.
//
// It hangs off applyHidden, not off the committed setPaneHidden, because the
// committed setter is not the only way the pane goes away: a drag past the
// collapse threshold hides it through applyHidden DIRECTLY (it must — a mid-drag
// frame cannot touch storage), and restorePane comes through the same door. One
// level up would leave the button announcing "Hide list" over a pane the drag
// just took off screen.
function syncToggle(): void {
   if (!toggleBtn) return
   const hidden = isPaneHidden()
   const label = hidden ? "Show list" : "Hide list"
   toggleBtn.setAttribute("aria-expanded", hidden ? "false" : "true")
   toggleBtn.setAttribute("aria-label", label)
   toggleBtn.title = `${label} (L)`
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

// ── The grip: the column rule between the wire and the page ──────────────────
// A real ARIA window splitter (role=separator + aria-value*), driven by pointer
// capture and by the keyboard. It writes --split-pane-open-w at most once per
// frame during a drag, and persists + asks for a re-layout only on release:
// rows genuinely re-wrap at a new width, so the list's virtualized window has
// to re-measure — but once, not sixty times a second.

const KEY_STEP = 16
const KEY_STEP_BIG = 64

interface PaneDeps {
   onSettle(): void
}

let deps: PaneDeps = { onSettle: () => {} }
let raf = 0
let pendingW = 0

// The width that is ON SCREEN, which is not always the width in storage: lsSet
// swallows a private-mode/quota failure by design, and the layout applies
// anyway. Sourcing the grip's own state from storage would then announce 380
// forever at a pane the eye sees at 500, and step every arrow press from that
// same stale 380 so the width could never accumulate. storedPaneW is the
// fallback for the one moment the property is genuinely absent — before
// restorePane's first write, or under a stylesheet that has never seen it.
function appliedPaneW(): number {
   const raw = parseFloat(document.documentElement.style.getPropertyValue("--split-pane-open-w"))
   return Number.isFinite(raw) && raw > 0 ? raw : storedPaneW()
}

function publish(grip: HTMLElement): void {
   const max = clampPaneW(Number.MAX_SAFE_INTEGER, window.innerWidth)
   grip.setAttribute("aria-valuemin", String(PANE_MIN_W))
   grip.setAttribute("aria-valuemax", String(max))
   grip.setAttribute("aria-valuenow", String(Math.round(appliedPaneW())))
}

// Commit a width the user landed on: apply it, persist it, publish it, and ask
// the app for one re-layout.
function settle(grip: HTMLElement, px: number): void {
   applyDragWidth(px, window.innerWidth, { persist: true })
   publish(grip)
   deps.onSettle()
}

export function initPane(d: PaneDeps): void {
   deps = d
   // BEFORE restorePane, which reaches applyHidden → syncToggle: a ref cached
   // after it would miss the one state the button most needs to describe, the
   // hidden pane a reload just restored. Wired before the grip lookup for the
   // same reason it is queried separately — the button lives in the toolbar and
   // must not depend on a document that happens to also have a grip.
   toggleBtn = document.querySelector(".srr-pane-toggle") as HTMLButtonElement | null
   toggleBtn?.addEventListener("click", () => {
      togglePane()
      deps.onSettle()
   })
   restorePane()
   const grip = document.querySelector(".srr-pane-grip") as HTMLElement | null
   if (!grip) return
   grip.setAttribute("role", "separator")
   grip.setAttribute("aria-orientation", "vertical")
   grip.setAttribute("aria-label", "Resize the article list")
   // Focusable unconditionally, and that is safe ONLY because the stylesheet
   // display:none's the grip outside body.srr-split: a display:none element is
   // not a tab stop, so below the breakpoint there is no invisible control to
   // land on. Keep the two facts together — a CSS rule that made it merely
   // invisible (visibility, opacity, a zero box) would put a phantom stop in
   // every phone's tab order.
   grip.setAttribute("tabindex", "0")
   publish(grip)

   grip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      grip.classList.add("srr-grip-active")
   })

   grip.addEventListener("pointermove", (e: PointerEvent) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      // One write per frame. clientX IS the width: the pane's left edge is 0.
      pendingW = e.clientX
      if (raf) return
      raf = requestAnimationFrame(() => {
         raf = 0
         // No persist and no re-layout mid-drag — the pane's own width follows
         // live, and the list re-measures once the drag stops moving.
         applyDragWidth(pendingW, window.innerWidth)
      })
   })

   const endDrag = (e: PointerEvent) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      grip.releasePointerCapture(e.pointerId)
      grip.classList.remove("srr-grip-active")
      if (raf) {
         cancelAnimationFrame(raf)
         raf = 0
      }
      settle(grip, e.clientX)
   }
   grip.addEventListener("pointerup", endDrag)
   grip.addEventListener("pointercancel", endDrag)

   // Back to the default. A reset needs a gesture that cannot be reached by
   // dragging, and double-click is the one every splitter in every OS uses.
   grip.addEventListener("dblclick", (e) => {
      e.preventDefault()
      settle(grip, PANE_DEFAULT_W)
   })

   grip.addEventListener("keydown", (e: KeyboardEvent) => {
      const cur = appliedPaneW()
      const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP
      let next: number | null = null
      if (e.key === "ArrowLeft") next = cur - step
      else if (e.key === "ArrowRight") next = cur + step
      else if (e.key === "Home") next = PANE_MIN_W
      else if (e.key === "End") next = clampPaneW(Number.MAX_SAFE_INTEGER, window.innerWidth)
      else if (e.key === "Enter" || e.key === " ") {
         e.preventDefault()
         togglePane()
         deps.onSettle()
         return
      }
      if (next === null) return
      e.preventDefault()
      settle(grip, next)
   })
}
