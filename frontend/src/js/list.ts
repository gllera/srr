import * as data from "./data"
import { timeAgo, srcColorIndex, dayLabelCtx, dayLabelWith, countBadge, CHECK_SVG } from "./fmt"
import { ROW_SWIPE_TRIGGER, setPullRefresh, setRowSwipe } from "./gestures"
import * as nav from "./nav"
// Named, NOT `import * as refresh`: this module exports its own refresh(), and a
// namespace binding of that name is shadowed by the local function declaration —
// silently, since the collision only shows up when the callback below runs.
import { refreshNow } from "./refresh"
// The fold-aware term matcher (RDR8). Taken from ./search rather than
// reimplemented here for the same reason the hit set is: a highlight computed on
// anything but search.ts's own fold would disagree with the hit that put the row
// on screen. search.ts stays DOM-free — it hands back raw-string ranges and the
// element building lives below.
import { matchSpans } from "./search"
import { windowScroller, type Scroller } from "./scroller"
import { isSplit } from "./split"
// The two frontier-write primitives, taken from ./seen rather than through nav's
// facade — the one place in the reader that does so, and deliberately:
// nav.markAllRead/markUnreadFrom bake in the ACTIVE FILTER's scope (that is what
// nav owns), while a row gesture's scope is one feed and one chron. The
// FrontierScope argument is exactly the seam ENG3 created for a caller that
// knows its own scope, so the row swipe passes its own instead of adding a
// second frontier-write path. Everything else — the tallies, the seen map, the
// undo machinery — still comes through nav.
import { markUnreadFrom as lowerFeedFrom, recordSeen as raiseFeedTo } from "./seen"

// The list surface — the app's home: a scannable feed of headlines under the
// current filter, newest-first, source-keyed with read/unread weighting. Tapping a row
// opens the reader (app wires that via setup's `open`). The list owns no nav
// state of its own — it walks nav.feedLeft/feedRight over the active filter (the
// same neighbor seam the reader steps through, just unbounded in both
// directions) and reads the seen map for dots, so the filter/unseen-only/saved/
// search semantics are identical to the reader's.
//
// Bidirectional infinite window, anchored at the filter's reading position. On
// open the list anchors at nav.listAnchor() — the article the reader last sat on
// when it still matches the filter, else a tag/feed's remembered resume
// position, else (a tag/feed with no navigation information) its OLDEST
// article, else ★ Saved's OLDEST saved article (the read-later queue is consumed
// front-to-back), else the newest match ([ALL]/search). The anchored article is
// CENTERED in the viewport and highlighted (.srr-row-current) on every arrival —
// reader return, filter switch, boot — so you land back on it with context above
// and below; returning from the reader commits that scroll immediately (warm
// pack), a cold build lands it once after layout settles. NEWER ("next")
// articles load ABOVE the anchor (scroll up) and older ones below (scroll
// down), both paged lazily off IntersectionObserver sentinels.
//
// The rendered rows ARE a persisted, expandable navigation list: returning from
// the reader to an article that's already a rendered row (the common case — you
// stepped a few within the loaded window) re-anchors by scrolling to it with NO
// feed walk, NO fetch and NO rebuild (see show()). Only a filter change or an
// article outside the window triggers a bounded rebuild (≤ 2 batches).

// Rows fetched per batch in either direction. One batch spans roughly one
// meta shard (5,000-card shards held in the LRU, falling back to data/ when
// meta lags), so this is a paint-budget knob, not a fetch-count one.
const BATCH = 30

// Max meta-card fetches in flight while filling a freshly-rendered batch. Bounds
// concurrency so the packs NEAREST the navigation anchor (filled first, see
// render) actually win the network before off-screen rows, instead of all BATCH
// fetches racing. ~the classic per-origin connection budget.
const FILL_CONCURRENCY = 6

// Start fetching the next batch this far beyond the fold (a scroll runway so
// rows are ready before they're scrolled into view), in either direction.
const ROOT_MARGIN = "800px"

// Per-row save star. Tapping it toggles nav.toggleSaved without opening the
// reader; the row carries .srr-row-saved for the filled look.
const STAR_SVG =
   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>'

let container: HTMLElement
let rowsEl: HTMLElement | null = null
let topSentinel: HTMLElement
let bottomSentinel: HTMLElement
let onOpen: (chron: number) => void = () => {}
// Called after every programmatic scroll the list performs (anchor positioning,
// prepend compensation) so the gesture layer can resync its toolbar-hide
// baseline — otherwise the jump reads as a downward scroll and hides the toolbar.
let notifyScroll: () => void = () => {}
// Surfaces a scroll-paging failure (a meta pack 404/network drop during fetchOlder/
// fetchNewer). The initial render reports errors through its awaited show() chain;
// the incremental paging fired off the IntersectionObserver has no such caller, so
// without this its rejection would be an unhandled promise — the list would just
// stop growing with no feedback. app wires this to its retry-able error popup.
let onError: (e: unknown) => void = () => {}

// The scroll seam (split view): window below the breakpoint, the pane element
// in split. Swapped by app.ts via setScroller on init and on every breakpoint
// crossing (which also invalidates + re-renders, so the IO root is re-read).
let sc: Scroller = windowScroller()
export function setScroller(s: Scroller): void {
   sc = s
}

// "Is a LIVE reader holding the shared cursor?" — app.ts's readerLive, injected
// for the same reason the scroller is: this module sits below the controllers
// and cannot import one (reader.ts already imports this, so the edge would be a
// cycle). The default answers "no reader", which is the single-surface truth and
// the one a unit test gets for free.
let readerHoldsCursor: () => boolean = () => false
export function setCursorOwner(fn: () => boolean): void {
   readerHoldsCursor = fn
}

// "A row's ★ just moved" — injected for the same reason readerHoldsCursor is
// (reader.ts already imports this module, so an edge back to the controller
// would be a cycle). Under split the reader's own save button is on screen and
// may be describing this very article, and the row star and that button are two
// paints of ONE set: the row's toggle alone left the button asserting the
// opposite, and a second toggle from the button then composed the two into a
// state neither of them showed. The default is the single-surface truth — no
// reader on screen to tell, and the button re-derives on its next render.
let notifySavedChanged: (chron: number) => void = () => {}
export function setSavedSink(fn: (chron: number) => void): void {
   notifySavedChanged = fn
}

// "A row's READ state just moved" — the seen-frontier twin of the sink above,
// injected for the same reason. refresh() below re-derives the ROWS, and that is
// all it can do: the reader's pending pill counts the unread AHEAD of the cursor
// and the tab title carries the store's unread badge, and neither is this
// module's to write. Every other frontier gesture goes through
// menus.afterFrontierMove, which reconciles both; the row swipe is the one that
// does not, and off split that stayed invisible because the reader re-derives on
// its next arrival and takes the badge with it. Under split there is no arrival:
// the pill sits on screen beside the rows it disagrees with, permanently.
let notifyFrontierMoved: () => void = () => {}
export function setFrontierSink(fn: () => void): void {
   notifyFrontierMoved = fn
}

// Freshness token: a new render() reassigns it so any in-flight load (or pending
// observer callback) from the prior filter bails before touching the DOM — the
// same discipline as dropdown's fill tokens and nav's prefetch.
let tok: object = {}
let newest = -1 // chronIdx of the newest (topmost) row rendered (-1 = none yet)
let oldest = -1 // chronIdx of the oldest (bottommost) row rendered (-1 = none yet)
let exhaustedTop = false // walked off the newest end (no newer matches above)
let exhaustedBottom = false // walked off the oldest end of the (filtered) feed
let loadingTop = false // a newer-load is in flight (re-entry guard for fetchNewer)
let loadingBottom = false // an older-load is in flight (re-entry guard for fetchOlder)
let pumping = false // a downward viewport-fill loop is running (re-entry guard for pump)
let growing = false // an onStoreGrown reopen/rebuild is in flight (re-entry guard)
let builtKey: string | null = null // filterKey() the current DOM was built for
let observer: IntersectionObserver | null = null
// Set by a genuine user scroll gesture (wheel/touch/key) during a render, so the
// post-fill anchor re-assert never yanks the page out from under the reader.
// Programmatic scrolls (sc.to) don't fire these, so they don't trip it.
let userScrolled = false

// ── "N new" arrivals pill ────────────────────────────────────────────────────
// A store refresh prepends fresh rows ABOVE the fold and compensates the scroll
// so nothing you are looking at moves (fetchNewer, the no-jank contract). The
// price of that silence is that the arrivals are undiscoverable — you have to
// scroll up on a hunch. The pill is the missing SIGNAL and nothing more:
//
//  - it is an OVERLAY (position:fixed, styles.css) — it takes no layout, so the
//    scroll-pinning contract it advertises stays exactly intact;
//  - it COUNTS NOTHING of its own: it consumes the batch sizes the prepend
//    already produced (article counting lives in nav.tallyWith, not here);
//  - it does not persist — a rebuild, a filter change or reaching the top
//    organically all drop it.
//
// Known gap, deliberate: onStoreGrown only reopens a top that was EXHAUSTED, so
// arrivals landing while the loaded window's top edge is already open (paged
// away from the newest end) are not signalled — there is no cheap count for
// them, and the pill must never invent one.
const PILL_TOP_EPS = 4 // px from the document top that still counts as "at the top"
let newAbove = 0 // rows a store-grown prepend put above the fold, still unseen
let pillEl: HTMLElement | null = null
let pillOnScroll: (() => void) | null = null
// Open between a store-grown top reopen and the moment that reopened runway is
// drained (exhaustedTop again). Only prepends inside that window are FRESH
// ARRIVALS: the same fetchNewer path serves ordinary upward paging, where the
// rows are ones the user is deliberately scrolling toward and a pill is noise.
let grownRunway = false
// Injected by setup(); see the offerFrontierUndo parameter.
let offerUndo: (() => Promise<void>) | null = null

export function setup(
   el: HTMLElement,
   open: (chron: number) => void,
   onScroll?: () => void,
   onPageError?: (e: unknown) => void,
   // The seen-frontier undo offer (menus.offerFrontierUndo), injected rather than
   // imported: it lives behind app.ts's snackbar deps, and importing menus here
   // would close a list↔menus cycle. Absent = no announcement, only the slot
   // marked (see markRowRead).
   offerFrontierUndo?: () => Promise<void>,
): void {
   container = el
   onOpen = open
   notifyScroll = onScroll ?? (() => {})
   onError = onPageError ?? (() => {})
   offerUndo = offerFrontierUndo ?? null
   container.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      const a = target.closest("a.srr-row") as HTMLElement | null
      if (!a) return
      // The row is a real <a href="#chron"> for keyboard/semantics, but
      // <base target="_blank"> would open it in a new tab — intercept and
      // route in-SPA instead (covers a star tap too: the star lives inside <a>).
      e.preventDefault()
      const chron = Number(a.dataset.chron)
      // A committed row swipe (RDR14) has already acted on this row; the
      // finger-lift's click must not ALSO open the reader. Engines differ on
      // whether a canceled touchmove sequence still synthesizes the click, so
      // the guard is here rather than assumed away.
      if (swipeClickGuard) {
         swipeClickGuard = false
         return
      }
      // The save star toggles in place; it does NOT open the reader. In the
      // Saved view, un-saving drops the row from the feed straight away.
      if (target.closest(".srr-row-star")) {
         toggleRowSave(a)
         return
      }
      onOpen(chron)
   })
   // A genuine scroll gesture during a progressive render disables the post-fill
   // anchor re-assert (the user's position wins). A programmatic sc.to
   // fires "scroll" but NOT these, so it never trips the flag.
   const markScrolled = () => {
      userScrolled = true
   }
   container.ownerDocument.addEventListener("wheel", markScrolled, { passive: true })
   container.ownerDocument.addEventListener("touchstart", markScrolled, { passive: true })
   container.ownerDocument.addEventListener("keydown", markScrolled)
   // A new touch means the previous gesture's synthesized click can no longer
   // arrive, so the swipe's click guard has done its job (or was never needed —
   // engines differ on whether a canceled touchmove sequence still produces the
   // click). Clearing it HERE rather than on a timer is what keeps a swipe that
   // produced no click from swallowing the next genuine tap.
   container.ownerDocument.addEventListener(
      "touchstart",
      () => {
         swipeClickGuard = false
      },
      { passive: true },
   )
   // Pull to refresh (RDR11): an overscroll pull that STARTS on this container
   // runs one refresh cycle. The touch machine is gestures.ts's — one state
   // machine, so the pull axis-locks against the horizontal swipe and the
   // two-finger cycle instead of racing them — but the surface and the action
   // are the list's, so the registration lives here rather than in app.ts's
   // setupGestures call. refreshNow() is the SAME entry point the background
   // triggers use and carries app.ts's guardBg mutex inside it, so this adds a
   // trigger, never a second concurrency path.
   setPullRefresh(container, () => refreshNow())
   // Row swipe actions (RDR14): → toggles ★ Saved, ← toggles read. Same
   // registration story as the pull — the touch machine is gestures.ts's (one
   // machine, so the row swipe axis-locks against the pull and the reader's
   // prev/next instead of racing them), the rows and the actions are the list's.
   setRowSwipe(container, {
      row: (t) => (t instanceof Element ? t.closest<HTMLElement>("a.srr-row") : null),
      move: paintRowSwipe,
      end: endRowSwipe,
   })
}

function el(tag: string, className: string): HTMLElement {
   const e = document.createElement(tag)
   e.className = className
   return e
}

// Count `n` freshly prepended rows toward the arrivals pill and (re)paint it.
// Search is exempt: its rows are an explicit query result rather than a wire
// that grows, and the pinned search bar owns the strip of viewport the pill
// would sit in.
function noteNewAbove(n: number): void {
   if (n <= 0 || nav.isSearchFilter()) return
   newAbove += n
   paintNewPill()
}

function paintNewPill(): void {
   if (!pillEl) {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "srr-new-pill"
      // It reports something that already happened off-screen — which is what a
      // polite live region is for. It is still a real <button> (keyboard
      // reachable, labelled), not decoration.
      b.setAttribute("aria-live", "polite")
      const arrow = el("span", "srr-new-pill-arrow")
      arrow.setAttribute("aria-hidden", "true")
      arrow.textContent = "↑"
      b.append(arrow, el("span", "srr-new-pill-label"))
      b.addEventListener("click", jumpToNew)
      pillEl = b
      // First child of the list container: the pill is the top-of-list control,
      // so DOM order matches where it paints (it is fixed, so this costs the
      // rows no layout either way).
      container.insertBefore(b, container.firstChild)
      pillOnScroll = () => {
         // Reaching the top by hand IS the dismissal — the arrivals are on
         // screen, so the signal has done its job.
         if (sc.y() <= PILL_TOP_EPS) resetNewPill()
      }
      window.addEventListener("scroll", pillOnScroll, { passive: true })
      container.addEventListener("scroll", pillOnScroll, { passive: true })
   }
   const badge = countBadge(newAbove)
   pillEl.querySelector(".srr-new-pill-label")!.textContent = `${badge} new`
   const name = `${badge} new ${newAbove === 1 ? "article" : "articles"} — jump to the top of the list`
   pillEl.setAttribute("aria-label", name)
   pillEl.title = name
}

// Tap/Enter on the pill: ride up to the arrivals and drop the signal. Smooth,
// because the whole point is showing you the rows travel past — except under
// prefers-reduced-motion, where the same jump happens instantly (the CSS can't
// reach a scroll behavior, so this one check lives here).
function jumpToNew(): void {
   resetNewPill()
   const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
   if (reduced) sc.to(0)
   else sc.smoothTo(0)
   notifyScroll()
}

// Drop the pill, its listener and its count. Every rebuild/collapse path goes
// through here, so a filter change can't leave a detached node's scroll
// listener alive or a stale count to be added onto.
function resetNewPill(): void {
   newAbove = 0
   if (pillOnScroll) {
      window.removeEventListener("scroll", pillOnScroll)
      container.removeEventListener("scroll", pillOnScroll)
      pillOnScroll = null
   }
   pillEl?.remove()
   pillEl = null
}

// ── Row swipe actions (RDR14) ────────────────────────────────────────────────
// A one-finger horizontal swipe on a row acts on THAT row: → toggles ★ Saved
// (the star's own action, with the whole row as the target), ← toggles read. The
// touch state machine and the axis lock live in gestures.ts (one machine, or the
// row swipe could not lock against the pull and the reader's prev/next); what
// lives here is the row shape, the affordance, and the two actions.
//
// The affordance is a CSS custom property, not a class per state: the row's
// children translate by --swipe while the row box itself stays put, revealing a
// pseudo-element glyph at the edge the finger came from (styles.css). That
// division matters twice — the row keeps its layout box (pinHeights' measured
// intrinsic size stays exact, so a swipe can never shift the scroll) and the
// bump/edge animations that own `transform` on the row are untouched.

// How far the row travels, and how hard it resists past the arm point: 1:1 with
// the finger up to the trigger (so the arm point is a distance you can feel),
// then damped — a committed release should read as hitting a wall, not as a row
// sliding off the screen.
const SWIPE_MAX = 96
const SWIPE_RESIST = 0.35

// A committed swipe suppresses the finger-lift's click on the row (which would
// otherwise open the reader — see setup's click handler).
let swipeClickGuard = false

// One step of EXACT reversibility for the read toggle — RDR14 riding S57's undo
// machinery. Marking a row read raises its feed's frontier to that row, which
// reads everything older in that feed with it; "swipe back" therefore cannot be
// expressed as "lower to chron−1", which would leave the swallowed backlog read,
// silently and for good. So the mark-read swipe keeps the FrontierUndo snapshot
// ./seen took of its own raise, and the inverse swipe on the same row restores it
// verbatim (nav.undoFrontierMove) as long as the frontier is still exactly where
// the swipe left it. That equality test is the whole validity rule; anything else
// falls back to the explicit rewind.
//
// It carries the MOUNT it was taken on, and the guard compares it first. The
// reader mounts N stores and every per-store piece of device state is namespaced
// by a mount id, because chronIdx AND feed id are only unique WITHIN a mount —
// feed 7 in store A is a different feed from feed 7 in store B, and nav's seen
// map is the ACTIVE store's. Without the mid, a swipe-back on store B could match
// a snapshot taken on store A (same chron, same feed number, and B's frontier
// happening to sit at that value) and replay A's frontier onto B. This module is
// the one consumer of the record, so the invariant stays local to it: a snapshot
// from another lane simply fails the guard and falls through to the explicit
// rewind, which is exactly what a caller with no valid snapshot should do.
let readSwipeUndo: { mid: string; chron: number; feed: number; to: number; undo: nav.FrontierUndo } | null = null

// ★ Saved / search are peek modes: ./seen exempts them from every frontier write,
// so the read toggle has nothing to act on there. swipeAction declines the
// direction outright (no affordance for an inert action), and the scope still
// carries the flag — the exemption stays structural in ./seen rather than resting
// on this module's gate.
const frontierPeek = () => nav.isSavedFilter() || nav.isSearchFilter()

interface RowAction {
   // Which edge the affordance reveals, and what it means (styles.css).
   kind: "read" | "save"
   // The OUTCOME of releasing now, not the current state.
   icon: string
   run: () => void
}

// What a swipe in `dir` would do to this row, or null when it would do nothing —
// which is also how the affordance learns to stay still (paintRowSwipe).
function swipeAction(row: HTMLElement, dir: -1 | 1): RowAction | null {
   const chron = Number(row.dataset.chron)
   if (!Number.isFinite(chron)) return null
   if (dir > 0) {
      // → ★ Saved. Addressed by chron alone, so it works on a still-skeleton row
      // and in every mode (in the Saved view it un-saves and the row leaves).
      const saved = nav.isSaved(chron)
      return { kind: "save", icon: saved ? "☆" : "★", run: () => toggleRowSave(row) }
   }
   // ← the read toggle. Read state is per FEED, so a skeleton row whose meta card
   // hasn't landed yet has no frontier to move.
   if (frontierPeek()) return null
   const feed = Number(row.dataset.feed)
   if (!Number.isFinite(feed)) return null
   const unread = nav.isRowUnread(chron, feed, nav.getSeenMap())
   return {
      kind: "read",
      icon: unread ? "✓" : "↺",
      run: () => (unread ? markRowRead(chron, feed) : markRowUnread(chron, feed)),
   }
}

// The resolved action for the gesture in flight. It is cached for two reasons:
// the affordance must not change its mind mid-drag, and swipeAction reads the
// seen map (a localStorage parse) which has no business running on every
// touchmove. Keyed on the row AND the direction, so a finger that crosses back
// over zero gets the other action honestly.
let swipeCache: { row: HTMLElement; dir: -1 | 1; act: RowAction | null } | null = null

function actionFor(row: HTMLElement, dir: -1 | 1): RowAction | null {
   if (swipeCache && swipeCache.row === row && swipeCache.dir === dir) return swipeCache.act
   swipeCache = { row, dir, act: swipeAction(row, dir) }
   return swipeCache.act
}

function paintRowSwipe(row: HTMLElement, dx: number, armed: boolean): void {
   const act = actionFor(row, dx < 0 ? -1 : 1)
   // Nothing to do in this direction: the row simply doesn't move, which reads as
   // "there is nothing here" rather than promising an action that no-ops.
   if (!act) {
      clearRowSwipe(row)
      return
   }
   row.dataset.swipe = act.kind
   row.dataset.swipeIcon = act.icon
   row.classList.toggle("srr-row-armed", armed)
   row.style.setProperty("--swipe", swipeOffset(dx) + "px")
}

function swipeOffset(dx: number): number {
   const a = Math.abs(dx)
   const d =
      a <= ROW_SWIPE_TRIGGER ? a : Math.min(ROW_SWIPE_TRIGGER + (a - ROW_SWIPE_TRIGGER) * SWIPE_RESIST, SWIPE_MAX)
   return dx < 0 ? -d : d
}

function clearRowSwipe(row: HTMLElement): void {
   delete row.dataset.swipe
   delete row.dataset.swipeIcon
   row.classList.remove("srr-row-armed")
   row.style.removeProperty("--swipe")
}

// The gesture ended (dir 0 = retracted or cancelled). The affordance comes off
// first, so a row the action removes is never left mid-swipe.
function endRowSwipe(row: HTMLElement, dir: -1 | 0 | 1): void {
   const act = dir === 0 ? null : actionFor(row, dir)
   clearRowSwipe(row)
   // gestures.ts calls end() for a commit AND for every retract/cancel, so this
   // is the one exit where the gesture's cached action can be dropped.
   swipeCache = null
   if (!act) return
   swipeClickGuard = true
   act.run()
   // A frontier move reads across the row's whole feed and a save can drop the
   // row, so re-derive the loaded window from live state instead of patching one
   // row. Deliberately NOT a rebuild: under unread-only the membership has
   // changed, but re-snapshotting it here would move the ground out from under a
   // gesture aimed at a single row — so the swiped row greys in place, exactly as
   // a row read in the reader does on the way back (show() → refresh()), and the
   // membership re-derives on the next natural rebuild.
   refresh()
   // …but "on the way back" only covers what the LIST paints. A read toggle also
   // moved the frontier the reader's pill and the unread badge are derived from,
   // and under split the pane never leaves for a return path to fix them.
   if (act.kind === "read") notifyFrontierMoved()
}

// The ★ Saved toggle, shared by the star tap and the → swipe so the two cannot
// drift — the swipe is the same action with the whole row as its target.
function toggleRowSave(a: HTMLElement): void {
   const chron = Number(a.dataset.chron)
   const nowSaved = nav.toggleSaved(chron)
   a.classList.toggle("srr-row-saved", nowSaved)
   a.querySelector(".srr-row-star")?.setAttribute("aria-pressed", String(nowSaved))
   // Before the Saved-lane removal below, so the sink still fires for the row it
   // is about to drop — that is exactly the case the reader's button is stale in.
   notifySavedChanged(chron)
   if (nav.isSavedFilter() && !nowSaved) {
      a.remove()
      relabelDividers() // drop a day divider the removed row may have orphaned
      if (rowsEl && !rowsEl.querySelector("a.srr-row")) showEmptyState()
      else syncRovingTab() // the removed row may have held the lone Tab stop
   }
}

// Mark the row read: raise its feed's seen frontier to this chron.
//
// recordSeen is ./seen's raise primitive — it raises `article.f`'s frontier to
// `pos` plus every member of the scope, stamps the per-key ordering timestamp,
// pushes to sync, and snapshots the move for S57's undo. An EMPTY membership is
// exactly the single-feed raise this gesture means: OPENING a row makes the same
// statement across the whole navigation list, and a row gesture is about one row.
// Going through that body keeps one owner for the seen write, the sync push and
// the snapshot. Only `.f` is read off the article, hence the minimal literal.
function markRowRead(chron: number, feed: number): void {
   const key = "feed:" + feed
   raiseFeedTo({ f: feed, a: 0, p: 0, t: "", l: "", c: "" }, chron, { peek: frontierPeek(), members: [] })
   // Adopt the snapshot only if it is unmistakably the raise just made (this
   // feed's key alone, moved to this chron) — pendingFrontierUndo() otherwise
   // still holds whatever came before, e.g. when the feed is unknown to the store
   // and the raise did nothing.
   const u = nav.pendingFrontierUndo()
   readSwipeUndo =
      u && u.to === chron && Object.keys(u.prev).length === 1 && key in u.prev
         ? { mid: data.activeStore().mid, chron, feed, to: chron, undo: u }
         : null
   // Answer the offer HERE, not on the next reader render — by then the swipe is
   // minutes old and on another surface, announcing a number nobody can place.
   //
   // Which matters because a swipe is not necessarily one article: swiping a row
   // that sits far ahead of its feed's frontier reads everything behind it too,
   // and that silent bulk move is precisely what RDR1's snackbar exists to
   // announce (offerFrontierUndo stays below its own UNDO_MIN_ARTICLES bar for
   // the ordinary one-row case, so the common swipe stays silent). The offer also
   // marks the slot itself, which is the only thing that has to happen — hence
   // the fallback for a caller that wires no offer.
   if (readSwipeUndo) {
      if (offerUndo) void offerUndo()
      else nav.markFrontierUndoOffered()
   }
}

// Mark the row unread again — the inverse swipe.
function markRowUnread(chron: number, feed: number): void {
   const u = readSwipeUndo
   readSwipeUndo = null
   // Exact restore while this row's own mark-read swipe is still the last thing
   // that touched the feed's frontier — ON THE MOUNT IT WAS TAKEN ON (the mid
   // term is first because everything after it is only meaningful within one
   // store: chrons and feed ids are per-mount, and getSeenMap() is the ACTIVE
   // mount's map). If anything moved it since (reading in the reader, another
   // swipe, a sync merge), replaying the snapshot would un-read articles that
   // have since been read — so the explicit rewind takes over.
   if (
      u &&
      u.mid === data.activeStore().mid &&
      u.chron === chron &&
      u.feed === feed &&
      nav.getSeenMap()["feed:" + feed] === u.to
   ) {
      if (nav.undoFrontierMove(u.undo)) return
   }
   // The explicit rewind, scoped to this row's feed: this chron and everything
   // after it become unread for it again. ./seen's markUnreadFrom is the one path
   // allowed to LOWER a frontier and is deliberately not itself undoable — the
   // rewind IS the undo.
   lowerFeedFrom(chron, { peek: frontierPeek(), members: [feed] })
}

// One headline row: a source-colored rail + ("source · age" eyebrow over the
// title). Unread reads as full-ink weight + saturated rail, read as dimmed.
// Display fallbacks ("(untitled)", the "[DELETED]" feed tombstone) live here.
// One headline row. With a card it is born complete (search hits, paging); with
// `art === null` it is a height-reserved SKELETON that fillRow() later populates
// in place (the feed/[ALL]/saved progressive path). Chron-derived bits (href,
// saved star, current highlight) are set up front; feed-derived bits (source
// color/name, age, title, unread weight, data-ts) arrive with the card.
export function rowEl(
   chron: number,
   art: import("./format.gen").IMetaWire | null,
   seen: Record<string, number>,
   // One saved-set parse per BATCH, threaded by the render/page/refresh passes
   // (the default covers direct one-off callers, e.g. tests).
   savedSet: Set<number> = nav.getSavedSet(),
): HTMLElement {
   const a = document.createElement("a")
   a.className = "srr-row"
   a.href = "#" + chron + nav.tokensSuffix()
   a.dataset.chron = String(chron)
   // Roving tabindex: every row defaults OUT of the Tab order; syncRovingTab puts
   // exactly one back in (the cursor, or the first row), so Tab lands on the
   // selection instead of stepping through every article.
   a.tabIndex = -1
   // The article currently in the reader (the one you were just reading) is
   // highlighted wherever it appears, so returning to the list lands you on it.
   if (chron === nav.currentChron()) a.classList.add("srr-row-current")
   const saved = savedSet.has(chron)
   if (saved) a.classList.add("srr-row-saved")
   const body = el("div", "srr-row-body")
   // Source-first head: the source name (the primary triage key) leads as a
   // colored mono eyebrow, with the age right-aligned beside it; the title
   // follows beneath.
   const head = el("div", "srr-row-head")
   const source = el("span", "srr-row-source")
   const age = el("time", "srr-row-age")
   head.append(source, age)
   const title = el("div", "srr-row-title")
   body.append(head, title)
   const star = el("span", "srr-row-star")
   star.setAttribute("role", "button")
   star.setAttribute("aria-label", "Save article")
   star.setAttribute("aria-pressed", String(saved))
   star.innerHTML = STAR_SVG
   a.append(body, star)
   if (art) fillRow(a, art, seen)
   else a.classList.add("srr-row-skeleton")
   return a
}

// Write a row title, marking the matched terms while a query is what put the row
// on screen (RDR8). Outside search mode this is exactly the textContent write it
// replaces — and INSIDE it, it is still element building plus text nodes: a
// title is untrusted feed content, so it never touches innerHTML, and the
// <mark>s are real elements the browser exposes to AT as emphasis.
//
// matchSpans returns RAW-string ranges (it owns the fold→raw mapping and returns
// nothing at all when that mapping can't be verified), so all that is left here
// is to walk them: text, mark, text, …
function paintTitle(host: Element, text: string): void {
   const spans = nav.isSearchFilter() ? matchSpans(text, nav.searchQuery()) : []
   if (spans.length === 0) {
      host.textContent = text
      return
   }
   host.replaceChildren()
   let at = 0
   for (const [s, e] of spans) {
      if (s > at) host.append(text.slice(at, s))
      const m = document.createElement("mark")
      m.textContent = text.slice(s, e)
      host.append(m)
      at = e
   }
   if (at < text.length) host.append(text.slice(at))
}

// Populate a skeleton row's feed-derived content in place once its meta card
// lands. Idempotent: also used as rowEl's content path when a card is present.
export function fillRow(a: HTMLElement, art: import("./format.gen").IMetaWire, seen: Record<string, number>): void {
   const chron = Number(a.dataset.chron)
   // Stable per-source color slot (see styles.css [data-src]): the source-colored
   // left rail + eyebrow let the feed be triaged by origin.
   a.dataset.feed = String(art.f)
   a.dataset.src = String(srcColorIndex(art.f))
   // The article's own timestamp — relabelDividers buckets rows into day strata
   // by comparing the dayLabel of consecutive rows.
   a.dataset.ts = String(art.w)
   a.classList.toggle("srr-row-unread", nav.isRowUnread(chron, art.f, seen))
   a.querySelector(".srr-row-source")!.textContent = data.feedTitle(art.f)
   a.querySelector(".srr-row-age")!.textContent = timeAgo(art.w)
   paintTitle(a.querySelector(".srr-row-title")!, art.t || "(untitled)")
   a.classList.remove("srr-row-skeleton")
   // If selectRow placed the cursor on this row while it was still a skeleton
   // (feed unknown → nav.select was deferred via data-select-pending), sync now —
   // but only when the row is still the current cursor.  refresh() can move
   // .srr-row-current to a different row (e.g. the reader navigated away during
   // the skeleton window) without clearing selectPending, so we clear the marker
   // unconditionally and re-select only if this row is still highlighted.
   if (a.dataset.selectPending) {
      delete a.dataset.selectPending
      if (a.classList.contains("srr-row-current")) nav.select(chron, art.f)
   }
}

// Pin each row's REAL height as its content-visibility intrinsic size. Rows are
// virtualized with `content-visibility: auto; contain-intrinsic-size: auto 4rem`
// (styles.css) — but a real row is 1- or 2-line (≈60 vs 80px), so the 4rem (64px)
// placeholder is wrong for every row. With the list's browser scroll anchoring
// off (overflow-anchor:none, for Safari parity), nothing absorbs a placeholder→
// real correction happening ABOVE the viewport: the moment a skipped row renders
// (scrolled into view, or swept past by a prepend's compensation scroll) its size
// jumps and shoves the viewport — the upward-scroll jump. Measuring each row once
// and pinning its true height makes the reserved space exact, so a row's size
// never changes when it later renders or skips, on any engine. Called at every
// insertion path so the invariant "every loaded row's intrinsic size is its real
// height" holds, keeping the fetchNewer prepend compensation exact. One forced
// layout per batch (the offsetHeight read); the rows stay virtualized afterward.
//
// `contain-intrinsic-size` sizes the CONTENT box, but offsetHeight is the
// border-box (box-sizing:border-box). Pinning offsetHeight directly makes a
// skipped row reserve offsetHeight + padding + border — ~19px too tall per row,
// which over-scrolls the prepend compensation. Subtract the row chrome (identical
// for every .srr-row) so the reserved border-box equals the real rendered height.
// The list's DOM window: how many screens' worth of rows stay materialized,
// centered on the viewport (~3 above, ~3 below the visible one).
//
// Rows used to be kept forever, so a deep walk through a 50k+ [ALL] lane
// accumulated tens of thousands of nodes (content-visibility:auto caps PAINT,
// not memory) and every page-in walked ALL of them in pinHeights and
// relabelDividers — so paging got slower the further you scrolled. The data
// layer is O(1)-boot and lazy; the DOM was the reader's only unbounded axis.
const WINDOW_VIEWPORTS = 7

// Fallback budget where row heights aren't measurable (jsdom). Generous enough
// that no realistic viewport pages past it before the height-derived budget
// takes over in a real browser.
const MIN_WINDOW_ROWS = BATCH * 3

// The live row-count budget, derived from the MEASURED row height rather than
// fixed, so a dense phone list and a roomy desktop one keep the same SCROLL
// distance of buffer. That distance is the load-bearing part: it must comfortably
// exceed the IntersectionObserver's ROOT_MARGIN, or trimming an edge would put
// its sentinel straight back in range and re-trigger the paging that refills it.
function rowBudget(rows: HTMLElement[]): number {
   const sample = Math.min(rows.length, 10)
   let total = 0
   for (let i = 0; i < sample; i++) total += rows[i].offsetHeight
   const mean = sample ? total / sample : 0
   if (!mean) return MIN_WINDOW_ROWS // no layout (jsdom): fall back to a count
   return Math.max(MIN_WINDOW_ROWS, Math.ceil((WINDOW_VIEWPORTS * sc.viewportH()) / mean))
}

// Drop rows past the budget from the FAR side of the direction just paged.
//
// A trimmed edge is RE-PAGEABLE, never exhausted: the matching exhausted flag is
// cleared and its terminus removed, so scrolling back re-materializes those rows
// through the existing fetch paths (rowEl/fillRow), which is the whole point —
// nothing here knows how to build a row.
//
// Removing rows above the viewport shifts the content up, so the scroll is
// compensated the same way fetchNewer's prepend is: by how far a row that is
// actually IN the viewport moves, never by a scrollHeight delta (which folds in
// changes that aren't directly above the viewport and lurches it).
function trimWindow(side: "top" | "bottom"): void {
   if (!rowsEl) return
   const rows = [...rowsEl.querySelectorAll<HTMLElement>("a.srr-row")]
   const excess = rows.length - rowBudget(rows)
   if (excess <= 0) return

   const victims = side === "top" ? rows.slice(0, excess) : rows.slice(rows.length - excess)
   const kept = side === "top" ? rows.slice(excess) : rows.slice(0, rows.length - excess)
   if (!kept.length) return // never trim the window away entirely

   // Anchor among the SURVIVORS, so a trim that reaches into the viewport still
   // measures against a row that is still in the document afterwards.
   const anchor = kept.find((r) => r.getBoundingClientRect().bottom > 0) ?? kept[0]
   const anchorBefore = anchor.getBoundingClientRect().top

   for (const r of victims) r.remove()

   // The window edge moved, so the paging cursor moves with it — and the edge is
   // open again by construction.
   if (side === "top") {
      newest = Number(kept[0].dataset.chron)
      exhaustedTop = false
      syncTopTerminus() // no compensate: the bracket below covers this removal too
      // The rows the pill points at just left the window (paged far enough down
      // that the recycler reclaimed them), so "jump to the top" would no longer
      // land on them. A pointer that has lost its referent is dropped, not kept.
      resetNewPill()
   } else {
      oldest = Number(kept[kept.length - 1].dataset.chron)
      exhaustedBottom = false
      syncBottomTerminus()
   }
   relabelDividers()

   const shift = anchor.getBoundingClientRect().top - anchorBefore
   if (shift) {
      sc.to(sc.y() + shift)
      notifyScroll()
   }
}

function pinHeights(rows: HTMLElement[]): void {
   if (!rows.length) return
   for (const r of rows) r.style.setProperty("content-visibility", "visible")
   const heights = rows.map((r) => r.offsetHeight) // single forced layout, then cached reads
   const cs = getComputedStyle(rows[0])
   const px = (v: string): number => parseFloat(v) || 0 // "" (jsdom) / "auto" → 0
   const chrome = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth)
   rows.forEach((r, i) => {
      r.style.setProperty("contain-intrinsic-size", `auto ${Math.max(0, heights[i] - chrome)}px`)
      r.style.removeProperty("content-visibility")
   })
}

// The "wire when it's quiet": each empty/in-between state is a directed station —
// a mono eyebrow (the wire voice) over one plain, specific line that says what's
// true and what to do next, instead of a vague "Nothing here". The caught-up
// state (unseen-only on, everything read) is the reward for the app's purpose.
// Returns the element so BOTH surfaces mount the same voice: the list (home) drops
// it into the feed, and the reader (app.ts) shows it in place of the bare
// "(no matching articles)" placeholder — keyed off the same nav state, so the two
// can't drift.
export function emptyStateEl(opts: { notStarted?: boolean; startFeed?: number } = {}): HTMLElement {
   const wrap = el("div", "srr-list-empty")
   const eyebrow = (text: string): void => {
      const e = el("span", "srr-empty-eyebrow")
      e.textContent = text
      wrap.appendChild(e)
   }
   const msg = el("p", "srr-empty-msg")
   const em = (text: string): HTMLElement => {
      const s = el("strong", "srr-empty-em")
      s.textContent = text
      return s
   }

   if (opts.notStarted) {
      // The reader's "not started" placeholder: a feed/tag you've never opened
      // (it HAS unread, but no already-read article to resume onto — the reader is
      // a resume surface). Deliberately NOT the "All caught up" reward, which would
      // be false here; a cold directive that points at Next — the placeholder
      // arrives with Next armed (nav.switchFilter), so one step starts reading
      // from the oldest unread right here, no detour through the list.
      // Reader-only — the list surface shows the unread rows and never this state.
      // The station OPENS with the wire-head — the never-read feed's name in the
      // reader-masthead voice (mono, upper, source-tinted) between the same
      // dashed hairlines that cap the list at LATEST/OLDEST — mirroring the
      // article anatomy (masthead first) that replaces it once Next is tapped;
      // the state + directive read under it. startFeed (the oldest unread's own
      // feed, threaded from nav.switchFilter) names WHICH feed the backlog
      // starts with: under a tag lane the label alone couldn't say which member
      // feed is the never-read one. Fallback (probe blip): the lane label.
      let label = ""
      if (opts.startFeed !== undefined) label = data.feedTitle(opts.startFeed)
      else {
         const key = nav.getCurrentFilterKey()
         if (key) label = nav.filterLabel(key)
      }
      if (label) {
         const head = el("div", "srr-empty-wirehead")
         const name = el("strong", "srr-empty-name")
         name.textContent = label
         if (opts.startFeed !== undefined) name.dataset.src = String(srcColorIndex(opts.startFeed))
         head.appendChild(name)
         wrap.appendChild(head)
      }
      eyebrow("Not started")
      msg.textContent = "Tap Next to start reading."
   } else if (nav.isSearchFilter()) {
      const q = nav.searchQuery()
      // A scoped query (RDR8) names its lane: "no match" means something quite
      // different when the search only ever looked inside one feed or tag, and
      // the pinned bar shows the words but never the scope.
      const scope = nav.searchScope()
      if (q) {
         msg.append("No titles match ", em(`“${q}”`))
         if (scope) msg.append(" in ", em(nav.filterLabel(scope)))
         msg.append(". Try fewer or different words.")
      } else {
         eyebrow("Search")
         msg.textContent = scope
            ? `Find an article in ${nav.filterLabel(scope)} by its title.`
            : "Find any article by its title."
      }
   } else if (nav.isSavedFilter()) {
      // Saved is a peek mode independent of the unread-only flag (which defaults
      // ON), so its empty state must be checked BEFORE the caught-up reward below
      // — otherwise an empty Saved view mis-reads as "All caught up".
      eyebrow("Nothing saved")
      const star = el("span", "srr-empty-star")
      star.textContent = "★"
      msg.append("Tap ", star, " on any article to keep it here for later.")
   } else if (nav.isUnreadOnly() && data.db.total_art > 0) {
      // The one empty state that's a reward, not an absence (unseen-only spans
      // [ALL] too): an empty list with articles present means there's nothing
      // left to read. Mark it with a plain checkmark in the warm accent the
      // cold/absent states never get; the eyebrow + line match the other states.
      wrap.classList.add("srr-caughtup")
      const check = el("div", "srr-caughtup-check")
      check.setAttribute("aria-hidden", "true") // decorative; the eyebrow + line are the accessible text
      check.innerHTML = CHECK_SVG
      wrap.appendChild(check)
      eyebrow("All caught up")
      const key = nav.getCurrentFilterKey()
      // Name the tag/feed (filterLabel turns a single-feed filter's raw id into
      // its title), not the key — "" (all/multi) stays the unscoped line.
      if (key) msg.append("Nothing unread in ", em(nav.filterLabel(key)), ".")
      else msg.textContent = "You've read everything."
   } else if (nav.isFilterActive()) {
      // Name the scope when it's a single feed/tag (filterLabel resolves a raw id
      // to its title) — the common case for the reader's empty-feed placeholder; a
      // multi-token filter's key is "" → the unscoped line.
      const key = nav.getCurrentFilterKey()
      if (key) msg.append("Nothing in ", em(nav.filterLabel(key)), " yet.")
      else msg.textContent = "No articles under this filter yet."
   } else {
      eyebrow("No dispatches")
      msg.textContent = "New articles show up here once your feeds are fetched."
   }
   wrap.appendChild(msg)
   return wrap
}

function emptyState(): void {
   container.appendChild(emptyStateEl())
}

// Collapse a now-empty list (the Saved view after un-saving the last row) to its
// empty state, dropping the observer so a stale sentinel can't keep firing.
function showEmptyState(): void {
   teardownObserver()
   resetNewPill() // nothing left above the fold to point at
   rowsEl = null
   container.replaceChildren()
   emptyState()
}

// The list's TIME axis: rebuild the sticky day-strata dividers from scratch over
// the currently rendered rows (idempotent — drop the old ones, walk the rows
// newest-first, and insert a divider before the first row of each new day).
// Cheap: the window is bounded, and dayLabel is unique per calendar day so a
// label change IS a day boundary. Suppressed in search and ★ Saved (both are
// cross-time explicit sets, not a date-ordered walk). Callers run
// it inside any scroll-compensation bracket so the divider heights ride the same
// scrollHeight delta as the rows.
// Re-assert the anchor after a progressive fill changed row heights, unless the
// user has scrolled (then their position wins). Only meaningful for an
// anchoredMid seed (rows above it can grow/shrink); a newest-top anchor is at
// scroll 0 and grows downward, so it never needs this.
function reassertAnchor(seed: number): void {
   if (userScrolled) return
   scrollChronToView(seed)
}

function relabelDividers(): void {
   if (!rowsEl) return
   rowsEl.querySelectorAll(".srr-day-divider").forEach((d) => d.remove())
   // Suppressed in search AND ★ Saved: both are cross-time explicit sets whose
   // rows aren't in date order (search hits span time; saved reads in save
   // order), so day strata would repeat chaotically instead of marking a walk
   // down through the days.
   if (nav.isSearchFilter() || nav.isSavedFilter()) return
   let prev: string | null = null
   const ctx = dayLabelCtx() // hoisted: the pass walks every loaded row
   for (const row of rowsEl.querySelectorAll<HTMLElement>("a.srr-row")) {
      if (row.dataset.ts === undefined) continue // skeleton: no timestamp yet
      const label = dayLabelWith(Number(row.dataset.ts), ctx)
      if (label !== prev) {
         const d = el("div", "srr-day-divider")
         d.textContent = label
         rowsEl.insertBefore(d, row)
         prev = label
      }
   }
}

// The list's oldest-end terminus: once the feed is exhausted downward, cap the
// rows with an "OLDEST" sign-off so scrolling to the bottom reads as a definite
// end. Idempotent (one terminus at most) and cleared on every rebuild via
// replaceChildren; rowSibling skips it, so it never intercepts cursor stepping.
function syncBottomTerminus(): void {
   if (!rowsEl) return
   const existing = rowsEl.querySelector(".srr-wire-end")
   if (!exhaustedBottom) {
      existing?.remove()
      return
   }
   if (existing) return
   const end = el("div", "srr-wire-end")
   const rule = el("div", "srr-wire-end-rule")
   rule.textContent = "OLDEST" // the bottom of a newest-first list is its oldest end
   end.append(rule)
   rowsEl.appendChild(end)
}

// The list's newest-end terminus — the symmetric cap at the top: once the upward
// walk is exhausted, prepend a "LATEST" sign-off so scrolling up to the newest
// reads as a definite end. Same idempotent/cleared-on-rebuild/rowSibling-skipped
// contract as the bottom. When
// `compensate`, it keeps the viewport put across the prepend (the incremental
// fetchNewer path, which compensates its own prepended rows the same way);
// render passes false because it sets scroll explicitly right after.
function syncTopTerminus(compensate = false): void {
   if (!rowsEl) return
   const existing = rowsEl.querySelector(".srr-wire-top")
   if (exhaustedTop === !!existing) return // already in the desired state
   const before = compensate ? sc.extent() : 0
   if (!exhaustedTop) {
      existing!.remove()
   } else {
      const top = el("div", "srr-wire-top")
      const rule = el("div", "srr-wire-end-rule")
      rule.textContent = "LATEST" // the top of a newest-first list is its newest end
      top.append(rule)
      rowsEl.insertBefore(top, rowsEl.firstChild)
   }
   if (compensate) {
      const delta = sc.extent() - before
      if (delta) {
         sc.to(sc.y() + delta)
         notifyScroll()
      }
   }
}

// Walk the filtered feed from MEMBER `start` (inclusive) collecting up to `max`
// matching chronIdxs, stepping the strict neighbor each iteration through nav's
// mode-aware seam (feed/search: the chronIdx value scan; ★ Saved: save-index
// order). "older" walks toward the front (feed: DESCENDING chrons, so the caller
// can append them newest-first); "newer" walks toward the back (feed: ASCENDING).
// `exhausted` is true when the walk ran off the end (a -1 neighbor) rather than
// merely filling `max`. A `start` of -1 yields an empty, exhausted result.
async function walk(
   my: object,
   start: number,
   max: number,
   dir: "older" | "newer",
): Promise<{ chrons: number[]; exhausted: boolean }> {
   const chrons: number[] = []
   let cur = start
   while (chrons.length < max) {
      if (cur === -1) return { chrons, exhausted: true }
      chrons.push(cur)
      const found = await (dir === "older" ? nav.neighborOlder(cur) : nav.neighborNewer(cur))
      if (my !== tok) return { chrons, exhausted: false }
      cur = found
   }
   return { chrons, exhausted: cur === -1 }
}

// Run `items` through `worker` with at most `limit` in flight, pulling them in
// the given order — so the earliest items (here: nearest the anchor) dispatch and
// resolve before later ones, regardless of transport (HTTP/2 would otherwise race
// them all at once). Each worker is token-guarded by its caller.
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
   let next = 0
   let failed = false
   const run = async (): Promise<void> => {
      while (next < items.length && !failed) {
         const i = next++
         try {
            await worker(items[i])
         } catch (e) {
            // First failure rejects the whole pool (render surfaces it). Flip the
            // flag so the other lanes stop claiming work instead of running on as
            // orphans — writing to detached rows and raising further unhandled
            // rejections after Promise.all has already settled.
            failed = true
            throw e
         }
      }
   }
   await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
}

// Full (re)build: clears the list, resolves the anchor (the reader's article when
// it matches, else newest), loads a batch older (incl. the anchor) and — when
// anchored mid-feed — a batch newer above it, then positions the anchor,
// CENTERED in the viewport (context above and below, the same mid-screen
// framing on every arrival). `anchorNow` (set when returning from the reader)
// commits that scroll immediately — the seed's pack is warm — instead of the
// cold-build land-once below. When the filter resolves to a SPECIFIC article
// (anchoredMid — a fresh feed/tag's oldest-unread position), that article also
// becomes the current selection (nav.select), so the highlighted row tracks what
// the reader would open; the newest-default anchor (-1: [ALL]/saved/search) is
// left unselected. `renderSearch` selects the newest hit for a query. Sets
// builtKey so show() can later refresh-vs-rebuild.
//
// May this REBUILD seed the shared cursor? nav.pos is one cursor for two
// surfaces, and under split the reader is on screen holding an article of its
// own: re-seeding from the list's anchor there would leave the pane highlighting
// one article while the reader shows another, and — worse — step the toolbar
// arrows from the highlight rather than from what you are reading (a Show-read
// flip jumped 20 → 25; a search keystroke left the arrows dead). So a rebuild
// claims the cursor only when nothing holds it: the single-surface layout (the
// list IS the cursor there) or a split pane with no article open. Explicit
// navigation — a row tap, a picker lane pick, the arrows — still moves it.
//
// The test is "a live READER holds it", not "the cursor is set". `pos >= 0` was
// the first cut and it is not the same thing: this module's own anchor seed sets
// pos at boot, so from the first paint onward the list could never re-seed
// ITSELF — pick a lane beside a resting pane and the rebuilt rows carried no
// .srr-row-current at all, the cursor still naming an article from the lane you
// had just left.
function mayClaimCursor(): boolean {
   return !isSplit() || !readerHoldsCursor()
}

export async function render(anchorNow = false, onInteractive?: () => void): Promise<void> {
   const my = (tok = {})
   teardownObserver()
   newest = oldest = -1
   exhaustedTop = exhaustedBottom = false
   loadingTop = loadingBottom = false
   pumping = false
   builtKey = nav.filterKey()
   rowsEl = null
   // A rebuild lays a fresh window: whatever the pill was pointing at is gone
   // with the old rows, and no reopened runway is in flight any more.
   resetNewPill()
   grownRunway = false
   container.replaceChildren()

   if (data.db.total_art === 0) {
      emptyState()
      onInteractive?.()
      return
   }

   // Search is always newest-top (listAnchor returns -1 for search) and discovers
   // its rows by walking nav's pre-loaded hit-set snapshot — a different path from
   // the feed walk + skeleton-fill below.
   if (nav.isSearchFilter()) return renderSearch(my, onInteractive)

   const anchor = await nav.listAnchor()
   // The seed is the topmost row of the older batch: the anchor itself when it's
   // a real match, the newest match when anchored at -1, and (defensively) the
   // nearest match below a non-matching anchor. ★ Saved's listAnchor already
   // returns a member (the front of the queue, or the live reader article), and
   // has no chronIdx value order to scan, so it seeds directly.
   let seed = nav.isSavedFilter() ? anchor : await nav.feedLeft(anchor === -1 ? data.db.total_art - 1 : anchor)
   if (my !== tok) return
   if (seed === -1 && anchor !== -1 && !nav.isSavedFilter()) seed = await nav.feedLeft(data.db.total_art - 1)
   if (my !== tok) return
   if (seed === -1) {
      emptyState()
      onInteractive?.()
      return
   }
   const anchoredMid = anchor !== -1 && seed === anchor

   // When the filter resolves to a SPECIFIC article — the anchoredMid seed, i.e.
   // a fresh feed/tag's oldest-unread position or ★ Saved's oldest saved — make
   // it the current selection so the list highlight tracks the article the reader
   // would open under that filter. Returning from the reader already holds it as
   // pos (guard no-ops). The newest-default anchor (-1: [ALL]/search, or a
   // caught-up feed/tag) is deliberately left unselected, so the first arrow
   // still establishes the cursor on the row in view (moveSelection) and a fresh
   // [ALL] boot shows no selection.
   // getFeedId is resident — feedLeft just walked the seed's idx pack — no fetch.
   if (anchoredMid && seed !== nav.currentChron() && mayClaimCursor()) {
      nav.select(seed, await data.getFeedId(seed))
      if (my !== tok) return
   }

   const older = await walk(my, seed, BATCH, "older") // [seed, ...older], descending
   if (my !== tok) return
   // The newer batch starts at the seed's strict newer neighbor (walk includes
   // its start member, and the seed already belongs to the older batch).
   let newer: { chrons: number[]; exhausted: boolean } = { chrons: [], exhausted: true }
   if (anchoredMid) {
      const firstNewer = await nav.neighborNewer(seed)
      if (my !== tok) return
      if (firstNewer !== -1) newer = await walk(my, firstNewer, BATCH, "newer") // above the seed, ascending
      if (my !== tok) return
   }
   if (older.chrons.length === 0) {
      emptyState()
      onInteractive?.()
      return
   }

   oldest = older.chrons[older.chrons.length - 1]
   newest = newer.chrons.length ? newer.chrons[newer.chrons.length - 1] : older.chrons[0]
   // The chronIdx==0 / ==total_art-1 shortcuts (global first/last article) only
   // hold when display order IS chronIdx order (feed/search). ★ Saved walks by
   // save-index, so a saved chron 0 can sit mid-queue — its own walk exhaustion
   // (a -1 neighbor) is the only reliable end signal there.
   exhaustedBottom = older.exhausted || (!nav.isSavedFilter() && oldest === 0)
   exhaustedTop = newer.exhausted || (!nav.isSavedFilter() && newest === data.db.total_art - 1)

   const chronsDesc = newer.chrons.slice().reverse().concat(older.chrons) // newest-first
   const seen = nav.getSeenMap()
   const savedSet = nav.getSavedSet()

   rowsEl = el("div", "srr-list-rows")
   topSentinel = el("div", "srr-list-sentinel")
   bottomSentinel = el("div", "srr-list-sentinel")
   const frag = document.createDocumentFragment()
   const rows = chronsDesc.map((c) => rowEl(c, null, seen, savedSet)) // skeletons, in order
   rows.forEach((r) => frag.appendChild(r))
   rowsEl.appendChild(frag)
   container.append(topSentinel, rowsEl, bottomSentinel)
   syncBottomTerminus() // cap the rows when the whole view fits one batch
   syncTopTerminus() // and cap the top when we're already anchored at the newest
   syncRovingTab() // the seed row (or, with no selection, the first row) is the lone Tab stop

   // Position the surface, then hand it over (interactive) before the fills land.
   // Returning from the reader (anchorNow) centers the live article immediately —
   // its pack is warm, so it anchors before the fill and re-asserts as neighbors
   // grow. A FRESH anchor (boot/filter change — landOnceMode) instead stays at the
   // top during load and lands ONCE, centered the same way, after layout settles
   // (below): scrolling onto still-skeleton, pre-font rows and then correcting as
   // they paint/reflow taller is exactly the visible "bump". The newest-default
   // (-1) is plain top.
   const landOnceMode = anchoredMid && !anchorNow
   // The cursor as land-once is ARMED. A normal boot never moves it again before
   // the deferred landing (the anchoredMid select above already ran; -1 stays -1,
   // a filter-change resume stays put), so the landing commits exactly as before.
   // Any reader open or cursor step meanwhile moves it — and in SPLIT view the
   // list stays visible, so the container.hidden bail below never trips — leaving
   // a landing computed for the OLD anchor: it must yield to followCursor instead
   // of overwriting it (the checkpoints below compare against this).
   const armedChron = nav.currentChron()
   if (anchoredMid && anchorNow) scrollChronToView(seed)
   else sc.to(0)
   notifyScroll()
   userScrolled = false
   onInteractive?.()
   // Hold the infinite-scroll observer until the land-once scroll: at the top during
   // load its top sentinel would page newer rows in (a large filter could runaway)
   // before we've reached the seed. The centered/newest paths observe right away.
   if (!landOnceMode) observe(my)

   // Fill rows NEAREST the anchor first (bounded concurrency), so the packs for
   // what you're looking at resolve before off-screen rows — progressive fill
   // prioritized by navigation position. Out-of-order arrival within a wave is
   // fine: each card fills its own row. Pin the rows' real heights, relabel
   // dividers (which skip still-skeleton rows), and re-assert the anchor
   // (immediate-anchor reader return only) so a height change above the seed
   // doesn't drift it —
   // coalesced to ONE flush per animation frame, not per card: pinHeights'
   // offsetHeight read after relabelDividers' divider churn forces a full
   // synchronous relayout, and per-card that's O(rows) forced reflows packed into
   // first paint (the fetchOlder/fetchNewer paths already batch per fetch). A
   // warm cache drains every card in one task, so without the frame gate the
   // whole batch still thrashed. No requestAnimationFrame (jsdom) → flush per
   // card, the order the unit tests observe.
   const pendingFill: HTMLElement[] = []
   let fillFrame = 0
   const flushFill = (): void => {
      fillFrame = 0
      if (my !== tok || !pendingFill.length) return
      pinHeights(pendingFill.splice(0))
      relabelDividers()
      if (anchoredMid && anchorNow) reassertAnchor(seed)
   }
   const anchorIdx = chronsDesc.indexOf(seed)
   const fillOrder = chronsDesc.map((_, k) => k).sort((a, b) => Math.abs(a - anchorIdx) - Math.abs(b - anchorIdx))
   await runPool(fillOrder, FILL_CONCURRENCY, async (k) => {
      if (my !== tok) return
      const card = await data.loadMeta(chronsDesc[k])
      if (my !== tok) return
      fillRow(rows[k], card, seen)
      pendingFill.push(rows[k])
      if (typeof requestAnimationFrame !== "function") flushFill()
      else if (!fillFrame) fillFrame = requestAnimationFrame(flushFill)
   })
   if (my !== tok) return
   if (fillFrame) cancelAnimationFrame(fillFrame)
   // Final authoritative pass: pin whatever a cancelled frame left pending, then
   // the full divider/anchor sync (keeps the every-row-pinned invariant — see
   // pinHeights — before the land-once measurement below).
   if (pendingFill.length) pinHeights(pendingFill.splice(0))
   relabelDividers()
   if (anchoredMid && anchorNow) reassertAnchor(seed)

   // Land-once for a fresh anchor: content-visibility rows paint taller and web
   // fonts reflow AFTER the fill, so scrolling now would land short and then bump as
   // the rows grow. Instead CONVERGE THE MEASUREMENT without moving: each frame
   // re-pin every row's current true height (so even off-screen rows reserve their
   // real size) and compute where the seed WOULD scroll to (centered — the same
   // mid-screen anchor as the reader return); once that target stops changing for
   // two frames, the layout has settled — scroll there a single time and only now
   // start the observer. Bounded so a never-settling layout can't spin; abandoned
   // if the user scrolls first. No requestAnimationFrame (jsdom) → land
   // synchronously.
   if (landOnceMode) {
      const allRows = (): HTMLElement[] => (rowsEl ? [...rowsEl.querySelectorAll<HTMLElement>("a.srr-row")] : [])
      const commit = (): void => {
         // The list and the reader share the window scroll. This scroll is DEFERRED
         // (fonts.ready + a settle loop), so a row opened meanwhile — app.ts
         // showReader() sets container.hidden (el.listView.hidden) — makes the reader
         // the visible surface before we land. Centering the list's seed row now
         // would yank the article view off the top it just scrolled to. Skip the
         // scroll when we're no longer the visible surface; still start the observer
         // so infinite scroll is live when the list returns (its offscreen guard
         // no-ops paging while hidden). A moved cursor (armedChron) bails the same
         // way: split view keeps the list visible, so it is the only tell there.
         if (!container.hidden && !userScrolled && nav.currentChron() === armedChron) {
            scrollChronToView(seed)
            notifyScroll()
            userScrolled = false
         }
         observe(my)
      }
      if (typeof requestAnimationFrame === "function") {
         let lastTarget = -1
         let stable = 0
         let tries = 0
         const tick = (): void => {
            if (my !== tok) return
            // Stop the settle loop early once the reader has opened over us, or the
            // cursor has moved off the armed anchor (commit then skips the scroll
            // but still starts the observer).
            if (container.hidden || userScrolled || !rowsEl || nav.currentChron() !== armedChron) return commit()
            pinHeights(allRows()) // re-measure true (post-paint/post-font) heights
            const target = chronScrollTarget(seed) ?? -1
            if (target === lastTarget) stable++
            else {
               stable = 0
               lastTarget = target
            }
            if (stable >= 2 || tries++ > 20) return commit()
            requestAnimationFrame(tick)
         }
         const fontsReady = document.fonts?.ready ?? Promise.resolve()
         void fontsReady.then(() => requestAnimationFrame(tick))
      } else {
         pinHeights(allRows())
         commit()
      }
   }
}

// Search render: the full hit-set is pre-loaded into nav's snapshot via
// feedLeft/feedRight → ensureSearchSet (search.ts caches results per query).
// Rows are built directly from the search snapshot's per-hit {f,w,t} cards
// (nav.searchCard) — no per-row meta fetch, since search.loadHits already parsed
// them during the scan. Search suppresses day dividers (relabelDividers returns
// early in search mode).
async function renderSearch(my: object, onInteractive?: () => void): Promise<void> {
   // Walk newest-first from the total_art ceiling to get the first batch.
   const seed = await nav.feedLeft(data.db.total_art - 1)
   if (my !== tok) return
   if (seed === -1) {
      emptyState()
      onInteractive?.()
      return
   }
   // The newest hit is the cursor position for a search render (the article
   // switchFilter → last() opens); select it before building rows so
   // rowEl paints .srr-row-current on it. Under split the reader's open article
   // keeps the cursor instead (mayClaimCursor) — a query is typed WHILE reading,
   // and the arrows must keep stepping from what is on screen.
   if (seed !== nav.currentChron() && mayClaimCursor()) nav.select(seed, await data.getFeedId(seed))
   if (my !== tok) return

   const older = await walk(my, seed, BATCH, "older")
   if (my !== tok) return
   if (older.chrons.length === 0) {
      emptyState()
      onInteractive?.()
      return
   }
   oldest = older.chrons[older.chrons.length - 1]
   newest = older.chrons[0]
   exhaustedBottom = older.exhausted || oldest === 0
   exhaustedTop = true // nothing newer than the newest hit

   const seen = nav.getSeenMap()
   const savedSet = nav.getSavedSet()
   rowsEl = el("div", "srr-list-rows")
   topSentinel = el("div", "srr-list-sentinel")
   bottomSentinel = el("div", "srr-list-sentinel")
   const frag = document.createDocumentFragment()
   const rows = older.chrons.map((c) => rowEl(c, nav.searchCard(c) ?? null, seen, savedSet))
   rows.forEach((r) => frag.appendChild(r))
   rowsEl.appendChild(frag)
   container.append(topSentinel, rowsEl, bottomSentinel)
   syncBottomTerminus()
   syncTopTerminus()
   syncRovingTab() // the newest hit (selected by renderSearch) is the lone Tab stop
   sc.to(0)
   notifyScroll()
   userScrolled = false
   onInteractive?.()
   observe(my)

   // Rows already carry their {f,w,t} from the search snapshot (no extra fetch).
   // Pin the heights of those filled rows; only a chron missing from the snapshot
   // (defensive — shouldn't happen) falls back to a lazy meta fill.
   const prefilled = rows.filter((_, k) => nav.searchCard(older.chrons[k]))
   if (prefilled.length) pinHeights(prefilled)
   const missing = older.chrons.map((c, k) => (nav.searchCard(c) ? -1 : k)).filter((k) => k >= 0)
   if (missing.length) {
      await runPool(missing, FILL_CONCURRENCY, async (k) => {
         if (my !== tok) return
         const card = await data.loadMeta(older.chrons[k])
         if (my !== tok) return
         fillRow(rows[k], card, seen)
         pinHeights([rows[k]])
      })
   }
}

// Drop the built-window claim so the NEXT show() takes the rebuild path even
// under an unchanged filter key. For actions that change the filter's
// MEMBERSHIP while the list is hidden behind the reader (markUnreadFrom
// re-raising the unseen bounds: newly-unread rows are missing from the loaded
// window) — rebuilding the display:none list immediately would pin zero row
// heights, so invalidate now, rebuild on return.
export function invalidate(): void {
   builtKey = null
   // Also drop the live observer and the arrivals pill NOW, not at the next
   // render: a split→narrow crossing in the reader view re-routes without
   // rendering the list, so the pane-rooted IntersectionObserver and the pill's
   // window/container scroll listeners would otherwise dangle until the list is
   // next shown. Strictly cleaner for every caller (frontier moves, mount
   // changes) — the rebuild this claims recreates both anyway.
   teardownObserver()
   resetNewPill()
}

// Re-show an already-built list (same filter). When the reader's article is
// already a rendered row — the common return path: you stepped a few articles
// within the loaded window — re-anchor by scrolling to it (centered, like every
// list anchor), with NO feed walk, fetch or rebuild. Filter change, or an
// article outside the window (you jumped, or navigated past the loaded batch),
// falls through to a bounded rebuild. `anchorNow` (returning from the reader)
// only matters on that rebuild path: it makes render() commit the centered
// anchor immediately instead of land-once.
export async function show(anchorNow = false, onInteractive?: () => void): Promise<void> {
   const pos = nav.currentChron()
   if (builtKey === nav.filterKey() && rowsEl && pos >= 0 && findRow(pos)) {
      refresh()
      scrollChronToView(pos)
      notifyScroll()
      onInteractive?.() // reuse path is already interactive
      return
   }
   await render(anchorNow, onInteractive)
}

// Split view: after a reader-pane step, bring the list along — re-derive the
// row highlight and nudge the cursor row into the pane's live band without
// re-centering on every keypress. A cursor that stepped outside the loaded
// window falls back to show(true)'s bounded rebuild (whose fast path is
// exactly this scroll when the row exists).
export function followCursor(): void {
   const chron = nav.currentChron()
   // A landing with NO cursor is still a landing. nav.switchFilter answers an
   // unstarted lane with the armed "not started" placeholder at pos = -1, so
   // picking a lane (or cycling to one with W/S) from the READER surface got
   // here with nothing to follow and returned — leaving the pane on the PREVIOUS
   // lane's rows while the toolbar readout and the hash both named the new one:
   // 31 [ALL] rows under a "Sport" heading that has 15. Below the breakpoint that
   // staleness is invisible and self-correcting (the list is display:none and
   // rebuilds on return); under split the pane is on screen, and "it re-derives
   // on its next open" is a promise about a surface that never closes. There is
   // no row to anchor, so rebuild unanchored rather than early-returning.
   if (chron < 0) {
      if (builtKey !== nav.filterKey()) void show(true).catch(onError)
      return
   }
   // The same freshness gate show() applies, and for the same reason: a window
   // built for another filter — or invalidated (builtKey === null) — must
   // REBUILD, never merely be scrolled. Without this an invalidate() that is
   // NOT followed by a render lands here on the fast path over a stale row set
   // whose observer invalidate() just tore down, leaving the pane on screen with
   // infinite scroll permanently dead. The breakpoint crossing is exactly that
   // sequence: onSplitChange invalidates, then route() reaches this through
   // guard()'s render path.
   const row = builtKey === nav.filterKey() ? findRow(chron) : null
   if (!row) {
      // Report a failed rebuild instead of swallowing it. Under split this
      // fallback IS the pane's only build path for a reader-side step, so a
      // dropped pack left a permanently blank pane with no message and no
      // retry — the one place a silent catch costs a whole surface. onError is
      // the same seam a scroll-paging failure uses (app.ts: the popup, whose
      // retry re-renders the list).
      void show(true).catch(onError)
      return
   }
   refresh()
   scrollRowIntoView(row)
}

// Re-derive read/unread dots + saved stars + the current-article highlight from
// the live state (you may have read or saved some in the reader), and in the
// Saved view drop rows un-saved elsewhere. Does NOT move scroll — show() owns
// re-anchoring.
export function refresh(): void {
   if (!rowsEl) return
   const seen = nav.getSeenMap()
   const savedSet = nav.getSavedSet()
   const savedView = nav.isSavedFilter()
   const current = nav.currentChron()
   let removedAny = false
   rowsEl.querySelectorAll<HTMLElement>("a.srr-row").forEach((a) => {
      const chron = Number(a.dataset.chron)
      a.classList.toggle("srr-row-unread", nav.isRowUnread(chron, Number(a.dataset.feed), seen))
      a.classList.toggle("srr-row-current", chron === current)
      const saved = savedSet.has(chron)
      a.classList.toggle("srr-row-saved", saved)
      a.querySelector(".srr-row-star")?.setAttribute("aria-pressed", String(saved))
      // In the Saved view, an article un-saved from the reader is gone from the
      // feed — drop its row on the way back.
      if (savedView && !saved) {
         a.remove()
         removedAny = true
      }
   })
   if (savedView && removedAny) {
      relabelDividers() // drop any day divider orphaned by the removed rows (#11)
      if (rowsEl && !rowsEl.querySelector("a.srr-row")) showEmptyState() // (#1)
   }
   syncRovingTab() // the live current highlight (or a saved-view removal) may have moved the cursor
}

// Force a rebuild regardless of builtKey — used after an unseen-only toggle or a
// search-query change, where the filter token may be unchanged but its
// membership (raised bounds / new hit set) is not.
export function rerender(): Promise<void> {
   builtKey = null
   return render()
}

// After a store refresh grew the feed: reopen the top of the list WITHOUT
// rebuilding or moving the viewport (the fully-silent contract). Probes for a
// newer MATCH first so the LATEST terminus doesn't flicker off when the refresh
// brought nothing for this filter; when one exists, the terminus comes off
// (scroll-compensated) and the top sentinel resumes paging — parked at the very
// top (the usual exhaustedTop position) the reopened runway pages in immediately
// but invisibly (the prepend compensation keeps the viewport pinned, so the new
// rows sit above the fold until the user scrolls up); away from the top it pages
// in when the sentinel next enters its rootMargin. An empty state (fresh store,
// all-caught-up, no rows) rebuilds instead: there is nothing on screen to
// disturb.
export async function onStoreGrown(): Promise<void> {
   if (growing) return
   growing = true
   try {
      if (!rowsEl || !rowsEl.querySelector("a.srr-row")) {
         await rerender()
         return
      }
      refresh() // re-derive row state; cheap, covers a gen-rebuild's changed feeds
      // refresh() can collapse a now-empty Saved view to its empty state
      // (showEmptyState nulls rowsEl) — nothing left to reopen.
      if (!rowsEl) return
      if (!exhaustedTop || newest < 0) return
      const my = tok
      const found = await nav.neighborNewer(newest).catch(() => -1)
      if (my !== tok || found === -1) return // superseded by a rebuild, or nothing newer
      exhaustedTop = false
      syncTopTerminus(true)
      // Open the arrivals window: every batch the reopened runway prepends from
      // here until the top re-exhausts is fresh content the user has not seen,
      // so fetchNewer counts it toward the "N new" pill (noteNewAbove).
      grownRunway = true
      // Kick the observer: IntersectionObserver only fires on intersection
      // CHANGES, and at the parked-at-scroll-0 position the top sentinel is
      // ALREADY intersecting — removing the terminus doesn't change that, and
      // from scroll 0 there is no upward scroll left to create a re-entry edge.
      // Re-observing re-delivers the sentinel's CURRENT intersection state, so
      // the reopened runway pages in through the normal fetchNewer path.
      if (observer) {
         observer.unobserve(topSentinel)
         observer.observe(topSentinel)
      }
      // …and then page the first batch OURSELVES, because "parked at scroll 0"
      // is only one of the two resting positions. A list is anchored CENTERED on
      // the article being read, and re-delivering the sentinel's state is worth
      // nothing when that state is "a viewport and a half above the top edge",
      // outside ROOT_MARGIN: the arrivals never paged in and the pill that
      // exists to announce them never painted — measured under split (store
      // 31 → 34 while reading, pane stuck at 31 rows, no pill) where a centered
      // list is the NORMAL resting position, not an edge case. fetchNewer keeps
      // this exactly as silent as the observer path: same freshness token, same
      // loadingTop guard (so the kick above and this call cannot both prepend
      // the same batch), and its viewport-anchored scroll compensation means
      // nothing the user is looking at moves.
      await fetchNewer(my)
   } finally {
      growing = false
   }
}

function findRow(chron: number): HTMLElement | null {
   return rowsEl ? rowsEl.querySelector<HTMLElement>(`a.srr-row[data-chron="${chron}"]`) : null
}

// Scroll the row for `chron` into view: its vertical midpoint lands at the
// center of the area below the sticky search bar — keep the anchored article in
// the middle, with context above and below, on every list arrival (reader
// return, filter change, boot). sc.to clamps to [0, maxScroll], so an
// anchor near the top or bottom of the feed lands as close to centered as the
// content allows. A no-op if the row isn't rendered (e.g. saved view dropped it
// on return) — the caller then keeps the current scroll.
function scrollChronToView(chron: number): void {
   const target = chronScrollTarget(chron)
   if (target !== null) sc.to(target)
}

// The clamped scrollY that would center `chron`'s row — the pure computation
// behind scrollChronToView, also used by the land-once loop to detect when the
// target has stopped moving (layout settled) BEFORE committing a single scroll.
// null if the row isn't rendered. Centering parks the row mid-band, away from
// the sticky day divider, reserving only the bar (topInset stays the
// top-alignment inset for scrollRowIntoView / the cursor seed).
function chronScrollTarget(chron: number): number | null {
   const row = findRow(chron)
   if (!row) return null
   const rect = row.getBoundingClientRect()
   const top = sc.absTop(rect.top)
   return Math.max(0, top + rect.height / 2 - (sc.viewportH() + stickyOffset()) / 2)
}

function stickyOffset(): number {
   const bar = document.querySelector<HTMLElement>(".srr-searchbar")
   return bar && bar.getClientRects().length > 0 ? bar.offsetHeight : 0
}

// The day-strata dividers are sticky at the top of the list viewport
// (position:sticky; top:0), so a row aligned to just the sticky search bar would
// land hidden beneath the divider parked there. Any top-alignment must reserve a
// divider's height on top of stickyOffset. 0 in search mode (dividers suppressed,
// none in the DOM) and before the first render — uniform height, so the first one
// stands in for whichever is currently stuck.
function dividerInset(): number {
   const d = rowsEl?.querySelector<HTMLElement>(".srr-day-divider")
   return d ? d.offsetHeight : 0
}

// Top of the live band: below the sticky search bar AND the day divider parked at
// top:0. The single inset every top-alignment measures against (scrollRowIntoView,
// the cursor seed in firstVisibleRow), so they all clear the same chrome.
function topInset(): number {
   return stickyOffset() + dividerInset()
}

// Pull the next older batch and append it below. Guarded against re-entry; bails
// on a stale token without touching the DOM.
async function fetchOlder(my: object): Promise<void> {
   if (my !== tok || exhaustedBottom || loadingBottom || !rowsEl) return
   loadingBottom = true
   try {
      const start = await nav.neighborOlder(oldest) // strict older neighbor of the current bottom edge
      if (my !== tok) return
      const { chrons, exhausted } = await walk(my, start, BATCH, "older")
      if (my !== tok) return
      if (chrons.length === 0) {
         exhaustedBottom = true
         return
      }
      const seen = nav.getSeenMap()
      const savedSet = nav.getSavedSet()
      const arts = await Promise.all(chrons.map((c) => data.loadMeta(c)))
      if (my !== tok || !rowsEl) return
      // Commit the window cursor only after loadMeta resolves: a transient
      // rejection must not advance oldest/exhaustedBottom past a batch that never
      // rendered, which would permanently skip those rows on the next page.
      oldest = chrons[chrons.length - 1]
      if (exhausted || (!nav.isSavedFilter() && oldest === 0)) exhaustedBottom = true // see render's note on the saved gate
      const frag = document.createDocumentFragment()
      const older: HTMLElement[] = []
      chrons.forEach((c, k) => {
         const row = rowEl(c, arts[k], seen, savedSet)
         older.push(row)
         frag.appendChild(row)
      })
      rowsEl.appendChild(frag)
      relabelDividers()
      pinHeights(older) // keep the every-row-pinned invariant (see pinHeights)
      trimWindow("top") // paged down: recycle the far end above
   } finally {
      if (my === tok) {
         loadingBottom = false
         syncBottomTerminus() // append the terminus the moment we page off the oldest end
      }
   }
}

// Pull the next newer batch and PREPEND it above, compensating window scroll so
// the viewport stays put (the content above the fold shifts down by the new
// rows' height). overflow-anchor:none on the list (see styles.css) keeps the
// browser from also adjusting — manual compensation is the sole adjuster, so it
// behaves the same on engines with and without scroll anchoring (Safari has none).
async function fetchNewer(my: object): Promise<void> {
   if (my !== tok || exhaustedTop || loadingTop || newest === -1 || !rowsEl) return
   loadingTop = true
   try {
      const start = await nav.neighborNewer(newest) // strict newer neighbor of the current top edge
      if (my !== tok) return
      const { chrons, exhausted } = await walk(my, start, BATCH, "newer") // ascending
      if (my !== tok) return
      if (chrons.length === 0) {
         exhaustedTop = true
         return
      }
      const seen = nav.getSeenMap()
      const savedSet = nav.getSavedSet()
      const arts = await Promise.all(chrons.map((c) => data.loadMeta(c)))
      if (my !== tok) return
      // Commit the cursor only after loadMeta resolves (see fetchOlder).
      newest = chrons[chrons.length - 1]
      if (exhausted || (!nav.isSavedFilter() && newest === data.db.total_art - 1)) exhaustedTop = true // see render's note on the saved gate
      const frag = document.createDocumentFragment()
      // chrons is ascending; prepend newest-first so the block reads top-down.
      const fresh: HTMLElement[] = []
      for (let k = chrons.length - 1; k >= 0; k--) {
         const row = rowEl(chrons[k], arts[k], seen, savedSet)
         fresh.push(row)
         frag.appendChild(row)
      }
      // Pick the compensation anchor — the first row reaching into the viewport
      // (bottom past the top edge) — BEFORE the insert. Compensating by how far a
      // VIEWPORT row actually moves (then scrolling to put it back) keeps the
      // visible content fixed across the insert regardless of ANY height change
      // above it (the prepended block, or day-divider churn from relabelDividers).
      // Anchoring to the topmost row or to a scrollHeight delta is wrong: either
      // folds in changes that aren't directly above the viewport and lurches it.
      // Rows are never removed, so the anchor survives the mutation.
      const anchor =
         [...rowsEl.querySelectorAll<HTMLElement>("a.srr-row")].find((r) => r.getBoundingClientRect().bottom > 0) ??
         rowsEl.querySelector<HTMLElement>("a.srr-row")
      const anchorBefore = anchor ? anchor.getBoundingClientRect().top : 0
      rowsEl.insertBefore(frag, rowsEl.firstChild)
      relabelDividers()
      // Pin the prepended rows to their real height so their reserved space is
      // exact: the anchor measurement below then reflects the true inserted height,
      // AND the rows never correct when scrolled up into later. pinHeights leaves
      // them content-visibility:auto with a contain-intrinsic-size matching their
      // measured height (getBoundingClientRect forces the layout it relies on).
      pinHeights(fresh)
      const shift = anchor ? anchor.getBoundingClientRect().top - anchorBefore : 0
      if (shift) {
         sc.to(sc.y() + shift)
         notifyScroll()
      }
      // The compensation above is exactly what makes these rows invisible when
      // they are fresh arrivals — so that is where the pill's count comes from.
      // Ordinary upward paging (grownRunway false) stays silent as before.
      if (grownRunway) noteNewAbove(chrons.length)
      trimWindow("bottom") // paged up: recycle the far end below
   } finally {
      if (my === tok) {
         loadingTop = false
         syncTopTerminus(true) // prepend the terminus the moment we page off the newest end
         // The reopened runway is drained — later prepends are the user paging.
         if (exhaustedTop) grownRunway = false
      }
   }
}

// Public for the IntersectionObserver and tests: page one batch in either
// direction under the current freshness token. loadMore keeps its name (older
// paging) for back-compat; loadNewer pages upward.
export function loadMore(): Promise<void> {
   return fetchOlder(tok)
}
export function loadNewer(): Promise<void> {
   return fetchNewer(tok)
}

// Token-guarded paging-error sink: a fetchOlder/fetchNewer rejection from the
// fire-and-forget IO paths below surfaces through app's error popup — but only
// while still current, so a superseded render's late failure stays silent.
function reportPageError(my: object, e: unknown): void {
   if (my === tok) onError(e)
}

function observe(my: object): void {
   if (typeof IntersectionObserver === "undefined") return // jsdom: no layout/IO
   observer = new IntersectionObserver(
      (entries) => {
         if (my !== tok) return
         for (const e of entries) {
            if (!e.isIntersecting) continue
            if (e.target === topSentinel) fetchNewer(my).catch((err) => reportPageError(my, err))
            else pump(my).catch((err) => reportPageError(my, err))
         }
      },
      { rootMargin: ROOT_MARGIN, root: sc.root() },
   )
   observer.observe(topSentinel)
   observer.observe(bottomSentinel)
   // The older batch below the anchor may not fill the viewport (tall screen /
   // sparse filter); pump until the bottom sentinel sits below the fold or the
   // feed is exhausted. The newer side above needs no initial pump — it's
   // off-screen until the user scrolls up, where the observer pages it in.
   pump(my).catch((err) => reportPageError(my, err))
}

async function pump(my: object): Promise<void> {
   if (pumping) return
   pumping = true
   try {
      while (my === tok && !exhaustedBottom && rowsEl) {
         // Offscreen guard. pump exists to FILL A VIEWPORT — with no viewport it
         // must not run. A hidden list (display:none behind the reader, via
         // el.listView.hidden = true) has no layout box, so getClientRects() is
         // empty and getBoundingClientRect() below returns all-zeros — making the
         // below-the-fold break (rect.top > …) never fire. pump would then page to
         // EXHAUSTION, walking the whole archive. This is the unread-only freeze:
         // the toggle lives in config, so its list.rerender() runs while the list
         // is hidden; with a live anchor that has a long older-unread tail (e.g. a
         // list-cursor selection near the newest end) pump fetched every pack and
         // hung the tab. Bailing loses nothing — the IntersectionObserver re-pumps
         // when the list is shown and the sentinel intersects.
         if (!bottomSentinel.getClientRects().length) break
         const rect = bottomSentinel.getBoundingClientRect()
         if (rect.top > sc.viewportH() + 800) break
         const before = rowsEl.childElementCount
         await fetchOlder(my)
         // No progress and not exhausted (a transient fetchOlder no-op) — stop to
         // avoid a busy spin; the next scroll/observer tick will retry.
         if (rowsEl && rowsEl.childElementCount === before && !exhaustedBottom) break
      }
   } finally {
      pumping = false
   }
}

function teardownObserver(): void {
   observer?.disconnect()
   observer = null
}

// ── Keyboard selection cursor ────────────────────────────────────────────────
// The list is a window over the SAME feed sequence the reader steps through, so
// its rows top→bottom are strictly newest→oldest (the filter's order). A/← select
// the OLDER neighbor (the row below) and D/→ the NEWER (the row above), mirroring
// the reader's left()/right() so the same key reaches the same article on either
// surface. The selected row carries .srr-row-current (the reader's highlight) and
// nav.select() tracks it in nav.pos, so opening it (tap) or re-anchoring the list
// later stays consistent. The neighbor is just the adjacent row — no feed walk —
// and the infinite window pages one batch when the neighbor isn't loaded yet.
// Returns the now-selected chronIdx, or -1 when there's nowhere to move.
export async function moveSelection(dir: "older" | "newer"): Promise<number> {
   if (!rowsEl) return -1
   const my = tok
   const cur = rowsEl.querySelector<HTMLElement>("a.srr-row.srr-row-current")
   if (!cur) {
      // No cursor yet (fresh list, or the reader's article isn't a rendered row):
      // the first key just drops the cursor on the topmost row in view, no step.
      const start = firstVisibleRow()
      if (!start) return -1
      selectRow(start)
      return Number(start.dataset.chron)
   }
   let target = rowSibling(cur, dir)
   if (!target) {
      // At the loaded edge — page one batch that way (append older / prepend
      // newer), then retry the sibling once. A stale token or an in-flight load
      // leaves target null and the keypress no-ops; the next press retries.
      await (dir === "older" ? fetchOlder(my) : fetchNewer(my))
      if (my !== tok || !rowsEl) return -1
      target = rowSibling(cur, dir)
   }
   if (!target) {
      // Still no neighbor. When the feed is genuinely exhausted that way we're at
      // the end/beginning of the list — bump the current row to make the boundary
      // clear. (A null target while NOT exhausted is a transient in-flight page;
      // no cue, since the next press will advance once it lands.)
      if (dir === "older" ? exhaustedBottom : exhaustedTop) bumpEdge(cur, dir)
      return -1
   }
   selectRow(target)
   return Number(target.dataset.chron)
}

// Nudge the current row toward the edge it can't pass and let it spring back — a
// localized "rubber-band" so a key press at the start/end of the list reads as a
// boundary, not a dropped input. Direction-aware (down at the oldest end, up at
// the newest); the animation self-clears, and a remove+reflow restarts it on a
// rapid repeat. Honors prefers-reduced-motion via the CSS (animation: none).
function bumpEdge(row: HTMLElement, dir: "older" | "newer"): void {
   const cls = dir === "older" ? "srr-row-bump-down" : "srr-row-bump-up"
   row.classList.remove("srr-row-bump-down", "srr-row-bump-up")
   void row.offsetWidth // force reflow so re-adding restarts the keyframes
   row.classList.add(cls)
   setTimeout(() => row.classList.remove(cls), 220) // > the 0.2s animation
}

// The adjacent row in `dir` (older = below / next sibling, newer = above /
// previous sibling), or null at the loaded edge. Skips day-strata dividers, which
// sit between rows inside rowsEl.
function rowSibling(row: HTMLElement, dir: "older" | "newer"): HTMLElement | null {
   let sib = (dir === "older" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null
   while (sib && !sib.classList.contains("srr-row")) {
      sib = (dir === "older" ? sib.nextElementSibling : sib.previousElementSibling) as HTMLElement | null
   }
   return sib
}

// Roving tabindex: keep exactly ONE row in the Tab order — the selected
// (.srr-row-current) row, or the first row when nothing is selected yet — so Tab
// lands on the cursor and then leaves the list, rather than stepping through every
// article. A/←·D/→ (moveSelection) move the cursor between rows; .focus() still
// works on the off-tab-order rows since tabindex -1 is programmatically focusable.
let lastTabbable: HTMLElement | null = null
function syncRovingTab(): void {
   if (!rowsEl) return
   const tabbable =
      rowsEl.querySelector<HTMLElement>("a.srr-row.srr-row-current") ?? rowsEl.querySelector<HTMLElement>("a.srr-row")
   if (tabbable === lastTabbable) return
   // Flip only the two affected rows — every row is born tabIndex -1 (rowEl),
   // so the previous tabbable is the one stray to clear. A rebuild replaces
   // the rows wholesale; the disconnected old ref is simply dropped (no reset
   // hook needed in every rebuild path).
   if (lastTabbable?.isConnected) lastTabbable.tabIndex = -1
   if (tabbable) tabbable.tabIndex = 0
   lastTabbable = tabbable
}

// Make `row` the cursor: move the highlight, sync nav.pos (so the selection IS
// the reader's "current article"), and scroll it into view. notifyScroll resyncs
// the gesture toolbar baseline so the programmatic scroll doesn't read as a
// downward swipe and hide the toolbar (same contract as render/fetchNewer).
function selectRow(row: HTMLElement): void {
   if (!rowsEl) return
   // Clear any pending deferred-select marker left by a prior selectRow call
   // (regardless of whether that skeleton is still .srr-row-current).
   rowsEl.querySelector("[data-select-pending]")?.removeAttribute("data-select-pending")
   rowsEl.querySelector(".srr-row-current")?.classList.remove("srr-row-current")
   row.classList.add("srr-row-current")
   syncRovingTab() // the cursor moved — it is now the one tabbable row
   // Move DOM focus to the row anchor so the keyboard selection is announced to
   // screen readers and the focus ring tracks the cursor; preventScroll leaves
   // positioning to scrollRowIntoView below (the visual highlight alone never
   // moves focus, so the cursor was invisible to assistive tech).
   row.focus({ preventScroll: true })
   // Skeleton rows have no dataset.feed yet — Number(undefined) = NaN which
   // poisons nav.currentFeed and breaks anchorChron().  Defer nav.select until
   // fillRow stamps the feed; mark the row so fillRow knows to pick it up.
   if (row.dataset.feed !== undefined) {
      nav.select(Number(row.dataset.chron), Number(row.dataset.feed))
   } else {
      row.dataset.selectPending = "1"
   }
   scrollRowIntoView(row)
   notifyScroll()
}

// The topmost row at least partly below the top chrome (sticky search bar + day
// divider) — where the cursor lands when none is set yet, so it appears where
// you're looking rather than at a fixed end, and clear of the divider like every
// scrolled-to row. Falls back to the last (oldest) row when geometry is
// unavailable (jsdom reports zero rects).
function firstVisibleRow(): HTMLElement | null {
   if (!rowsEl) return null
   const top = topInset()
   const rows = rowsEl.querySelectorAll<HTMLElement>("a.srr-row")
   for (const r of rows) if (r.getBoundingClientRect().bottom > top + 1) return r
   return (rows[rows.length - 1] as HTMLElement | undefined) ?? null
}

// True when a same-day row sits directly above `row` (its previous sibling is a
// row, not the day divider) and is clipped by the pinned divider — straddling the
// divider's bottom edge at `inset`. Its empty lower edge would otherwise show as a
// gap above the selection, so scrollRowIntoView snaps flush past it. First-of-day
// rows (previous sibling IS the divider) have no same-day neighbour → false.
function clippedAbove(row: HTMLElement, inset: number): boolean {
   const prev = row.previousElementSibling as HTMLElement | null
   if (!prev || !prev.classList.contains("srr-row")) return false
   const r = prev.getBoundingClientRect()
   return r.top < inset && r.bottom > inset
}

// Bring the selected row fully into the live band — below the sticky search bar +
// day divider (top) and ABOVE the toolbar fixed to the bottom of the viewport —
// but only when it isn't already there (a keyboard step shouldn't recenter on
// every press, unlike the return-from-reader centering). Without the bottom inset
// a row stepped downward parks flush against the viewport bottom, hidden behind
// the toolbar (which selectRow's notifyScroll always reveals). sc.to
// clamps to [0, maxScroll].
//
// Both ends land the row FLUSH against the chrome (no inner margin): the row's own
// padding already separates its text from the divider/toolbar, and a top margin
// would reveal a clipped same-day row above (clippedAbove) as a gap. The
// clippedAbove probe is short-circuited — only measured when the row isn't already
// behind the top inset.
function scrollRowIntoView(row: HTMLElement): void {
   const rect = row.getBoundingClientRect()
   const top = topInset()
   const bottom = sc.viewportH() - toolbarInset()
   const margin = 8 // snap tolerance: how close to the chrome before re-aligning flush
   if (rect.top < top + margin || clippedAbove(row, top)) sc.to(Math.max(0, sc.y() + rect.top - top))
   else if (rect.bottom > bottom - margin) sc.to(sc.y() + rect.bottom - bottom)
}

// Height the bottom-fixed toolbar occupies OVER THE LIST. selectRow reveals it
// after every move (notifyScroll), so its full rendered height is reserved
// unconditionally of the current slide state — offsetHeight ignores the slide
// transform and reads 0 only when the toolbar is display:none (no list surface).
// Under split it covers nothing here: the bar starts at the pane's right edge
// (styles.css), so reserving its height would stop the pane's keyboard stepping
// a bar-height short of the bottom against chrome that isn't there — the same
// phantom reserve the pane's own padding-bottom shed.
function toolbarInset(): number {
   if (isSplit()) return 0
   const bar = document.querySelector<HTMLElement>(".srr-toolbar")
   return bar ? bar.offsetHeight : 0
}

// ── test seams (jsdom drives module-private DOM state) ───────────────────────
export function __setRowsForTest(rows: HTMLElement | null): void {
   rowsEl = rows
}
export function __relabelDividersForTest(): void {
   relabelDividers()
}
