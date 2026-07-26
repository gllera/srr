export interface GestureDeps {
   toolbar: HTMLElement
   // A committed one-finger swipe steps the reader: toward a live neighbor it
   // navigates, toward a dead edge (prev/next disabled) it rings the margin bell.
   // app.ts owns both the navigation guard and the bell, so it passes the composed
   // step in — the same goPrev/goNext the keyboard prev/next keys use.
   goPrev: () => void
   goNext: () => void
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

// ── Pull to refresh (RDR11) ──────────────────────────────────────────────────
// An overscroll pull on the LIST is the reader's only manual "check for new
// articles": refresh.ts owns the background triggers (re-focus, reconnect, a
// 5-minute heartbeat) and there is deliberately no button, so before this the
// only way to ASK was a full page reload. The gesture honours that decision
// rather than reopening it — it runs the same refresh.refreshNow() cycle, under
// the same app.ts guardBg mutex, and adds no second concurrency path.
//
// It arrives through a registration call instead of GestureDeps because the
// surface it belongs to is the LIST, and because of the one architectural
// property this module has: gestures.ts imports NOTHING. Reaching for
// refresh.ts from here would drag data.ts's module-load db.gz fetch into every
// test that touches gestures. So list.ts — which already owns the list
// container and may import refresh — hands both over, and the action stays a
// plain injected callback (which is also what makes it assertable in
// gestures.test.ts).
//
// The state below is module-level for the same reason: setPullRefresh has no
// gesture instance to hang on. setupGestures runs exactly once in the app, and
// the handlers of a second (test) instance would share this state rather than
// racing a second pull — see pullEnd's pullBusy guard.

// Finger travel before the gesture commits to an axis. Small enough that the
// browser hasn't started its own overscroll, big enough to survive a thumb roll.
const PULL_SLOP = 8
// Downward travel that arms the refresh.
const PULL_TRIGGER = 72
// The badge follows at half the finger's distance (the rubber-band feel every
// pull-to-refresh has: the surface resists), capped so a long drag doesn't send
// it down the page.
const PULL_RESIST = 0.5
const PULL_MAX = 96
// Where it parks while the cycle runs.
const PULL_REST = 56
// Floor on how long the running state shows. A cycle answered from cache in
// 20ms would otherwise blink and read as "nothing happened".
const PULL_MIN_MS = 400
// Scroll positions this close to the document top still count as "at the top"
// (iOS rubber-band can report a negative scrollY, hence the one-sided test).
const PULL_TOP_EPS = 2

let pullSurface: HTMLElement | null = null
let pullRun: (() => Promise<unknown>) | null = null
let pullEl: HTMLElement | null = null
// This gesture began somewhere a pull could start (and hasn't been vetoed by
// the horizontal axis lock since).
let pullEligible = false
// The pull is ENGAGED: it owns the gesture, and the swipe can no longer have it.
let pulling = false
let pullArmed = false
// The gesture that just ended WAS a pull. Kept past the lift so pullEnd's answer
// is stable for the whole gesture: "was this a pull?" must read the same to
// every caller, and a lift that reported `true` once must never report `false`
// to a second one and be re-read as a swipe.
let pullConsumed = false
// A committed pull's cycle is still running — a second pull must not stack one.
let pullBusy = false
// Ownership token for that cycle (the freshness-token discipline nav's prefetch
// and list's `tok` use): a cycle that finally settles after a re-registration
// must not clear an affordance it no longer owns.
let pullCycle = 0
let pullStartX = 0
let pullAnchorY = 0

// Register the pull: `surface` is the element a pull must START inside, `run`
// the cycle a committed pull triggers. list.ts calls this from its setup().
//
// The surface is also the whole gating story, and it is deliberately ONE test
// rather than three: a touch that starts inside the (visible) list container is
// by construction not inside the filter picker, not inside the image lightbox —
// both are separate elements laid OVER the surface — and not in the reader,
// whose list container is `hidden`. That is the same exclusion the keymap
// spells out as picker.isOpen() / lightbox.isOpen(), reached without importing
// either module.
export function setPullRefresh(surface: HTMLElement, run: () => Promise<unknown>): void {
   pullSurface = surface
   pullRun = run
   // Re-registration means the surface this was tracking is gone; drop any live
   // gesture and any parked affordance with it, and orphan an in-flight cycle so
   // its settle can't reach back into the new one.
   pullBusy = false
   pullCycle++
   pullCancel()
}

function pullReady(target: EventTarget | null): boolean {
   return (
      !!pullSurface &&
      !!pullRun &&
      !pullBusy &&
      !pullSurface.hidden &&
      target instanceof Node &&
      pullSurface.contains(target)
   )
}

function pullStart(target: EventTarget | null, x: number, y: number): void {
   pullEligible = pullReady(target)
   pulling = false
   pullArmed = false
   pullConsumed = false
   pullStartX = x
   pullAnchorY = y
}

function pullMove(e: Event, x: number, y: number): void {
   if (!pullEligible) return
   if (!pulling) {
      const dx = Math.abs(x - pullStartX)
      const dy = y - pullAnchorY
      // Axis lock, half one: a gesture that commits to the HORIZONTAL axis
      // belongs to the swipe for the rest of its life — the pull can never
      // claim it back mid-drag, whatever the finger does afterwards.
      if (dx > PULL_SLOP && dx >= Math.abs(dy)) {
         pullEligible = false
         return
      }
      // Anywhere but the very top this is an ordinary scroll. Keep re-anchoring
      // so the pull measures from where the finger was when the list ran OUT of
      // scroll — otherwise a long swipe up from deep in the list would arrive at
      // the top already past the threshold.
      if (window.scrollY > PULL_TOP_EPS || dy <= 0) {
         pullAnchorY = y
         return
      }
      if (dy < PULL_SLOP) return
      pulling = true
   } else if (y < pullAnchorY) {
      // Dragged back up past the anchor: the affordance retracts to zero instead
      // of sticking out, and a release there commits nothing.
      pullAnchorY = y
   }
   // Axis lock, half two: an engaged pull owns the gesture, which means owning
   // the scroll. preventDefault is what stops the native overscroll — Chrome
   // Android's own pull-to-reload above all — running the same finger a second
   // time; the overscroll-behavior-y rule in styles.css is the belt to this brace
   // (it covers the case where the browser claimed the scroll before we did).
   e.preventDefault()
   paintPull(y - pullAnchorY)
}

// The gesture ended. Returns true when it WAS a pull, in which case the caller
// must not also evaluate it as a horizontal swipe — the third face of the axis
// lock.
function pullEnd(): boolean {
   if (!pulling) {
      pullEligible = false
      return pullConsumed
   }
   pulling = false
   pullEligible = false
   pullConsumed = true
   const armed = pullArmed
   pullArmed = false
   // pullBusy: a cycle from an earlier pull is still running. refreshNow would
   // skip on the busy mutex anyway, but the affordance has one state to show and
   // stacking two would leave it parked after the first settles.
   if (!armed || !pullRun || pullBusy) {
      hidePull()
      return true
   }
   pullBusy = true
   const my = ++pullCycle
   const d = ensurePullEl()
   d.classList.remove("srr-pull-live", "srr-pull-armed")
   d.classList.add("srr-pull-busy")
   d.style.transform = `translate(-50%, ${PULL_REST}px)`
   d.style.opacity = "1"
   const settle = () => {
      if (my !== pullCycle) return
      pullBusy = false
      hidePull()
   }
   // The cycle reports its own failures through the settings-menu status line
   // (refresh.lastRefreshError) — the affordance only says "asked", so a
   // rejection lands on the same path as success.
   Promise.all([pullRun().catch(() => {}), new Promise((r) => setTimeout(r, PULL_MIN_MS))]).then(settle, settle)
   return true
}

function pullCancel(): void {
   pullEligible = false
   pulling = false
   pullArmed = false
   pullConsumed = false
   // A parked, running affordance is not this gesture's to clear.
   if (!pullBusy) hidePull()
}

// Built lazily and reused, never declared in index.html — the lightbox's
// precedent, and it keeps the design.html skeleton drift guard out of it.
function ensurePullEl(): HTMLElement {
   // isConnected, not a bare null check: painting into a node something has
   // detached from <body> is a silent no-op, so rebuild instead.
   if (pullEl?.isConnected) return pullEl
   const d = document.createElement("div")
   d.className = "srr-pull"
   // Decorative: it mirrors a touch gesture back to the finger performing it.
   // The refresh it triggers is the same silent in-place adoption the background
   // triggers do, and that has never announced itself either.
   d.setAttribute("aria-hidden", "true")
   const icon = document.createElement("span")
   icon.className = "srr-pull-icon"
   icon.textContent = "↓"
   d.appendChild(icon)
   document.body.appendChild(d)
   pullEl = d
   return d
}

function paintPull(dist: number): void {
   const d = ensurePullEl()
   const progress = Math.min(1, dist / PULL_TRIGGER)
   const offset = Math.min(dist * PULL_RESIST, PULL_MAX)
   // srr-pull-live drops the CSS easing so the badge tracks the thumb 1:1 — the
   // same override the toolbar's scroll-linked bottom reveal makes below.
   d.classList.add("srr-pull-live")
   d.style.transform = `translate(-50%, ${offset}px)`
   d.style.opacity = String(0.25 + progress * 0.75)
   pullArmed = progress >= 1
   d.classList.toggle("srr-pull-armed", pullArmed)
}

function hidePull(): void {
   if (!pullEl) return
   pullEl.classList.remove("srr-pull-live", "srr-pull-armed", "srr-pull-busy")
   // Back to the stylesheet's parked-above-the-viewport transform, under the
   // transition srr-pull-live was suppressing.
   pullEl.style.transform = ""
   pullEl.style.opacity = ""
}

// setupGestures wires touch swipes (one-finger left/right = prev/next,
// one-finger downward overscroll on the list = pull to refresh, two-finger
// vertical = cycle filter) and scroll-based toolbar hide.
export function setupGestures(deps: GestureDeps): Gestures {
   let touchStartX = 0
   let touchStartY = 0
   let twoFingerStartY = 0
   let twoFingerStartDist = 0
   let twoFingerDy = 0
   // Set once a two-finger gesture is recognised as a pinch-zoom rather than a
   // vertical pan, so the move handler stops claiming it and touchend doesn't cycle.
   let pinch = false
   // The tracked gesture, if any. A swipe is only evaluated when it began as
   // a single-finger gesture ("single"), so a 3+-finger tap/lift ("none")
   // can't fire a spurious prev/next off a stale touchStartX.
   let mode: "none" | "single" | "two" = "none"

   // `target` is the node the touch STARTED on — the pull's eligibility test.
   // The two-finger→one-finger re-seed passes null on purpose: a gesture that
   // began with two fingers is a cycle/pinch that lost a finger, never a pull.
   const trackSingle = (t: Touch, target: EventTarget | null) => {
      mode = "single"
      touchStartX = t.clientX
      touchStartY = t.clientY
      pullStart(target, t.clientX, t.clientY)
   }

   // Gesture guard (RDR16): the player bar's seek control is a horizontal
   // drag, and the touchstart/touchmove/touchend listeners below are bound to
   // `document` with no target filtering — any 50px horizontal drag reads as
   // a swipe and fires prev/next, so scrubbing the seek bar would navigate
   // away instead of seeking. Stopping propagation at `.srr-player` keeps the
   // touch from ever reaching the document-level handlers below. This also
   // fixes the same latent problem for today's in-content `<audio controls>`
   // scrubber — a horizontal drag inside its native seek control is exactly
   // as indistinguishable from a swipe to these handlers. Queried
   // defensively: `.srr-player` ships in index.html so this always finds it,
   // but a null query here must not throw at setup — nothing below depends
   // on the player module having run first.
   document.querySelector(".srr-player")?.addEventListener("touchstart", (e) => e.stopPropagation(), {
      passive: true,
   })

   document.addEventListener(
      "touchstart",
      (e) => {
         if (e.touches.length === 2) {
            mode = "two"
            twoFingerStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2
            twoFingerStartDist = Math.hypot(
               e.touches[0].clientX - e.touches[1].clientX,
               e.touches[0].clientY - e.touches[1].clientY,
            )
            twoFingerDy = 0
            pinch = false
            // A second finger landing mid-pull hands the gesture to the cycle /
            // pinch guard — retract the affordance rather than leaving it hanging.
            pullCancel()
         } else if (e.touches.length === 1) {
            trackSingle(e.touches[0], e.target)
         } else {
            // 3+ fingers: not a gesture we handle.
            mode = "none"
            pullCancel()
         }
      },
      { passive: true },
   )
   document.addEventListener(
      "touchmove",
      (e) => {
         if (mode === "two" && e.touches.length === 2) {
            // A pinch-zoom is also a two-finger move, but it changes the
            // inter-finger distance; the filter-cycle pan keeps the fingers
            // parallel (distance ~constant) and moves their centroid. Once the
            // distance shifts past a threshold, treat it as a pinch: stop claiming
            // the gesture so the browser can zoom (accessibility — the viewport
            // meta intentionally allows zoom), and don't cycle on touchend.
            const dist = Math.hypot(
               e.touches[0].clientX - e.touches[1].clientX,
               e.touches[0].clientY - e.touches[1].clientY,
            )
            if (Math.abs(dist - twoFingerStartDist) > 25) pinch = true
            if (pinch) return
            e.preventDefault()
            twoFingerDy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - twoFingerStartY
         } else if (mode === "single" && e.touches.length === 1) {
            // The pull tracks (and, once engaged, preventDefaults) here — which
            // is why this listener is the non-passive one. An un-engaged pull
            // touches nothing, so ordinary list scrolling is untouched.
            pullMove(e, e.touches[0].clientX, e.touches[0].clientY)
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
               if (!pinch && Math.abs(twoFingerDy) >= 50) deps.onCycle(twoFingerDy < 0 ? -1 : 1)
            } else if (e.touches.length === 1) {
               // Fingers lifted one at a time: the two-finger gesture is over.
               // Re-seed the remaining finger as a fresh single-finger swipe
               // instead of staying in "two" (which would swallow it) or later
               // firing cycleFilter off a stale twoFingerDy.
               trackSingle(e.touches[0], null)
            }
            return
         }
         if (mode !== "single" || e.touches.length !== 0) return
         mode = "none"
         // An engaged pull consumed this gesture — it is vertical by definition,
         // so evaluating it as a swipe as well is exactly the double-fire the
         // axis lock exists to prevent.
         if (pullEnd()) return
         const dx = e.changedTouches[0].clientX - touchStartX
         const dy = e.changedTouches[0].clientY - touchStartY
         if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return
         // Past the threshold dx is a committed left/right swipe; goPrev/goNext
         // navigate toward a live neighbor or ring the margin bell at a dead edge.
         if (dx > 0) deps.goPrev()
         else deps.goNext()
      },
      { passive: true },
   )
   document.addEventListener(
      "touchcancel",
      () => {
         mode = "none"
         pullCancel()
      },
      { passive: true },
   )

   let lastScrollY = 0
   let toolbarHidden = false
   let bottomSettleTimer: ReturnType<typeof setTimeout> | undefined
   const setHidden = (hide: boolean) => {
      if (hide !== toolbarHidden) {
         deps.toolbar.classList.toggle("srr-toolbar-slide", hide)
         // Mirrored onto <body> (RDR16): the player bar is a fixed sibling of
         // the toolbar, not a descendant, so a stylesheet rule that slides it
         // down into the toolbar's vacated place on auto-hide needs the state
         // observable somewhere both elements' CSS can see — a class living
         // only on the toolbar itself isn't reachable from a sibling's rule.
         document.body.classList.toggle("srr-toolbar-hidden", hide)
         toolbarHidden = hide
      }
   }
   // Drop the scroll-linked bottom-reveal override, handing position back to the
   // class-driven slide (+ its transition).
   const clearBottomReveal = () => {
      clearTimeout(bottomSettleTimer)
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
            // A scroll that STOPS mid-zone fires no further event, leaving the bar
            // parked half-sunken below the screen edge. Arm a settle timer (re-armed
            // by each in-zone scroll) that seats it under the normal transition once
            // the gesture stops.
            clearTimeout(bottomSettleTimer)
            bottomSettleTimer = setTimeout(clearBottomReveal, 150)
            return
         }
         clearBottomReveal()
         setHidden(y > 50 && goingDown)
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
