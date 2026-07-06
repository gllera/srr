import * as config from "./config"
import * as data from "./data"
import { setProfileImportHook, showBackupDialog, showImgProxyDialog, showSyncDialog } from "./dropdown"
import { collapseBrokenMedia, countBadge, formatDate, sanitizeHtml, srcColorIndex, timeAgo, URL_DENY } from "./fmt"
import { setupGestures, type Gestures } from "./gestures"
import { UNREAD_ONLY_KEY } from "./keys"
import * as list from "./list"
import * as nav from "./nav"
import { clearAllPins, isPinned, listPins, pinFilter, unpinFilter } from "./pin"
import * as refresh from "./refresh"
import * as sync from "./sync"

const el = {
   article: document.querySelector(".srr-reader") as HTMLElement,
   listView: document.querySelector(".srr-list") as HTMLElement,
   config: document.querySelector(".srr-config") as HTMLElement,
   back: document.querySelector(".srr-back") as HTMLButtonElement,
   backLabel: document.querySelector(".srr-back-label") as HTMLElement,
   openReader: document.querySelector(".srr-open-reader") as HTMLButtonElement,
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleLink: document.querySelector(".srr-title-link") as HTMLAnchorElement,
   kickerLink: document.querySelector(".srr-kicker-link") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   nextCount: document.querySelector(".srr-next-count") as HTMLElement,
   feed: document.querySelector(".srr-feed") as HTMLElement,
   settings: document.querySelector(".srr-settings") as HTMLButtonElement,
   source: document.querySelector(".srr-source") as HTMLElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   desk: document.querySelector(".srr-desk") as HTMLElement,
   searchInput: document.querySelector(".srr-search-input") as HTMLInputElement,
   searchClear: document.querySelector(".srr-search-clear") as HTMLButtonElement,
   searchNote: document.querySelector(".srr-search-note") as HTMLElement,
   save: document.querySelector(".srr-save") as HTMLButtonElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
   pinProgress: document.querySelector(".srr-pin-progress") as HTMLElement,
}

// Which surface is showing. The list is home; the reader is the drill-down; the
// config surface (ephemeral, opened from the list) is the settings + nav hub.
let view: "list" | "reader" | "config" = "list"
// Set once gestures are wired; the list calls it after a programmatic scroll so
// the toolbar-hide baseline stays in sync (declared up here so list.setup, wired
// before setupGestures runs, can close over it).
let gestures: Gestures | null = null
let busy = false
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
   // A dedicated node (.srr-pin-progress), separate from config.ts's role=status
   // freshness line (.srr-config-status). Per-pack ticks stay SILENT (no live
   // role) so they don't flood screen readers or clobber that status message;
   // only the final outcome becomes a role=status live region, so the single
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
      // copy" entry over bytes that were never saved. Re-render the open config
      // so the row reflects the true outcome.
      if (e.data.done >= e.data.total) {
         if ((e.data.cached ?? 0) > 0) pinFilter(key, names)
         else unpinFilter(key)
         if (config.isOpen()) config.render()
      }
   }
   controller.postMessage({ type: "pin", names }, [port2])
   showPinProgress(0, names.length)
}

function unpinCurrentFilter(): void {
   const controller = navigator.serviceWorker?.controller
   const key = pinKey()
   // Read the stored names before removing the registry entry, then subtract any
   // name still referenced by another pinned scope: the shared latest packs
   // (idx/L, data/L, meta/L) and any overlapping finalized packs/assets must NOT
   // be deleted while a different active pin still needs them. Only the names
   // unique to this scope are dropped from the SW cache.
   const pins = listPins()
   const names = pins.get(key)?.names ?? []
   const stillNeeded = new Set<string>()
   for (const [k, entry] of pins) if (k !== key) for (const n of entry.names) stillNeeded.add(n)
   const toDelete = names.filter((n) => !stillNeeded.has(n))
   unpinFilter(key)
   if (controller) controller.postMessage({ type: "unpin", names: toDelete })
   // Re-render the open config surface so the pin row flips to "Download for
   // offline" now that the cached copy is gone.
   if (config.isOpen()) config.render()
}

// Returns the pin menu row entry for the current filter, or null when pinning
// is not available (no SW controller, or a saved/search scope).
function pinMenuEntry(): { label: string; action: () => void } | null {
   if (!navigator.serviceWorker?.controller) return null
   if (nav.filter.saved || nav.filter.search) return null
   const key = pinKey()
   if (isPinned(key)) {
      return { label: "Remove offline copy", action: unpinCurrentFilter }
   }
   return {
      label: "Download for offline",
      action: () => void pinCurrentFilter().catch((e) => showError(e)),
   }
}

function showReader() {
   view = "reader"
   document.body.classList.remove("srr-view-list", "srr-view-config")
   config.close()
   el.listView.hidden = true
   el.article.hidden = false
}

function showList() {
   view = "list"
   document.body.classList.add("srr-view-list")
   document.body.classList.remove("srr-view-config")
   config.close()
   el.article.hidden = true
   el.listView.hidden = false
   // Disable the reader-only nav so a one-finger swipe / arrow key is a no-op
   // while the list scrolls natively (the buttons are also hidden via CSS).
   el.prev.disabled = true
   el.next.disabled = true
}

// The config surface stacks over the list (srr-view-list stays on underneath so
// the list keeps its state); srr-view-config hides the toolbar, but the
// pin-progress toast stays visible — the pin is triggered from here, so its
// progress/outcome feedback must show — and config.open() reveals + (re)renders
// the panel.
function showConfig() {
   view = "config"
   document.body.classList.add("srr-view-config")
   el.article.hidden = true
   el.listView.hidden = true
   config.open()
}

// Leave the config surface back to the article (reader) surface — the Escape /
// close-button path. enterReader resolves the right article (current, else the
// list's selected row, else the filter's oldest unseen, else newest).
function closeConfig() {
   document.body.classList.remove("srr-view-config")
   config.close()
   void enterReader()
}

// The shared "go to the article surface" resolver, reused by every → reader
// transition (Escape from the list, Escape/close from config). Opens the reader
// at the current reader/selected article when there is one, else the filter's
// oldest-unseen article (start of the backlog), else its newest.
async function enterReader() {
   const chron = nav.currentChron()
   if (chron >= 0) return guard(() => nav.goTo(chron))
   const anchor = await nav.listAnchor() // oldest unseen, else -1 (newest)
   return anchor >= 0 ? guard(() => nav.goTo(anchor)) : guard(() => nav.last())
}

function persistHash(hash: string) {
   try {
      localStorage.setItem("srr-hash", hash)
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

async function guard(fn: () => Promise<IShowFeed>) {
   if (busy) return
   busy = true
   document.body.classList.add("srr-loading")
   try {
      render(await fn())
   } catch (e) {
      showError(e, () => guard(fn))
   } finally {
      document.body.classList.remove("srr-loading")
      busy = false
   }
}

// The background variant of guard(): same busy mutex, no render/error popup — a
// caller that loses the race is skipped, not queued (its next trigger retries).
// Used by the store refresh so a state swap can't interleave with navigation.
async function guardBg(fn: () => Promise<void>): Promise<boolean> {
   if (busy) return false
   busy = true
   try {
      await fn()
      return true
   } finally {
      busy = false
   }
}

function clearContentTransition() {
   el.content.style.transition = ""
   el.content.style.opacity = ""
   el.content.style.transform = ""
}

// The next pill's pending readout: how many articles are still AHEAD under the
// active filter — the settings badges' own counting (nav.pendingRight routes
// through it) minus the article on screen, so it ticks 3, 2, 1 and reads an
// explicit "0" on the last article (greyed on the disabled pill: nothing ahead,
// said out loud). Digits show whenever the count is known (o present and ≥ 0);
// hidden only on a degraded (-1) probe and the no-article states (placeholder /
// empty reader, the null calls) — never a spinner, never a ghost. The count
// rides the accessible name rather than a separate live region — it changes on
// navigation, when the button is re-announced anyway.
function syncNextCount(o: IShowFeed | null) {
   const n = o ? o.right_count : -1
   el.nextCount.textContent = n >= 0 ? countBadge(n) : ""
   const base = "Next article"
   el.next.setAttribute("aria-label", n >= 0 ? `${base} — ${n} remaining` : base)
   el.next.title = n >= 0 ? `${base} — ${n} remaining (→/D)` : `${base} (→/D)`
}

function render(o: IShowFeed) {
   showReader()
   // Showing the reader supersedes any pending debounced search query. A row-tap
   // commit can land within the 200ms search debounce; without this the stale
   // timer fires applySearchQuery under the now-hidden list and rewrites the
   // reader's hash to the positionless #!q:<query>, losing the resume position.
   clearTimeout(searchDebounce)
   if (o.placeholder) return renderEmptyReader()
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
   el.content.innerHTML = sanitizeHtml(o.article.c)
   // Reject javascript:/data:/vbscript:/file: in case the writer pipeline let one
   // through. Both the title link and the titleless masthead permalink point at
   // the same article URL; CSS shows whichever one this feed uses.
   const safeLink = o.article.l && !URL_DENY.test(o.article.l) ? o.article.l : ""
   for (const a of [el.titleLink, el.kickerLink]) {
      if (safeLink) a.href = safeLink
      else a.removeAttribute("href")
   }
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right
   syncNextCount(o)

   // p is omitted (=> undefined) when the writer couldn't parse a date
   const currentPublished = o.article.p ?? 0
   // The reader carries an absolute dateline (you're reading an archived
   // dispatch, so the real date matters more than "5h ago"); the relative age
   // moves to the hover title.
   el.date.textContent = currentPublished ? formatDate(currentPublished) : ""
   el.date.title = currentPublished ? timeAgo(currentPublished) : ""
   // Hide the date (and its leading "·" separator) in the kicker when undated,
   // so the source name doesn't trail a dangling middot.
   el.date.hidden = !currentPublished

   // Key the reader's masthead to the article's source color (same ramp as the
   // list rails — see styles.css [data-src]).
   el.article.dataset.src = String(srcColorIndex(o.article.f))
   el.source.textContent = data.feedTitle(o.article.f)
   refreshFeedLabel()
   refreshSaveButton(!o.placeholder)

   document.title = "SRR - " + (o.article.t ?? "")
   window.scrollTo(0, 0)
   // A titleless feed hides the <h1>; focusing a display:none element is a no-op,
   // so move focus to the visible body instead to keep the reader region focused.
   el.content.tabIndex = -1
   ;(feed?.nt ? el.content : el.title).focus()

   // Double rAF: first ensures the browser has painted with opacity:0, second
   // re-enables transitions so the fade-in animates.
   requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

   persistHash(location.hash)
}

// The reader's no-match state. Instead of a bare "(no matching articles)" title
// over an empty body (with a stray "[DELETED]" source for the synthetic feed 0),
// show the SAME directed empty state the list uses (list.emptyStateEl) so both
// surfaces speak one wire voice — search / caught-up / saved / filtered wording,
// keyed off the same nav state. The article chrome (source · date · h1) is hidden
// via .srr-reader-empty; prev/next/save are disabled — a placeholder has no
// neighbors to step to and nothing to save.
function renderEmptyReader() {
   el.article.classList.add("srr-reader-empty")
   el.article.classList.remove("srr-reader-titleless")
   delete el.article.dataset.src
   el.desk.textContent = ""
   el.title.textContent = ""
   el.titleLink.removeAttribute("href")
   el.kickerLink.removeAttribute("href")
   el.prev.disabled = true
   el.next.disabled = true
   syncNextCount(null)
   refreshSaveButton(false)

   // Static panel: no fade-in (clear any inline opacity/transform a prior article
   // render left behind), and swap the body for the shared empty-state element.
   clearContentTransition()
   el.content.replaceChildren(list.emptyStateEl())

   refreshFeedLabel()
   document.title = "SRR"
   window.scrollTo(0, 0)
   // The empty state hides the whole title row; focus the (visible) content host,
   // which carries the directed empty-state element.
   el.content.tabIndex = -1
   el.content.focus() // keep keyboard focus inside the reader region
   persistHash(location.hash)
}

function refreshFeedLabel() {
   // The article's source now lives in the header kicker, so the toolbar label
   // is a pure active-filter indicator: "All", a tag name, or a single feed.
   // Search mode is orthogonal to the feed axis (the pinned search bar owns the
   // query), so show the button neutral ("All", unhighlighted) instead of the raw
   // "q:<query>" token getCurrentFilterKey returns.
   const key = nav.isSearchFilter() ? "" : nav.getCurrentFilterKey() // "" (all/multi) | tag name | numeric feed id
   if (key === lastFeedLabel) return
   lastFeedLabel = key

   const label = nav.filterLabel(key)
   el.feed.textContent = label
   // A single-feed filter tints the toolbar label with that feed's source
   // color (the wire-desk identity in the toolbar); [ALL]/tag/saved/search stay
   // neutral. The chip-less label still says which source you're viewing.
   const isFeed = /^\d+$/.test(key)
   if (isFeed) el.feed.dataset.src = String(srcColorIndex(Number(key)))
   else delete el.feed.dataset.src
   el.feed.classList.toggle("srr-filter-on", key !== "")
   // Tooltip shows the full filter name when a long one ellipsizes; the label is
   // non-interactive, so its visible text is its accessible name (no aria-label).
   el.feed.title = key === "" ? "All feeds" : `Filtered: ${label}`

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
   if (busy) return
   busy = true
   // Returning FROM THE READER (back button, browser-back) centers + highlights
   // the article you were reading; arriving via a filter change / boot (view was
   // already "list") keeps the top-aligned anchor. Captured before showList()
   // flips view to "list".
   const center = view === "reader"
   showList()
   refreshFeedLabel()
   document.title = listTitle()
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
      document.body.classList.remove("srr-loading")
      busy = false
   }
   try {
      await list.show(center, onInteractive)
   } catch (e) {
      showError(e, () => void renderListSurface())
   } finally {
      if (!interactive) {
         document.body.classList.remove("srr-loading")
         busy = false
      }
      syncSearchBar()
   }
}

// Hash → surface. A numeric position routes to the reader (deep-link or restored
// reading position); anything else (empty, or just `!tokens`) is the list at
// that filter.
async function route(hash: string) {
   // A URL-driven filter change (hashchange / back-forward) also supersedes any
   // pending debounced query — see selectFilter.
   clearTimeout(searchDebounce)
   const bang = hash.indexOf("!")
   const posStr = bang === -1 ? hash : hash.substring(0, bang)
   if (posStr !== "" && /^-?\d+$/.test(posStr)) {
      await guard(() => nav.fromHash(hash))
      return
   }
   const tokens = nav.parseHashTokens(hash)
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
// restores its saved scroll for the active filter.
async function goToList(push: boolean) {
   // Bail BEFORE mutating history/localStorage: renderListSurface also checks
   // busy, but the pushState/persistHash below would already have rewritten the
   // URL to a filter the dropped render never painted, desyncing URL from view.
   if (busy) return
   const h = "#" + nav.tokensSuffix()
   history[push ? "pushState" : "replaceState"](null, "", h)
   persistHash(h)
   await renderListSurface()
}

async function selectFilter(token: string) {
   // Bail BEFORE applyFilter/goToList: goToList drops on busy, but applyFilter
   // would already have mutated nav.filter (and goToList's pushState the URL) for
   // a render that never ran. Dropping the whole handler keeps filter+URL+view
   // consistent — same mutex discipline as guard() for reader actions.
   if (busy) return
   // Any explicit filter change cancels a still-pending debounced search query;
   // otherwise typing then leaving search (✕ / Escape / the magnifier, but also a
   // feed-menu pick or a two-finger/arrow cycle, which all land here) within
   // the debounce window lets the stale applySearchQuery fire ~200ms later and
   // bounce the list back into search. Typing itself never routes through here.
   clearTimeout(searchDebounce)
   nav.applyFilter(token === "" ? [] : [token])
   await goToList(true)
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
   document.title = listTitle()
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
// entered from the config "Search articles…" row, not a toolbar button now.)
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

// The unread (catch-up) toggle now lives in the config surface as the inverted
// "Read" button: unread-only is the default view, and pressing "Read" turns it
// off to ALSO show already-read articles. config's onUnreadToggle hook flips the
// mode and rebuilds the list. Unseen-only spans every filter ([ALL]/feed/tag).
function toggleUnseenOnly() {
   // setUnreadOnly re-applies the filter (raised/restored bounds) internally;
   // force a rebuild since the token set is unchanged (list.show() alone would
   // only refresh dots).
   nav.setUnreadOnly(!nav.isUnreadOnly())
   void list.rerender()
}

// Two-finger vertical swipe = step the filter. In the reader, cycle to the next
// filter's article; on the list, re-filter the list to the next entry.
function onCycle(dir: number) {
   // The two-finger cycle gesture must not drive the reader that sits hidden
   // behind the open config surface (same input-leak class as the keyboard and
   // one-finger-swipe guards).
   if (view === "config") return
   if (nav.getFilterEntries().length <= 1) return
   // cycleToken steps relative to cycleOriginKey (a single tagged-feed filter
   // cycles by its tag), so the list and the reader share one rotation.
   if (view === "list") void selectFilter(nav.cycleToken(dir))
   else guard(() => nav.cycleFilter(dir))
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
// (gestures' goPrev/goNext). They act only on the reader surface: gating on
// view !== "reader" makes a swipe over the LIST (where prev/next are disabled, so
// it would otherwise ring the hidden reader's margin bell on a forced reflow) or
// over the open settings surface a clean no-op, instead of driving the reader
// stacked behind them. The keyboard never reaches these off the reader — the list
// branch and the config guard in the keydown handler both return first.
const stepLeft = () => {
   if (view !== "reader") return
   return el.prev.disabled ? bumpReaderEdge("prev") : guard(() => nav.left())
}
const stepRight = () => {
   if (view !== "reader") return
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
   f: () => {
      if (!el.titleLink.getAttribute("href")) return
      el.titleLink.dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }),
      )
   },
}

async function init() {
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

   // Shared refresh after any profile merge — a backup import or a sync pull
   // that changed local state: prune stale seen keys, refresh the save button,
   // rebuild the list under the current filter, and re-derive an open config
   // surface (unread badges + sync status). The reader view skips the list
   // rebuild — the return path (show() → refresh()) re-derives per-row state
   // anyway, and rebuilding a display:none list would pin zero row heights.
   const refreshAfterMerge = () => {
      nav.pruneSeen()
      refreshSaveButton(!el.save.disabled)
      if (view !== "reader") void list.rerender()
      if (config.isOpen()) config.render()
   }

   // Shared reconciliation after a store refresh adopted a newer db.gz — the
   // fully-silent contract: no reload, no scroll, no content re-render. The
   // toolbar label re-derives, the reader's prev/next chrome re-probes (a cached
   // "no newer article" is exactly what new content invalidates), the list
   // reopens its top, and an open config repaints its freshness line.
   const refreshAfterStore = () => {
      refreshFeedLabel()
      if (view === "reader") {
         // A prev/next step during the probe window supersedes it: re-check the
         // probed position so stale chrome is never stamped over the new article.
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
      } else {
         void list.onStoreGrown()
      }
      if (config.isOpen()) config.render()
   }

   // Sync now (config quick-action): make this browser current in both
   // directions — the content refresh and a manual (pure-LWW, always-push)
   // profile cycle, run concurrently (they're independent). Content errors get
   // the popup (the one user-initiated path); sync errors stay on the status
   // line as always. Config stays open so its freshness line confirms the result.
   // Either half can silently no-op: the content refresh busy-skips when a
   // navigation holds the mutex, and syncNow skips when a cycle is inflight —
   // both recoverable by re-tapping, same posture as sync's documented no-op.
   const manualSyncNow = async () => {
      const [contentErr] = await Promise.all([refresh.refreshNow(), sync.syncNow({ manual: true })])
      // No explicit config repaint: on real changes refreshAfterStore /
      // refreshAfterMerge already re-render an open config, and a no-change
      // cycle repaints the sig-guarded status footer via sync's onStatus hook —
      // an unconditional render() here would only re-kick the filter-list
      // rebuild redundantly.
      if (contentErr) showError(new Error(contentErr), () => void manualSyncNow())
   }
   // After a successful profile import (backup dialog), additionally reconcile
   // prefs: importProfile wrote srr-unread-only straight to localStorage, but nav
   // holds unreadOnly in a module var only mutated via setUnreadOnly (this also
   // re-applies the filter so the raised unseen bounds take hold). Sync pulls
   // never touch prefs (prefs:false), so they skip this.
   setProfileImportHook(() => {
      nav.setUnreadOnly(localStorage.getItem(UNREAD_ONLY_KEY) === "1")
      refreshAfterMerge()
   })

   // The config surface: the filter picker, the unread toggle, the settings rows
   // (offline pin / backup / image proxy), and the freshness status. pinEntry is
   // evaluated lazily at render so its label reflects the current filter's pin
   // state (null when pinning is unavailable — no SW controller, saved/search).
   config.setup(el.config, {
      onSearch: () => {
         // Search is a list activity: enterSearch → selectFilter → goToList
         // switches to the list surface (closing config) with the search bar open.
         void enterSearch()
      },
      onSelect: (token) => {
         // A filter pick opens the article (reader) surface at that filter's resume
         // position — switchFilter is the reader's own "go to this filter" op (the
         // same primitive the two-finger / arrow filter-cycle uses), so the picked
         // feed/tag resumes where you left off (its first/newest if never read) and
         // [ALL] opens at the oldest unseen article, not the list overview. guard()'s
         // render() swaps to the reader (closing config) once the article resolves;
         // an empty feed degrades to the "(no matching articles)" placeholder.
         void guard(() => nav.switchFilter(token))
      },
      onUnreadToggle: () => {
         toggleUnseenOnly()
         // Re-render the open config filter list so its unread badges / hidden
         // fully-read rows reflect the flipped mode immediately.
         config.render()
      },
      onClose: closeConfig,
      pinEntry: pinMenuEntry,
      openImgProxy: showImgProxyDialog,
      openBackup: () => showBackupDialog(),
      openSync: showSyncDialog,
      onRefresh: () => void manualSyncNow(),
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
   el.back.addEventListener("click", () => void goToList(true))
   // The list's open-article button (left edge) is the tap counterpart of Escape on
   // the list: enter the reader at the article you were reading (enterReader resolves
   // current → oldest-unseen → newest), mirroring the reader's back-to-list button.
   el.openReader.addEventListener("click", () => void enterReader())
   // capture: error events don't bubble (see collapseBrokenMedia)
   el.content.addEventListener("error", collapseBrokenMedia, true)
   // The settings gear is the config entry point (search · filter picker · unread
   // toggle · settings · status). It lives on BOTH surfaces — its one fixed home is
   // the bar's right edge — so config is always one tap away. The now-viewing
   // readout (.srr-feed) is just a label now, not a second config trigger.
   el.settings.addEventListener("click", () => showConfig())
   // Search now lives in config (the "Search articles…" row → enterSearch); the `/`
   // key still toggles it on the list. The pinned search bar owns the input
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
         clearAllPins()
         // Re-render an open config so the pin row reverts to "Download for
         // offline" immediately, matching the now-empty PINNED bucket.
         if (config.isOpen()) config.render()
      }
   })

   window.addEventListener("hashchange", () => void route(location.hash.substring(1)))
   document.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && el.popup.classList.contains("srr-open")) {
         const focusable = el.popup.querySelectorAll<HTMLElement>("button:not(.srr-hidden)")
         const first = focusable[0]
         const last = focusable[focusable.length - 1]
         if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
         } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
         }
         return
      }
      if (e.key === "Escape") {
         // Overlays close first (the popup here; the image-proxy / backup modals
         // self-handle Escape via capture + stopPropagation, so this never fires
         // while one is open). Then Escape toggles the surfaces: config → reader,
         // reader → list, list → reader (enterReader resolves the article).
         if (el.popup.classList.contains("srr-open")) {
            closePopup()
            return
         }
         e.preventDefault()
         if (view === "config") closeConfig()
         else if (view === "reader") void goToList(true)
         else void enterReader()
         return
      }
      if (el.popup.classList.contains("srr-open")) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      // On the list, vertical arrows/letters scroll and rove rows natively. The
      // horizontal step keys move the selected (highlighted) row through the feed
      // — A/← to the older neighbor, D/→ to the newer — mirroring the reader's
      // prev/next so the same key reaches the same article on both surfaces; `/`
      // toggles search. The rest of the reader keymap stays reader-only.
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
         }
         return
      }
      // The settings (config) surface stacks over a still-mounted reader; without
      // this guard the reader keymap (arrows/letters, cycle, save, open-link)
      // would drive that hidden reader and even switch surfaces from behind the
      // panel. Escape is handled above (closeConfig), so config keeps its own UI.
      if (view === "config") return
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
   const bang = hash.indexOf("!")
   const posPart = bang === -1 ? hash : hash.substring(0, bang)
   if (posPart && !/^-?\d+$/.test(posPart)) {
      history.replaceState(null, "", location.pathname + location.search)
      hash = ""
   }
   if (!hash)
      try {
         hash = localStorage.getItem("srr-hash")?.substring(1) || ""
      } catch {}
   await route(hash)
   // Cross-device sync: run the LWW profile cycle (pull-adopt when the remote is
   // newer, guarded push when local changes are pending) only after the first
   // surface has rendered (local state is authoritative and paints instantly;
   // an adopt rerenders when it lands), then keep cycling on tab re-focus and
   // reconnect, flushing pending pushes on hide. No-op until a sync endpoint is
   // configured (Settings → Sync). The status callback repaints an open config
   // footer after each cycle — enabling sync from the dialog confirms itself
   // ("Synced just now") without closing and re-opening settings.
   sync.init(refreshAfterMerge, () => {
      if (config.isOpen()) config.refreshStatus()
   })
   // Live content sync: boot is already fresh (data.init just ran), so only the
   // ongoing triggers are wired — re-focus (throttled), reconnect, heartbeat.
   refresh.init(guardBg, refreshAfterStore)
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
if ("serviceWorker" in navigator && !document.documentElement.hasAttribute("data-srr-harness")) {
   if (process.env.NODE_ENV === "production") {
      // sw.ts lives at src/ root (not src/js/) so Parcel emits it at the deployment
      // root — its default scope then covers the whole env (incl. packs/assets/).
      // type:module lets sw.ts import the generated contract (format.gen.ts); the
      // SW already requires DecompressionStream, which is the newer feature, so
      // module-worker support is never the limiting factor.
      navigator.serviceWorker.register(new URL("../sw.ts", import.meta.url), { type: "module" }).catch(() => {})
   } else {
      navigator.serviceWorker
         .getRegistrations()
         .then((regs) => regs.forEach((r) => r.unregister()))
         .catch(() => {})
      if (typeof caches !== "undefined")
         caches
            .keys()
            .then((keys) => keys.forEach((k) => caches.delete(k)))
            .catch(() => {})
   }
}
