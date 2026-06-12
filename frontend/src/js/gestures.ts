import { closeAllDropdowns } from "./dropdown"
import * as nav from "./nav"

export interface GestureDeps {
   prev: HTMLButtonElement
   next: HTMLButtonElement
   toolbar: HTMLElement
   guard: (fn: () => Promise<IShowFeed>) => void
}

// setupGestures wires touch swipes (one-finger left/right = prev/next,
// two-finger vertical = cycle filter) and scroll-based toolbar hide.
export function setupGestures(deps: GestureDeps): void {
   let touchStartX = 0
   let touchStartY = 0
   let twoFingerStartY = 0
   let twoFingerDy = 0
   let twoFinger = false
   // singleTouch marks an in-progress, tracked one-finger gesture. A swipe is
   // only evaluated when it began as one, so a 3+-finger tap/lift can't fire a
   // spurious prev/next off a stale touchStartX.
   let singleTouch = false

   document.addEventListener(
      "touchstart",
      (e) => {
         if (e.touches.length === 2) {
            twoFinger = true
            singleTouch = false
            twoFingerStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2
            twoFingerDy = 0
         } else if (e.touches.length === 1) {
            twoFinger = false
            singleTouch = true
            touchStartX = e.touches[0].clientX
            touchStartY = e.touches[0].clientY
         } else {
            // 3+ fingers: not a gesture we handle. Clear state so the eventual
            // lift doesn't reuse a stale single-finger start point.
            twoFinger = false
            singleTouch = false
         }
      },
      { passive: true },
   )
   document.addEventListener(
      "touchmove",
      (e) => {
         if (twoFinger && e.touches.length === 2) {
            e.preventDefault()
            twoFingerDy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - twoFingerStartY
         }
      },
      { passive: false },
   )
   document.addEventListener(
      "touchend",
      (e) => {
         if (twoFinger) {
            if (e.touches.length === 0) {
               twoFinger = false
               if (Math.abs(twoFingerDy) >= 50 && nav.getFilterEntries().length > 1)
                  deps.guard(() => nav.cycleFilter(twoFingerDy < 0 ? -1 : 1))
            } else if (e.touches.length === 1) {
               // Fingers lifted one at a time: the two-finger gesture is over.
               // Re-seed the remaining finger as a fresh single-finger swipe
               // instead of leaving twoFinger stuck true (which would swallow
               // it) or later firing cycleFilter off a stale twoFingerDy.
               twoFinger = false
               singleTouch = true
               touchStartX = e.touches[0].clientX
               touchStartY = e.touches[0].clientY
            }
            return
         }
         if (!singleTouch || e.touches.length !== 0) return
         singleTouch = false
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
         twoFinger = false
         singleTouch = false
      },
      { passive: true },
   )

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
      },
      { passive: true },
   )
}
