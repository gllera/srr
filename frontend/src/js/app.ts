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
import { setProfileImportHook, wrapTabFocus } from "./dropdown"
import { el } from "./els"
import { collapseBrokenMedia, countBadge, handleFragmentClick } from "./fmt"
import { setupGestures, type Gestures } from "./gestures"
import { HASH_KEY, UNREAD_ONLY_KEY } from "./keys"
import * as lightbox from "./lightbox"
import * as list from "./list"
import * as menus from "./menus"
import { loadMounts } from "./mounts"
import * as nav from "./nav"
import * as picker from "./picker"
import { clearAllPins } from "./pin"
import * as pinUI from "./pin-ui"
import * as player from "./player"
import * as reader from "./reader"
import * as refresh from "./refresh"
import { ensureSchema } from "./schema"
import * as searchUI from "./search-ui"
import * as sync from "./sync"

// Which surface is showing. The list is home; the reader is the drill-down.
// (The filter picker is a fixed overlay over the list, not a view of its own —
// while it's open, view stays "list" and picker.isOpen() gates input instead.)
let view: "list" | "reader" = "list"
// Set once gestures are wired; the list calls it after a programmatic scroll so
// the toolbar-hide baseline stays in sync (declared up here so list.setup, wired
// before setupGestures runs, can close over it).
let gestures: Gestures | null = null
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
   busy = true
   busyAt = Date.now()
   return ++busyToken
}
function release(token: number): void {
   if (token === busyToken) busy = false
}
// Freshness token for the list's async cycle: each W/S press bumps it, and only
// the LATEST press applies its resolved token, so rapid presses can't land out
// of order off a stale cycleOriginKey. A token, not a held flag — a cycleToken()
// that never settles must not permanently latch cycling off.
let listCycleGen = 0
let retryFn: (() => void) | null = null
let previousFocus: HTMLElement | null = null

function showReader() {
   view = "reader"
   document.body.classList.remove("srr-view-list")
   picker.close()
   el.listView.hidden = true
   el.article.hidden = false
}

function showList() {
   view = "list"
   document.body.classList.add("srr-view-list")
   picker.close()
   el.article.hidden = true
   el.listView.hidden = false
   // Disable the reader-only nav so a one-finger swipe / arrow key is a no-op
   // while the list scrolls natively (the buttons are also hidden via CSS).
   el.prev.disabled = true
   el.next.disabled = true
}

// The shared "go to the article surface" resolver, reused by every → reader
// transition (Escape from the list, the open-article toolbar button). Opens the
// reader at the current reader/selected article when there is one, else the
// filter's oldest-unseen article (start of the backlog), else its newest.
async function enterReader() {
   const chron = nav.currentChron()
   if (chron >= 0) return guard(() => nav.goTo(chron))
   const anchor = await nav.listAnchor() // oldest unseen, else -1 (newest)
   return anchor >= 0 ? guard(() => nav.goTo(anchor)) : guard(() => nav.last())
}

function persistHash(hash: string) {
   try {
      localStorage.setItem(HASH_KEY, hash)
   } catch {}
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
   document.body.classList.add("srr-loading")
   try {
      const o = await fn()
      // If this op was reclaimed as stale mid-flight (see acquire), a newer holder
      // now owns the surface — don't paint our stale result / error over it.
      if (token === busyToken) reader.render(o)
   } catch (e) {
      if (token === busyToken) showError(e, () => guard(fn))
   } finally {
      if (token === busyToken) document.body.classList.remove("srr-loading")
      release(token)
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

// Re-derive the reader after its filter bounds/mode shifted (a frontier gesture
// or a Show-read flip). On a real article, silently re-probe the chrome. On a
// placeholder (pos < 0) reprobeReaderChrome no-ops, so re-run the switch to
// re-resolve the surface — but ONLY for a single-token/[ALL] filter:
// switchFilter is single-token and getCurrentFilterKey() collapses a multi-token
// (URL-only, e.g. #!5+9) filter to "", which switchFilter("") would misread as
// [ALL] and teleport the reader off its lane, so leave that rare placeholder be.
function reReadReader() {
   if (view !== "reader") return
   if (nav.currentChron() >= 0) {
      reader.reprobeReaderChrome()
      return
   }
   if (nav.isFilterActive() && nav.filterTokens().length > 1) return
   void guard(() => nav.switchFilter(nav.getCurrentFilterKey()))
}

// The reader's save (★) toggle reflects whether the current article is in the
// saved set. Disabled only on the "(no matching articles)" placeholder, where
// there's nothing to save — keyed off o.placeholder, NOT feed presence, so a
// saved article whose feed was deleted ([DELETED] tombstone, feed ===
// undefined) stays toggleable.
function refreshSaveButton(hasArticle: boolean) {
   const chron = nav.currentChron()
   const canSave = hasArticle && chron >= 0
   const saved = canSave && nav.isSaved(chron)
   el.save.disabled = !canSave
   paintSaveButton(saved)
}

// The save-button visual contract (active class + aria), single-sourced so the
// reader's refresh and toggle paths can't drift out of lockstep.
function paintSaveButton(saved: boolean) {
   el.save.classList.toggle("srr-saved", saved)
   el.save.setAttribute("aria-pressed", String(saved))
   el.save.setAttribute("aria-label", saved ? "Unsave article" : "Save article")
}

// Toggle the current article's saved state from the reader. A local state flip
// (localStorage + the button), not a navigation — it stays off the guard mutex,
// and the list re-derives stars from the live set when you return to it.
function toggleSave() {
   const chron = nav.currentChron()
   if (chron < 0) return
   const saved = nav.toggleSaved(chron)
   paintSaveButton(saved)
}

// RDR12 — the unread total, surfaced where an installed app is actually looked
// at: the launcher badge and the tab title.
//
// The tally already exists (it is what fills every picker badge); nothing was
// reading it outside the app's own chrome, so an installed SRR gave no sign that
// anything had arrived until you opened it. Scope is the ACTIVE store's [ALL] —
// the same thing the picker's [ALL] row counts, so the two can never disagree.
// -1, not 0, so the FIRST sync always writes through. An app badge outlives the
// session that set it — it is on the installed icon until something clears it —
// so a launch that finds everything already read is exactly when clearAppBadge
// has to run, and seeding 0 would make that the one case skipped as "no change".
let unreadTotal = -1
let titleBase = "SRR"
let badgeRunning = false
// Set when a sync is asked for while one is in flight. The count it would have
// read is already stale by then, so the answer is to re-run once at the end, not
// to queue one run per request.
let badgeAgain = false

// The single writer of document.title, so the count and the surface's own name
// can never get out of step. The count LEADS: a tab title is truncated from the
// right, and a number nobody can see is not a notification.
function setTitle(base: string): void {
   titleBase = base
   document.title = unreadTotal > 0 ? `(${countBadge(unreadTotal)}) ${base}` : base
}

async function syncUnreadBadge(): Promise<void> {
   // Navigation fires these back to back, so collapse a burst into "one running,
   // one more after" — dropping the later call outright would leave the badge on
   // whatever count the in-flight run happened to read, stale until the next
   // landing. The loop (rather than a recursive tail call) is what keeps the
   // re-run inside the guard: writeUnreadBadge returns early when nothing moved,
   // and an early return past the guard would skip the pending re-run entirely.
   if (badgeRunning) {
      badgeAgain = true
      return
   }
   badgeRunning = true
   try {
      do {
         badgeAgain = false
         await writeUnreadBadge()
      } while (badgeAgain)
   } finally {
      badgeRunning = false
      badgeAgain = false
   }
}

async function writeUnreadBadge(): Promise<void> {
   try {
      const feeds = Object.values(data.db?.feeds ?? {})
      const total = feeds.length ? nav.tagUnreadFromCounts(feeds, await nav.unreadCounts(feeds)) : 0
      if (total === unreadTotal) return
      unreadTotal = total
      setTitle(titleBase)
      // Feature-detected on both sides: no Badging API (Firefox, iOS Safari) just
      // leaves the title readout, and a rejection (permission, unsupported
      // context) is not worth telling anyone about.
      const badging = navigator as Navigator & {
         setAppBadge?: (n?: number) => Promise<void>
         clearAppBadge?: () => Promise<void>
      }
      if (total > 0) await badging.setAppBadge?.(total)
      else await badging.clearAppBadge?.()
   } catch {
      // A count blip or an unsupported badge call must never surface as an error.
   }
}

function listTitle(): string {
   if (nav.isSearchFilter()) {
      const q = nav.searchQuery()
      return q ? `SRR · Search: ${q}` : "SRR · Search"
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
   // The list centers + highlights its anchor (the article you were reading /
   // the lane's resume position) on every arrival. Returning FROM THE READER
   // (back button, browser-back) commits that scroll immediately — the seed's
   // pack is warm from the article on screen; a filter change / boot arrival
   // (view was already "list") takes the settle-then-land-once path instead.
   // Captured before showList() flips view to "list".
   const anchorNow = view === "reader"
   showList()
   reader.refreshFeedLabel()
   setTitle(listTitle())
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
      if (token === busyToken) document.body.classList.remove("srr-loading")
      release(token)
   }
   try {
      await list.show(anchorNow, onInteractive)
   } catch (e) {
      showError(e, () => void renderListSurface())
   } finally {
      if (!interactive) {
         if (token === busyToken) document.body.classList.remove("srr-loading")
         release(token)
      }
      searchUI.syncSearchBar()
   }
}

// A well-formed reader position: the hash's position part (nav.hashPos) is a
// bare integer. Shared by route() below and the boot foreign-hash guard.
const INT_POS = /^-?\d+$/

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
   const posStr = nav.hashPos(hash)
   if (posStr !== "" && INT_POS.test(posStr)) {
      await guard(() => nav.fromHash(hash))
      return
   }
   // The list hash carries the mount too (§6.3) — extract it and switch the
   // active lane before applying the (bare) filter tokens, mirroring
   // nav.fromHash's reader path. setActive fails softly for an unmounted/errored
   // mount, resolving against the current lane rather than blanking (MS4).
   const { mid, tokens } = nav.parseHashMount(nav.parseHashTokens(hash))
   if (mid !== data.activeStore().mid) data.setActive(mid)
   nav.applyFilter(tokens)
   // Canonicalize the URL (boot may restore an empty location.hash from
   // localStorage) without growing history.
   const h = "#" + nav.tokensSuffix()
   history.replaceState(null, "", h)
   persistHash(h)
   await renderListSurface()
}

// Return to the list from the reader (back button / two-finger cycle / filter
// pick). pushState so browser-back from the reader still works; the list
// re-centers on the article you were reading (see renderListSurface).
async function goToList(push: boolean) {
   // Bail BEFORE mutating history/localStorage: renderListSurface also checks
   // the mutex, but the pushState/persistHash below would already have rewritten
   // the URL to a filter the dropped render never painted, desyncing URL from view.
   if (held()) return
   const h = "#" + nav.tokensSuffix()
   history[push ? "pushState" : "replaceState"](null, "", h)
   persistHash(h)
   await renderListSurface()
}

async function selectFilter(token: string) {
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
   // A mount-qualified token (a peer lane/section picked from the picker):
   // switch the active lane first, then apply the bare token in that store's
   // context (§6.3). A bare token leaves the active mount as-is.
   if (token.startsWith("@")) {
      const { mid, tokens } = nav.parseHashMount([token])
      data.setActive(mid)
      token = tokens[0] ?? ""
   }
   nav.applyFilter(token === "" ? [] : [token])
   await goToList(true)
}

// Switch the active mount from the picker's mount switcher WITHOUT closing the
// overlay (§6.3): re-point the active lane to that store's [ALL], rebuild the
// list underneath, and re-render the picker's lanes in place for the new store.
// A failed/unmounted mount (setActive returns false) is a no-op.
async function switchMount(mid: string) {
   if (held()) return
   if (mid === data.activeStore().mid) return
   if (!data.setActive(mid)) return
   nav.applyFilter([])
   const h = "#" + nav.tokensSuffix()
   history.pushState(null, "", h)
   persistHash(h)
   await renderListSurface()
   if (picker.isOpen()) picker.render()
}

// The unread (catch-up) toggle — the picker header's "Show read" button
// (onToggleShowRead). Unread-only is the default view; flipping it OFF ALSO
// shows already-read articles. Unseen-only spans every filter ([ALL]/feed/tag).
// The picker can be open over EITHER surface (the list readout or the reader's
// filter button), so reconcile whichever is active: setUnreadOnly re-applies the
// filter (raised/restored bounds) internally, then the mode flip changes
// membership in both directions, so the list must fully rebuild — rerender when
// it's the visible surface, or invalidate a hidden list (rebuilding a
// display:none list now would pin zero row heights) and re-derive the reader's
// chrome against the shifted bounds. The picker re-renders its own rows itself.
function toggleUnseenOnly() {
   nav.setUnreadOnly(!nav.isUnreadOnly())
   if (view === "list") void list.rerender()
   else {
      list.invalidate()
      // The reader re-derives for the new mode: a real article re-probes its
      // chrome; a placeholder (pos < 0) re-runs the switch (reprobeReaderChrome
      // would no-op and leave it stale). Shared with menus' afterFrontierMove.
      reReadReader()
   }
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
   if (view === "list") {
      // Only the latest press applies its resolved token (a stale one — from a
      // press superseded before its cycleToken resolved — is discarded), so
      // rapid presses can't land out of order; selectFilter's own busy guard
      // serializes the apply. A freshness token rather than a held flag: a
      // never-settling cycleToken() then can't latch cycling off for the session.
      const gen = ++listCycleGen
      void nav.cycleToken(dir).then((tok) => {
         if (gen === listCycleGen) void selectFilter(tok)
      })
   } else guard(() => nav.cycleFilter(dir))
}

// Each step/cycle key has an arrow + letter alias; define the action once and
// point both keys at it. step toward a dead edge rings the reader margin bell;
// cycle is a no-op when the filter rotation has a single entry.
// stepLeft/stepRight back BOTH the reader keymap and the one-finger swipe
// (gestures' goPrev/goNext). They act only on the reader surface. The picker
// overlay can be open OVER the reader (via the reader's filter button, view
// stays "reader"), so a swipe on it must be inert too — the same guard the
// keymap and the two-finger cycle carry (a bare view check no longer covers it
// now that the picker isn't list-only). Gating on view !== "reader" additionally
// makes a swipe over the LIST (where prev/next are disabled) a clean no-op.
// The image lightbox is the same class of overlay: it covers the reader while a
// content image is enlarged, so a swipe on it must not step the article behind.
// (Its KEY input is already swallowed at the capture phase — lightbox.ts onKey —
// but touch gestures reach these callbacks directly and need the flag.)
const stepLeft = () => {
   if (view !== "reader" || picker.isOpen() || lightbox.isOpen()) return
   return el.prev.disabled ? reader.bumpReaderEdge("prev") : guard(() => nav.left())
}
const stepRight = () => {
   if (view !== "reader" || picker.isOpen() || lightbox.isOpen()) return
   return el.next.disabled ? reader.bumpReaderEdge("next") : guard(() => nav.right())
}
const cycle = (dir: -1 | 1) => () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(dir))
const cyclePrev = cycle(-1)
const cycleNext = cycle(1)

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

   // Shared refresh after any profile merge — a backup import or a sync pull
   // that changed local state: prune stale seen keys, refresh the save button,
   // rebuild the list under the current filter, and re-derive an open picker
   // overlay (unread badges). The reader view skips the list rebuild — the
   // return path (show() → refresh()) re-derives per-row state anyway, and
   // rebuilding a display:none list would pin zero row heights.
   //
   // When the merge also moved the `mnt` mount table (a peer mounted on another
   // device, pulled in by sync — profile.ts mergeMountState), re-adopt it into
   // data.ts FIRST via afterMountChange, exactly as the Stores dialog does
   // (applyMountTable boots the new root, postMounts SW-routes it, the picker
   // repaints once it booted). Without this a sync-pulled mount never boots,
   // never appears in the picker and isn't SW-routed until a full page reload.
   // Gated on mountsChanged so an ordinary seen/saved-only pull doesn't re-run
   // applyMountTable every cycle (both it and postMounts are idempotent, but the
   // gate keeps the common pull cheap).
   const refreshAfterMerge = (mountsChanged = false) => {
      if (mountsChanged) menus.afterMountChange(loadMounts())
      nav.pruneSeen()
      refreshSaveButton(!el.save.disabled)
      if (view === "list" && !hasInteracted && !nav.isSavedFilter() && !nav.isSearchFilter()) {
         // The BOOT pull changed the profile before anything was touched — the
         // device-switch moment, and the navigator half of the sync feature
         // (the profile syncs on page load; there is deliberately no button):
         // re-derive the unseen bounds from the new seen map and rebuild the
         // list anchored at the new range (listAnchor → the new oldest unread)
         // instead of the gentle rebuild. Saved/search are exempt peek modes
         // (their sets are seen-independent), and a boot into the READER stays
         // gentle: that position is a restored mid-article read or a shared
         // deep link — swapping the on-screen article out from under the reader
         // would be wrong in both cases.
         nav.applyFilter([...nav.filterTokens()])
         void list.render()
      } else if (view !== "reader") {
         void list.rerender()
      }
      if (picker.isOpen()) picker.render()
      void syncUnreadBadge() // another device's reading changes this device's count
   }

   // Shared reconciliation after a store refresh adopted a newer db.gz — the
   // fully-silent contract: no reload, no scroll, no content re-render. The
   // toolbar label re-derives, the reader's prev/next chrome re-probes (a cached
   // "no newer article" is exactly what new content invalidates), the list
   // reopens its top, and an open picker re-derives its rows and badges.
   //
   // Silent is not the same as unsignalled (RDR3): the surface you are on gets
   // ONE non-disruptive cue that content landed — the list's overlay "N new"
   // pill (list.onStoreGrown → the prepend that feeds it) and, in the reader,
   // a one-shot pulse on the pending pill when its count actually grew.
   const refreshAfterStore = () => {
      reader.refreshFeedLabel()
      if (view === "reader") reader.reprobeReaderChrome(true)
      else void list.onStoreGrown()
      if (picker.isOpen()) picker.render()
      // New articles landed: the launcher badge is the one readout that is
      // supposed to notice without anyone opening the app (RDR12).
      void syncUnreadBadge()
   }

   // After a successful profile import (backup dialog), additionally reconcile
   // prefs: importProfile wrote srr-unread-only straight to localStorage, but nav
   // holds unreadOnly in a module var only mutated via setUnreadOnly (this also
   // re-applies the filter so the raised unseen bounds take hold). Sync pulls
   // never touch prefs (prefs:false), so they skip this.
   setProfileImportHook((mountsChanged) => {
      nav.setUnreadOnly(localStorage.getItem(UNREAD_ONLY_KEY) === "1")
      refreshAfterMerge(mountsChanged)
   })

   // ★-Saved keeps its article's media too (FMT2a). Both save paths — the
   // reader's star and the list row's — go through nav.toggleSaved, so one hook
   // covers them; failures are silent because a save must never fail on account
   // of an optional cache write.
   nav.setSavedHook((chron, saved) => void pinUI.syncSavedAssets(chron, saved).catch(() => {}))

   // Hand the extracted controllers what they need from the orchestrator (the
   // house DI pattern — see list.setup / picker.setup / setupGestures). None of
   // them imports app.ts, so these calls are the ONLY direction the coupling
   // runs. reader + menus here, search-ui down with the search bar it wires —
   // every one of them before route() paints the first surface.
   reader.setup({
      view: () => view,
      showReader,
      persistHash,
      setTitle,
      refreshSaveButton,
      // Read lazily: gestures is wired further down, after list.setup.
      resetScroll: () => gestures?.resetScroll(),
      clearSearchDebounce: searchUI.clearSearchDebounce,
      offerFrontierUndo: menus.offerFrontierUndo,
      syncUnreadBadge,
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
            await guard(() => nav.goTo(chron))
         })()
      },
      rememberPosition: reader.rememberPosition,
   })
   menus.setup({
      view: () => view,
      showError,
      showSnackbar,
      hideSnackbar,
      syncUnreadBadge,
      reReadReader,
   })

   // The filter picker overlay: a pick closes it and routes per surface — from
   // the list, selectFilter re-filters the LIST in place (pushes the #!filter
   // history entry; you land back on the headlines under the new lane); from
   // the reader, switchFilter stays IN the reader on the picked lane's resume
   // article (the same semantics as the W/S / two-finger filter cycle — see
   // onCycle). ✕ / Escape just close it — the surface underneath never moved.
   // The settings that used to share this surface live in menus.openSettingsMenu.
   picker.setup(el.picker, {
      onSelect: (token) => {
         picker.close()
         if (view === "reader") guard(() => nav.switchFilter(token))
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
      (chron) => guard(() => nav.goTo(chron)),
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
   el.next.addEventListener("click", () => guard(() => nav.right()))
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
      view: () => view,
      selectFilter,
      persistHash,
      setTitle,
      listTitle,
      showError,
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

   // The SW posts "pins-purged" after a gen-change purge of the PINNED cache —
   // reset the local pin registry so menu labels match the (now empty) cache.
   navigator.serviceWorker?.addEventListener("message", (e: MessageEvent) => {
      if (e.data?.type === "pins-purged") {
         clearAllPins(data.activeStore().mid)
         // The pin row derives its label fresh on the next settings-menu open,
         // so clearing the registry is all it takes to match the empty bucket.
      }
   })

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
         else if (view === "reader") void goToList(true)
         else void enterReader()
         return
      }
      if (el.popup.classList.contains("srr-open")) return
      // The picker overlay stacks over the list; without this guard the list
      // keymap below (`/`, A/D row stepping) — and the reader keymap after it —
      // would drive the surfaces stacked behind it. Escape is handled above;
      // the picker keeps its own UI (rows are plain links, Tab walks them).
      if (picker.isOpen()) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      // On the list, the horizontal step keys move the selected (highlighted) row
      // through the feed — A/← to the older neighbor, D/→ to the newer — mirroring
      // the reader's prev/next so the same key reaches the same article on both
      // surfaces; the vertical cycle keys (W/S, ↑/↓) step the filter in place,
      // sharing onCycle with the two-finger swipe so every cycle input works on
      // both surfaces — except with a single lane to rotate, where they fall
      // through to native scrolling instead of going dead; `/` toggles search.
      // The rest of the reader keymap stays reader-only.
      if (view === "list") {
         if (e.key === "/") {
            e.preventDefault()
            searchUI.toggleSearch()
         } else if (e.key === "a" || e.key === "ArrowLeft") {
            e.preventDefault()
            void list.moveSelection("older")
         } else if (e.key === "d" || e.key === "ArrowRight") {
            e.preventDefault()
            void list.moveSelection("newer")
         } else if (e.key === "w" || e.key === "ArrowUp" || e.key === "s" || e.key === "ArrowDown") {
            if (nav.getFilterEntries().length > 1) {
               e.preventDefault()
               onCycle(e.key === "w" || e.key === "ArrowUp" ? -1 : 1)
            }
         }
         return
      }
      const action = KEY_ACTIONS[e.key]
      if (action) {
         e.preventDefault()
         action()
      }
   })

   gestures = setupGestures({
      toolbar: el.toolbar,
      goPrev: stepLeft,
      goNext: stepRight,
      onCycle,
   })

   let hash = location.hash.substring(1)
   // Reject foreign hashes (e.g., OAuth implicit-flow tokens injected by an
   // auth provider in front of the app — Cloudflare Access JWT-in-fragment,
   // OIDC, etc.) so the page lands on the user's last position instead of
   // the latest article. SRR hashes are `[integer][!tokens]` or `!tokens`.
   const posPart = nav.hashPos(hash)
   if (posPart && !INT_POS.test(posPart)) {
      history.replaceState(null, "", location.pathname + location.search)
      hash = ""
   }
   if (!hash)
      try {
         hash = localStorage.getItem(HASH_KEY)?.substring(1) || ""
      } catch {}
   await route(hash)
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
   // configured (settings menu → Sync). The status callback refills the footer
   // of a settings menu that happens to be open when a cycle lands; a closed
   // menu's footer is disconnected and skipped (it rebuilds on the next open).
   sync.init(refreshAfterMerge, menus.refreshSettingsStatus)
   // Live content sync: boot is already fresh (data.init just ran), so only the
   // ongoing triggers are wired — re-focus (throttled), reconnect, heartbeat.
   // The third callback repaints the picker when a background PEER poll changed
   // shape (its unread rollups), without touching the active lane.
   refresh.init(guardBg, refreshAfterStore, () => {
      if (picker.isOpen()) picker.render()
   })

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
   // First badge + title readout, after the first surface is up so it never
   // delays paint (RDR12).
   void syncUnreadBadge()

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
