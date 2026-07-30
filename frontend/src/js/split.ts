// Split-view (two-pane desktop) breakpoint owner — a leaf module like keys.ts:
// ONE matchMedia subscription, mirrored onto <body> as `srr-split`, so CSS and
// every dependency-free module (gestures.ts reads the class, never this module)
// key off a single source instead of duplicating the media query. isSplit()
// reads the class back rather than caching a boolean for the same reason.
const QUERY = "(min-width: 1000px)"

interface LegacyMQL {
   addListener?: (fn: (e: { matches: boolean }) => void) => void
}

const listeners: Array<(on: boolean) => void> = []

export function initSplit(): void {
   // jsdom / ancient engines: no matchMedia means no split view, never an error.
   if (typeof matchMedia !== "function") return
   const mql = matchMedia(QUERY)
   apply(mql.matches)
   const onChange = (e: { matches: boolean }) => {
      apply(e.matches)
      // Chrome evaluates width queries against the PAGE BOX while printing, so
      // Ctrl-P fires a full crossing and its undo — twice the app's whole
      // re-layout for a window that never changed size. The CLASS still follows
      // the media (the single-surface layout is the better one to print), but
      // the JS layout state — the list's scroller, its built window — is left
      // exactly as the screen had it, in both directions of the pair.
      if (typeof matchMedia === "function" && matchMedia("print").matches) return
      for (const fn of listeners) fn(e.matches)
   }
   // Safari < 14 has no addEventListener on MediaQueryList.
   if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange)
   else (mql as LegacyMQL).addListener?.(onChange)
}

function apply(on: boolean): void {
   document.body.classList.toggle("srr-split", on)
}

export function isSplit(): boolean {
   return document.body.classList.contains("srr-split")
}

export function onSplitChange(fn: (on: boolean) => void): void {
   listeners.push(fn)
}
