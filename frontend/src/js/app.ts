import * as data from "./data"
import {
   closeAllDropdowns,
   dateJump,
   openDatePicker,
   showChannelMenu,
   showOverflowMenu,
   type ChannelMenuHost,
} from "./dropdown"
import { collapseBrokenMedia, formatDate, readMinutes, sanitizeHtml, srcColorIndex, timeAgo, URL_DENY } from "./fmt"
import { setupGestures, type Gestures } from "./gestures"
import * as list from "./list"
import * as nav from "./nav"

const el = {
   article: document.querySelector(".srr-reader") as HTMLElement,
   listView: document.querySelector(".srr-list") as HTMLElement,
   mastheadStatus: document.querySelector(".srr-masthead-status") as HTMLElement,
   back: document.querySelector(".srr-back") as HTMLButtonElement,
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   readon: document.querySelector(".srr-readon") as HTMLElement,
   titleLink: document.querySelector(".srr-title-link") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   channel: document.querySelector(".srr-channel") as HTMLButtonElement,
   source: document.querySelector(".srr-source") as HTMLElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   readlen: document.querySelector(".srr-readlen") as HTMLElement,
   search: document.querySelector(".srr-search") as HTMLButtonElement,
   searchInput: document.querySelector(".srr-search-input") as HTMLInputElement,
   searchClear: document.querySelector(".srr-search-clear") as HTMLButtonElement,
   searchNote: document.querySelector(".srr-search-note") as HTMLElement,
   overflow: document.querySelector(".srr-overflow") as HTMLButtonElement,
   jump: document.querySelector(".srr-jump") as HTMLButtonElement,
   jumpDate: document.querySelector(".srr-jump-date") as HTMLInputElement,
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
let currentPublished = 0
let currentChannel = { id: 0, title: "", tag: "" }
let lastChannelLabel: string | null = null
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

// "Read on" — the next dispatch previewed at the article's end, so the wire
// reads as a continuous feed and the next tap lands under your thumb (not at the
// bottom toolbar). A "NEXT" divider (perforated rule, echoing the masthead — the
// paper keeps feeding) over a list-row-style preview keyed to the next source's
// color; tapping it is exactly the toolbar's next. At the newest match it's a
// quiet terminal line. Token-guarded so a fast next/prev never paints a stale
// preview; nav.peek's loadArticle is the cache the neighbor prefetch warms.
let readonTok = 0
function readonDivider(label: string): HTMLElement {
   const d = document.createElement("div")
   d.className = "srr-readon-divider"
   d.textContent = label
   return d
}
function renderReadon(next: { chron: number; article: IArticle } | null) {
   el.readon.replaceChildren()
   if (!next) {
      el.readon.append(readonDivider("LATEST"))
      const end = document.createElement("p")
      end.className = "srr-readon-endmsg"
      end.textContent = "You're at the newest dispatch in this view."
      el.readon.append(end)
      return
   }
   el.readon.append(readonDivider("NEXT"))
   const a = document.createElement("a")
   a.className = "srr-readon-next"
   a.href = "#" + next.chron + nav.tokensSuffix()
   a.dataset.src = String(srcColorIndex(next.article.s))
   // Same as the toolbar next (right = newer): intercept like a list row so the
   // hash link doesn't new-tab under <base target=_blank>.
   a.addEventListener("click", (e) => {
      e.preventDefault()
      guard(() => nav.right())
   })
   const head = document.createElement("div")
   head.className = "srr-readon-head"
   const src = document.createElement("span")
   src.className = "srr-readon-source"
   src.textContent = data.channelTitle(next.article.s)
   const age = document.createElement("time")
   age.className = "srr-readon-age"
   age.textContent = timeAgo(next.article.p || next.article.a)
   head.append(src, age)
   const title = document.createElement("div")
   title.className = "srr-readon-title"
   title.textContent = next.article.t || "(untitled)"
   a.append(head, title)
   el.readon.append(a)
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
   currentPublished = o.article.p ?? 0
   // The reader carries an absolute dateline (you're reading an archived
   // dispatch, so the real date matters more than "5h ago"); the relative age
   // moves to the hover title.
   el.date.textContent = currentPublished ? formatDate(currentPublished) : ""
   el.date.title = currentPublished ? timeAgo(currentPublished) : ""
   // Hide the date (and its leading "·" separator) in the kicker when undated,
   // so the source name doesn't trail a dangling middot.
   el.date.hidden = !currentPublished

   // Dispatch length — the commitment the read-through spine then fulfills.
   // Counted off the just-rendered text; hidden (with its separator) when empty.
   const mins = readMinutes(el.content.textContent ?? "")
   el.readlen.textContent = mins ? `${mins} MIN READ` : ""
   el.readlen.hidden = !mins

   currentChannel = {
      id: o.channel?.id ?? 0,
      title: data.channelTitle(o.article.s),
      tag: o.channel?.tag || "",
   }
   // Key the reader's spine + masthead to the article's source color (same ramp
   // as the list rails — see styles.css [data-src]).
   el.article.dataset.src = String(srcColorIndex(o.article.s))
   el.source.textContent = currentChannel.title
   refreshChannelLabel()
   refreshSaveButton(!o.placeholder)

   // Read on: clear the prior article's preview now (it's below the fold, so no
   // flash), then fill — the next dispatch when there is one, else a terminal
   // line. peek is token-guarded against a faster subsequent navigation.
   el.readon.replaceChildren()
   const myReadon = ++readonTok
   if (!o.has_right) renderReadon(null)
   else
      void nav
         .peek("right")
         .then((nx) => {
            if (myReadon === readonTok) renderReadon(nx)
         })
         .catch(() => {})

   document.title = "SRR - " + (o.article.t ?? "")
   window.scrollTo(0, 0)
   // Don't steal focus to the title while a dropdown menu is open — the only
   // render() with a menu still open is the unseen-only eye-chip toggle, which
   // keeps the menu open and restores focus to the chip. Stealing it here would
   // strand the keyboard user behind the open menu (next Arrow finds
   // activeElement outside the menu items). Every navigation selection closes
   // the menu before its render(), so this is a no-op on all other paths.
   if (!document.querySelector(".srr-dropdown-menu.srr-open")) el.title.focus()

   // Double rAF: first ensures the browser has painted with opacity:0,
   // second re-enables transitions so the fade-in animates. The article is now
   // laid out at scrollTop 0, so sync the read-through spine (scrollTo(0,0) above
   // fired no scroll event when already at the top — a short article would
   // otherwise keep the prior article's fill until first scroll).
   requestAnimationFrame(() =>
      requestAnimationFrame(() => {
         clearContentTransition()
         gestures?.syncReadProgress()
      }),
   )

   try {
      localStorage.setItem("srr-hash", location.hash)
   } catch {}
}

function refreshChannelLabel() {
   // The article's source now lives in the header kicker, so the toolbar button
   // is a pure active-filter indicator: "All", a tag name, or a single channel.
   // Search mode is orthogonal to the channel axis (the pinned search bar owns the
   // query), so show the button neutral ("All", unhighlighted) instead of the raw
   // "q:<query>" token getCurrentFilterKey returns.
   const key = nav.isSearchFilter() ? "" : nav.getCurrentFilterKey() // "" (all/multi) | tag name | numeric channel id
   if (key === lastChannelLabel) return
   lastChannelLabel = key

   const label =
      key === ""
         ? "All"
         : key === nav.SAVED_TOKEN
           ? "★ Saved"
           : /^\d+$/.test(key)
             ? data.channelTitle(Number(key))
             : key
   el.channel.textContent = label
   // A single-channel filter tints the toolbar label with that channel's source
   // color (the wire-desk identity in the toolbar); [ALL]/tag/saved/search stay
   // neutral. The chip-less label still says which source you're viewing.
   if (/^\d+$/.test(key)) el.channel.dataset.src = String(srcColorIndex(Number(key)))
   else delete el.channel.dataset.src
   el.channel.classList.toggle("srr-filter-on", key !== "")
   el.channel.title = key === "" ? "All channels" : `Filtered: ${label}`
   el.channel.setAttribute("aria-label", `Filter: ${label}`)
}

// The reader's save (★) toggle reflects whether the current article is in the
// saved set. Disabled only on the "(no matching articles)" placeholder, where
// there's nothing to save — keyed off o.placeholder, NOT channel presence, so a
// saved article whose channel was deleted ([DELETED] tombstone, channel ===
// undefined) stays toggleable.
function refreshSaveButton(hasArticle: boolean) {
   const chron = nav.currentChron()
   const canSave = hasArticle && chron >= 0
   const saved = canSave && nav.isSaved(chron)
   el.save.disabled = !canSave
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
   el.save.classList.toggle("srr-saved", saved)
   el.save.setAttribute("aria-pressed", String(saved))
   el.save.setAttribute("aria-label", saved ? "Unsave article" : "Save article")
}

function listTitle(): string {
   if (nav.isSearchFilter()) {
      const q = nav.searchQuery()
      return q ? `SRR · Search: ${q}` : "SRR · Search"
   }
   const key = nav.getCurrentFilterKey()
   if (key === "") return "SRR"
   if (key === nav.SAVED_TOKEN) return "SRR · ★ Saved"
   return "SRR · " + (/^\d+$/.test(key) ? data.channelTitle(Number(key)) : key)
}

// Front-page masthead — the wire's live state on the home list. Freshness is
// instant off the resident db; the unread total across the WHOLE wire (not the
// active filter — the nameplate says "your wire") is async (idx scans, the same
// machinery as the filter-menu badges) and token-guarded so a rapid re-entry
// never writes a stale total. lastWireUnread caches the prior total so a return
// to the list shows it immediately, then refreshes (e.g. ticks down after you
// read a few). The freshness part always shows, so the async fill grows the line
// without a vertical shift.
let lastWireUnread = -1
let mastheadTok = 0
function renderMastheadStatus(unread: number) {
   const fresh = data.db.fetched_at ? `updated ${timeAgo(data.db.fetched_at)} ago` : ""
   const unreadText = unread < 0 ? "" : unread > 0 ? `${unread.toLocaleString()} unread` : "All caught up"
   el.mastheadStatus.replaceChildren()
   if (unreadText) {
      const u = document.createElement("span")
      u.className = "srr-masthead-unread"
      u.textContent = unreadText
      el.mastheadStatus.append(u)
   }
   if (fresh) {
      const f = document.createElement("span")
      f.className = "srr-masthead-fresh"
      f.textContent = (unreadText ? " · " : "") + fresh
      el.mastheadStatus.append(f)
   }
}
function refreshMasthead() {
   renderMastheadStatus(lastWireUnread)
   const my = ++mastheadTok
   const chans = Object.values(data.db.channels ?? {}).filter((c) => c.total_art > 0)
   void nav
      .unreadCounts(chans)
      .then((counts) => {
         if (my !== mastheadTok) return
         let total = 0
         for (const n of counts.values()) total += n
         lastWireUnread = total
         renderMastheadStatus(total)
      })
      .catch(() => {})
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
   refreshChannelLabel()
   refreshMasthead()
   document.title = listTitle()
   document.body.classList.add("srr-loading")
   try {
      await list.show(center)
   } catch (e) {
      showError(e, () => void renderListSurface())
   } finally {
      document.body.classList.remove("srr-loading")
      syncSearchBar()
      busy = false
   }
}

// Picking a date (calendar 🗓, list-only) repositions the LIST to the first
// article at-or-after local midnight of that day, snapped forward through the
// active filter — it does NOT open the reader. nav.seek moves the cursor
// without loading an article; list.show() then anchors the list there (newer
// "next" rows above, older below), reusing the rendered window when the target
// is already on screen. Mirrors renderListSurface's guard/loading/searchbar
// bookkeeping (we're already on the list, so the filter/hash are unchanged); a
// cold idx-pack fetch that rejects surfaces in the popup with Retry.
async function jumpToDate(ts: number) {
   if (busy) return
   busy = true
   document.body.classList.add("srr-loading")
   try {
      await nav.seek(await data.findChronForTimestamp(ts))
      await list.show()
   } catch (e) {
      showError(e, () => void jumpToDate(ts))
   } finally {
      document.body.classList.remove("srr-loading")
      syncSearchBar()
      busy = false
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
   // channel-menu pick or a two-finger/arrow cycle, which all land here) within
   // the debounce window lets the stale applySearchQuery fire ~200ms later and
   // bounce the list back into search. Typing itself never routes through here.
   clearTimeout(searchDebounce)
   nav.applyFilter(token === "" ? [] : [token])
   closeAllDropdowns()
   await goToList(true)
}

const dropdownHost: ChannelMenuHost = {
   viewIsList: () => view === "list",
   selectFilter: (token) => void selectFilter(token),
   toggleUnseenOnly,
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

// The unseen-only (tags) toggle — now a row in the channel menu (dropdownHost
// hands this to showChannelMenu). Flipping it persists the mode and rebuilds the
// list under the new (raised/restored) bounds; the mode also governs reader
// navigation, but the list is the only place it's switched. The menu re-renders
// its own row state + unseen-only row hiding after calling this.
function toggleUnseenOnly() {
   nav.setUnreadOnly(!nav.isUnreadOnly())
   // Re-apply the same tokens so filter.set re-reads the new mode (raised bounds
   // in single-tag mode), then force a rebuild — the token set is unchanged, so
   // list.show() alone would only refresh dots.
   nav.applyFilter(nav.currentTokens())
   void list.rerender()
}

// Two-finger vertical swipe = step the filter. In the reader, cycle to the next
// filter's article; on the list, re-filter the list to the next entry.
function onCycle(dir: number) {
   const entries = nav.getFilterEntries()
   if (entries.length <= 1) return
   if (view === "list") {
      // cycleOriginKey (not getCurrentFilterKey) so a single tagged-channel
      // filter cycles relative to its tag, matching the reader's cycleFilter —
      // getFilterEntries lists tagged channels only by tag, so a raw id misses.
      let idx = entries.indexOf(nav.cycleOriginKey())
      if (idx === -1) idx = 0
      void selectFilter(entries[(idx + dir + entries.length) % entries.length])
   } else {
      guard(() => nav.cycleFilter(dir))
   }
}

function channelMenuTag(): string {
   // Which tag group to auto-expand in the menu. In the reader, the shown
   // article's tag; on the list, the active tag filter (if any).
   if (view === "list") {
      if (nav.isSearchFilter()) return ""
      const key = nav.getCurrentFilterKey()
      return key !== "" && !/^\d+$/.test(key) ? key : ""
   }
   return currentChannel.tag
}

const KEY_ACTIONS: Record<string, () => void> = {
   ArrowLeft: () => !el.prev.disabled && guard(() => nav.left()),
   a: () => !el.prev.disabled && guard(() => nav.left()),
   ArrowRight: () => !el.next.disabled && guard(() => nav.right()),
   d: () => !el.next.disabled && guard(() => nav.right()),
   ArrowUp: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(-1)),
   w: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(-1)),
   ArrowDown: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(1)),
   s: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(1)),
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
   )

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   el.next.addEventListener("click", () => guard(() => nav.right()))
   el.back.addEventListener("click", () => void goToList(true))
   // capture: error events don't bubble (see collapseBrokenMedia)
   el.content.addEventListener("error", collapseBrokenMedia, true)
   el.channel.addEventListener("click", () => showChannelMenu(channelMenuTag(), guard, dropdownHost))
   el.overflow.addEventListener("click", () => showOverflowMenu())
   // Jump: the button pops the native date picker; picking a day (the input's
   // change) repositions the LIST to that date (jumpToDate), not the reader. No
   // dropdown menu of its own.
   el.jump.addEventListener("click", () => openDatePicker(el.jumpDate))
   el.jumpDate.addEventListener("change", () => dateJump(el.jumpDate, jumpToDate))
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
      // closest(), not matches(): a dropdown button (channel, overflow) is
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

   gestures = setupGestures({ prev: el.prev, next: el.next, toolbar: el.toolbar, reader: el.article, guard, onCycle })

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
}

init().catch(showError)

// Cache immutable self-hosted assets via a service worker (scope = this
// deployment's directory, e.g. /srr/ or /srr.tmp/). Best-effort: any failure
// (unsupported, insecure context, registration error) leaves the app working
// straight off the network.
if ("serviceWorker" in navigator) {
   // sw.ts lives at src/ root (not src/js/) so Parcel emits it at the deployment
   // root — its default scope then covers the whole env (incl. packs/assets/).
   // type:module lets sw.ts import the generated contract (format.gen.ts); the
   // SW already requires DecompressionStream, which is the newer feature, so
   // module-worker support is never the limiting factor.
   navigator.serviceWorker.register(new URL("../sw.ts", import.meta.url), { type: "module" }).catch(() => {})
}
