// Split-view (two-pane desktop) breakpoint owner: ONE matchMedia subscription,
// written to model.split — the layout record's input (layout.ts), whose effect
// stamps `body.srr-split` for the CSS and for the dependency-free modules
// (gestures.ts reads the class, never this module). isSplit() reads that class
// back rather than caching a boolean, so every caller agrees with the CSS.
import * as model from "./model"

const QUERY = "(min-width: 1000px)"

interface LegacyMQL {
   addListener?: (fn: (e: { matches: boolean }) => void) => void
}

const listeners: Array<(on: boolean) => void> = []

export function initSplit(): void {
   // jsdom / ancient engines: no matchMedia means no breakpoint to follow. Seed
   // the model from a class the host already stamped (the unit suites drive split
   // that way); in a real browser nothing has stamped it and this is false.
   if (typeof matchMedia !== "function") {
      model.split.set(document.body.classList.contains("srr-split"))
      return
   }
   const mql = matchMedia(QUERY)
   model.split.set(mql.matches)
   const printing = () => typeof matchMedia === "function" && matchMedia("print").matches
   const onChange = (e: { matches: boolean }) => {
      // Chrome evaluates width queries against the PAGE BOX while printing, so
      // Ctrl-P fires a crossing and, later, its undo. While print media matches,
      // the CLASS follows the media (the single-surface layout is the better one
      // to print) and the model — the scroller, the built list window, every
      // layout effect — stays exactly as the screen has it. This raw toggle is
      // the one layout-class write outside layout.ts (layout plan deviation D5).
      // The override flag stops applyLayout re-stamping over it; it is derived
      // fresh on every firing, so a crossing Chrome repeats during print preview
      // keeps it engaged.
      if (printing()) {
         document.body.classList.toggle("srr-split", e.matches)
         model.printOverride.set(e.matches !== model.split())
         return
      }
      // Chrome delivers the undo AFTER print media stopped matching (measured:
      // beforeprint → crossing → afterprint → undo), so it lands here. Printing
      // is over either way: hand the class back to layout.ts first.
      model.printOverride.set(false)
      // A print's undo moved nothing on screen — there is no crossing to handle.
      if (e.matches === model.split()) return
      // The model first: its effects re-stamp the classes, the hosts and the
      // scroller synchronously, so every listener below reads a settled layout.
      model.split.set(e.matches)
      for (const fn of listeners) fn(e.matches)
   }
   // Safari < 14 has no addEventListener on MediaQueryList.
   if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange)
   else (mql as LegacyMQL).addListener?.(onChange)
   // Printing ended: whatever override the job left is over, whether or not
   // Chrome has delivered the undo crossing yet.
   window.addEventListener("afterprint", () => model.printOverride.set(false))
}

export function isSplit(): boolean {
   return document.body.classList.contains("srr-split")
}

export function onSplitChange(fn: (on: boolean) => void): void {
   listeners.push(fn)
}
