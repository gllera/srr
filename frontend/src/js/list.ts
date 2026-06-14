import * as data from "./data"
import { timeAgo } from "./fmt"
import * as nav from "./nav"

// The list surface — the app's home: a scannable feed of headlines under the
// current filter, newest-first, with a read/unread dot per row. Tapping a row
// opens the reader (app wires that via setup's `open`). The list owns no nav
// state of its own — it walks nav.feedLeft over nav.filter.channels (the same
// neighbor seam the reader steps through, just unbounded) and reads the seen
// map for dots, so the filter/unseen-only semantics are identical to the reader's.

// Rows fetched per older batch. One batch spans ~1 data pack (titles already
// ride in the data packs the LRU holds), so this is a paint-budget knob, not a
// fetch-count one.
const BATCH = 30

// Start fetching the next batch this far below the fold (a scroll runway so
// rows are ready before they're scrolled into view).
const ROOT_MARGIN = "800px"

// Per-row save star. Tapping it toggles nav.toggleSaved without opening the
// reader; the row carries .srr-row-saved for the filled look.
const STAR_SVG =
   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>'

let container: HTMLElement
let rowsEl: HTMLElement
let sentinel: HTMLElement
let onOpen: (chron: number) => void = () => {}

// Freshness token: a new render() reassigns it so any in-flight older-load (or
// pending observer callback) from the prior filter bails before touching the
// DOM — the same discipline as dropdown's fill tokens and nav's prefetch.
let tok: object = {}
let oldest = -1 // chronIdx of the oldest row currently rendered (-1 = none yet)
let exhausted = false // walked off the start of the (filtered) feed
let loading = false // a batch load is in flight (re-entry guard for loadOlder)
let pumping = false // a viewport-fill loop is running (re-entry guard for pump)
let builtKey: string | null = null // filterKey() the current DOM was built for
let observer: IntersectionObserver | null = null

// Scroll memory keyed by filter, so returning from the reader (back button or
// browser-back) lands where you left the list. Session-only (cleared on reload).
let savedScroll: { key: string; top: number } | null = null

export function setup(el: HTMLElement, open: (chron: number) => void): void {
   container = el
   onOpen = open
   container.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      const a = target.closest("a.srr-row") as HTMLElement | null
      if (!a) return
      // The row is a real <a href="#chron"> for keyboard/semantics, but
      // <base target="_blank"> would open it in a new tab — intercept and
      // route in-SPA instead (covers a star tap too: the star lives inside <a>).
      e.preventDefault()
      const chron = Number(a.dataset.chron)
      // The save star toggles in place; it does NOT open the reader. In the
      // Saved view, un-saving drops the row from the feed straight away.
      const star = target.closest(".srr-row-star")
      if (star) {
         const nowSaved = nav.toggleSaved(chron)
         a.classList.toggle("srr-row-saved", nowSaved)
         star.setAttribute("aria-pressed", String(nowSaved))
         if (nav.filter.saved && !nowSaved) {
            a.remove()
            if (rowsEl && rowsEl.childElementCount === 0) showEmptyState()
         }
         return
      }
      saveScroll()
      onOpen(chron)
   })
}

// Remember the current scroll position against the active filter — called
// before leaving the list for the reader.
export function saveScroll(): void {
   savedScroll = { key: nav.filterKey(), top: window.scrollY }
}

function el(tag: string, className: string): HTMLElement {
   const e = document.createElement(tag)
   e.className = className
   return e
}

// One headline row: dot + (title over "channel · age"). Display fallbacks
// ("(untitled)", the "[DELETED]" channel tombstone) live here.
function rowEl(chron: number, art: IArticle, seen: Record<string, number>): HTMLElement {
   const a = document.createElement("a")
   a.className = "srr-row"
   a.href = "#" + chron + nav.tokensSuffix()
   a.dataset.chron = String(chron)
   a.dataset.chan = String(art.s)
   if (nav.isRowUnread(chron, art.s, seen)) a.classList.add("srr-row-unread")
   const saved = nav.isSaved(chron)
   if (saved) a.classList.add("srr-row-saved")
   const body = el("div", "srr-row-body")
   const title = el("div", "srr-row-title")
   title.textContent = art.t || "(untitled)"
   const meta = el("div", "srr-row-meta")
   meta.textContent = `${data.channelTitle(art.s)} · ${timeAgo(art.p || art.a)}`
   body.append(title, meta)
   const star = el("span", "srr-row-star")
   star.setAttribute("role", "button")
   star.setAttribute("aria-label", "Save article")
   star.setAttribute("aria-pressed", String(saved))
   star.innerHTML = STAR_SVG
   a.append(el("span", "srr-row-dot"), body, star)
   return a
}

function emptyState(): void {
   const empty = el("div", "srr-list-empty")
   empty.textContent = nav.isSearchFilter()
      ? nav.searchQuery()
         ? "No matching articles."
         : "Type to search article titles."
      : nav.filter.saved
        ? "No saved articles yet."
        : nav.filter.active
          ? "Nothing here yet."
          : "No articles yet."
   container.appendChild(empty)
}

// Collapse a now-empty list (the Saved view after un-saving the last row) to its
// empty state, dropping the observer so a stale sentinel can't keep firing.
function showEmptyState(): void {
   teardownObserver()
   container.replaceChildren()
   emptyState()
}

// Full (re)build: clears the list and loads the newest batch under the current
// filter, scrolled to top. Sets builtKey so show() can later refresh-vs-rebuild.
export async function render(): Promise<void> {
   const my = (tok = {})
   teardownObserver()
   oldest = -1
   exhausted = false
   loading = false
   pumping = false
   builtKey = nav.filterKey()
   container.replaceChildren()

   if (data.db.total_art === 0) {
      emptyState()
      return
   }

   rowsEl = el("div", "srr-list-rows")
   sentinel = el("div", "srr-list-sentinel")
   container.append(rowsEl, sentinel)

   await loadOlder(my)
   if (my !== tok) return
   if (rowsEl.childElementCount === 0) {
      container.replaceChildren()
      emptyState()
      return
   }
   window.scrollTo(0, 0)
   observe(my)
}

// Re-show an already-built list (same filter): refresh read/unread dots from
// the live seen map (you may have read some in the reader) and restore scroll.
export function refresh(): void {
   const seen = nav.getSeenMap()
   const savedView = nav.filter.saved
   container.querySelectorAll<HTMLElement>("a.srr-row").forEach((a) => {
      const chron = Number(a.dataset.chron)
      a.classList.toggle("srr-row-unread", nav.isRowUnread(chron, Number(a.dataset.chan), seen))
      const saved = nav.isSaved(chron)
      a.classList.toggle("srr-row-saved", saved)
      a.querySelector(".srr-row-star")?.setAttribute("aria-pressed", String(saved))
      // In the Saved view, an article un-saved from the reader is gone from the
      // feed — drop its row on the way back.
      if (savedView && !saved) a.remove()
   })
   if (savedView && rowsEl && rowsEl.childElementCount === 0) showEmptyState()
   if (savedScroll && savedScroll.key === nav.filterKey()) window.scrollTo(0, savedScroll.top)
}

// Entry point on (re)entering the list surface: rebuild when the filter changed
// since the last build, else just refresh dots + restore scroll.
export async function show(): Promise<void> {
   if (builtKey !== nav.filterKey()) await render()
   else refresh()
}

// Force a rebuild regardless of builtKey — used after an unseen-only toggle,
// where the filter token is unchanged but its membership (raised bounds) is not.
export function rerender(): Promise<void> {
   builtKey = null
   return render()
}

// Pull the next older batch by walking findLeft from below the oldest row.
// Guarded against re-entry; bails on a stale token without touching the DOM.
async function loadOlder(my: object): Promise<void> {
   if (my !== tok || exhausted || loading) return
   loading = true
   try {
      const from = oldest === -1 ? data.db.total_art - 1 : oldest - 1
      const chrons: number[] = []
      let i = from
      while (chrons.length < BATCH && i >= 0) {
         const found = await nav.feedLeft(i)
         if (my !== tok) return
         if (found === -1) {
            exhausted = true
            break
         }
         chrons.push(found)
         i = found - 1
      }
      if (chrons.length === 0) {
         exhausted = true
         return
      }
      oldest = chrons[chrons.length - 1]
      if (oldest === 0) exhausted = true
      const seen = nav.getSeenMap()
      const arts = await Promise.all(chrons.map((c) => data.loadArticle(c)))
      if (my !== tok) return
      const frag = document.createDocumentFragment()
      chrons.forEach((c, k) => frag.appendChild(rowEl(c, arts[k], seen)))
      rowsEl.appendChild(frag)
   } finally {
      if (my === tok) loading = false
   }
}

// Public for the IntersectionObserver and tests: pull one older batch under the
// current freshness token.
export function loadMore(): Promise<void> {
   return loadOlder(tok)
}

function observe(my: object): void {
   if (typeof IntersectionObserver === "undefined") return // jsdom: no layout/IO
   observer = new IntersectionObserver(
      (entries) => {
         if (my === tok && entries.some((e) => e.isIntersecting)) void pump(my)
      },
      { rootMargin: ROOT_MARGIN },
   )
   observer.observe(sentinel)
   // The first batch may not fill the viewport (tall screen / sparse filter);
   // pump until the sentinel sits below the fold or the feed is exhausted.
   void pump(my)
}

async function pump(my: object): Promise<void> {
   if (pumping) return
   pumping = true
   try {
      while (my === tok && !exhausted) {
         const rect = sentinel.getBoundingClientRect()
         if (rect.top > window.innerHeight + 800) break
         const before = rowsEl.childElementCount
         await loadOlder(my)
         // No progress and not exhausted (a transient loadOlder no-op) — stop to
         // avoid a busy spin; the next scroll/observer tick will retry.
         if (rowsEl.childElementCount === before && !exhausted) break
      }
   } finally {
      pumping = false
   }
}

function teardownObserver(): void {
   observer?.disconnect()
   observer = null
}
