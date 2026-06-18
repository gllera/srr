import { closeAllDropdowns } from "./dropdown"
import * as nav from "./nav"

export interface GestureDeps {
   prev: HTMLButtonElement
   next: HTMLButtonElement
   toolbar: HTMLElement
   guard: (fn: () => Promise<IShowFeed>) => void
   // A committed swipe toward an edge with no neighbor (the prev/next button
   // disabled) rings the reader's margin bell instead of navigating — app.ts owns
   // the reader animation, like onCycle.
   edgeBump: (side: "prev" | "next") => void
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
         // Past the threshold dx is a committed left/right swipe. Toward a live
         // neighbor it navigates; toward a dead edge (button disabled) it rings
         // the margin bell so the boundary is felt rather than swallowed.
         if (dx > 0) {
            if (deps.prev.disabled) deps.edgeBump("prev")
            else deps.guard(() => nav.left())
         } else {
            if (deps.next.disabled) deps.edgeBump("next")
            else deps.guard(() => nav.right())
         }
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

   let lastScrollY = 0
   let toolbarHidden = false
   const setHidden = (hide: boolean) => {
      if (hide !== toolbarHidden) {
         deps.toolbar.classList.toggle("srr-toolbar-slide", hide)
         toolbarHidden = hide
      }
   }
   // Drop the scroll-linked bottom-reveal override, handing position back to the
   // class-driven slide (+ its transition).
   const clearBottomReveal = () => {
      if (deps.toolbar.style.transform) {
         deps.toolbar.style.transform = ""
         deps.toolbar.style.transition = ""
      }
   }
   window.addEventListener(
      "scroll",
      () => {
         const y = window.scrollY
         const goingDown = y > lastScrollY
         lastScrollY = y
         const scroller = document.scrollingElement ?? document.documentElement
         const barH = deps.toolbar.offsetHeight || 1
         const distFromBottom = scroller.scrollHeight - (y + window.innerHeight)
         // Bottom reveal: scrolling down through the last bar-height, the toolbar
         // rises 1:1 with the scroll — like a footer that's part of the page,
         // not a fixed bar popping in. transition:none so it tracks the scroll
         // instead of easing behind it. Scrolling up falls through to the normal
         // show path, so it never slides back down on you near the end.
         if (goingDown && distFromBottom < barH) {
            setHidden(false)
            deps.toolbar.style.transition = "none"
            deps.toolbar.style.transform = `translateY(${Math.max(0, distFromBottom)}px)`
            return
         }
         clearBottomReveal()
         const hide = y > 50 && goingDown
         setHidden(hide)
         if (hide) closeAllDropdowns()
      },
      { passive: true },
   )

   return {
      resetScroll() {
         // Sync the baseline to the post-jump position so the queued scroll event
         // from a programmatic scrollTo reads zero delta (no spurious hide), drop
         // any bottom-reveal transform, and reveal a slid-away toolbar.
         lastScrollY = window.scrollY
         clearBottomReveal()
         setHidden(false)
      },
   }
}
