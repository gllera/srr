// app.ts — the orchestrator: the surface router (list ⇄ reader), the single
// navigation mutex every async action runs through, the error popup and the
// transient snackbar, the unread badge / document.title readout, the keyboard
// map, the boot wiring, and the service-worker registration.
//
// The four controllers it wires — reader.ts (the article surface), pin-ui.ts (the
// offline-pin + SW message protocol), search-ui.ts (title search) and menus.ts
// (the settings + frontier menus) — never import this module. Whatever they need
// from here arrives through their setup() deps or as explicit arguments, which is
// what keeps the module graph acyclic; the shared DOM reference map lives in the
// leaf els.ts for the same reason.
import * as data from "./data"
import { showShortcutsDialog, wrapTabFocus } from "./dropdown"
import { el } from "./els"
import { registerEffects, type Effects } from "./effects"
import { collapseBrokenMedia, countBadge, handleFragmentClick } from "./fmt"
import { setupGestures, type Gestures } from "./gestures"
import { HASH_KEY, UNREAD_ONLY_KEY } from "./keys"
import * as lightbox from "./lightbox"
import * as list from "./list"
import * as menus from "./menus"
import * as model from "./model"
import * as nav from "./nav"
import * as pager from "./pager"
import { initLayout, layout } from "./layout"
import { initPane, togglePane } from "./pane"
import * as picker from "./picker"
import * as pinUI from "./pin-ui"
import * as player from "./player"
import * as reader from "./reader"
import * as refresh from "./refresh"
import { ensureSchema } from "./schema"
import { elementScroller, windowScroller } from "./scroller"
import * as searchUI from "./search-ui"
import { initSplit, isSplit, onSplitChange } from "./split"
import { effect, onChange } from "./signals"
import { lsSet } from "./storage"
import * as sync from "./sync"

// Which surface has the KEYBOARD is model.focus, written by showList /
// showReader below, and once directly by init() to seed the reader-boot
// chrome before the layout's first paint. Every visibility question reads
// layout.ts's record; the record's focus field is read at exactly the sites
// docs/ARCHITECTURE.md lists under "The layout record". (The filter picker
// is an overlay, not a surface: picker.isOpen() gates input while it is up.)
// Set once gestures are wired; the list calls it after a programmatic scroll so
// the toolbar-hide baseline stays in sync (declared up here so list.setup, wired
// before setupGestures runs, can close over it).
let gestures: Gestures | null = null
// The derived-paint effects table (effects.ts), captured so guard() can tell it
// which chrome its own render just painted (markChromePainted, D3).
let effects: Effects | null = null
// The single navigation mutex. Every reader action runs through guard()/guardBg()
// so a store swap can't interleave with a render. It self-heals: a mutex held far
// past any bounded operation (every store fetch is abort-timed at 30s in data.ts)
// means a wedged await that never settled, so it is treated as free rather than
// no-opping every swipe/arrow/button until the page is reloaded — the reported
// "swipe stops working until refresh". busyToken makes release() ownership-guarded
// so a stale owner that finally settles after being reclaimed can't clear the lock
// a newer holder now owns.
let busy = false
let busyToken = 0
let busyAt = 0
// INVARIANT (ENG7): this must stay comfortably ABOVE data.ts's FETCH_TIMEOUT_MS
// (30s), the abort budget every store fetch is armed with. That is the whole
// reason 60s is safe to treat as "stale": the longest bounded thing a mutex
// holder can be waiting on is a store fetch, so a hold older than this cannot be
// live work — it is a wedged await. Raising FETCH_TIMEOUT_MS without raising
// this would make a slow-but-honest fetch look dead and let a second caller
// reclaim the mutex underneath it. Documented rather than derived
// (`2 * data.FETCH_TIMEOUT_MS`) on purpose: app.test.ts replaces the whole
// ./data module with a mock factory, so a derived value would read undefined
// there and quietly disable the mutex in every test. Appendix D of the findings
// puts it as "document, don't narrow".
const BUSY_STUCK_MS = 60_000
// Held by a LIVE owner? A stale hold (past BUSY_STUCK_MS) reads as free so the
// next caller reclaims it. Shared by acquire() and the pre-mutation bail-outs
// (goToList/selectFilter) so every busy check agrees on staleness.
function held(): boolean {
   return busy && Date.now() - busyAt < BUSY_STUCK_MS
}
// Take the mutex (reclaiming a stale one), returning an ownership token — or null
// when a live owner holds it and the caller must skip.
function acquire(): number | null {
   if (held()) return null
   // Reclaiming a STALE mutex (busy, but past BUSY_STUCK_MS): the wedged
   // owner's rendering holds will never be released, so drop them — every hold
   // taken before the mutex went stale. A hold taken since is live: the list
   // commands (route, selectTokens, selectFilter, switchMount) take their outer
   // hold BEFORE acquiring, and dropping it would flip rendering false in the
   // middle of the reclaiming command. model.rendering is re-derived here too,
   // not left to the caller's begin/endRendering pair: guardBg() takes no hold,
   // so a reclaim it performs would otherwise leave rendering latched true.
   if (busy) {
      const staleSince = busyAt + BUSY_STUCK_MS
      for (const [hold, at] of renderingHolds) if (at < staleSince) renderingHolds.delete(hold)
      if (renderingHolds.size === 0) model.rendering.set(false)
   }
   busy = true
   busyAt = Date.now()
   return ++busyToken
}
function release(token: number): void {
   if (token === busyToken) busy = false
}
// model.rendering is held while a command that ends in a surface paint is in
// flight (D3, S16): guard()'s landing, and the list commands that write the lane
// (or the store) BEFORE their own list render — without the hold, the
// listSurface effect would rebuild the list inside applyFilter and the command
// would rebuild it again a moment later. One TOKEN per hold rather than a depth
// count: those commands nest (selectTokens' pane follow-up is a guard()), so an
// inner release must not drop the outer hold — and a command wedged past
// BUSY_STUCK_MS never reaches its finally, so acquire()'s stale reclaim clears
// every hold taken before the mutex went stale. A depth count could only leak
// there, stranding `rendering` true and silencing every effect that waits it
// out (the self-heal the Layout plan's render generation gave guard(), L20,
// kept for every holder).
const renderingHolds = new Map<symbol, number>() // hold → Date.now() when taken
function beginRendering(): symbol {
   const hold = Symbol("rendering")
   renderingHolds.set(hold, Date.now())
   model.rendering.set(true)
   return hold
}
function endRendering(hold: symbol): void {
   renderingHolds.delete(hold)
   if (renderingHolds.size === 0) model.rendering.set(false)
}
// Freshness token for the list's async cycle: each W/S press bumps it, and only
// the LATEST press applies its resolved token, so rapid presses can't land out
// of order off a stale cycleOriginKey. A token, not a held flag — a cycleToken()
// that never settles must not permanently latch cycling off.
let listCycleGen = 0
let retryFn: (() => void) | null = null
let previousFocus: HTMLElement | null = null

function showReader() {
   model.focus.set("reader")
   picker.close()
}

// Landing a pane on a lane it did not navigate to: don't consume unread, and
// don't leave a history entry — the user's own act was the pick, not this
// follow-up. Named because the two call sites below used to spell it as the
// same two booleans in opposite orders (nav.last(true,false) beside
// nav.goTo(anchor,false,true)) and read as two different intentions.
const RESUME: nav.Landing = { record: false, replace: true }

function showList() {
   model.focus.set("list")
   picker.close()
}

// The ONE door to "put this article on the reader surface", shared by the row
// tap (list.setup) and enterReader below — two affordances for a single act,
// which under split answer it differently unless they share a body.
//
// Split view: the reader never left. When the pane is ALREADY mounted on the
// article being asked for, "opening" it is a focus change and nothing more —
// re-rendering would tear down the mounted DOM and scroll it back to its top,
// so glancing at the list and coming back (Escape, Escape), or clicking the row
// the pane is already showing, threw away your place in a long article that had
// been on screen the whole time. The test is the MOUNTED chron AND the cursor:
// the list moves that cursor too, so landing somewhere new — or on an article
// the pane holds but nav has since left behind — is a real navigation that must
// still render.
//
// The HASH still moves. It is the URL you would copy and the key a reload
// restores from, and a focus-only re-entry that skipped it left both naming the
// LIST: Escape, Escape, reload landed you on an empty resting pane instead of
// the article that had been on screen throughout, and a copied link shared the
// lane rather than what you were reading. pushState, not replace, mirroring
// nav.goTo — goToList pushed on the way out, so back still steps the pair.
function openArticle(chron: number): Promise<void> {
   if (isSplit() && chron >= 0 && nav.currentChron() === chron && reader.mountedArticle()?.chron === chron) {
      nav.publishHash()
      persistHash(location.hash)
      showReader()
      return Promise.resolve()
   }
   return guard(() => nav.goTo(chron))
}

// The shared "go to the article surface" resolver, reused by every → reader
// transition (Escape from the list, the open-article toolbar button). Opens the
// reader at the current reader/selected article when there is one, else the
// filter's oldest-unseen article (start of the backlog), else its newest.
async function enterReader() {
   const chron = nav.currentChron()
   if (chron >= 0) return openArticle(chron)
   const anchor = await nav.listAnchor() // oldest unseen, else -1 (newest)
   return anchor >= 0 ? guard(() => nav.goTo(anchor)) : guard(() => nav.last())
}

function persistHash(hash: string) {
   lsSet(HASH_KEY, hash)
}

function showError(e: unknown, retry?: () => void) {
   el.popupText.textContent = e instanceof Error ? e.message : String(e)
   retryFn = retry ?? null
   el.popupRetry.classList.toggle("srr-hidden", !retry)
   previousFocus = document.activeElement as HTMLElement
   el.popup.classList.add("srr-open")
   ;(retry ? el.popupRetry : el.popupClose).focus()
}

function closePopup() {
   el.popup.classList.remove("srr-open")
   previousFocus?.focus()
}

// The transient snackbar: one line about something that already happened, with
// at most one way to answer it. Unlike showError's dialog it takes no focus and
// blocks nothing — a notice you may ignore must not interrupt reading.
// Auto-dismissing, because an offer that outlives its moment is just clutter;
// the action is a shortcut, never the only way to get somewhere.
const SNACKBAR_MS = 8000
let snackbarTimer: ReturnType<typeof setTimeout> | undefined
let snackbarAction: (() => void) | null = null

function showSnackbar(text: string, action?: { label: string; run: () => void }) {
   clearTimeout(snackbarTimer)
   el.snackbarText.textContent = text
   snackbarAction = action?.run ?? null
   el.snackbarAction.textContent = action?.label ?? ""
   el.snackbarAction.classList.toggle("srr-hidden", !action)
   el.snackbar.hidden = false
   snackbarTimer = setTimeout(hideSnackbar, SNACKBAR_MS)
}

function hideSnackbar() {
   clearTimeout(snackbarTimer)
   el.snackbar.hidden = true
   snackbarAction = null
}

async function guard(fn: () => Promise<IShowFeed>) {
   const token = acquire()
   if (token === null) return
   const hold = beginRendering()
   // Two veil classes, one progress bar: `srr-loading` is the shared top-edge
   // bar, `srr-loading-reader` additionally dims the ARTICLE — which only this
   // path may do. renderListSurface takes the first alone, because under split
   // its list render happens beside a reader that is not loading at all.
   document.body.classList.add("srr-loading", "srr-loading-reader")
   try {
      const o = await fn()
      // If this op was reclaimed as stale mid-flight (see acquire), a newer holder
      // now owns the surface — don't paint our stale result / error over it.
      if (token === busyToken) {
         reader.render(o)
         // The chrome render just painted is current for these inputs (D3).
         effects?.markChromePainted()
      }
   } catch (e) {
      // A landing the active store switched under committed nothing (nav refuses
      // it): nothing failed that a retry could fix, and the switch routes itself.
      if (token === busyToken && !nav.isStaleLanding(e)) showError(e, () => guard(fn))
   } finally {
      if (token === busyToken) document.body.classList.remove("srr-loading", "srr-loading-reader")
      // endRendering flushes the deferred paints; whatever one of them throws,
      // the mutex is released.
      try {
         endRendering(hold)
      } finally {
         release(token)
      }
   }
}

// The background variant of guard(): same busy mutex, no render/error popup — a
// caller that loses the race is skipped, not queued (its next trigger retries).
// Used by the store refresh so a state swap can't interleave with navigation.
async function guardBg(fn: () => Promise<void>): Promise<boolean> {
   const token = acquire()
   if (token === null) return false
   try {
      await fn()
      return true
   } finally {
      release(token)
   }
}

// The lane-change follow-up for the READER surface, the twin of selectTokens'.
// A pick (or a cycle) made while the reader holds focus goes through
// nav.switchFilter, which answers a lane you have never opened with its "not
// started" placeholder. On the phone that placeholder IS the surface and reads
// correctly. Under split it blanks two thirds of the window beside a list that
// has just built the new lane and highlighted its first unread — and the
// identical pick made while the LIST holds focus lands the pane on that article.
// `focus` is only which surface the keyboard drives here, and nothing on screen
// says which one that is, so one control must not answer two ways.
//
// record: FALSE, exactly as selectTokens' landing — a lane change must not
// consume an unread article. replace: TRUE — switchFilter already wrote the
// lane's entry, and a second would make the first browser-back a visual no-op.
// A caught-up or empty lane answers -1 and is LEFT on its placeholder: "All
// caught up" is the right answer there, and falling back to the newest would
// open something already read.
//
// `hadArticle` is the pane's state BEFORE the switch, and it is what keeps this
// the mirror of selectTokens rather than its opposite: a pane that was already
// RESTING is left resting there ("a pick is not a reason to start reading
// something"), so a pick that merely moves the keyboard focus must not be the
// one thing that starts it.
async function landPaneOnLane(hadArticle: boolean): Promise<void> {
   if (!isSplit() || !hadArticle || reader.hasArticle()) return
   const anchor = await nav.listAnchor()
   if (anchor >= 0) await guard(() => nav.goTo(anchor, RESUME))
}

// Every lane change made from the READER surface — the picker's pick, the W/S
// keymap, the two-finger cycle — is this switch plus that follow-up.
async function laneChange(fn: () => Promise<IShowFeed>): Promise<void> {
   const hadArticle = reader.hasArticle()
   await guard(fn)
   await landPaneOnLane(hadArticle)
}

// Re-resolve a reader PLACEHOLDER after its lane's bounds or mode shifted (a
// frontier gesture, a Show-read flip). A real article needs nothing here — the
// readerChrome effect re-derives its arrows and pill. A placeholder (pos < 0)
// has no article to probe, so the lane switch runs again, but ONLY for a
// single-token/[ALL] filter: getCurrentFilterKey() collapses a multi-token
// (URL-only, e.g. #!5+9) filter to "", which switchFilter("") would misread as
// [ALL] and teleport the reader off its lane. A command, never an effect (S17).
function rerunPlaceholder() {
   // "The reader needs re-deriving" is a LAYOUT question under split: the pane
   // is on screen with its arrows and pending pill live even while the LIST has
   // focus, so a frontier gesture or a Show-read flip made from there left both
   // stale — a next-count that no longer matched the lane, arrows armed against
   // bounds that had moved.
   if (!layout().readerSteppable) return
   if (nav.currentChron() >= 0) return
   if (nav.isFilterActive() && nav.filterTokens().length > 1) return
   void guard(() => nav.switchFilter(nav.getCurrentFilterKey()))
}

// Toggle the current article's saved state from the reader. A local state flip
// (localStorage + the button), not a navigation — it stays off the guard mutex.
function toggleSave() {
   const chron = nav.currentChron()
   if (chron < 0) return
   nav.toggleSaved(chron)
}

// RDR12 — the unread total, surfaced where an installed app is actually looked
// at: the launcher badge and the tab title.
//
// The tally already exists (it is what fills every picker badge); nothing was
// reading it outside the app's own chrome, so an installed SRR gave no sign that
// anything had arrived until you opened it. Scope is the ACTIVE store's [ALL] —
// the same thing the picker's [ALL] row counts, so the two can never disagree.
let unreadTotal = -1
let titleBase = "SRR"

// The single writer of document.title, so the count and the surface's own name
// can never get out of step. The count LEADS: a tab title is truncated from the
// right, and a number nobody can see is not a notification.
function setTitle(base: string): void {
   titleBase = base
   document.title = unreadTotal > 0 ? `(${countBadge(unreadTotal)}) ${base}` : base
}

// The titleAndBadge effect's writer. The -1 seed above makes the FIRST total
// always write through: an app badge outlives the session that set it, so a
// launch that finds everything read is exactly when clearAppBadge must run.
function applyUnreadTotal(total: number): void {
   if (total === unreadTotal) return
   unreadTotal = total
   setTitle(titleBase)
   // Feature-detected on both sides: no Badging API (Firefox, iOS Safari) just
   // leaves the title readout, and a rejection is not worth telling anyone about.
   const badging = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
   }
   void (async () => {
      try {
         if (total > 0) await badging.setAppBadge?.(total)
         else await badging.clearAppBadge?.()
      } catch {
         // An unsupported badge call must never surface as an error.
      }
   })()
}

// The active store's [ALL] unread — the same tally the picker's [ALL] row shows.
async function unreadTotalOfActiveStore(): Promise<number> {
   const feeds = Object.values(data.db?.feeds ?? {})
   return feeds.length ? nav.tagUnreadFromCounts(feeds, await nav.unreadCounts(feeds)) : 0
}

function listTitle(): string {
   if (nav.isSearchFilter()) {
      const q = nav.searchQuery()
      // A scoped query (RDR8) names its lane here too — the tab title is the one
      // readout that survives the tab being in the background.
      const scope = nav.searchScope()
      const lane = scope ? " in " + nav.filterLabel(scope) : ""
      return (q ? `SRR · Search: ${q}` : "SRR · Search") + lane
   }
   const key = nav.getCurrentFilterKey()
   if (key === "") return "SRR"
   return "SRR · " + nav.filterLabel(key)
}

// Show the list surface and (re)render it under the current filter. Shares the
// guard() busy flag so it can't overlap an in-flight article load; on error,
// the popup's Retry re-runs it.
async function renderListSurface() {
   const token = acquire()
   if (token === null) return
   const hold = beginRendering()
   // The list centers + highlights its anchor (the article you were reading /
   // the lane's resume position) on every arrival. Returning FROM THE READER
   // (back button, browser-back) commits that scroll immediately — the seed's
   // pack is warm from the article on screen; a filter change / boot arrival
   // (focus was already on the list) takes the settle-then-land-once path
   // instead. Captured before showList() moves focus to the list.
   const anchorNow = layout().focus === "reader"
   showList()
   document.body.classList.add("srr-loading")
   // Release busy + the loading veil at FIRST PAINT (skeletons / first matches),
   // not when the whole list finishes streaming — so rows are tappable while the
   // rest fills in. The finally only resets busy if first paint never happened
   // (an error before onInteractive), so a reader-open that grabs busy during the
   // fill window is not stomped when show() finally resolves.
   let interactive = false
   const onInteractive = () => {
      if (interactive) return
      interactive = true
      try {
         endRendering(hold)
      } finally {
         if (token === busyToken) document.body.classList.remove("srr-loading")
         release(token)
      }
   }
   try {
      await list.show(anchorNow, onInteractive)
   } catch (e) {
      showError(e, () => void renderListSurface())
   } finally {
      // onInteractive is idempotent (its own `interactive` latch), so the
      // never-painted case is just "call it now" rather than a second copy of
      // the release path guarded by the same condition.
      onInteractive()
      searchUI.syncSearchBar()
   }
}

// The re-layout every pane geometry change ends with — the grip's settle, the
// toolbar's toggle button, and the `L` key. It is the TAIL of the breakpoint
// handler and nothing more: a resize or a hide crosses no breakpoint, so the
// scroller, the surface visibility and the cursor ownership are all already
// correct — only the list's measured row heights are stale, because rows re-wrap
// at a new width.
//
// ONE body, because a second copy of a re-layout tail drifts: its callers differ
// in what they have already established (the `L` key is gated on isSplit before
// it gets here, initPane's onSettle is not), and that difference is exactly what
// a hand-copied version quietly loses.
function relayoutPane(): void {
   list.invalidate()
   if (layout().focus === "reader") {
      // followCursor rebuilds the PANE beside the article; off split there is no
      // pane to rebuild and the reader owns the whole window.
      if (isSplit()) list.followCursor()
   } else void renderListSurface()
}

// Commit the LIST surface's hash (`#!tokens`, no position) into history AND the
// reload-restore key in ONE act — the two must always name the same thing, or a
// reload lands somewhere the URL never showed (the desync class openArticle's
// comment documents). Every list-hash writer routes through here; search-ui
// gets it as a dep.
function commitListHash(push: boolean): void {
   const h = "#" + nav.tokensSuffix()
   history[push ? "pushState" : "replaceState"](null, "", h)
   persistHash(h)
}

// Does this hash route to the READER surface? A numeric position does (a deep
// link or a restored reading position); anything else — empty, or `!tokens` —
// is the list at that filter.
function routesToReader(hash: string): boolean {
   const pos = nav.hashPos(hash)
   return pos !== "" && nav.isPosInt(pos)
}

// The hash the first route() takes. Foreign hashes (OAuth implicit-flow tokens
// an auth provider in front of the app injected — Cloudflare Access
// JWT-in-fragment, OIDC, …) are dropped so the page lands on the user's last
// position instead of the latest article; SRR hashes are `[integer][!tokens]`
// or `!tokens`. An empty hash restores the stored one.
function bootHash(): string {
   let hash = location.hash.substring(1)
   const posPart = nav.hashPos(hash)
   if (posPart && !nav.isPosInt(posPart)) {
      history.replaceState(null, "", location.pathname + location.search)
      hash = ""
   }
   if (!hash)
      try {
         hash = localStorage.getItem(HASH_KEY)?.substring(1) || ""
      } catch {}
   return hash
}

// Hash → surface. A numeric position routes to the reader (deep-link or restored
// reading position); anything else (empty, or just `!tokens`) is the list at
// that filter.
async function route(hash: string) {
   // The lightbox is a modal over the reader, so nothing in the UI can navigate
   // while it is up — but the BROWSER's back/forward can, and an enlarged image
   // left hanging over a different article is a lie. Every routed change closes
   // it (a no-op when it isn't open), which also hands focus back before the
   // article it belongs to is replaced.
   lightbox.close()
   // A URL-driven filter change (hashchange / back-forward) also supersedes any
   // pending debounced query — see selectFilter.
   searchUI.clearSearchDebounce()
   if (routesToReader(hash)) {
      await guard(() => nav.fromHash(hash))
      // Split view: deliberately no list call here — model.cursor moved inside
      // guard(), and the listRows effect (effects.ts) calls followListCursor at
      // endRendering, whose not-yet-built fallback is show(true), so a deep
      // link/restore already builds the list pane beside the article.
      return
   }
   // The list hash carries the mount too (§6.3) — extract it and switch the
   // active lane before applying the (bare) filter tokens, mirroring
   // nav.fromHash's reader path. setActive fails softly for an unmounted/errored
   // mount, resolving against the current lane rather than blanking (MS4).
   const { mid, tokens } = nav.parseHashMount(nav.parseHashTokens(hash))
   // Held across the store + lane writes until renderListSurface takes its own
   // hold (synchronously, before its first await) — S16.
   let listed: Promise<void>
   const hold = beginRendering()
   try {
      if (mid !== data.activeStore().mid) data.setActive(mid)
      nav.applyFilter(tokens)
      // Canonicalize the URL (boot may restore an empty location.hash from
      // localStorage) without growing history.
      commitListHash(false)
      listed = renderListSurface()
   } finally {
      endRendering(hold)
   }
   await listed
}

// Return to the list from the reader (back button / two-finger cycle / filter
// pick). pushState so browser-back from the reader still works; the list
// re-centers on the article you were reading (see renderListSurface).
async function goToList(push: boolean) {
   // Bail BEFORE mutating history/localStorage: renderListSurface also checks
   // the mutex, but the pushState/persistHash below would already have rewritten
   // the URL to a filter the dropped render never painted, desyncing URL from view.
   if (held()) return
   commitListHash(push)
   await renderListSurface()
}

// Apply an explicit token LIST and land on the list. The multi-token front door,
// which search-ui needs for a scoped query (RDR8: `q:<query>` + one lane token);
// selectFilter below is the single-token one every picker row and cycle uses,
// and it resolves a mount-qualified token before coming through here. Tokens
// arriving this way are already in the active store's context (nav hands them
// back bare — the mount rides in tokensSuffix), so there is no `@mid:` to strip.
async function selectTokens(tokens: string[], paneLive = layout().readerLive) {
   // Bail BEFORE applyFilter/goToList: goToList drops on a held mutex, but
   // applyFilter would already have mutated nav.filter (and goToList's pushState
   // the URL) for a render that never ran. Dropping the whole handler keeps
   // filter+URL+view consistent — same mutex discipline as guard() for reader actions.
   if (held()) return
   // Any explicit filter change cancels a still-pending debounced search query;
   // otherwise typing then leaving search (✕ / Escape / the magnifier, but also a
   // feed-menu pick or a two-finger/arrow cycle, which all land here) within
   // the debounce window lets the stale applySearchQuery fire ~200ms later and
   // bounce the list back into search. Typing itself never routes through here.
   searchUI.clearSearchDebounce()
   const beforeChron = nav.currentChron()
   let listed: Promise<void>
   const hold = beginRendering() // S16: until renderListSurface holds on its own
   try {
      nav.applyFilter(tokens)
      listed = goToList(true)
   } finally {
      endRendering(hold)
   }
   await listed
   // Split view (paneLive — read when the command started): the reader pane never left, so the article on screen may not
   // belong to the lane just picked — and the still-live toolbar arrows would
   // then step from a position nothing on screen names. Ask the SAME question
   // the list just asked (nav.listAnchor: the live article while it still
   // matches, else the lane's oldest unread, else -1 = newest) and land the pane
   // on that answer, so both panes name one article. An unchanged answer means
   // the article is still a member: no re-render, no scroll back to its top.
   //
   // record: FALSE. A mere lane switch must not consume an unread article —
   // nav.switchFilter passes record = false at every one of its landings for
   // exactly that reason, and the READER-surface path through the picker IS
   // switchFilter, so recording here would make one pick mean two different
   // things depending on which surface had focus. On the phone none of this
   // runs: the reader is hidden and re-derives on its next open. A pane that is
   // RESTING is left resting — the restingPane effect repaints its panel for the new lane; a
   // pick is not a reason to start reading something.
   //
   // SEARCH is exempt, and not as a special case: a query is a LIST presentation
   // mode (nav.listAnchor answers -1 = newest-first for it, which is a statement
   // about row order, not a landing), and it is typed WHILE reading. Following it
   // would yank the pane onto the newest hit at every keystroke — and onto the
   // no-match placeholder the moment the bar opens empty.
   if (paneLive && !nav.isSearchFilter()) {
      const anchor = await nav.listAnchor()
      // replace, not push: goToList already pushed this filter change, and a
      // second entry would make the first browser-back a visual no-op.
      // beforeChron < 0 with a live pane means a store switch cleared the cursor
      // (selectFilter's peer pick): the pane's article belongs to the store just
      // left, so even a newest (-1) answer is a landing.
      if (anchor !== beforeChron || beforeChron < 0) {
         await guard(() => (anchor < 0 ? nav.last(RESUME) : nav.goTo(anchor, RESUME)))
         // The follow-up is the PANE catching up with a pick made on the list —
         // it must not be mistaken for going to the reader. Two things do
         // mistake it: guard()'s render path calls showReader(), and the landing
         // rewrites the `#!tokens` entry goToList just pushed into a reader
         // `#pos!tokens`. Left alone, picking a lane from the list moved focus
         // into the article and made a reload open it, against both this
         // surface's contract ("you land back on the headlines under the new
         // lane") and the resting pane's. Put both back — showList() is
         // idempotent and keeps the pane's article on screen.
         showList()
         commitListHash(false)
      }
   }
}

async function selectFilter(token: string) {
   if (held()) return
   searchUI.clearSearchDebounce()
   // Read BEFORE the mount token resolves: a peer pick switches the store, which
   // clears the cursor, and a pane that was showing an article must still land.
   const paneLive = layout().readerLive
   // A mount-qualified token (a peer lane picked from the picker) switches the
   // active lane and resolves to its bare half — nav owns that grammar (§6.3).
   let selected: Promise<void>
   const hold = beginRendering() // S16: the store switch is a write the list must not react to alone
   try {
      token = nav.resolveMountToken(token)
      selected = selectTokens(token === "" ? [] : [token], paneLive)
   } finally {
      endRendering(hold)
   }
   await selected
}

// Switch the active mount from the picker's mount switcher WITHOUT closing the
// overlay (§6.3): re-point the active lane to that store's [ALL], rebuild the
// list underneath, and re-render the picker's lanes in place for the new store.
// A failed/unmounted mount (setActive returns false) is a no-op.
async function switchMount(mid: string) {
   if (held()) return
   if (mid === data.activeStore().mid) return
   let listed: Promise<void> | null = null
   const hold = beginRendering() // S16
   try {
      if (data.setActive(mid)) {
         nav.applyFilter([])
         commitListHash(true)
         listed = renderListSurface()
      }
   } finally {
      endRendering(hold)
   }
   // The picker's rows for the new store are the pickerRows effect's.
   if (listed) await listed
}

// The unread (catch-up) toggle — the picker header's "Show read" button. The
// flip is a write (model.unreadOnly, nav's); the list, the reader's chrome, the
// badge and the open picker follow it. A reader PLACEHOLDER is the one thing an
// effect cannot re-derive — it takes a lane switch.
function toggleUnseenOnly() {
   nav.setUnreadOnly(!nav.isUnreadOnly())
   rerunPlaceholder()
}

// Two-finger vertical swipe = step the filter. In the reader, cycle to the next
// filter's article; on the list, re-filter the list to the next entry.
function onCycle(dir: number) {
   // The two-finger cycle gesture must not re-filter the list that sits under
   // the open picker overlay (same input-leak class as the keyboard and
   // one-finger-swipe guards) — nor under the open image lightbox, which is a
   // modal over the reader and owns every input while it is up.
   if (picker.isOpen() || lightbox.isOpen()) return
   if (nav.getFilterEntries().length <= 1) return
   // cycleToken steps relative to cycleOriginKey (a single tagged-feed filter
   // cycles by its tag) and skips ★ Saved / empty-of-unread lanes, so the list and
   // the reader share one rotation. Async (unread is idx-derived): the list resolves
   // the token then re-filters in place; the reader's cycleFilter awaits it inside.
   if (layout().focus === "list") {
      // Only the latest press applies its resolved token (a stale one — from a
      // press superseded before its cycleToken resolved — is discarded), so
      // rapid presses can't land out of order; selectFilter's own busy guard
      // serializes the apply. A freshness token rather than a held flag: a
      // never-settling cycleToken() then can't latch cycling off for the session.
      const gen = ++listCycleGen
      void nav.cycleToken(dir).then((tok) => {
         if (gen === listCycleGen) void selectFilter(tok)
      })
   } else void laneChange(() => nav.cycleFilter(dir))
}

// Each step/cycle key has an arrow + letter alias; define the action once and
// point both keys at it. step toward a dead edge rings the reader margin bell;
// cycle is a no-op when the filter rotation has a single entry.
// stepLeft/stepRight back the reader KEYMAP alone (ArrowLeft/a, ArrowRight/d) —
// touch prev/next is the pager's and commits through pagerCommit below, and the
// toolbar's prev/next buttons have their own listeners (they are `disabled` at a
// dead edge, so they never need the bell). They act only on the reader surface.
// The picker overlay can be open OVER the reader (via the reader's filter
// button, focus stays on the reader), so a key pressed under it must be inert too —
// a bare focus check no longer covers it now that the picker isn't list-only.
// Gating on the record's readerSteppable additionally makes them a clean no-op on
// a list with no live pane beside it.
// The image lightbox is the same class of overlay: it covers the reader while a
// content image is enlarged, so it must not step the article behind. (Its key
// input is already swallowed at the capture phase — lightbox.ts onKey — so that
// flag is belt to this brace; pagerCommit mirrors both guards for the drag.)
// "The reader is steppable" is a LAYOUT question under split, where the pane is
// live beside the list and its prev/next buttons stay enabled on both surfaces:
// a key must reach the same article the button beside it does, or ← / → go dead
// on the list surface while the arrows a centimetre away still work.
// A modal over the reader (the picker, the image lightbox) owns input while up.
const overlayUp = () => picker.isOpen() || lightbox.isOpen()
const stepLeft = () => {
   if (!layout().readerSteppable || overlayUp()) return
   return el.prev.disabled ? reader.bumpReaderEdge("prev") : guard(() => nav.left())
}
const stepRight = () => {
   if (!layout().readerSteppable || overlayUp()) return
   return el.next.disabled ? reader.bumpReaderEdge("next") : guard(() => nav.right())
}
// The reader keymap's W/S — the same lane change onCycle's reader branch makes,
// so it takes the same split follow-up (laneChange).
const cycle = (dir: -1 | 1) => () => {
   if (nav.getFilterEntries().length > 1) void laneChange(() => nav.cycleFilter(dir))
}
const cyclePrev = cycle(-1)
const cycleNext = cycle(1)

// The pager's committed drag: the SAME guarded step the keyboard uses. Success
// is "the cursor moved" — resolve() commits pos only on success, guard() owns
// its own error popup, and a busy mutex returns without stepping — so an
// unchanged chron covers busy AND failure with one signal, and the pane knows
// to snap back. The overlay guards mirror stepLeft/stepRight's: a drag that
// somehow ends under the picker/lightbox must not step the reader beneath.
// The finally is NOT redundant with reader.ts consuming the flag on read: the
// consume bounds a stale "slide" to one render, this clears it when the step
// produces NO render at all (guard() skipped it on a busy mutex, or it
// rejected). Neither covers the other's case — see reader.ts entryTransition.
// Not split-relaxed, deliberately: pagerStart stands the drag down entirely
// under split (gestures.ts — an unclipped slide would cross the list pane), so
// this is only ever reached from the single-surface layout, where "reader" is
// the only view a drag can start in.
async function pagerCommit(side: "prev" | "next"): Promise<boolean> {
   if (layout().focus !== "reader" || overlayUp()) return false
   const before = nav.currentChron()
   reader.setEntryTransition("slide")
   try {
      await guard(() => (side === "prev" ? nav.left() : nav.right()))
   } finally {
      reader.setEntryTransition(null)
   }
   return nav.currentChron() !== before
}

const KEY_ACTIONS: Record<string, () => void> = {
   ArrowLeft: stepLeft,
   a: stepLeft,
   ArrowRight: stepRight,
   d: stepRight,
   ArrowUp: cyclePrev,
   w: cyclePrev,
   ArrowDown: cycleNext,
   s: cycleNext,
   q: () => guard(() => nav.first()),
   e: () => guard(() => nav.last()),
   b: () => !el.save.disabled && toggleSave(),
   // The playlist toggle's keyboard path (parity with b-for-save): the article's
   // first enclosure, via the chip's own click; no enclosure = quiet no-op.
   p: () => player.queueKey(),
   // The unread rewind's direct power-user path (its pointer home is the
   // frontier menu); markUnreadFromHere no-ops without an article / in peek modes.
   u: () => menus.markUnreadFromHere(),
   f: () => {
      if (!el.titleRow.getAttribute("href")) return
      el.titleRow.dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }),
      )
   },
}

async function init() {
   // Gate the device's stored SHAPE before anything reads it (ENG6): stamp a
   // device that has never run this build, walk the migration ladder for one on
   // an older shape. It must come first — postMounts() below derives the SW's
   // roots from the mount table, data.init() reconciles that table, and every
   // reader after them (pruneSeen, the unread-only default, the HASH_KEY restore
   // feeding route(), sync's profile merge) assumes the shape is settled. Never
   // throws, and outside the try below on purpose: a migration failure is warned
   // internally, not a boot error the popup should offer to reload past.
   ensureSchema()
   // Read once the stored shape is settled (the HASH_KEY restore is one of its
   // readers) and before the layout's first paint: a hash that routes to the
   // reader boots with the READER holding focus, so a phone restoring a reading
   // position never flashes the list's chrome while the article loads.
   const hash = bootHash()
   if (routesToReader(hash)) model.focus.set("reader")
   // Split view (two-pane desktop): learn the breakpoint, then register the
   // layout record's DOM writer at once — before data.init() — so the first
   // paint already carries body.srr-split. layout.ts is the only writer of the
   // layout's body classes and of both hosts' `hidden` from here on.
   initSplit()
   initLayout({ listView: el.listView, article: el.article })
   // The list's scroller follows the BREAKPOINT and nothing else — keyed on
   // model.split alone, never on the whole layout record, or every focus change
   // would swap the scroller and reset the toolbar's scroll baseline.
   effect(() => {
      list.setScroller(model.split() ? elementScroller(el.listView) : windowScroller())
      gestures?.resetScroll()
   })
   // Crossing INTO split the PANE owns the cursor: it keeps its article across
   // the crossing, while below the breakpoint the list legitimately claimed the
   // cursor (a search rebuild seats it on the newest hit). Re-seat it on the
   // mounted article in the crossing's OWN flush — this effect is created before
   // the derived-paint table, and effects run in creation order — so the chrome
   // and the list rows see one cursor, once.
   onChange(
      () => model.split(),
      (on) => {
         if (!on) return
         const mounted = reader.mountedArticle()
         if (mounted && nav.currentChron() !== mounted.chron) nav.select(mounted.chron, mounted.feedId)
      },
   )
   // Who owns the shared cursor when the list rebuilds (list.mayClaimCursor).
   list.setCursorOwner(() => layout().readerLive)
   // The pane's width + visibility (pane.ts), including the rail's toggle
   // button, which pane.ts wires and keeps labelled. Every committed change ends
   // in the shared re-layout tail above.
   initPane({ onSettle: relayoutPane })
   // A breakpoint crossing. The classes, both hosts, the scroller, the resting
   // pane and the cursor re-seat (above) have all re-derived by the time this
   // runs — split.ts writes the model before notifying. What is left is command
   // work: close an open picker (a crossing is a surface-changing gesture, like
   // Escape or a filter pick) and the shared re-layout tail, which rebuilds what
   // the new layout needs without re-routing (a re-route would re-render the
   // article).
   onSplitChange(() => {
      picker.close()
      relayoutPane()
   })
   // Tell the SW its mounted roots BEFORE data.init() (the PWA0 fix, §5.1): the
   // roots come from the mount TABLE (valid pre-init), so a peer store's boot
   // fetches — kicked inside data.init() — are already routed + cached by the SW
   // instead of passing through uncached. Re-posted after init (reconcile may
   // change the table) and on controllerchange.
   pinUI.postMounts()
   try {
      await data.init()
   } catch (e) {
      showError(e, () => location.reload())
      return
   }
   nav.pruneSeen()

   // First run (no stored preference) defaults to unread-only — a new reader opens
   // on just what's unread. An explicit choice persists as "1"/"0" via
   // setUnreadOnly, so a user who turns it off stays off; only a never-set key
   // (null) trips this default. Set before route() so the first render is filtered.
   try {
      if (localStorage.getItem(UNREAD_ONLY_KEY) === null) nav.setUnreadOnly(true)
   } catch {}

   // Has the person touched anything yet this session? The boot sync pull
   // re-anchors the list only BEFORE the first interaction (the device-switch
   // moment: read on the phone, then reload this tab); once you've tapped /
   // typed / scrolled, a background merge must not move anything under you.
   let hasInteracted = false
   for (const t of ["pointerdown", "keydown", "wheel", "touchstart"])
      document.addEventListener(t, () => (hasInteracted = true), { capture: true, passive: true, once: true })

   // The boot pull's re-anchor — the device-switch moment, the navigator half of
   // the sync feature: a merge that lands BEFORE the first interaction, while the
   // list is mounted with no live article beside it, re-derives the unseen bounds
   // from the new seen map and re-anchors the list at the new oldest unread. A
   // hidden split pane counts: it stays laid out, so its rebuild measures. ★ Saved
   // and search are exempt peek modes, and a boot into the READER stays gentle:
   // that position is a restored mid-article read or a shared deep link.
   //
   // AFTER the first interaction a merge moves nothing. Re-deriving the bounds
   // under an open article would strand ← (D1), and rebuilding the list would
   // yank a session in progress. Everything a merge changes — row weights, the
   // badge, the picker, the ★, the pending pill — is derived; a row another
   // device read stays in an unread-only list, greyed, until the lane is next
   // built, exactly like a row read on this device.
   onChange(
      () => model.profileRev(),
      () => {
         if (hasInteracted) return
         const l = layout()
         if (!l.listMounted || l.readerLive || nav.lanePeek()) return
         nav.reapplyLane()
         void list.render()
      },
   )

   // Hand the extracted controllers what they need from the orchestrator (the
   // house DI pattern — see list.setup / picker.setup / setupGestures). None of
   // them imports app.ts, so these calls are the ONLY direction the coupling
   // runs. reader + menus here, search-ui down with the search bar it wires —
   // every one of them before route() paints the first surface.
   reader.setup({
      showReader,
      persistHash,
      setTitle,
      // Read lazily: gestures is wired further down, after list.setup.
      resetScroll: () => gestures?.resetScroll(),
      clearSearchDebounce: searchUI.clearSearchDebounce,
      offerFrontierUndo: menus.offerFrontierUndo,
   })
   // RDR16 — the mini-player. reader.ts drives the relocation seam directly
   // (it owns the render path); what the player needs from the orchestrator is
   // the ability to route back to an episode's article, and a way to hand a
   // position to FEB2's store without importing reader.ts.
   player.setup({
      openArticle: (mid, chron) => {
         void (async () => {
            // chron is per-mount, so an episode can belong to a store that is not
            // the active one — switch first, then open. switchMount no-ops when
            // the mutex is held or the mid is unknown, so re-check before routing
            // rather than navigating into the wrong store.
            if (mid !== data.activeStore().mid) {
               await switchMount(mid)
               if (mid !== data.activeStore().mid) return
            }
            // The exact jump, not goTo: the bar names ONE article, and goTo's
            // filter snap showed a neighbor whenever the active lane could not
            // address the episode's chron (another tag, ★ Saved, or its own
            // lane once unread-only's re-applied bounds excluded it).
            await guard(() => nav.goToArticle(chron))
            // The landing may have CHANGED the filter — the one player path
            // that can exit search mode. Under split nothing else re-derives
            // the pinned bar (the pane never closes), so it would stay up with
            // the dead query.
            searchUI.syncSearchBar()
         })()
      },
      rememberPosition: reader.rememberPosition,
      readPosition: reader.readPosition,
   })
   menus.setup({
      showError,
      showSnackbar,
      hideSnackbar,
      rerunPlaceholder,
      showHomeList: () => route(""),
   })

   // The filter picker overlay: a pick closes it and routes per surface — from
   // the list, selectFilter re-filters the LIST in place (pushes the #!filter
   // history entry; you land back on the headlines under the new lane); from
   // the reader, switchFilter stays IN the reader on the picked lane's resume
   // article (the same semantics as the W/S / two-finger filter cycle — see
   // onCycle), plus laneChange's follow-up, so a lane with no resume position
   // does not leave the always-on-screen pane blank. ✕ / Escape just close it —
   // the surface underneath never moved.
   // The settings that used to share this surface live in menus.openSettingsMenu.
   picker.setup(el.picker, {
      onSelect: (token) => {
         picker.close()
         if (layout().focus === "reader") void laneChange(() => nav.switchFilter(token))
         else void selectFilter(token)
      },
      onClose: () => picker.close(),
      // The header "Show read" toggle: flip unread-only and reconcile the surface
      // under the overlay (the picker re-renders its own rows). The overlay stays
      // open so you keep browsing feeds in the new mode.
      onToggleShowRead: toggleUnseenOnly,
      // The mount switcher: switch the active store in place (§6.3). switchMount
      // re-points the lane, rebuilds the list underneath, and re-renders the
      // picker's rows for the new store.
      onSwitchMount: (mid) => void switchMount(mid),
   })

   // The list opens an article in the reader through the same guard mutex as
   // every other navigation. The scroll callback resyncs the gesture toolbar
   // baseline after the list's anchor jump / prepend compensation.
   list.setup(
      el.listView,
      (chron) => void openArticle(chron),
      () => gestures?.resetScroll(),
      // A scroll-paging failure (meta pack 404 / network drop) surfaces here; the
      // retry rebuilds the list at the current anchor, same recovery as a failed
      // initial render.
      (e) => showError(e, () => void renderListSurface()),
      // A row swipe's mark-read is a frontier move like any other, so it gets the
      // same "Marked N read · Undo" announcement the reader's gestures get —
      // which matters because a swipe far ahead of a feed's frontier reads
      // everything behind it, not just that row.
      menus.offerFrontierUndo,
   )

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   // Next STEPS the cursor everywhere except a split-view pane holding NO
   // article, where the same button is the "start reading" affordance its own
   // copy advertises ("Tap Next to start reading"). Such a panel is built for a
   // cursor of -1, from which a →-step resolves the FIRST match itself — but
   // under split it sits beside a list that has already seeded that shared cursor
   // at the lane's anchor, so the step lands one PAST it: the panel offers the
   // backlog, opens its SECOND article, and marks the first read behind you.
   //
   // The test is the physical one — "the pane holds no article" — not "it is the
   // RESTING panel". Both panels are the same panel: nav.switchFilter answers a
   // never-opened lane with its own "not started" placeholder, painted through
   // render() rather than renderResting, and routing on which of the two it was
   // simply moved the skip from one to the other. A lane change made from the
   // reader surface then consumed the new lane's first unread unseen — the very
   // defect the resting flag had been added to fix, one code path over.
   //
   // enterReader resolves the same answer Escape and a row tap give, which is
   // also the row the list is highlighting as it says this.
   el.next.addEventListener("click", () =>
      isSplit() && !reader.hasArticle() ? void enterReader() : guard(() => nav.right()),
   )
   // The frontier menu rides the reader's next pill as a secondary gesture —
   // its only anchor; see menus.frontierMenuItems.
   menus.bindFrontierMenu(el.next)
   // A plain tap on the lane readout (list-only — hidden in the reader) opens
   // the anchored settings menu: search · offline pin · the three dialogs, with
   // the status readout as its footer. Its right-click / long-press stays the
   // browser's own menu (deliberately not a frontier-menu anchor — see
   // menus.frontierMenuItems).
   el.feed.addEventListener("click", () => menus.openSettingsMenu())
   // The filter button at the toolbar's right edge (both surfaces) opens the
   // picker overlay; the surface-aware onSelect above re-filters the list from
   // the list and keeps a reader pick in the reader.
   el.filter.addEventListener("click", () => picker.open())
   el.back.addEventListener("click", () => void goToList(true))
   // The list's open-article button (left edge) is the tap counterpart of Escape on
   // the list: enter the reader at the article you were reading (enterReader resolves
   // current → oldest-unseen → newest), mirroring the reader's back-to-list button.
   el.openReader.addEventListener("click", () => void enterReader())
   // capture: error events don't bubble (see collapseBrokenMedia)
   el.content.addEventListener("error", collapseBrokenMedia, true)
   // In-page fragment links (footnotes, ToC entries) scroll instead of
   // navigating — location.hash is the reader's router, not the article's.
   el.content.addEventListener("click", handleFragmentClick)
   // Bare content images open in the lightbox (RDR7). Delegated, like the two
   // above: the content host's children are replaced on every navigation, so a
   // per-image handler would be re-bound on every render. Registered AFTER the
   // fragment handler so a linked <img> is resolved as a link first — the
   // lightbox skips anything inside an <a href> anyway.
   el.content.addEventListener("click", lightbox.handleContentClick)
   el.snackbarAction.addEventListener("click", () => snackbarAction?.())
   // Search lives in the settings menu (the "Search articles…" row → enterSearch);
   // the `/` key still toggles it on the list. search-ui.setup wires the pinned
   // search bar's own input (debounced live query, Enter applies immediately,
   // Escape / ✕ leave search) and owns the debounce timer.
   searchUI.setup({
      selectTokens,
      commitListHash,
   })
   el.save.addEventListener("click", () => !el.save.disabled && toggleSave())
   el.popupClose.addEventListener("click", closePopup)
   el.popupRetry.addEventListener("click", () => {
      closePopup()
      if (retryFn) retryFn()
   })
   window.addEventListener("mousedown", (e) => {
      if (el.popup.classList.contains("srr-open") && !el.popup.contains(e.target as Node)) closePopup()
   })

   // (There was a "pins-purged" listener here. It reset the pin registry after
   // the SW's gen-change purge of the PINNED bucket — but `gen` was retired at
   // the manifest cutover, and with it that purge: every mutation of PINNED is
   // now an explicit pin/unpin/unpin-all this page asked for. The worker's only
   // outbound message is "pin-progress", so the branch had no sender at all.)

   window.addEventListener("hashchange", () => void route(location.hash.substring(1)))
   document.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && el.popup.classList.contains("srr-open")) {
         wrapTabFocus(e, el.popup, "button:not(.srr-hidden)")
         return
      }
      if (e.key === "Escape") {
         // Overlays close first (the popup and the picker here; the image-proxy /
         // backup modals and the anchored menus self-handle Escape via capture +
         // stopPropagation, so this never fires while one is open). Then Escape
         // toggles the surfaces: reader → list, list → reader (enterReader
         // resolves the article).
         if (el.popup.classList.contains("srr-open")) {
            closePopup()
            return
         }
         e.preventDefault()
         if (picker.isOpen()) picker.close()
         else if (layout().focus === "reader") void goToList(true)
         else void enterReader()
         return
      }
      if (el.popup.classList.contains("srr-open")) return
      // The picker overlay stacks over the list; without this guard the list
      // keymap below (`/`, A/D row stepping) — and the reader keymap after it —
      // would drive the surfaces stacked behind it. Escape is handled above;
      // the picker keeps its own UI (rows are plain links, Tab walks them).
      if (picker.isOpen()) return
      // Typing beats every shortcut below: a bare-letter keymap over a focused
      // field would eat the text. isContentEditable joins the tag test because a
      // rich-text host is a text field that happens not to be an <input>.
      const target = e.target as HTMLElement
      const tag = target.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return
      // The two SURFACE-AGNOSTIC keys, ahead of the per-surface maps below.
      // `/` is search (RDR8): on the list it toggles the bar, and from the reader
      // it switches to the list in search mode — search is a list filter mode, so
      // reaching it from an article used to mean going back by hand first.
      // `?` is the shortcuts card (RDR10) — the app's two keymaps had no in-UI
      // listing at all, and a key that only works on one surface is a poor place
      // to document keys that work on both.
      if (e.key === "/") {
         e.preventDefault()
         searchUI.toggleSearch()
         return
      }
      if (e.key === "?") {
         e.preventDefault()
         showShortcutsDialog()
         return
      }
      // `L` puts the desktop list pane away (and brings it back). Surface-
      // agnostic, so it belongs here rather than in KEY_ACTIONS: on the list
      // surface with no live pane the branch below returns whatever the key was,
      // and KEY_ACTIONS would never see it.
      //
      // Below the breakpoint this is a REFUSAL, not a no-op waiting to be
      // tidied: there is no pane, and the flag pane.ts would store is read back
      // at ANY viewport, so an accidental `l` on a phone would open the next
      // desktop session with no list and nothing on screen saying why.
      if (e.key === "l") {
         if (!isSplit()) return
         e.preventDefault()
         togglePane()
         relayoutPane()
         return
      }
      // On the list, the horizontal step keys move the selected (highlighted) row
      // through the feed — A/← to the older neighbor, D/→ to the newer — mirroring
      // the reader's prev/next so the same key reaches the same article on both
      // surfaces; the vertical cycle keys (W/S, ↑/↓) step the filter in place,
      // sharing onCycle with the two-finger swipe so every cycle input works on
      // both surfaces — except with a single lane to rotate, where they fall
      // through to native scrolling instead of going dead.
      // The rest of the reader keymap stays reader-only.
      //
      // …except under split with an article in the pane, where the row cursor IS
      // the reader's article (list.followCursor keeps them one) and the reader's
      // controls are on screen and enabled on BOTH surfaces. A/← there must step
      // the article the ‹ button beside it steps — a second, list-only cursor
      // would leave the pane highlighting one article while the reader shows
      // another, and the toolbar arrows stepping from the highlight. So the
      // horizontal keys (and the rest of the reader keymap, whose actions all
      // target the same visible article) fall through; only the cycle keys stay
      // here, because onCycle's list path re-filters the LIST in place.
      if (layout().focus === "list") {
         const cycleKey = e.key === "w" || e.key === "ArrowUp" || e.key === "s" || e.key === "ArrowDown"
         if (cycleKey) {
            if (nav.getFilterEntries().length > 1) {
               e.preventDefault()
               onCycle(e.key === "w" || e.key === "ArrowUp" ? -1 : 1)
            }
            return
         }
         if (layout().listKeys) {
            if (e.key === "a" || e.key === "ArrowLeft") {
               e.preventDefault()
               void list.moveSelection("older")
            } else if (e.key === "d" || e.key === "ArrowRight") {
               e.preventDefault()
               void list.moveSelection("newer")
            }
            return
         }
      }
      const action = KEY_ACTIONS[e.key]
      if (action) {
         e.preventDefault()
         action()
      }
   })

   gestures = setupGestures({
      toolbar: el.toolbar,
      onCycle,
   })
   // The reader swipe pager: gestures owns the drag geometry, pager.ts the pane
   // and visuals, and this seam hands a committed drag to the nav mutex.
   // `abandon` is the pager giving up on a step that outran its watchdog while
   // pagerCommit's own finally is still blocked on it: the slide is over, so the
   // arrival that eventually lands should fade in like any other entry.
   pager.setup({ commit: pagerCommit, abandon: () => reader.setEntryTransition(null) })

   // The device-state atoms as stored, before anything derives from them.
   nav.publishSeen()
   nav.publishSaved()
   pinUI.initSavedAssets()
   // Derived rendering (effects.ts): registered once, after every surface is
   // wired and before the first route() paints.
   // Rendering is held from the table's registration until the first route
   // takes its own hold, so every deferred paint — the resting pane, the list
   // title, the list's rows and membership — primes over the state the first
   // surface leaves, never over nav's pre-route lane. route() takes its hold
   // synchronously, before its first await, so the release below leaves no gap.
   const bootHold = beginRendering()
   effects = registerEffects({
      unreadTotal: unreadTotalOfActiveStore,
      setListTitle: () => setTitle(listTitle()),
      applyUnreadTotal,
      refreshSettingsStatus: menus.refreshSettingsStatus,
      probeChrome: nav.probeCurrent,
      applyChrome: reader.applyChrome,
      paintSaveButton: reader.paintSaveButton,
      paintFeedLabel: reader.paintFeedLabel,
      restingState: nav.restingState,
      renderResting: reader.renderResting,
      reconcileList: list.reconcile,
      afterListBuild: searchUI.syncSearchBar,
      onListError: (e) => showError(e, () => void renderListSurface()),
      refreshListRows: list.refresh,
      followListCursor: list.followCursor,
      listGrown: () => void list.onStoreGrown(),
      pickerOpen: picker.isOpen,
      renderPicker: picker.render,
      onPaintError: (e) => showError(e),
   })

   let routed: Promise<void>
   try {
      routed = route(hash)
   } finally {
      endRendering(bootHold)
   }
   await routed
   // RDR16 — offer back an episode a reload interrupted. After route() so the
   // active store is settled and the first surface has painted; PAUSED, never
   // auto-resumed (browsers block it, and audio starting by itself on a cold
   // boot is what people disable autoplay to avoid).
   player.restorePersisted()
   // Cross-device sync: run the LWW profile cycle (pull-adopt when the remote is
   // newer, guarded push when local changes are pending) only after the first
   // surface has rendered (local state is authoritative and paints instantly;
   // an adopt rerenders when it lands), then keep cycling on tab re-focus and
   // reconnect, flushing pending pushes on hide. No-op until a sync endpoint is
   // configured (settings menu → Sync).
   sync.init()
   // Live content sync: boot is already fresh (data.init just ran), so only the
   // ongoing triggers are wired — re-focus (throttled), reconnect, heartbeat.
   refresh.init(guardBg)

   // Tell the SW its mounted roots (the PWA0 fix, §5.1). A controller may not be
   // active yet on a first visit, so also post whenever a worker takes control.
   pinUI.postMounts()
   // ONE controllerchange listener, in this order: the mount roots first (a
   // fresh worker starts with none and would otherwise route nothing), then the
   // update notice. A second listener would race this one for that ordering.
   // A `let`, re-read after every takeover: a session long enough to see TWO
   // worker activations must be told about the second one too, and a value
   // captured once at boot would suppress every change after the first.
   let hadController = !!navigator.serviceWorker?.controller
   navigator.serviceWorker?.addEventListener("controllerchange", () => {
      pinUI.postMounts()
      const first = !hadController
      hadController = !!navigator.serviceWorker?.controller
      // PWA1 — a new worker takes over MID-SESSION with, until now, zero signal.
      // Harmless while only the cache changes; not harmless the day a pack-grammar
      // or contract change ships, because the page still running is the old build
      // reading through the new worker. Say so, and offer the one fix.
      //
      // Suppressed on FIRST INSTALL (there was no controller before): that
      // controllerchange is the worker arriving, not the reader changing under
      // you, and telling a first-time visitor to reload would be nonsense.
      if (first) return
      showSnackbar("Reader updated", { label: "Reload", run: () => location.reload() })
   })

   // Signal to the dev design harness (design.ts) that the real app has booted
   // and the first surface is rendered. Inert in production — nothing else
   // listens. Only fires on the success path (init returns early on db.gz error).
   document.dispatchEvent(new CustomEvent("srr:ready"))
}

init().catch(showError)

// Cache immutable self-hosted assets via a service worker (scope = this
// deployment's directory, e.g. /srr/ or /srr.tmp/). Best-effort: any failure
// (unsupported, insecure context, registration error) leaves the app working
// straight off the network. The design harness (design.html sets
// data-srr-harness) skips the SW so its cache-first pack bucket can't serve a
// stale fixture store across reloads.
//
// PRODUCTION ONLY. Under `parcel serve` (dev, NODE_ENV !== "production") the
// bundle keeps a stable filename across rebuilds, so the cache-first shell bucket
// would serve STALE JS after every code change — a phantom-bug generator that
// masks real fixes. So in dev we don't register, and actively unregister any SW a
// prior build left controlling this origin + drop its caches (self-healing, so a
// developer who already has a dev SW recovers on the next load without manually
// clearing site data). `parcel build` (e2e + real prod) sets NODE_ENV=production,
// so the offline/PWA behavior and its e2e coverage are unaffected.
// `serviceWorker` can be PRESENT-but-undefined (a locked-down browser profile, a
// test double), so every use below is optional-chained: "in navigator" answers
// whether the name exists, not whether there is an object behind it.
if ("serviceWorker" in navigator && !document.documentElement.hasAttribute("data-srr-harness")) {
   if (process.env.NODE_ENV === "production") {
      // sw.ts lives at src/ root (not src/js/) so Parcel emits it at the deployment
      // root — its default scope then covers the whole env (incl. packs/assets/).
      // type:module lets sw.ts import the generated contract (format.gen.ts); the
      // SW already requires DecompressionStream, which is the newer feature, so
      // module-worker support is never the limiting factor.
      navigator.serviceWorker?.register(new URL("../sw.ts", import.meta.url), { type: "module" }).catch(() => {})
   } else {
      navigator.serviceWorker
         ?.getRegistrations()
         .then((regs) => regs.forEach((r) => r.unregister()))
         .catch(() => {})
      if (typeof caches !== "undefined")
         caches
            .keys()
            .then((keys) => keys.forEach((k) => caches.delete(k)))
            .catch(() => {})
   }
}
