// empty-state.ts — the ONE directed empty state both article-bearing surfaces
// show, extracted from list.ts so the reader does not have to import the whole
// list surface to reach it.
//
// It is a LEAF by the article-view.ts / els.ts rule: it imports data/nav/fmt and
// no controller, and builds its own nodes rather than reaching for a caller's.
// That is the same argument article-view.ts makes for the article fill — two
// surfaces owe the reader the identical thing, so the builder belongs to
// NEITHER of them. Before this the reader borrowed it off list.ts, which
// falsified reader.ts's own "imports no sibling controller" invariant and pulled
// list's gestures/refresh/search/seen/scroller edges into the reader's graph.
import * as data from "./data"
import { CHECK_SVG, stampSrc } from "./fmt"
import * as nav from "./nav"

// The two-argument element factory both this module and list.ts build rows and
// stations with. It lives here rather than in list.ts because list.ts already
// imports this module — so sharing it costs no edge — and because a leaf is
// where a shape with no dependencies belongs.
export function el(tag: string, className: string): HTMLElement {
   const e = document.createElement(tag)
   e.className = className
   return e
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
         if (opts.startFeed !== undefined) stampSrc(name, opts.startFeed)
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
