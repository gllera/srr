import { makeLRU } from "./cache"
import * as data from "./data"
import {
   setProfileImportHook,
   showBackupDialog,
   showContextMenu,
   showImgProxyDialog,
   showMountsDialog,
   showSyncDialog,
   wrapTabFocus,
   type MenuItem,
} from "./dropdown"
import {
   collapseBrokenMedia,
   countBadge,
   extractAssetKeys,
   handleFragmentClick,
   readerDateline,
   sanitizeFragment,
   srcColorIndex,
} from "./fmt"
import { setupGestures, type Gestures } from "./gestures"
import { HASH_KEY, UNREAD_ONLY_KEY } from "./keys"
import * as list from "./list"
import { addMount, forgetStoreState, loadMounts, mountLabel, removeMount, type MountRecord } from "./mounts"
import * as nav from "./nav"
import * as picker from "./picker"
import { clearAllPins, isPinned, listPins, pinFilter, unpinFilter } from "./pin"
import * as refresh from "./refresh"
import * as sync from "./sync"
import { URL_DENY } from "./urlish"

const el = {
   article: document.querySelector(".srr-reader") as HTMLElement,
   listView: document.querySelector(".srr-list") as HTMLElement,
   picker: document.querySelector(".srr-picker") as HTMLElement,
   back: document.querySelector(".srr-back") as HTMLButtonElement,
   backLabel: document.querySelector(".srr-back-label") as HTMLElement,
   openReader: document.querySelector(".srr-open-reader") as HTMLButtonElement,
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleRow: document.querySelector(".srr-title-row") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   nextCount: document.querySelector(".srr-next-count") as HTMLElement,
   feed: document.querySelector(".srr-feed") as HTMLButtonElement,
   feedName: document.querySelector(".srr-feed-name") as HTMLElement,
   source: document.querySelector(".srr-source") as HTMLElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   desk: document.querySelector(".srr-desk") as HTMLElement,
   searchInput: document.querySelector(".srr-search-input") as HTMLInputElement,
   searchClear: document.querySelector(".srr-search-clear") as HTMLButtonElement,
   searchNote: document.querySelector(".srr-search-note") as HTMLElement,
   save: document.querySelector(".srr-save") as HTMLButtonElement,
   filter: document.querySelector(".srr-filter") as HTMLButtonElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
   pinProgress: document.querySelector(".srr-pin-progress") as HTMLElement,
   snackbar: document.querySelector(".srr-snackbar") as HTMLElement,
   snackbarText: document.querySelector(".srr-snackbar-text") as HTMLElement,
   snackbarAction: document.querySelector(".srr-snackbar-action") as HTMLButtonElement,
}

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
let lastFeedLabel: string | null = null
let previousFocus: HTMLElement | null = null
// Pending debounced search query (see the Title search section). Declared up
// here so selectFilter / route can cancel it when the filter changes by any
// means other than continued typing.
let searchDebounce: ReturnType<typeof setTimeout> | undefined

// Offline-pin progress: show a transient "Downloading N / M…" note in the
// status bar while the SW caches the filter's packs, then restore.
let pinProgressTimer: ReturnType<typeof setTimeout> | undefined
// Whether the current pin was started in unread-only mode (snapshot note).
let pinIsUnreadSnapshot = false

function showPinProgress(done: number, total: number, cached?: number): void {
   clearTimeout(pinProgressTimer)
   let text: string
   const finished = done >= total
   if (finished) {
      // `cached` is the real success count from the SW; absent (older message)
      // falls back to `total`. Zero cached = nothing saved (offline/degraded).
      const ok = cached ?? total
      if (ok === 0) {
         text = "Couldn't save offline copy — you may be offline"
      } else {
         text = `Offline copy saved (${ok} file${ok === 1 ? "" : "s"})`
         // The pin is a snapshot — unread that arrives later isn't auto-pinned.
         if (pinIsUnreadSnapshot) text += " — new unread won't update automatically"
      }
   } else {
      text = `Downloading ${done} / ${total}…`
   }
   // A dedicated node (.srr-pin-progress), separate from the settings menu's
   // status footer (picker.renderStatus) — the menu closes when the pin row is
   // clicked, so the toast is the only feedback surface left. Per-pack ticks
   // stay SILENT (no live role) so they don't flood screen readers; only the
   // final outcome becomes a role=status live region, so the single
   // success/failure message is announced once.
   if (finished) el.pinProgress.setAttribute("role", "status")
   else el.pinProgress.removeAttribute("role")
   el.pinProgress.textContent = text
   el.pinProgress.hidden = false
   if (finished) {
      pinProgressTimer = setTimeout(() => {
         el.pinProgress.hidden = true
         el.pinProgress.textContent = ""
         el.pinProgress.removeAttribute("role")
      }, 3000)
   }
}

// The offline-pin registry key. Distinct from nav.filterKey() (which the list
// reuses for scroll memory): the pinned pack SET differs by unread-only mode
// (raised bounds enumerate only the unread tail), so the key must encode it too.
function pinKey(): string {
   const base = nav.filterKey()
   return nav.isUnreadOnly() && nav.filter.active ? base + " #unread" : base
}

// Enumerate the packs for the current filter and cache them in the SW's
// eviction-exempt PINNED bucket. Records the pin in the localStorage registry
// so the overflow menu can show "Remove offline copy" on the next open.
// Scoped to [ALL] / feed / tag / unread — saved and search scopes are deferred
// (the pinMenuHook returns null for them).
async function pinCurrentFilter(): Promise<void> {
   const controller = navigator.serviceWorker?.controller
   if (!controller) return // dev / harness / insecure context — silent no-op
   const key = pinKey()
   // [ALL] => empty Map, the documented fast path; a populated map is a feed/tag
   // scope (filter.feeds is fully populated even for [ALL], so pass empty here).
   const feeds = nav.filter.active ? nav.filter.feeds : new Map<number, number>()
   const names = await data.packNamesForFilter(feeds)
   if (names.length === 0) return
   // Track whether this pin was taken in unread-only mode so the completion
   // message can surface the snapshot caveat (new unread won't auto-update).
   pinIsUnreadSnapshot = nav.isUnreadOnly() && nav.filter.active
   const { port1, port2 } = new MessageChannel()
   port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number; cached?: number }>) => {
      if (e.data?.type !== "pin-progress") return
      showPinProgress(e.data.done, e.data.total, e.data.cached)
      // Record the pin in the registry only once the SW confirms it actually
      // cached something. A fully-failed (offline) pin reports cached === 0 on
      // completion; recording it then would leave a phantom "Remove offline
      // copy" entry over bytes that were never saved. (The pin row lives in the
      // settings menu, which is rebuilt fresh on every open — nothing on screen
      // to re-render here.)
      if (e.data.done >= e.data.total) {
         if ((e.data.cached ?? 0) > 0) pinFilter(key, names, data.activeStore().mid)
         else unpinFilter(key, data.activeStore().mid)
      }
   }
   // base = the URL the page resolves pack names against (the active store's
   // root), so the SW pins at the exact URLs it will later fetch (self-hosted
   // store root, hosted /packs/, a mounted peer, …).
   controller.postMessage({ type: "pin", names, base: data.activeStore().base.href }, [port2])
   showPinProgress(0, names.length)
   requestPersistentStorage()
}

// Drop one pin scope from the registry and return the names that are now
// genuinely unreferenced. The subtraction is the point: shared latest packs
// (idx/L, data/L, meta/L), overlapping finalized packs, and an asset two saved
// articles both show must NOT be deleted while another pin still needs them.
// Shared by the filter-scope unpin and the ★-Saved asset release.
function dropPinScope(key: string): string[] {
   const mid = data.activeStore().mid
   const pins = listPins(mid)
   const names = pins.get(key)?.names ?? []
   const stillNeeded = new Set<string>()
   for (const [k, entry] of pins) if (k !== key) for (const n of entry.names) stillNeeded.add(n)
   unpinFilter(key, mid)
   return names.filter((n) => !stillNeeded.has(n))
}

function unpinCurrentFilter(): void {
   const controller = navigator.serviceWorker?.controller
   const toDelete = dropPinScope(pinKey())
   if (controller) controller.postMessage({ type: "unpin", names: toDelete, base: data.activeStore().base.href })
   // The pin row reads its state fresh on the next settings-menu open — the
   // menu that triggered this unpin closed when the row was clicked.
}

// PWA2 — ask the browser to make this origin's storage persistent, the first
// time the user does something that means "keep these bytes".
//
// The SW's PINNED bucket is exempt from SRR's OWN eviction, which is all the
// eviction SRR controls: under storage pressure the browser can still evict the
// whole origin, taking the pinned packs and every saved article's media with it.
// One call converts the offline-pin feature from best-effort to durable, and it
// is the pin that earns it — asking on boot would be a prompt for something the
// user has not asked for yet. Fire-and-forget: a refusal (or a browser with no
// such API) leaves today's behaviour exactly as it was.
let persistenceAsked = false

function requestPersistentStorage(): void {
   if (persistenceAsked) return
   persistenceAsked = true
   void navigator.storage
      ?.persist?.()
      .then((granted) => console.info(granted ? "storage: persistent" : "storage: best-effort (not granted)"))
      .catch(() => {})
}

// FMT2a — a ★-saved article's self-hosted media, pinned for as long as it is
// saved. Its TEXT already survives forever (immutable packs); its images and
// video do not, because expiration deletes the assets/ objects once the feed's
// retention window passes. Nothing server-side can help — the saved set is
// device-local — so the device that saved it is the one that has to keep them.
//
// One registry scope per saved article, so releasing one never touches an asset
// another saved article (or a pinned filter) still shows.
function savedPinKey(chron: number): string {
   return nav.SAVED_TOKEN + ":" + chron
}

async function syncSavedAssets(chron: number, saved: boolean): Promise<void> {
   const controller = navigator.serviceWorker?.controller
   if (!controller) return // dev / harness / insecure context — the SW is inert
   const store = data.activeStore()
   const key = savedPinKey(chron)
   if (!saved) {
      const toDelete = dropPinScope(key)
      if (toDelete.length) controller.postMessage({ type: "unpin", names: toDelete, base: store.base.href })
      return
   }
   // Warm for the article on screen; one data-pack read when the save came from
   // a list row instead.
   const article = await data.loadArticle(chron)
   // Re-check the set: the un-save path is SYNCHRONOUS, so a star tapped twice
   // over a cold pack runs it to completion inside this await and finds no
   // registry entry to release yet. Pinning after that would leave an un-saved
   // article's media in PINNED — a bucket enforceCacheBounds never touches and
   // only a matching unpin clears — with a registry entry that also makes those
   // names read as "still needed" when some other scope is released.
   if (!nav.isSaved(chron)) return
   const names = extractAssetKeys(article?.c ?? "")
   if (names.length === 0) return
   pinFilter(key, names, store.mid)
   controller.postMessage({ type: "pin", names, base: store.base.href })
   requestPersistentStorage()
}

// Tell the service worker which store roots are mounted (docs/MULTI-STORE-SPEC.md
// §5.1) — the FIX for PWA0: the deployed reader's home base (cdn.llera.eu) is
// cross-origin to its shell origin, so the SW's old origin-equality gate never
// cached a production pack. Posting the mounted roots lets it route + cache them.
// Called on boot, on every mount-table change, and whenever a new SW takes
// control (a fresh worker starts with no roots and falls back to own-origin).
function postMounts(): void {
   const controller = navigator.serviceWorker?.controller
   if (!controller) return // dev / harness / insecure context — the SW is inert anyway
   // Built from the mount TABLE, not the booted stores, so it is valid BEFORE
   // data.init() (which is what lets the SW route a peer's boot fetches). A root
   // that never boots is harmless — the SW just knows it may cache under it.
   const roots = data
      .mountRecords()
      .filter((r) => !r.del)
      .map((r) => ({
         mid: r.id,
         base: r.url,
         cred: r.cred ? "include" : "same-origin",
         role: r.role,
      }))
   controller.postMessage({ type: "mounts", roots })
}

// Returns the pin menu row entry for the current filter, or null when pinning
// is not available (no SW controller, or a saved/search scope).
function pinMenuEntry(): { label: string; action: () => void } | null {
   if (!navigator.serviceWorker?.controller) return null
   if (nav.filter.saved || nav.filter.search) return null
   const key = pinKey()
   if (isPinned(key, data.activeStore().mid)) {
      return { label: "Remove offline copy", action: unpinCurrentFilter }
   }
   return {
      label: "Download for offline",
      action: () => void pinCurrentFilter().catch((e) => showError(e)),
   }
}

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

// RDR1/RDR2 — after a landing (or a Mark all read) has raised the frontier,
// report a LARGE consumption and offer to take it back. Ordinary reading moves
// the frontier by one article and says nothing; what needs a signal is the jump
// that swallows a backlog, which until now happened silently and for good.
//
// Deliberately after the fact and off the navigation path: the size is measured
// with the same tally the badges use (nav.frontierUndoSize), so the number shown
// is the number the badges just lost.
const UNDO_MIN_ARTICLES = 10

async function offerFrontierUndo() {
   const pending = nav.pendingFrontierUndo()
   if (!pending) return
   let consumed: number
   try {
      consumed = await nav.frontierUndoSize(pending)
   } catch {
      return // a count blip is not worth an error popup for an optional offer
   }
   // A newer move superseded it mid-measurement: leave that one to its own
   // render rather than announcing a number we just recomputed against a
   // snapshot nobody is holding.
   if (nav.pendingFrontierUndo() !== pending) return
   // Asked and answered, whether or not it clears the bar below. This runs on
   // EVERY render, and a render that raised no frontier of its own (a step
   // backwards, a filter switch, any read under ★ Saved / search) leaves the
   // previous snapshot pending — so without marking it, one big landing would
   // re-announce itself for the rest of the session.
   nav.markFrontierUndoOffered()
   if (consumed < UNDO_MIN_ARTICLES) return
   showSnackbar(`Marked ${consumed} read`, {
      label: "Undo",
      run: () => {
         hideSnackbar()
         // `pending`, not "whatever is pending now": the button undoes the move
         // whose size it is showing, even if reading has moved a frontier again
         // in the seconds it has been up.
         if (nav.undoFrontierMove(pending)) afterFrontierMove()
      },
   })
}

async function guard(fn: () => Promise<IShowFeed>) {
   const token = acquire()
   if (token === null) return
   document.body.classList.add("srr-loading")
   try {
      const o = await fn()
      // If this op was reclaimed as stale mid-flight (see acquire), a newer holder
      // now owns the surface — don't paint our stale result / error over it.
      if (token === busyToken) render(o)
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

function clearContentTransition() {
   el.content.style.transition = ""
   el.content.style.opacity = ""
   el.content.style.transform = ""
}

// The next pill's pending readout: how much is UNREAD AND AHEAD under the
// active filter — the picker badges' own count with each frontier floored at
// the cursor (nav.pendingRight), so it matches the picker on every recorded
// landing and ticks 3, 2, 1 — by exactly one per forward step, the first step
// included (an unrecorded entry reads one below the badge: the badge counts
// the not-yet-consumed article on screen, the pill counts what → still has).
// It reads an explicit "0" on the last article (greyed on the disabled pill:
// nothing left, said out loud) — and an honest "0" mid-history in show-read
// mode when only read articles remain ahead (Next stays armed off has_right).
// Digits show whenever the count is known (o present and ≥ 0); hidden only on
// a degraded (-1) probe and the dead-end no-article states (the null calls —
// the armed "not started" placeholder keeps its full-backlog digits) — never
// a spinner, never a ghost. The count rides the accessible name rather than a
// separate live region — it changes on navigation, when the button is
// re-announced anyway.
function syncNextCount(o: IShowFeed | null) {
   const n = o ? o.right_count : -1
   el.nextCount.textContent = n >= 0 ? countBadge(n) : ""
   const base = "Next article"
   el.next.setAttribute("aria-label", n >= 0 ? `${base} — ${n} remaining` : base)
   el.next.title = n >= 0 ? `${base} — ${n} remaining (→/D)` : `${base} (→/D)`
}

// Land a freshly rendered article at the top AND resync the toolbar auto-hide
// baseline (reveal it, drop any parked bottom-reveal transform, re-zero the
// scroll baseline — see gestures.resetScroll). The list does this after its own
// programmatic scrolls; the reader must too. Relying on the scrollTo(0,0) scroll
// event alone to reveal the bar is unsound: that event doesn't fire when we're
// already at y=0, and on mobile it can be coalesced or read a stale downward
// delta (URL-bar dynamics) — leaving the toolbar stuck hidden on arrival, with
// no way to scroll up past the top to bring it back.
function scrollReaderTop() {
   window.scrollTo(0, 0)
   gestures?.resetScroll()
}

// The §9.3 compaction tombstone body: an expired article whose payload `srr
// compact` reclaimed. A sibling of the "[DELETED]" feed tombstone (feedTitle) —
// the source · date masthead still renders correctly, only the content is gone.
function expiredTombstone(): HTMLElement {
   const p = document.createElement("p")
   p.className = "srr-expired-note"
   p.textContent = "This article is no longer stored"
   return p
}

// FEB2 — playing media survives prev/next.
//
// Rendering an article REPLACES the content host's children, which destroys any
// <audio>/<video> in it: the backend's #enclosure injects podcast <audio
// controls>, so a single swipe used to kill a playing episode dead with no way
// back to where you were. Harvesting the outgoing elements' positions and
// restoring them on return makes stepping away non-destructive.
//
// It restores POSITION, not playback. Resuming automatically would mean audio
// starting on its own whenever navigation happens to land back on the article —
// including a restored deep link or a two-finger filter cycle — which is the
// behaviour people disable autoplay to avoid. Press play and you continue where
// you were. (Media that keeps playing ACROSS articles is the mini-player,
// RDR16, deliberately a separate piece of work.)
interface MediaState {
   time: number
   rate: number
}
// Keyed by chronIdx, bounded: a long session must not accumulate one entry per
// article ever opened, and the value is only interesting for the handful you
// might step back to.
const mediaStates = makeLRU<MediaState[]>(20)
// The chron whose content is currently mounted, so the harvest knows whose
// positions it is taking. -1 = nothing to harvest (boot, or an empty state).
let mountedChron = -1
// State a restore has QUEUED but not yet applied (currentTime is only settable
// once duration is known). Without this a second render of the same article
// before the metadata lands — a re-route, a post-refresh re-probe — would
// harvest the element's still-untouched values and throw the real ones away.
const pendingRestore = new WeakMap<HTMLMediaElement, MediaState>()

function harvestMediaState(): void {
   if (mountedChron < 0) return
   const chron = mountedChron
   mountedChron = -1
   const media = el.content.querySelectorAll<HTMLMediaElement>("audio,video")
   if (!media.length) return
   const out: MediaState[] = []
   let worthKeeping = false
   media.forEach((m, i) => {
      // A live element speaks for itself; one still waiting on its metadata
      // reports the state that restore queued for it.
      out[i] = m.currentTime
         ? { time: m.currentTime, rate: m.playbackRate }
         : (pendingRestore.get(m) ?? { time: 0, rate: m.playbackRate })
      // An untouched element sits at 0 and has nothing to restore; keeping it
      // would only pin a stale entry in the LRU.
      if (out[i].time > 0) worthKeeping = true
   })
   if (worthKeeping) mediaStates.put(chron, out)
   else mediaStates.drop(chron)
}

function restoreMediaState(chron: number): void {
   const saved = mediaStates.get(chron)
   if (!saved) return
   // Positional pairing: the same immutable article renders the same media in
   // the same order, so index IS the identity (src would break on a re-proxied
   // or re-resolved URL).
   el.content.querySelectorAll<HTMLMediaElement>("audio,video").forEach((m, i) => {
      const s = saved[i]
      if (!s || s.time <= 0) return
      // currentTime is only settable once the element knows its duration;
      // before that the assignment is dropped (or throws in some engines).
      const apply = () => {
         pendingRestore.delete(m)
         try {
            m.currentTime = s.time
            m.playbackRate = s.rate
         } catch {}
      }
      if (m.readyState >= HTMLMediaElement.HAVE_METADATA) apply()
      else {
         pendingRestore.set(m, s)
         m.addEventListener("loadedmetadata", apply, { once: true })
      }
   })
}

function render(o: IShowFeed) {
   showReader()
   // Showing the reader supersedes any pending debounced search query. A row-tap
   // commit can land within the 200ms search debounce; without this the stale
   // timer fires applySearchQuery under the now-hidden list and rewrites the
   // reader's hash to the positionless #!q:<query>, losing the resume position.
   clearTimeout(searchDebounce)
   if (o.placeholder) return renderEmptyReader(o)
   el.article.classList.remove("srr-reader-empty")
   const feed = data.db.feeds[o.article.f]
   // Titleless feeds (Telegram-style: the title is just the content's first
   // line) hide the <h1> in the reader so the body isn't shown twice; the home
   // list still uses the title as its row label. The masthead permalink stands
   // in for the hidden title's link.
   el.article.classList.toggle("srr-reader-titleless", !!feed?.nt)
   // Desk/section: the feed's tag as a hashtag ("#" is real text so it shares
   // the tag's ink; the "·" separator is CSS). Empty for an untagged feed →
   // the .srr-desk row is hidden (:not(:empty)).
   el.desk.textContent = feed?.tag ? "#" + feed.tag : ""
   // t/l are omitempty on the wire — an untitled article must not render "undefined"
   el.title.textContent = o.article.t ?? ""
   el.content.style.transition = "none"
   el.content.style.opacity = "0"
   el.content.style.transform = "translateY(6px)"
   // §9.3 (docs/MANIFEST-SPEC.md): `srr compact` replaces an expired article's
   // payload with a tombstone that keeps f/a/p and DROPS c/t/l — so `c` is
   // absent on the wire (`c` is typed string, but omitempty means undefined at
   // runtime for a compacted line). Reachable only via a ★-Saved / deep-linked
   // expired chron (normal nav filters chron < add_idx). Render an explicit
   // "no longer stored" state — source · date intact, a sibling of feedTitle's
   // "[DELETED]" feed tombstone — instead of the literal "undefined"
   // sanitizeFragment(undefined) would produce.
   const body = o.article.c as string | undefined
   // The outgoing article's media positions, taken BEFORE replaceChildren
   // destroys the elements holding them (see harvestMediaState).
   harvestMediaState()
   // The article's own language (`g` on the wire, from the backend's always-on
   // detection). Without it the whole reader inherits <html lang="en">: a
   // screen reader pronounces a Spanish body in an English voice, hyphenation
   // applies English patterns, and an undeclared-RTL body renders LTR.
   //
   // `g` is absent for anything the detector wasn't confident about and for
   // every article written before 2026-07-19, and the fallback is `lang=""` —
   // which declares the language UNKNOWN, not "inherit". That distinction is
   // the point, and it is deliberate: unknown is what stops `hyphens: auto`
   // (styles.css) from breaking possibly-non-English prose on English patterns,
   // where REMOVING the attribute would inherit <html lang="en"> and do exactly
   // that. renderEmptyReader removes it instead, because reader chrome IS ours
   // to declare.
   //
   // dir=auto lets the browser infer direction from the first strong character,
   // which is the only honest answer when the feed declares none.
   el.content.lang = o.article.g ?? ""
   el.content.dir = "auto"
   // Adopt the sanitized nodes directly — an innerHTML string round-trip would
   // re-parse the whole article on every prev/next step (see sanitizeFragment).
   if (body == null) el.content.replaceChildren(expiredTombstone())
   else el.content.replaceChildren(sanitizeFragment(body, data.activeStore().base))
   mountedChron = nav.currentChron()
   if (mountedChron >= 0) restoreMediaState(mountedChron)
   // Reject javascript:/data:/vbscript:/file: in case the writer pipeline let one
   // through. The whole masthead row (source · date · title) is the one permalink;
   // an href makes it a link, its absence leaves it inert chrome (titleless feeds
   // hide the <h1> but the source · date kicker still carries the link).
   const safeLink = o.article.l && !URL_DENY.test(o.article.l) ? o.article.l : ""
   if (safeLink) el.titleRow.href = safeLink
   else el.titleRow.removeAttribute("href")
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right
   syncNextCount(o)

   // p is omitted (=> undefined) when the writer couldn't parse a date
   const currentPublished = o.article.p ?? 0
   // A recent article leads with its relative age ("5h ago"); an older one leads
   // with the absolute date (an archived dispatch's real date matters more than
   // "5h ago"). Either way the other form is on the hover title — see readerDateline.
   const dateline = currentPublished ? readerDateline(currentPublished) : null
   el.date.textContent = dateline ? dateline.text : ""
   el.date.title = dateline ? dateline.title : ""
   // Hide the date (and its leading "·" separator) in the kicker when undated,
   // so the source name doesn't trail a dangling middot.
   el.date.hidden = !currentPublished

   // Key the reader's masthead to the article's source color (same ramp as the
   // list rails — see styles.css [data-src]).
   el.article.dataset.src = String(srcColorIndex(o.article.f))
   el.source.textContent = data.feedTitle(o.article.f)
   refreshFeedLabel()
   refreshSaveButton(!o.placeholder)

   setTitle("SRR - " + (o.article.t ?? ""))
   scrollReaderTop()
   // A titleless feed hides the <h1>; focusing a display:none element is a no-op,
   // so move focus to the visible body instead to keep the reader region focused.
   // preventScroll: scrollReaderTop() owns the landing position — a bare focus()
   // on a taller-than-viewport body aligns its top with the viewport (CSSOM
   // "nearest"), scrolling the masthead off and auto-hiding the toolbar.
   el.content.tabIndex = -1
   ;(feed?.nt ? el.content : el.title).focus({ preventScroll: true })

   // Double rAF: first ensures the browser has painted with opacity:0, second
   // re-enables transitions so the fade-in animates.
   requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

   persistHash(location.hash)
   // If this landing consumed a backlog, say so and offer one way back (RDR1).
   // Un-awaited: it measures the move against the idx and must not hold up paint.
   void offerFrontierUndo()
   // Reading is what moves the unread total; the badge follows it (RDR12).
   void syncUnreadBadge()
}

// The reader's no-match state. Instead of a bare "(no matching articles)" title
// over an empty body (with a stray "[DELETED]" source for the synthetic feed 0),
// show the SAME directed empty state the list uses (list.emptyStateEl) so both
// surfaces speak one wire voice — search / caught-up / saved / filtered wording,
// keyed off the same nav state. The article chrome (source · date · h1) is hidden
// via .srr-reader-empty; prev/save are disabled — a placeholder has nothing to
// save and no left neighbor. Next follows o.has_right: the dead-end placeholders
// (caught-up / no-match) disable it, but the "not started" one arrives ARMED
// (nav.switchFilter) — a →/D/swipe/click steps onto the first unread, so reading
// starts from the reader without a detour through the list; its pill carries the
// full-backlog count (== the picker badge).
function renderEmptyReader(o: IShowFeed) {
   el.article.classList.add("srr-reader-empty")
   el.article.classList.remove("srr-reader-titleless")
   delete el.article.dataset.src
   el.desk.textContent = ""
   el.title.textContent = ""
   el.titleRow.removeAttribute("href")
   el.prev.disabled = true
   el.next.disabled = !o.has_right
   syncNextCount(o.has_right ? o : null)
   refreshSaveButton(false)

   // Static panel: no fade-in (clear any inline opacity/transform a prior article
   // render left behind), and swap the body for the shared empty-state element.
   clearContentTransition()
   harvestMediaState()
   // Reader chrome, not article prose: the empty state is OUR copy, in the UI's
   // language, so the host goes back to INHERITING <html lang> rather than
   // keeping the last article's. Removing the attribute is what inherits;
   // `lang=""` would declare the language unknown, which is the right answer for
   // an article of uncertain origin (see render) and the wrong one for our own
   // words — it would leave assistive tech picking a fallback voice to read
   // "All caught up" in. `dir` goes with it for the same reason.
   el.content.removeAttribute("lang")
   el.content.removeAttribute("dir")
   el.content.replaceChildren(list.emptyStateEl({ notStarted: o.notStarted, startFeed: o.startFeed }))

   refreshFeedLabel()
   setTitle("SRR")
   scrollReaderTop()
   // The empty state hides the whole title row; focus the (visible) content host,
   // which carries the directed empty-state element.
   el.content.tabIndex = -1
   // keep keyboard focus inside the reader region; preventScroll as in render()
   el.content.focus({ preventScroll: true })
   persistHash(location.hash)
}

// The active mount's display label, or "" when only one store is mounted (the
// single-store case shows no mount prefix — §6.3).
function activeMountName(): string {
   if (data.mountedStores().length <= 1) return ""
   const mid = data.activeStore().mid
   const rec = data.mountRecords().find((r) => r.id === mid)
   return rec ? mountLabel(rec) : mid
}

function refreshFeedLabel() {
   // The article's source now lives in the header kicker, so the toolbar label
   // is the active-filter indicator: "All", a tag name, or a single feed.
   // Search mode is orthogonal to the feed axis (the pinned search bar owns the
   // query), so show the button neutral ("All", unhighlighted) instead of the raw
   // "q:<query>" token getCurrentFilterKey returns.
   const key = nav.isSearchFilter() ? "" : nav.getCurrentFilterKey() // "" (all/multi) | tag name | numeric feed id
   // Multi-store breadcrumb (docs/MULTI-STORE-SPEC.md §6.3): prefix the readout
   // with the active mount "MOUNT · LANE" ONLY when more than one store is
   // mounted — a single-store user sees byte-identical chrome. The mount rides in
   // the early-return cache key so a mount switch repaints even at the same lane.
   const mountName = activeMountName()
   const cacheKey = mountName + " " + key
   if (cacheKey === lastFeedLabel) return
   lastFeedLabel = cacheKey

   const label = nav.filterLabel(key)
   el.feedName.textContent = mountName ? mountName + " · " + label : label
   // A single-feed filter tints the toolbar label with that feed's source
   // color (the wire-desk identity in the toolbar); [ALL]/tag/saved/search stay
   // neutral. The chip-less label still says which source you're viewing.
   const isFeed = /^\d+$/.test(key)
   if (isFeed) el.feed.dataset.src = String(srcColorIndex(Number(key)))
   else delete el.feed.dataset.src
   el.feed.classList.toggle("srr-filter-on", key !== "")
   // The readout is the settings-menu opener: its tooltip / accessible name says
   // so, while still carrying the full filter name (the visible text ellipsizes
   // when long, and an aria-label would otherwise mask it from AT).
   const readoutName = key === "" ? "Settings" : `Settings — viewing: ${label}`
   el.feed.title = readoutName
   el.feed.setAttribute("aria-label", readoutName)

   // Reader breadcrumb: the back button names the filtered list it returns to
   // (#tag / feed name in its source color / ★ Saved) so the reader says which
   // lane prev/next walk. Empty on the unfiltered wire — silence means [ALL],
   // the same rule that keeps the list readout neutral. The span is aria-hidden;
   // the filter rides the button's aria-label/tooltip instead.
   const crumb = key === "" ? "" : isFeed || key === nav.SAVED_TOKEN ? label : "#" + label
   el.backLabel.textContent = crumb
   if (isFeed) el.backLabel.dataset.src = String(srcColorIndex(Number(key)))
   else delete el.backLabel.dataset.src
   const backName = crumb === "" ? "Back to list" : `Back to list — filtered: ${crumb}`
   el.back.setAttribute("aria-label", backName)
   el.back.title = backName
}

// One reconciliation for both seen-frontier gestures (they differ only in the
// direction the frontier moved). Under unread-only the filter membership
// changed (each member's bound re-derives from the moved frontier): re-apply
// the filter, then rebuild the list if it's the visible surface — or just
// invalidate its built window when it's hidden behind the reader (rebuilding a
// display:none list would pin zero row heights; the next show() rebuilds).
// With read items shown the membership is untouched: re-grey the visible rows
// in place (a hidden list re-greys on its return path — show()'s refresh()).
// An open reader re-probes its chrome silently (prev/next + the pending pill
// re-derive from the re-raised bounds; no content re-render, no scroll),
// mirroring refreshAfterStore's reader branch.
function afterFrontierMove() {
   if (nav.isUnreadOnly()) {
      nav.applyFilter([...nav.filter.tokens])
      if (view === "list") void list.rerender()
      else list.invalidate()
   } else if (view === "list") {
      list.refresh()
   }
   void syncUnreadBadge()
   // A frontier move from the ARMED "not started" placeholder (pos is -1, always a
   // single-token filter — the only way nav.switchFilter produces it) re-runs the
   // switch so the surface re-derives — mark-all-read turns it into the caught-up
   // placeholder, Next disarmed. A real article just re-probes its chrome.
   reReadReader()
}

// Silently re-derive the reader's prev/next + pending pill for the article
// already on screen after its filter bounds shift under it (a frontier gesture,
// a Show-read flip) — no content re-render, no scroll. loadArticle(pos) is
// cache-warm, so probeCurrent costs at most an idx/meta probe; the chron guard
// drops a stale probe if navigation moved on in the meantime.
function reprobeReaderChrome() {
   const probed = nav.currentChron()
   void nav
      .probeCurrent()
      .then((o) => {
         if (o && view === "reader" && nav.currentChron() === probed) {
            el.prev.disabled = !o.has_left
            el.next.disabled = !o.has_right
            syncNextCount(o)
         }
      })
      .catch(() => {})
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
      reprobeReaderChrome()
      return
   }
   if (nav.filter.active && nav.filter.tokens.length > 1) return
   void guard(() => nav.switchFilter(nav.getCurrentFilterKey()))
}

// Mark the whole current feed/tag/[ALL] selection read — the frontier menu's
// first action. A pure frontier raise in nav (sync-safe by construction).
function markAllRead() {
   if (!nav.markAllRead()) return
   afterFrontierMove()
   // Rides the same undo as a large landing (RDR2): one gesture, one way back,
   // and no confirm dialog standing in front of the common case.
   void offerFrontierUndo()
}

// The explicit unread rewind — the frontier menu's second action and the
// reader's U key: everything from the current article (inclusive) to the
// latest becomes unread across the current selection — the one gesture allowed
// to lower a seen frontier (nav.markUnreadFrom; plain backward navigation no
// longer does). The reader stays on the article; only its chrome re-derives.
function markUnreadFromHere() {
   const chron = nav.currentChron()
   if (chron >= 0 && nav.markUnreadFrom(chron)) afterFrontierMove()
}

// The frontier menu — both seen-frontier gestures live behind a secondary
// gesture (right-click / long-press / the keyboard menu key), deliberately off
// the visible chrome: occasional whole-backlog actions don't earn a button.
// Its one anchor is the readout of exactly the walk the gestures operate on:
// the reader's next pill (the pending count they raise past or restore). The
// list's lane readout is deliberately NOT an anchor — it's the picker opener,
// and a second meaning there shadowed the browser's own menu. Saved/search are
// seen-neutral peek modes — no items, and the gesture falls through to the
// browser's own menu.
function frontierMenuItems(): { label: string; action: () => void }[] {
   if (nav.filter.saved || nav.isSearchFilter()) return []
   const items: { label: string; action: () => void }[] = []
   if (nav.filter.feeds.size > 0) items.push({ label: "Mark all read", action: markAllRead })
   if (nav.currentChron() >= 0) items.push({ label: "Mark unread from here", action: markUnreadFromHere })
   return items
}

// Wire one frontier-menu anchor. Desktop right-click and Android long-press
// both arrive as `contextmenu` (so does Shift+F10 / the menu key on a focused
// anchor — the menu stays keyboard-reachable); iOS Safari never fires
// contextmenu on non-links, so a touch-held timer covers it there. `held`
// marks a timer-opened menu so the click that follows the finger lift is
// swallowed (it would otherwise also navigate) and so
// a late native contextmenu (Android fires both) doesn't reopen the menu it
// just opened; any new touch resets it.
function bindFrontierMenu(anchor: HTMLElement) {
   let hold = 0
   let held = false
   const open = (): boolean => {
      const items = frontierMenuItems()
      if (items.length > 0) showContextMenu(anchor, items)
      return items.length > 0
   }
   anchor.addEventListener("contextmenu", (e) => {
      clearTimeout(hold)
      if (held || open()) e.preventDefault()
   })
   anchor.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return
      held = false
      clearTimeout(hold)
      hold = window.setTimeout(() => (held = open()), 500)
   })
   for (const ev of ["pointerup", "pointercancel", "pointerleave"])
      anchor.addEventListener(ev, () => clearTimeout(hold))
   anchor.addEventListener(
      "click",
      (e) => {
         if (!held) return
         held = false
         e.preventDefault()
         e.stopImmediatePropagation()
      },
      true,
   )
}

// ── Filter picker & settings menu ─────────────────────────────────────────────

// The now-viewing readout's anchored settings menu — everything the retired
// config surface owned minus the filter picker (its own overlay now, opened
// from the filter button) and the Show-read toggle (moved to the picker's header):
// search, the contextual offline-pin row, and the three dialog openers, with the
// freshness / status readout as a quiet footer. Items derive fresh on every open
// (pin label, search availability), so nothing needs re-rendering in place.
function settingsMenuItems(): MenuItem[] {
   const items: MenuItem[] = [
      // Search leaves the menu for the list with the search bar open; inert
      // (listed but disabled) while the meta index is still rebuilding.
      { label: "Search articles…", action: () => void enterSearch(), disabled: !nav.searchAvailable() },
   ]
   const pin = pinMenuEntry()
   if (pin) items.push(pin)
   items.push(
      { label: "Stores…", action: openMountsDialog },
      { label: "Image proxy…", action: showImgProxyDialog },
      { label: "Backup / Restore…", action: () => showBackupDialog() },
      { label: "Sync…", action: showSyncDialog },
   )
   return items
}

// The per-mount state chip for the Stores dialog (docs/MULTI-STORE-SPEC.md §8.3),
// same wording as the picker switcher's mountChip.
function mountChipText(mid: string): string {
   const s = data.mountStatus(mid)
   if (s.state === "ok") return ""
   if (s.kind === "toonew") return "Too new"
   if (s.kind === "offline") return navigator.onLine === false ? "Offline" : "Unreachable"
   return "Error"
}

// Apply a changed mount table: adopt it in data (boots new mounts, drops gone
// ones), re-post the roots to the SW (§5.1), and repaint an open picker. The
// list/reader keep their current lane unless it was unmounted (data falls back
// to home), so no forced re-render here.
function afterMountChange(recs: MountRecord[]): void {
   void data.applyMountTable(recs).then(() => {
      postMounts()
      if (picker.isOpen()) picker.render()
   })
}

// Open the Stores dialog (§3): mount by URL, unmount a peer, or forget its
// history. The dialog is pure UI; app.ts owns the mounts.ts mutations here.
function openMountsDialog(): void {
   showMountsDialog({
      list: () =>
         data
            .mountRecords()
            .filter((r) => !r.del)
            .map((r) => ({ id: r.id, url: r.url, label: r.label, role: r.role, chip: mountChipText(r.id) })),
      add: (url) => {
         const res = addMount(data.mountRecords(), url)
         if (!res) return "Enter a full https:// store URL"
         afterMountChange(res.records)
         return null
      },
      remove: (mid) => afterMountChange(removeMount(data.mountRecords(), mid)),
      forget: (mid) => {
         // Drop this mount's pinned SW-cache entries BEFORE forgetStoreState
         // clears pinsKey(mid) — that registry is the only record of those
         // cached URLs, and the PINNED bucket is eviction-exempt, so a
         // pinned-then-forgotten peer would otherwise leak its bytes forever.
         // The mount's own url gives the same base the pin used (Store.base is
         // new URL(url)), so the SW resolves the identical absolute URLs; unpin
         // needs no live root (it deletes unconditionally, unlike pin).
         const controller = navigator.serviceWorker?.controller
         const rec = data.mountRecords().find((r) => r.id === mid)
         if (controller && rec) {
            const names = [...new Set([...listPins(mid).values()].flatMap((e) => e.names))]
            if (names.length) controller.postMessage({ type: "unpin", names, base: new URL(rec.url).href })
         }
         forgetStoreState(mid)
         afterMountChange(removeMount(data.mountRecords(), mid))
      },
   })
}

// The footer node of the open settings menu, kept so the sync status callback
// can refresh the readout in place while the menu is up; stale once the menu
// closes (isConnected gates the refill).
let settingsStatus: HTMLElement | null = null

function openSettingsMenu() {
   const footer = document.createElement("div")
   picker.renderStatus(footer)
   settingsStatus = footer
   showContextMenu(el.feed, settingsMenuItems(), { footer })
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
   refreshFeedLabel()
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
      syncSearchBar()
   }
}

// A well-formed reader position: the hash's position part (nav.hashPos) is a
// bare integer. Shared by route() below and the boot foreign-hash guard.
const INT_POS = /^-?\d+$/

// Hash → surface. A numeric position routes to the reader (deep-link or restored
// reading position); anything else (empty, or just `!tokens`) is the list at
// that filter.
async function route(hash: string) {
   // A URL-driven filter change (hashchange / back-forward) also supersedes any
   // pending debounced query — see selectFilter.
   clearTimeout(searchDebounce)
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
   clearTimeout(searchDebounce)
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

// ── Title search (list filter mode) ──────────────────────────────────────────
// The toolbar magnifier / `/` toggle a "q:<query>" filter (nav search mode): the
// list renders the matching articles and the reader walks them, all via the
// shared #!q:<query> hash. A search bar pinned atop the list owns the input;
// typing updates the query in place (debounced, replaceState) so each keystroke
// re-renders results without spamming history, while entering/leaving search is
// a single history step. The bar lives outside .srr-list, so list.rerender
// (which clears .srr-list) never disturbs the focused input.

function toggleSearch() {
   if (view === "list" && nav.isSearchFilter()) void exitSearch()
   else void enterSearch()
}

async function enterSearch() {
   if (!nav.searchAvailable()) return
   await selectFilter(nav.SEARCH_PREFIX) // one history step into search; the bar drives the query
   el.searchInput.focus()
}

function exitSearch() {
   return selectFilter("")
}

async function applySearchQuery(q: string) {
   clearTimeout(searchDebounce)
   // Defense in depth against a debounce that fired after the user already left
   // search (e.g. opened an article): only the list-search surface owns the query.
   if (view !== "list" || !nav.isSearchFilter()) return
   nav.applyFilter([nav.SEARCH_PREFIX + q])
   const h = "#" + nav.tokensSuffix()
   history.replaceState(null, "", h)
   persistHash(h)
   setTitle(listTitle())
   try {
      await list.rerender()
   } catch (e) {
      showError(e, () => void applySearchQuery(q))
      return
   }
   syncSearchBar()
}

// Reflect the active search state into the bar: show/hide it (CSS gates display
// on body.srr-searching + .srr-view-list), seed the input from the query (unless
// the user is mid-type), and surface the short-query / truncation hint. (Search is
// entered from the settings menu's "Search articles…" row, not a toolbar button.)
function syncSearchBar() {
   const on = nav.isSearchFilter()
   document.body.classList.toggle("srr-searching", on && view === "list")
   if (!on) {
      el.searchNote.hidden = true
      return
   }
   const q = nav.searchQuery()
   if (document.activeElement !== el.searchInput) el.searchInput.value = q
   let note = ""
   if (q && nav.searchShort(q))
      note = "Short words search only recent articles — type a longer word to reach the archive."
   else if (nav.searchTruncated()) note = "Showing the most recent matches — refine to reach older ones."
   el.searchNote.textContent = note
   el.searchNote.hidden = !note
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
      // would no-op and leave it stale). Shared with afterFrontierMove.
      reReadReader()
   }
}

// Two-finger vertical swipe = step the filter. In the reader, cycle to the next
// filter's article; on the list, re-filter the list to the next entry.
function onCycle(dir: number) {
   // The two-finger cycle gesture must not re-filter the list that sits under
   // the open picker overlay (same input-leak class as the keyboard and
   // one-finger-swipe guards).
   if (picker.isOpen()) return
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

// Margin bell — a step toward an edge with no neighbor (prev/next disabled) kicks
// the reader toward that wall and springs it back, and pulses the dead control,
// so a swipe or arrow at the first/last article reads as a boundary instead of a
// dropped input — the reader's counterpart to the list's row bump (list.ts
// bumpEdge). Reduced motion drops the kick (styles.css); the greyed button stays
// as the static cue.
function bumpReaderEdge(side: "prev" | "next") {
   const bell = side === "prev" ? "srr-bell-left" : "srr-bell-right"
   el.article.classList.remove("srr-bell-left", "srr-bell-right")
   void el.article.offsetWidth // force reflow so a rapid repeat restarts the keyframes
   el.article.classList.add(bell)
   const btn = side === "prev" ? el.prev : el.next
   btn.classList.remove("srr-edge-pulse")
   void btn.offsetWidth
   btn.classList.add("srr-edge-pulse")
   setTimeout(() => {
      el.article.classList.remove(bell)
      btn.classList.remove("srr-edge-pulse")
   }, 240) // > the 0.22s animations
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
const stepLeft = () => {
   if (view !== "reader" || picker.isOpen()) return
   return el.prev.disabled ? bumpReaderEdge("prev") : guard(() => nav.left())
}
const stepRight = () => {
   if (view !== "reader" || picker.isOpen()) return
   return el.next.disabled ? bumpReaderEdge("next") : guard(() => nav.right())
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
   u: () => markUnreadFromHere(),
   f: () => {
      if (!el.titleRow.getAttribute("href")) return
      el.titleRow.dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }),
      )
   },
}

async function init() {
   // Tell the SW its mounted roots BEFORE data.init() (the PWA0 fix, §5.1): the
   // roots come from the mount TABLE (valid pre-init), so a peer store's boot
   // fetches — kicked inside data.init() — are already routed + cached by the SW
   // instead of passing through uncached. Re-posted after init (reconcile may
   // change the table) and on controllerchange.
   postMounts()
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
      if (mountsChanged) afterMountChange(loadMounts())
      nav.pruneSeen()
      refreshSaveButton(!el.save.disabled)
      if (view === "list" && !hasInteracted && !nav.filter.saved && !nav.filter.search) {
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
         nav.applyFilter([...nav.filter.tokens])
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
   const refreshAfterStore = () => {
      refreshFeedLabel()
      if (view === "reader") reprobeReaderChrome()
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
   nav.setSavedHook((chron, saved) => void syncSavedAssets(chron, saved).catch(() => {}))

   // The filter picker overlay: a pick closes it and routes per surface — from
   // the list, selectFilter re-filters the LIST in place (pushes the #!filter
   // history entry; you land back on the headlines under the new lane); from
   // the reader, switchFilter stays IN the reader on the picked lane's resume
   // article (the same semantics as the W/S / two-finger filter cycle — see
   // onCycle). ✕ / Escape just close it — the surface underneath never moved.
   // The settings that used to share this surface live in openSettingsMenu.
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
   )

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   el.next.addEventListener("click", () => guard(() => nav.right()))
   // The frontier menu rides the reader's next pill as a secondary gesture —
   // its only anchor; see frontierMenuItems.
   bindFrontierMenu(el.next)
   // A plain tap on the lane readout (list-only — hidden in the reader) opens
   // the anchored settings menu: search · offline pin · the three dialogs, with
   // the status readout as its footer. Its right-click / long-press stays the
   // browser's own menu (deliberately not a frontier-menu anchor — see
   // frontierMenuItems).
   el.feed.addEventListener("click", () => openSettingsMenu())
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
   el.snackbarAction.addEventListener("click", () => snackbarAction?.())
   // Search lives in the settings menu (the "Search articles…" row → enterSearch);
   // the `/` key still toggles it on the list. The pinned search bar owns the input
   // (debounced live query, Enter applies immediately, Escape / ✕ leave search).
   el.searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce)
      searchDebounce = setTimeout(() => void applySearchQuery(el.searchInput.value), 200)
   })
   el.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
         e.preventDefault()
         void applySearchQuery(el.searchInput.value)
      } else if (e.key === "Escape") {
         // Stop the document-level Escape handler from also acting; leave search.
         e.preventDefault()
         e.stopPropagation()
         void exitSearch()
      }
   })
   el.searchClear.addEventListener("click", () => void exitSearch())
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
            toggleSearch()
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
   // Cross-device sync: run the LWW profile cycle (pull-adopt when the remote is
   // newer, guarded push when local changes are pending) only after the first
   // surface has rendered (local state is authoritative and paints instantly;
   // an adopt rerenders when it lands), then keep cycling on tab re-focus and
   // reconnect, flushing pending pushes on hide. No-op until a sync endpoint is
   // configured (settings menu → Sync). The status callback refills the footer
   // of a settings menu that happens to be open when a cycle lands; a closed
   // menu's footer is disconnected and skipped (it rebuilds on the next open).
   sync.init(refreshAfterMerge, () => {
      if (settingsStatus?.isConnected) picker.renderStatus(settingsStatus)
   })
   // Live content sync: boot is already fresh (data.init just ran), so only the
   // ongoing triggers are wired — re-focus (throttled), reconnect, heartbeat.
   // The third callback repaints the picker when a background PEER poll changed
   // shape (its unread rollups), without touching the active lane.
   refresh.init(guardBg, refreshAfterStore, () => {
      if (picker.isOpen()) picker.render()
   })

   // Tell the SW its mounted roots (the PWA0 fix, §5.1). A controller may not be
   // active yet on a first visit, so also post whenever a worker takes control.
   postMounts()
   // ONE controllerchange listener, in this order: the mount roots first (a
   // fresh worker starts with none and would otherwise route nothing), then the
   // update notice. A second listener would race this one for that ordering.
   // A `let`, re-read after every takeover: a session long enough to see TWO
   // worker activations must be told about the second one too, and a value
   // captured once at boot would suppress every change after the first.
   let hadController = !!navigator.serviceWorker?.controller
   navigator.serviceWorker?.addEventListener("controllerchange", () => {
      postMounts()
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
