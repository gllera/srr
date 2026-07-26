// search-ui.ts — Title search (list filter mode).
//
// The settings menu's "Search articles…" row / the `/` key toggle a "q:<query>"
// filter (nav search mode): the list renders the matching articles and the reader
// walks them, all via the shared #!q:<query> hash. A search bar pinned atop the
// list owns the input; typing updates the query in place (debounced,
// replaceState) so each keystroke re-renders results without spamming history,
// while entering/leaving search is a single history step. The bar lives outside
// .srr-list, so list.rerender (which clears .srr-list) never disturbs the focused
// input.
//
// The debounce timer lives here, and every other surface that must supersede a
// pending query (the reader's render, a URL-driven route, an explicit filter
// change) calls clearSearchDebounce() — one owner, so the timer can't be cleared
// from two places that disagree about who holds it.
import { el } from "./els"
import * as list from "./list"
import * as nav from "./nav"

export interface SearchDeps {
   // Which surface is showing. Search is a LIST filter mode: a pending debounce
   // that fires after the reader took over must not rewrite the reader's hash.
   view: () => "list" | "reader"
   // Enter / leave search as ONE history step (app.ts owns the router).
   selectFilter: (token: string) => Promise<void>
   persistHash: (hash: string) => void
   // The single writer of document.title, and the list's own title text.
   setTitle: (base: string) => void
   listTitle: () => string
   // The retryable error popup.
   showError: (e: unknown, retry?: () => void) => void
}

let d: SearchDeps

// Pending debounced search query. Module state so selectFilter / route / the
// reader's render can cancel it when the filter changes by any means other than
// continued typing.
let searchDebounce: ReturnType<typeof setTimeout> | undefined

export function clearSearchDebounce(): void {
   clearTimeout(searchDebounce)
}

// Wire the pinned search bar. Search is ENTERED from the settings menu (the
// "Search articles…" row → enterSearch) or the `/` key on the list; the bar
// itself owns the query — `input` is debounced (200ms), Enter applies
// immediately, Escape / ✕ leave search.
export function setup(deps: SearchDeps): void {
   d = deps
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
}

export function toggleSearch(): void {
   if (d.view() === "list" && nav.isSearchFilter()) void exitSearch()
   else void enterSearch()
}

export async function enterSearch(): Promise<void> {
   if (!nav.searchAvailable()) return
   await d.selectFilter(nav.SEARCH_PREFIX) // one history step into search; the bar drives the query
   el.searchInput.focus()
}

function exitSearch(): Promise<void> {
   return d.selectFilter("")
}

async function applySearchQuery(q: string): Promise<void> {
   clearTimeout(searchDebounce)
   // Defense in depth against a debounce that fired after the user already left
   // search (e.g. opened an article): only the list-search surface owns the query.
   if (d.view() !== "list" || !nav.isSearchFilter()) return
   nav.applyFilter([nav.SEARCH_PREFIX + q])
   const h = "#" + nav.tokensSuffix()
   history.replaceState(null, "", h)
   d.persistHash(h)
   d.setTitle(d.listTitle())
   try {
      await list.rerender()
   } catch (e) {
      d.showError(e, () => void applySearchQuery(q))
      return
   }
   syncSearchBar()
}

// Reflect the active search state into the bar: show/hide it (CSS gates display
// on body.srr-searching + .srr-view-list), seed the input from the query (unless
// the user is mid-type), and surface the short-query / truncation hint. (Search is
// entered from the settings menu's "Search articles…" row, not a toolbar button.)
export function syncSearchBar(): void {
   const on = nav.isSearchFilter()
   document.body.classList.toggle("srr-searching", on && d.view() === "list")
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
