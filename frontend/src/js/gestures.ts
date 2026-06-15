import { closeAllDropdowns } from "./dropdown"
import * as nav from "./nav"

export interface GestureDeps {
   prev: HTMLButtonElement
   next: HTMLButtonElement
   toolbar: HTMLElement
   // The reader article — its --read (0→1) drives the read-through spine. The
   // toolbar scroll listener already fires on every scroll, so the gauge rides it
   // (no second listener); app.ts calls syncReadProgress() after each render.
   reader: HTMLElement
   guard: (fn: () => Promise<IShowFeed>) => void
   // Two-finger vertical swipe = step the filter. The handler is surface-aware
   // (reader → cycle to next filter's article; list → re-filter the list), so
   // app.ts owns it rather than calling nav.cycleFilter directly.
   onCycle: (dir: number) => void
}

export interface Gestures {
   // Resync the scroll baseline after a programmatic scroll (the list's anchor
   // jump / prepend compensation), and reveal the toolbar. Without this, the jump
   // reads as a fast downward scroll and the scroll handler hides the toolbar.
   resetScroll(): void
   // Recompute the read-through spine fill. Called after a render() scrolls the
   // new article to the top (scrollTo(0,0) fires no scroll event when already at
   // 0), so a short article that needs no scroll still inks its spine to full.
   syncReadProgress(): void
}

// setupGestures wires touch swipes (one-finger left/right = prev/next,
// two-finger vertical = cycle filter) and scroll-based toolbar hide.
export function setupGestures(deps: GestureDeps): Gestures {
   let touchStartX = 0
   let touchStartY = 0
   let twoFingerStartY = 0
   let twoFingerDy = 0
   // The tracked gesture, if any. A swipe is only evaluated when it began as
   // a single-finger gesture ("single"), so a 3+-finger tap/lift ("none")
   // can't fire a spurious prev/next off a stale touchStartX.
   let mode: "none" | "single" | "two" = "none"

   const trackSingle = (t: Touch) => {
      mode = "single"
      touchStartX = t.clientX
      touchStartY = t.clientY
   }

   document.addEventListener(
      "touchstart",
      (e) => {
         if (e.touches.length === 2) {
            mode = "two"
            twoFingerStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2
            twoFingerDy = 0
         } else if (e.touches.length === 1) {
            trackSingle(e.touches[0])
         } else {
            // 3+ fingers: not a gesture we handle.
            mode = "none"
         }
      },
      { passive: true },
   )
   document.addEventListener(
      "touchmove",
      (e) => {
         if (mode === "two" && e.touches.length === 2) {
            e.preventDefault()
            twoFingerDy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - twoFingerStartY
         }
      },
      { passive: false },
   )
   document.addEventListener(
      "touchend",
      (e) => {
         if (mode === "two") {
            if (e.touches.length === 0) {
               mode = "none"
               if (Math.abs(twoFingerDy) >= 50) deps.onCycle(twoFingerDy < 0 ? -1 : 1)
            } else if (e.touches.length === 1) {
               // Fingers lifted one at a time: the two-finger gesture is over.
               // Re-seed the remaining finger as a fresh single-finger swipe
               // instead of staying in "two" (which would swallow it) or later
               // firing cycleFilter off a stale twoFingerDy.
               trackSingle(e.touches[0])
            }
            return
         }
         if (mode !== "single" || e.touches.length !== 0) return
         mode = "none"
         const dx = e.changedTouches[0].clientX - touchStartX
         const dy = e.changedTouches[0].clientY - touchStartY
         if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return
         if (dx > 0 && !deps.prev.disabled) deps.guard(() => nav.left())
         if (dx < 0 && !deps.next.disabled) deps.guard(() => nav.right())
      },
      { passive: true },
   )
   document.addEventListener(
      "touchcancel",
      () => {
         mode = "none"
      },
      { passive: true },
   )

   // Read-through spine: how far the reader article has scrolled past the top of
   // the viewport, as a 0→1 fraction of its scrollable height. A short article
   // (nothing to scroll) reads as fully read (1). No-op on the list (hidden
   // reader) — the gauge only exists in the reader.
   const updateReadProgress = () => {
      const r = deps.reader
      if (r.hidden) return
      const rect = r.getBoundingClientRect()
      const scrollable = rect.height - window.innerHeight
      const p = scrollable > 10 ? Math.min(1, Math.max(0, -rect.top / scrollable)) : 1
      r.style.setProperty("--read", String(p))
   }

   let lastScrollY = 0
   let toolbarHidden = false
   window.addEventListener(
      "scroll",
      () => {
         const y = window.scrollY
         const hide = y > 50 && y > lastScrollY
         if (hide !== toolbarHidden) {
            deps.toolbar.classList.toggle("srr-toolbar-slide", hide)
            toolbarHidden = hide
         }
         if (hide) closeAllDropdowns()
         lastScrollY = y
         updateReadProgress()
      },
      { passive: true },
   )

   return {
      syncReadProgress: updateReadProgress,
      resetScroll() {
         // Sync the baseline to the post-jump position so the queued scroll event
         // from a programmatic scrollTo reads zero delta (no spurious hide), and
         // reveal the toolbar if a prior scroll had slid it away.
         lastScrollY = window.scrollY
         if (toolbarHidden) {
            deps.toolbar.classList.remove("srr-toolbar-slide")
            toolbarHidden = false
         }
      },
   }
}
