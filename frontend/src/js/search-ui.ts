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
// RDR8 — search carries a SCOPE. Entering it from a feed/tag lane keeps that
// lane as the query's scope ("search within this tag", `#!q:x+tech`), every
// keystroke re-applies the same pair, and leaving search returns to the lane you
// searched inside rather than dumping you in [ALL]. [ALL] and ★ Saved search
// everything: ★ Saved's membership is a device-local chron set, not a feed
// map, so there is nothing for nav's scope intersection to take.
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
   // Enter / leave search as ONE history step (app.ts owns the router). A TOKEN
   // LIST, not a token: a scoped query is `q:<query>` plus its lane.
   selectTokens: (tokens: string[]) => Promise<void>
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

// The lane a query is (or would be) scoped to — "" for an unscoped one. Already
// searching: nav owns the answer. Otherwise it is the lane you are looking at,
// except ★ Saved (see the header) and a multi-token URL filter, both of which
// getCurrentFilterKey already reports as something the scope can't be.
function scopeToken(): string {
   if (nav.isSearchFilter()) return nav.searchScope()
   const key = nav.getCurrentFilterKey()
   return key === nav.SAVED_TOKEN ? "" : key
}

// The token pair for a query under the current scope — the ONE place the
// `[q:<query>, scope]` shape is built, so the bar, the debounce and the hash can
// never spell a scoped query three different ways.
function searchTokens(q: string, scope: string): string[] {
   return scope ? [nav.SEARCH_PREFIX + q, scope] : [nav.SEARCH_PREFIX + q]
}

export function toggleSearch(): void {
   if (d.view() === "list" && nav.isSearchFilter()) void exitSearch()
   else void enterSearch()
}

// Enter search. From the READER this lands on the list in search mode (RDR8's
// `/`-from-the-reader): selectTokens routes through the list surface, which is
// where the pinned bar lives — search has always been a list filter mode.
export async function enterSearch(): Promise<void> {
   if (!nav.searchAvailable()) return
   // A q: filter can already be active while the READER is showing (you opened
   // an article from the results and are walking the hits): `/` there means "take
   // me back to those results", not "start the query over".
   const q = nav.isSearchFilter() ? nav.searchQuery() : ""
   await d.selectTokens(searchTokens(q, scopeToken())) // one history step in; the bar drives the query
   el.searchInput.focus()
}

// Leaving search returns to the LANE it was scoped to, not to [ALL]: the scope
// was the lane you were reading when you started searching it.
function exitSearch(): Promise<void> {
   const scope = scopeToken()
   return d.selectTokens(scope ? [scope] : [])
}

async function applySearchQuery(q: string): Promise<void> {
   clearTimeout(searchDebounce)
   // Defense in depth against a debounce that fired after the user already left
   // search (e.g. opened an article): only the list-search surface owns the query.
   if (d.view() !== "list" || !nav.isSearchFilter()) return
   nav.applyFilter(searchTokens(q, nav.searchScope()))
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
   // Split view: search is a list-pane mode and the pane is always on screen,
   // so the bar shows whatever surface has key focus (class check, not an
   // import — the same dependency-free idiom gestures.ts uses).
   document.body.classList.toggle(
      "srr-searching",
      on && (d.view() === "list" || document.body.classList.contains("srr-split")),
   )
   if (!on) {
      el.searchNote.hidden = true
      return
   }
   const q = nav.searchQuery()
   if (document.activeElement !== el.searchInput) el.searchInput.value = q
   // The scope belongs IN the bar (RDR8) — "Search titles…" over a lane-scoped
   // query would claim to be searching everything. The placeholder + accessible
   // name are the honest place for it: the field itself must keep showing only
   // the words, because those are what the user edits.
   const scope = nav.searchScope()
   const lane = scope ? nav.filterLabel(scope) : ""
   el.searchInput.placeholder = lane ? `Search titles in ${lane}…` : "Search titles…"
   el.searchInput.setAttribute("aria-label", lane ? `Search article titles in ${lane}` : "Search article titles")
   let note = ""
   if (q && nav.searchShort(q))
      note = "Short words search only recent articles — type a longer word to reach the archive."
   else if (nav.searchTruncated()) note = "Showing the most recent matches — refine to reach older ones."
   el.searchNote.textContent = note
   el.searchNote.hidden = !note
}
