import * as data from "./data"
import { closeAllDropdowns, showFeedMenu, showOverflowMenu, type FeedMenuHost } from "./dropdown"
import { collapseBrokenMedia, formatDate, sanitizeHtml, srcColorIndex, timeAgo, URL_DENY } from "./fmt"
import { setupGestures, type Gestures } from "./gestures"
import * as list from "./list"
import * as nav from "./nav"

const el = {
   article: document.querySelector(".srr-reader") as HTMLElement,
   listView: document.querySelector(".srr-list") as HTMLElement,
   back: document.querySelector(".srr-back") as HTMLButtonElement,
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleLink: document.querySelector(".srr-title-link") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   feed: document.querySelector(".srr-feed") as HTMLButtonElement,
   source: document.querySelector(".srr-source") as HTMLElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   search: document.querySelector(".srr-search") as HTMLButtonElement,
   searchInput: document.querySelector(".srr-search-input") as HTMLInputElement,
   searchClear: document.querySelector(".srr-search-clear") as HTMLButtonElement,
   searchNote: document.querySelector(".srr-search-note") as HTMLElement,
   overflow: document.querySelector(".srr-overflow") as HTMLButtonElement,
   unread: document.querySelector(".srr-unread") as HTMLButtonElement,
   save: document.querySelector(".srr-save") as HTMLButtonElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
}

// Which surface is showing. The list is home; the reader is the drill-down.
let view: "list" | "reader" = "list"
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

function showReader() {
   view = "reader"
   document.body.classList.remove("srr-view-list")
   el.listView.hidden = true
   el.article.hidden = false
}

function showList() {
   view = "list"
   document.body.classList.add("srr-view-list")
   el.article.hidden = true
   el.listView.hidden = false
   // Disable the reader-only nav so a one-finger swipe / arrow key is a no-op
   // while the list scrolls natively (the buttons are also hidden via CSS).
   el.prev.disabled = true
   el.next.disabled = true
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

function clearContentTransition() {
   el.content.style.transition = ""
   el.content.style.opacity = ""
   el.content.style.transform = ""
}

function render(o: IShowFeed) {
   showReader()
   // Showing the reader supersedes any pending debounced search query. A row-tap
   // commit can land within the 200ms search debounce; without this the stale
   // timer fires applySearchQuery under the now-hidden list and rewrites the
   // reader's hash to the positionless #!q:<query>, losing the resume position.
   clearTimeout(searchDebounce)
   // t/l are omitempty on the wire — an untitled article must not render "undefined"
   el.title.textContent = o.article.t ?? ""
   el.content.style.transition = "none"
   el.content.style.opacity = "0"
   el.content.style.transform = "translateY(6px)"
   el.content.innerHTML = sanitizeHtml(o.article.c)
   // Reject javascript:/data:/vbscript:/file: in case the writer pipeline let one through
   if (o.article.l && !URL_DENY.test(o.article.l)) el.titleLink.href = o.article.l
   else el.titleLink.removeAttribute("href")
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right

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
   // Don't steal focus to the title while a dropdown menu is open — the only
   // render() with a menu still open is the unseen-only eye-chip toggle, which
   // keeps the menu open and restores focus to the chip. Stealing it here would
   // strand the keyboard user behind the open menu (next Arrow finds
   // activeElement outside the menu items). Every navigation selection closes
   // the menu before its render(), so this is a no-op on all other paths.
   if (!document.querySelector(".srr-dropdown-menu.srr-open")) el.title.focus()

   // Double rAF: first ensures the browser has painted with opacity:0, second
   // re-enables transitions so the fade-in animates.
   requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

   persistHash(location.hash)
}

function refreshFeedLabel() {
   // The article's source now lives in the header kicker, so the toolbar button
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
   if (/^\d+$/.test(key)) el.feed.dataset.src = String(srcColorIndex(Number(key)))
   else delete el.feed.dataset.src
   el.feed.classList.toggle("srr-filter-on", key !== "")
   el.feed.title = key === "" ? "All feeds" : `Filtered: ${label}`
   el.feed.setAttribute("aria-label", `Filter: ${label}`)
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
   const tokens =
      bang === -1
         ? []
         : hash
              .substring(bang + 1)
              .split("+")
              .filter((t) => t.length > 0)
              .map((t) => {
                 try {
                    return decodeURIComponent(t)
                 } catch {
                    return t
                 }
              })
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
   closeAllDropdowns()
   await goToList(true)
}

const dropdownHost: FeedMenuHost = {
   viewIsList: () => view === "list",
   selectFilter: (token) => void selectFilter(token),
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
// the user is mid-type), drive the toolbar button's pressed state, and surface
// the short-query / truncation hint.
function syncSearchBar() {
   const on = nav.isSearchFilter()
   document.body.classList.toggle("srr-searching", on && view === "list")
   el.search.setAttribute("aria-pressed", String(on))
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

// The unread (catch-up) toggle — a toolbar button (list-only). Flipping it
// persists the mode and rebuilds the list under the new (raised/restored) bounds;
// the mode also governs reader navigation, but the list is where it's switched.
// Unseen-only now spans every filter ([ALL]/feed/tag), so this is the one-tap
// "show only unread" button for the whole wire.
function refreshUnreadButton() {
   const on = nav.isUnreadOnly()
   el.unread.setAttribute("aria-pressed", String(on))
   el.unread.setAttribute("aria-label", on ? "Showing only unread — show all" : "Show only unread")
   el.unread.title = on ? "Showing only unread" : "Show only unread"
}
function toggleUnseenOnly() {
   // setUnreadOnly re-applies the filter (raised/restored bounds) internally;
   // force a rebuild since the token set is unchanged (list.show() alone would
   // only refresh dots).
   nav.setUnreadOnly(!nav.isUnreadOnly())
   refreshUnreadButton()
   void list.rerender()
}

// Two-finger vertical swipe = step the filter. In the reader, cycle to the next
// filter's article; on the list, re-filter the list to the next entry.
function onCycle(dir: number) {
   if (nav.getFilterEntries().length <= 1) return
   // cycleToken steps relative to cycleOriginKey (a single tagged-feed filter
   // cycles by its tag), so the list and the reader share one rotation.
   if (view === "list") void selectFilter(nav.cycleToken(dir))
   else guard(() => nav.cycleFilter(dir))
}

function feedMenuTag(): string {
   // Which tag group to auto-expand in the menu. In the reader, the shown
   // article's tag; on the list, the active tag filter (if any).
   if (view === "list") {
      if (nav.isSearchFilter()) return ""
      const key = nav.getCurrentFilterKey()
      return key !== "" && !/^\d+$/.test(key) ? key : ""
   }
   const id = nav.currentFeedId()
   return id >= 0 ? (data.db.feeds[id]?.tag ?? "") : ""
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
const stepLeft = () => (el.prev.disabled ? bumpReaderEdge("prev") : guard(() => nav.left()))
const stepRight = () => (el.next.disabled ? bumpReaderEdge("next") : guard(() => nav.right()))
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
   // capture: error events don't bubble (see collapseBrokenMedia)
   el.content.addEventListener("error", collapseBrokenMedia, true)
   el.feed.addEventListener("click", () => showFeedMenu(feedMenuTag(), guard, dropdownHost))
   // ⋯ overflow holds settings — currently just the "Image proxy…" row.
   el.overflow.addEventListener("click", () => showOverflowMenu())
   // Unread (catch-up) toggle — one-tap "show only unread" in whatever's filtered.
   el.unread.addEventListener("click", toggleUnseenOnly)
   // Search: the magnifier toggles the list's "q:<query>" filter; the pinned
   // search bar owns the input (debounced live query, Enter applies immediately,
   // Escape / ✕ leave search).
   el.search.disabled = !nav.searchAvailable()
   el.search.addEventListener("click", () => !el.search.disabled && toggleSearch())
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
   window.addEventListener("click", (e) => {
      // closest(), not matches(): a dropdown button (feed, overflow) is
      // clicked on its inner icon (e.g. the .srr-overflow-icon svg), so the
      // event target is the child, not the button. matches() missed that and
      // closed the menu the button's own handler had just opened — leaving the
      // button dead to taps/clicks.
      if (!(e.target as HTMLElement).closest(".srr-dropdown-btn")) closeAllDropdowns()
   })
   window.addEventListener("mousedown", (e) => {
      if (el.popup.classList.contains("srr-open") && !el.popup.contains(e.target as Node)) closePopup()
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
         if (el.popup.classList.contains("srr-open")) {
            closePopup()
            return
         }
         closeAllDropdowns()
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
   refreshUnreadButton() // reflect the persisted unread-only mode on the toolbar at boot

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
