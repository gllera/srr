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
   const onChange = (e: { matches: boolean }) => {
      // Chrome evaluates width queries against the PAGE BOX while printing, so
      // Ctrl-P fires a full crossing and its undo. The CLASS still follows the
      // media — the single-surface layout is the better one to print — but the
      // model (and so the scroller, the built list window, every layout effect)
      // is left exactly as the screen had it, in both directions of the pair.
      // This raw toggle is the one layout-class write outside layout.ts, and it
      // is deliberate (layout plan deviation D5).
      if (typeof matchMedia === "function" && matchMedia("print").matches) {
         document.body.classList.toggle("srr-split", e.matches)
         return
      }
      // The model first: its effects re-stamp the classes, the hosts and the
      // scroller synchronously, so every listener below reads a settled layout.
      model.split.set(e.matches)
      for (const fn of listeners) fn(e.matches)
   }
   // Safari < 14 has no addEventListener on MediaQueryList.
   if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange)
   else (mql as LegacyMQL).addListener?.(onChange)
}

export function isSplit(): boolean {
   return document.body.classList.contains("srr-split")
}

export function onSplitChange(fn: (on: boolean) => void): void {
   listeners.push(fn)
}
