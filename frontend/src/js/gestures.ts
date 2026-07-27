// What setupGestures needs from the app. The reader's touch prev/next is NOT
// here any more: a one-finger horizontal drag on the reader is the PAGER's (the
// spec registered through setPager below — a tracked drag that decides its own
// commit and calls back through app.ts's guarded step). The only reader action
// this interface still carries is the two-finger filter cycle.
export interface GestureDeps {
   toolbar: HTMLElement
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

// Finger travel before a gesture commits to an axis. Small enough that the
// browser hasn't started its own overscroll, big enough to survive a thumb roll.
//
// SHARED across all three horizontal/vertical clients below (the pull, the row
// swipe, the reader pager), and it has to be shared: every axis lock is the
// same comparison read in its own direction, so a different slop on any one
// side would leave a band of gestures that two machines both claim (or that
// none does).
const AXIS_SLOP = 8
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
      if (dx > AXIS_SLOP && dx >= Math.abs(dy)) {
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
      if (dy < AXIS_SLOP) return
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

// ── Row swipe actions (RDR14) ────────────────────────────────────────────────
// A one-finger HORIZONTAL swipe on a list ROW acts on that row (the surface
// decides what: → toggles ★ Saved, ← toggles read). It is the mirror image of
// the pull above and shares everything structural with it:
//
//  - ONE state machine. A second one could not axis-lock against this one —
//    each would only see its own gesture and both would fire.
//  - The same registration seam. gestures.ts imports nothing, so the ACTION
//    (and the row-shaped DOM it acts on) is injected by the surface that owns
//    the rows — list.ts — and stays a plain callback this module never inspects.
//  - The same one-test gating: the touch must START inside the registered,
//    visible surface, which by construction excludes the filter picker and the
//    image lightbox (elements laid OVER the list) and the reader (whose list
//    container is `hidden`) — the exclusion the keymap spells out as
//    picker.isOpen() / lightbox.isOpen(), without importing either.
//
// The axis lock has THREE faces here too, pointed the other way:
//   1. a gesture that commits to the VERTICAL axis can never become a row swipe
//      — it is a scroll, and at the top of the list it may be the pull;
//   2. an engaged row swipe preventDefaults every subsequent move, so the list
//      cannot scroll away under a finger that is dragging a row;
//   3. rowEnd() reports "this WAS a row swipe" so touchend skips the reader's
//      prev/next branch entirely — the same double-fire pullEnd() prevents.
// Faces 1 and 2 make the two machines mutually exclusive on the first move past
// the slop: the pull vetoes itself at dx >= |dy| and the row swipe engages only
// at |dx| > |dy| (with the tie going to neither), all measured against the one
// AXIS_SLOP above.
//
// Module-level state for the pull's reason: setRowSwipe has no gesture instance
// to hang it on.

// Horizontal travel that ARMS the row action — deliberately past the reader's
// 50px prev/next threshold, so the two horizontal gestures can't both read as
// committed on the same drag. Exported because the surface paints the row's
// progress against it and a second copy of the number would drift.
export const ROW_SWIPE_TRIGGER = 64

// What the surface that owns the rows hands over. gestures.ts never touches the
// row itself: it owns the geometry (which axis, how far, armed or not) and the
// surface owns the DOM and the meaning.
export interface RowSwipe {
   // The row a touch landed on, or null when it landed on something else (the
   // "N new" pill, a day divider, a terminus, the empty state) — the surface
   // resolves it because a row's shape is its business, not this module's.
   row(target: EventTarget | null): HTMLElement | null
   // Live affordance while the finger is down: `dx` is the signed horizontal
   // travel, `armed` is "releasing now commits". A direction the surface cannot
   // act on simply doesn't move — declining to paint is how availability is
   // expressed, which keeps the geometry here action-agnostic.
   move(row: HTMLElement, dx: number, armed: boolean): void
   // The gesture ended: -1 = swiped left, +1 = swiped right, 0 = retracted
   // without committing (short of the trigger, or cancelled). The surface clears
   // its own affordance in every case — this module painted nothing.
   end(row: HTMLElement, dir: -1 | 0 | 1): void
}

let rowSpec: RowSwipe | null = null
let rowSurface: HTMLElement | null = null
// The row this gesture landed on, while it may still become a swipe.
let rowNode: HTMLElement | null = null
// This gesture began on a row and hasn't been vetoed by the vertical axis lock.
let rowEligible = false
// The swipe is ENGAGED: it owns the gesture, and the scroll can no longer have it.
let rowSwiping = false
// Which way a release would commit right now (0 = not far enough).
let rowDir: -1 | 0 | 1 = 0
// The gesture that just ended WAS a row swipe — kept past the lift so rowEnd's
// answer is stable for every caller, exactly like pullConsumed.
let rowConsumed = false
let rowStartX = 0
let rowStartY = 0

// Register the row actions: `surface` is the element a swipe must START inside,
// `spec` the row resolver + affordance + action. list.ts calls this from setup().
export function setRowSwipe(surface: HTMLElement, spec: RowSwipe): void {
   // Cancel FIRST, against the outgoing spec: a row mid-swipe is that spec's DOM,
   // and it is the one that has to be told to retract the affordance.
   rowCancel()
   rowSurface = surface
   rowSpec = spec
}

function rowStart(target: EventTarget | null, x: number, y: number): void {
   rowNode = null
   rowEligible = false
   rowSwiping = false
   rowDir = 0
   rowConsumed = false
   rowStartX = x
   rowStartY = y
   if (!rowSurface || !rowSpec || rowSurface.hidden) return
   if (!(target instanceof Node) || !rowSurface.contains(target)) return
   rowNode = rowSpec.row(target)
   rowEligible = !!rowNode
}

function rowMove(e: Event, x: number, y: number): void {
   if (!rowEligible || !rowSpec || !rowNode) return
   const dx = x - rowStartX
   const dy = y - rowStartY
   if (!rowSwiping) {
      // Axis lock, half one (mirrored): a gesture that commits to the VERTICAL
      // axis belongs to the scroll — or, at the top of the list, to the pull —
      // for the rest of its life. The row can never claim it back mid-drag.
      if (Math.abs(dy) > AXIS_SLOP && Math.abs(dy) >= Math.abs(dx)) {
         rowEligible = false
         rowNode = null
         return
      }
      if (Math.abs(dx) <= AXIS_SLOP) return
      rowSwiping = true
   }
   // Half two: an engaged swipe owns the gesture, which means owning the scroll
   // the finger would otherwise be doing. (touchmove is the non-passive
   // listener, for the pull's sake — see setupGestures.)
   e.preventDefault()
   rowDir = Math.abs(dx) >= ROW_SWIPE_TRIGGER ? (dx < 0 ? -1 : 1) : 0
   rowSpec.move(rowNode, dx, rowDir !== 0)
}

// The gesture ended. Returns true when it WAS a row swipe, in which case the
// caller must not also evaluate it as a reader prev/next swipe — the third face
// of the axis lock.
function rowEnd(): boolean {
   if (!rowSwiping) {
      rowEligible = false
      rowNode = null
      return rowConsumed
   }
   const row = rowNode
   const dir = rowDir
   rowSwiping = false
   rowEligible = false
   rowConsumed = true
   rowNode = null
   rowDir = 0
   if (row && rowSpec) rowSpec.end(row, dir)
   return true
}

function rowCancel(): void {
   const row = rowNode
   const engaged = rowSwiping
   rowEligible = false
   rowSwiping = false
   rowConsumed = false
   rowNode = null
   rowDir = 0
   // The affordance is the surface's, so a cancellation has to be handed over —
   // otherwise a row stays parked mid-swipe with no gesture left to close it.
   if (engaged && row && rowSpec) rowSpec.end(row, 0)
}

// ── Reader pager (spec docs/superpowers/specs/2026-07-27-reader-swipe-pager-design.md) ──
// A one-finger HORIZONTAL drag on the READER surface pages prev/next with the
// article tracking the finger. Fourth client of the one state machine, and the
// same division of labor as the row swipe: this module owns the geometry (axis,
// distance, velocity, the commit decision), the surface module (pager.ts) owns
// the DOM and the meaning. Two faces of the axis lock are the row swipe's
// exactly: a vertical-dominant move vetoes for the gesture's life, and an
// engaged drag preventDefaults every move. The third — pagerEnd()'s "this WAS a
// pager drag" answer — has no reader here: the pager is evaluated LAST in
// touchend, so there is nothing left to skip. It is kept for symmetry with
// pullEnd/rowEnd, and so the lock is already closed if a fifth machine is ever
// added after it.

// Release past this fraction of the surface width commits the page turn. 0.20
// rather than 0.25: a quarter of a 390px phone is ~98px, a long pull for a thumb
// pivoting from the edge.
const PAGE_COMMIT_FRACTION = 0.2
// ...or a flick: last-segment velocity in the drag's own direction, px/ms.
const PAGE_FLICK_VX = 0.5

export type PagerSide = "prev" | "next"

export interface Pager {
   // How this drag behaves, decided at engage: "page" tracks toward a live
   // neighbor, "resist" is the damped dead-edge drag, "skip" declines the
   // gesture entirely (a drag arriving while a prior commit is still animating).
   engage(side: PagerSide): "page" | "resist" | "skip"
   // Signed horizontal travel from the touch start; the surface clamps painting
   // to the engaged direction.
   move(dx: number): void
   // The finger lifted. commit is this module's call: "page" mode AND travel in
   // the engaged direction AND (past the fraction OR flicked). `vx` is the
   // last-segment velocity in px/ms, signed — the surface carries it into the
   // settle duration so a flick lands faster than a considered release.
   end(dx: number, commit: boolean, vx: number): void
   cancel(): void
}

let pagerSpec: Pager | null = null
let pagerSurface: HTMLElement | null = null
let pagerEligible = false
let pagerActive = false
// No pagerConsumed twin of pullConsumed/rowConsumed: that flag exists so a
// SECOND caller of pullEnd/rowEnd reads the same answer as the first, and the
// pager has no first caller to be consistent with (see pagerEnd).
let pagerSide: PagerSide = "next"
let pagerMode: "page" | "resist" = "page"
let pagerStartX = 0
let pagerStartY = 0
let pagerDx = 0
// Last-segment velocity (px/ms): the flick test reads the finger's speed at
// lift, not the drag's average — a drag that travels fast then STOPS before
// lifting is a considered release, not a flick.
let pagerVx = 0
let pagerLastX = 0
let pagerLastT = 0

// Register the pager: `surface` is the element a drag must START inside (the
// reader <article>, hidden when the list is showing, which is the whole
// view-gating story, like the pull's), `spec` the pane + commit half.
export function setPager(surface: HTMLElement, spec: Pager): void {
   pagerCancel() // against the outgoing spec, the row swipe's precedent
   pagerSurface = surface
   pagerSpec = spec
}

// A touch starting inside content that itself scrolls horizontally (a wide
// <pre>, a table) belongs to that element's own scrolling. This also fixes a
// pre-existing bug: the old blind swipe fired prev/next off a code-block pan.
function inHScrollable(target: EventTarget | null, stop: HTMLElement): boolean {
   let n = target instanceof Element ? target : null
   while (n && n !== stop) {
      if (n instanceof HTMLElement && n.scrollWidth > n.clientWidth + 1) return true
      n = n.parentElement
   }
   return false
}

function pagerStart(target: EventTarget | null, x: number, y: number): void {
   pagerEligible =
      !!pagerSpec &&
      !!pagerSurface &&
      !pagerSurface.hidden &&
      target instanceof Node &&
      pagerSurface.contains(target) &&
      !inHScrollable(target, pagerSurface)
   pagerActive = false
   pagerStartX = x
   pagerStartY = y
}

function pagerMove(e: Event, x: number, y: number): void {
   if (!pagerEligible || !pagerSpec) return
   const dx = x - pagerStartX
   const dy = y - pagerStartY
   if (!pagerActive) {
      // Axis lock, half one: vertical-dominant past the slop = a scroll for the
      // rest of the gesture's life, measured against the ONE shared AXIS_SLOP.
      if (Math.abs(dy) > AXIS_SLOP && Math.abs(dy) >= Math.abs(dx)) {
         pagerEligible = false
         return
      }
      if (Math.abs(dx) <= AXIS_SLOP) return
      pagerSide = dx > 0 ? "prev" : "next"
      const mode = pagerSpec.engage(pagerSide)
      if (mode === "skip") {
         pagerEligible = false
         return
      }
      pagerMode = mode
      pagerActive = true
      pagerVx = 0
      pagerLastX = x
      pagerLastT = performance.now()
   }
   // Reversal: a finger that crosses back through the origin is asking for the
   // other neighbour, not for the article to sit at 0. Re-engage from scratch —
   // side, mode and the preview all have to be re-derived, and engage() is what
   // owns that. A "skip" answer ends the gesture, exactly as at first engage.
   //
   // This is the pager's alone and cannot leak into the other three clients:
   // they are separate state machines over the same touch stream, none of them
   // reads pagerSide, and the shared AXIS_SLOP is untouched — a drag that
   // reverses here was already horizontal-dominant, so the pull had vetoed
   // itself and the row swipe had claimed (or declined) the gesture on the very
   // first move past the slop, long before any sign change.
   const wantSide: PagerSide = dx > 0 ? "prev" : "next"
   if (pagerActive && dx !== 0 && wantSide !== pagerSide) {
      const mode = pagerSpec.engage(wantSide)
      if (mode === "skip") {
         pagerEligible = false
         pagerActive = false
         return
      }
      pagerSide = wantSide
      pagerMode = mode
   }
   // Half two: an engaged drag owns the gesture, which means owning the scroll.
   e.preventDefault()
   const now = performance.now()
   const dt = now - pagerLastT
   if (dt > 0) pagerVx = (x - pagerLastX) / dt
   pagerLastX = x
   pagerLastT = now
   pagerDx = dx
   pagerSpec.move(dx)
}

// The gesture ended. Returns true when it WAS a pager drag — the shape pullEnd
// and rowEnd have, kept deliberately even though NOTHING reads it today: the
// pager is evaluated last in touchend, so the axis lock's third face has
// nothing left to guard. It stays so the three machines read alike and so the
// answer is already correct if anything is ever added after this call.
function pagerEnd(): boolean {
   if (!pagerActive) {
      pagerEligible = false
      return false
   }
   const spec = pagerSpec
   const dx = pagerDx
   pagerActive = false
   pagerEligible = false
   // jsdom reports clientWidth 0; the viewport is the honest fallback.
   const width = pagerSurface?.clientWidth || window.innerWidth
   const dirOk = pagerSide === "prev" ? dx > 0 : dx < 0
   const flick = dirOk && Math.sign(pagerVx) === Math.sign(dx) && Math.abs(pagerVx) >= PAGE_FLICK_VX
   const commit = pagerMode === "page" && dirOk && (Math.abs(dx) >= width * PAGE_COMMIT_FRACTION || flick)
   spec?.end(dx, commit, pagerVx)
   return true
}

function pagerCancel(): void {
   const engaged = pagerActive
   pagerEligible = false
   pagerActive = false
   if (engaged) pagerSpec?.cancel()
}

// setupGestures wires the touch machines (one-finger horizontal = a reader page
// turn on the reader surface, or a row action when it starts on a list row,
// one-finger downward overscroll on the list = pull to refresh, two-finger
// vertical = cycle filter) and scroll-based toolbar hide.
export function setupGestures(deps: GestureDeps): Gestures {
   let twoFingerStartY = 0
   let twoFingerStartDist = 0
   let twoFingerDy = 0
   // Set once a two-finger gesture is recognised as a pinch-zoom rather than a
   // vertical pan, so the move handler stops claiming it and touchend doesn't cycle.
   let pinch = false
   // The tracked gesture, if any. The three single-finger machines below are
   // only moved and only settled when the gesture began as a single-finger one
   // ("single"), so a 3+-finger tap/lift ("none") can't drive or commit one.
   let mode: "none" | "single" | "two" = "none"

   // `target` is the node the touch STARTED on — the eligibility test for BOTH
   // surface-aware gestures (the pull and the row swipe). The two-finger→
   // one-finger re-seed passes null on purpose: a gesture that began with two
   // fingers is a cycle/pinch that lost a finger, never a pull or a row action.
   // A drag that STARTS on a media scrubber is a seek, never a swipe. Native
   // media controls are shadow DOM, so the event retargets to the <audio>/
   // <video> host — `closest` from there is the whole test.
   const onScrubber = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest("audio, video, .srr-player") !== null

   const trackSingle = (t: Touch, target: EventTarget | null) => {
      // Declining the gesture outright (rather than stopping propagation at one
      // element) is what makes this cover in-content media as well as the bar —
      // see the guard note below.
      if (onScrubber(target)) {
         mode = "none"
         pullCancel()
         rowCancel()
         pagerCancel()
         return
      }
      mode = "single"
      pullStart(target, t.clientX, t.clientY)
      rowStart(target, t.clientX, t.clientY)
      pagerStart(target, t.clientX, t.clientY)
   }

   // Gesture guard (RDR16): a seek control is a horizontal drag, and the
   // touchstart/touchmove/touchend listeners below are bound to `document`
   // with no target filtering — an in-content scrubber sits INSIDE the pager's
   // own surface, so its horizontal drag would page the article instead of
   // seeking.
   //
   // This USED to be one `stopPropagation` listener on `.srr-player`, whose
   // comment claimed it covered the in-content `<audio controls>` scrubber
   // too. It did not, and could not: `fmt.ts` force-sets `controls` on content
   // audio (the #enclosure podcast case), and that element lives in
   // `.srr-content`, so its touches never passed through a listener bound to
   // the bar. Scrubbing a podcast inside the article navigated away from it —
   // the pointer twin of the keymap bug fixed alongside this, and hidden for
   // as long as it was because the comment asserted the opposite.
   //
   // The test now lives in `trackSingle` (`onScrubber`) instead, so it covers
   // the bar, in-content media, and any future scrubber, with no element to
   // remember to bind.

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
            // A second finger landing mid-pull (or mid-row-swipe) hands the
            // gesture to the cycle / pinch guard — retract the affordances rather
            // than leaving one hanging.
            pullCancel()
            rowCancel()
            pagerCancel()
         } else if (e.touches.length === 1) {
            trackSingle(e.touches[0], e.target)
         } else {
            // 3+ fingers: not a gesture we handle.
            mode = "none"
            pullCancel()
            rowCancel()
            pagerCancel()
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
            // The pull and the row swipe both track (and, once engaged,
            // preventDefault) here — which is why this listener is the
            // non-passive one. Neither touches anything before it engages, so
            // ordinary list scrolling is untouched; and the pull's horizontal
            // veto runs against the same AXIS_SLOP as the row swipe's engage
            // test, so at most one of them can ever claim a given gesture.
            pullMove(e, e.touches[0].clientX, e.touches[0].clientY)
            rowMove(e, e.touches[0].clientX, e.touches[0].clientY)
            pagerMove(e, e.touches[0].clientX, e.touches[0].clientY)
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
         // Likewise a row swipe: it IS the horizontal gesture, aimed at one row
         // rather than at the article on screen, so the reader step must not also
         // fire. (app.ts's stepLeft/stepRight are view-gated and inert on the list
         // anyway — the lock belongs here, beside the other two faces, rather
         // than resting on a guard in another module.)
         if (rowEnd()) return
         // Finally the pager, which IS the reader's horizontal gesture: it
         // decided commit-or-snap at the lift itself. Its "this WAS a pager
         // drag" answer has no consumer here because nothing follows it — the
         // blind 50px swipe this used to guard is gone, replaced by the tracked
         // drag above — so the call is unconditional. The boolean it still
         // returns is symmetry with the two above, nothing more (its docblock
         // says so too).
         pagerEnd()
      },
      { passive: true },
   )
   document.addEventListener(
      "touchcancel",
      () => {
         mode = "none"
         pullCancel()
         rowCancel()
         pagerCancel()
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
