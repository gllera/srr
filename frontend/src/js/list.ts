import * as data from "./data"
import { timeAgo, srcColorIndex, dayLabel } from "./fmt"
import * as nav from "./nav"

// The list surface — the app's home: a scannable feed of headlines under the
// current filter, newest-first, source-keyed with read/unread weighting. Tapping a row
// opens the reader (app wires that via setup's `open`). The list owns no nav
// state of its own — it walks nav.feedLeft/feedRight over the active filter (the
// same neighbor seam the reader steps through, just unbounded in both
// directions) and reads the seen map for dots, so the filter/unseen-only/saved/
// search semantics are identical to the reader's.
//
// Bidirectional infinite window, anchored at the filter's reading position. On
// open the list anchors at nav.listAnchor() — the article the reader last sat on
// when it still matches the filter, else a tag/feed's remembered resume
// position, else (a tag/feed with no navigation information) its OLDEST
// article, else the newest match ([ALL]/saved/search). Returning FROM THE READER
// centers that article in the viewport and highlights its row (.srr-row-current)
// so you land back on what you were reading; a resume/oldest anchor (filter
// switch, date scrub, never-opened tag) is top-aligned instead — the
// start-of-backlog framing. NEWER ("next") articles load ABOVE the anchor (scroll
// up) and older ones below (scroll down), both paged lazily off
// IntersectionObserver sentinels.
//
// The rendered rows ARE a persisted, expandable navigation list: returning from
// the reader to an article that's already a rendered row (the common case — you
// stepped a few within the loaded window) re-anchors by scrolling to it with NO
// feed walk, NO fetch and NO rebuild (see show()). Only a filter change or an
// article outside the window triggers a bounded rebuild (≤ 2 batches).

// Rows fetched per batch in either direction. One batch spans roughly one
// meta shard (5,000-card shards held in the LRU, falling back to data/ when
// meta lags), so this is a paint-budget knob, not a fetch-count one.
const BATCH = 30

// Start fetching the next batch this far beyond the fold (a scroll runway so
// rows are ready before they're scrolled into view), in either direction.
const ROOT_MARGIN = "800px"

// Per-row save star. Tapping it toggles nav.toggleSaved without opening the
// reader; the row carries .srr-row-saved for the filled look.
const STAR_SVG =
   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>'

// The caught-up reward mark — a plain checkmark, the universal "done".
const CHECK_SVG =
   '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

let container: HTMLElement
let rowsEl: HTMLElement | null = null
let topSentinel: HTMLElement
let bottomSentinel: HTMLElement
let onOpen: (chron: number) => void = () => {}
// Called after every programmatic scroll the list performs (anchor positioning,
// prepend compensation) so the gesture layer can resync its toolbar-hide
// baseline — otherwise the jump reads as a downward scroll and hides the toolbar.
let notifyScroll: () => void = () => {}

// Freshness token: a new render() reassigns it so any in-flight load (or pending
// observer callback) from the prior filter bails before touching the DOM — the
// same discipline as dropdown's fill tokens and nav's prefetch.
let tok: object = {}
let newest = -1 // chronIdx of the newest (topmost) row rendered (-1 = none yet)
let oldest = -1 // chronIdx of the oldest (bottommost) row rendered (-1 = none yet)
let exhaustedTop = false // walked off the newest end (no newer matches above)
let exhaustedBottom = false // walked off the oldest end of the (filtered) feed
let loadingTop = false // a newer-load is in flight (re-entry guard for fetchNewer)
let loadingBottom = false // an older-load is in flight (re-entry guard for fetchOlder)
let pumping = false // a downward viewport-fill loop is running (re-entry guard for pump)
let builtKey: string | null = null // filterKey() the current DOM was built for
let observer: IntersectionObserver | null = null

export function setup(el: HTMLElement, open: (chron: number) => void, onScroll?: () => void): void {
   container = el
   onOpen = open
   notifyScroll = onScroll ?? (() => {})
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
            relabelDividers() // drop a day divider the removed row may have orphaned
            if (rowsEl && !rowsEl.querySelector("a.srr-row")) showEmptyState()
         }
         return
      }
      onOpen(chron)
   })
}

function el(tag: string, className: string): HTMLElement {
   const e = document.createElement(tag)
   e.className = className
   return e
}

// One headline row: a source-colored rail + ("source · age" eyebrow over the
// title). Unread reads as full-ink weight + saturated rail, read as dimmed.
// Display fallbacks ("(untitled)", the "[DELETED]" feed tombstone) live here.
function rowEl(chron: number, art: import("./format.gen").IMetaWire, seen: Record<string, number>): HTMLElement {
   const a = document.createElement("a")
   a.className = "srr-row"
   a.href = "#" + chron + nav.tokensSuffix()
   a.dataset.chron = String(chron)
   a.dataset.feed = String(art.f)
   // Stable per-source color slot (see styles.css [data-src]): the source-colored
   // left rail + eyebrow let the feed be triaged by origin.
   a.dataset.src = String(srcColorIndex(art.f))
   // The article's own timestamp — relabelDividers buckets rows into day strata
   // by comparing the dayLabel of consecutive rows.
   a.dataset.ts = String(art.w)
   if (nav.isRowUnread(chron, art.f, seen)) a.classList.add("srr-row-unread")
   // The article currently in the reader (the one you were just reading) is
   // highlighted wherever it appears, so returning to the list lands you on it.
   if (chron === nav.currentChron()) a.classList.add("srr-row-current")
   const saved = nav.isSaved(chron)
   if (saved) a.classList.add("srr-row-saved")
   const body = el("div", "srr-row-body")
   // Source-first head: the source name (the primary triage key) leads as a
   // colored mono eyebrow, with the age right-aligned beside it; the title
   // follows beneath.
   const head = el("div", "srr-row-head")
   const source = el("span", "srr-row-source")
   source.textContent = data.feedTitle(art.f)
   const age = el("time", "srr-row-age")
   age.textContent = timeAgo(art.w)
   head.append(source, age)
   const title = el("div", "srr-row-title")
   title.textContent = art.t || "(untitled)"
   body.append(head, title)
   const star = el("span", "srr-row-star")
   star.setAttribute("role", "button")
   star.setAttribute("aria-label", "Save article")
   star.setAttribute("aria-pressed", String(saved))
   star.innerHTML = STAR_SVG
   a.append(body, star)
   return a
}

// The "wire when it's quiet": each empty/in-between state is a directed station —
// a mono eyebrow (the wire voice) over one plain, specific line that says what's
// true and what to do next, instead of a vague "Nothing here". The caught-up
// state (unseen-only on, everything read) is the reward for the app's purpose.
function emptyState(): void {
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

   if (nav.isSearchFilter()) {
      const q = nav.searchQuery()
      if (q) msg.append("No titles match ", em(`“${q}”`), ". Try fewer or different words.")
      else {
         eyebrow("Search")
         msg.textContent = "Find any article by its title."
      }
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
   } else if (nav.filter.saved) {
      eyebrow("Nothing saved")
      const star = el("span", "srr-empty-star")
      star.textContent = "★"
      msg.append("Tap ", star, " on any article to keep it here for later.")
   } else if (nav.filter.active) {
      msg.textContent = "No articles under this filter yet."
   } else {
      eyebrow("No dispatches")
      msg.textContent = "New articles show up here once your feeds are fetched."
   }
   wrap.appendChild(msg)
   container.appendChild(wrap)
}

// Collapse a now-empty list (the Saved view after un-saving the last row) to its
// empty state, dropping the observer so a stale sentinel can't keep firing.
function showEmptyState(): void {
   teardownObserver()
   rowsEl = null
   container.replaceChildren()
   emptyState()
}

// The list's TIME axis: rebuild the sticky day-strata dividers from scratch over
// the currently rendered rows (idempotent — drop the old ones, walk the rows
// newest-first, and insert a divider before the first row of each new day).
// Cheap: the window is bounded, and dayLabel is unique per calendar day so a
// label change IS a day boundary. Suppressed in search mode (title hits are
// cross-time, and the pinned search bar owns the sticky top slot). Callers run
// it inside any scroll-compensation bracket so the divider heights ride the same
// scrollHeight delta as the rows.
function relabelDividers(): void {
   if (!rowsEl) return
   rowsEl.querySelectorAll(".srr-day-divider").forEach((d) => d.remove())
   if (nav.isSearchFilter()) return
   let prev: string | null = null
   for (const row of rowsEl.querySelectorAll<HTMLElement>("a.srr-row")) {
      const label = dayLabel(Number(row.dataset.ts))
      if (label !== prev) {
         const d = el("div", "srr-day-divider")
         d.textContent = label
         rowsEl.insertBefore(d, row)
         prev = label
      }
   }
}

// The list's oldest-end terminus: once the feed is exhausted downward, cap the
// rows with an "OLDEST" sign-off so scrolling to the bottom reads as a definite
// end — the list counterpart to the reader's read-on "LATEST" line. Idempotent
// (one terminus at most) and cleared on every rebuild via replaceChildren;
// rowSibling skips it, so it never intercepts cursor stepping.
function syncBottomTerminus(): void {
   if (!rowsEl) return
   const existing = rowsEl.querySelector(".srr-wire-end")
   if (!exhaustedBottom) {
      existing?.remove()
      return
   }
   if (existing) return
   const end = el("div", "srr-wire-end")
   const rule = el("div", "srr-wire-end-rule")
   rule.textContent = "OLDEST" // the bottom of a newest-first list is its oldest end
   end.append(rule)
   rowsEl.appendChild(end)
}

// The list's newest-end terminus — the symmetric cap at the top: once the upward
// walk is exhausted, prepend a "LATEST" sign-off so scrolling up to the newest
// reads as a definite end, matching the reader's read-on "LATEST" line. Same
// idempotent/cleared-on-rebuild/rowSibling-skipped contract as the bottom. When
// `compensate`, it keeps the viewport put across the prepend (the incremental
// fetchNewer path, which compensates its own prepended rows the same way);
// render passes false because it sets scroll explicitly right after.
function syncTopTerminus(compensate = false): void {
   if (!rowsEl) return
   const existing = rowsEl.querySelector(".srr-wire-top")
   if (exhaustedTop === !!existing) return // already in the desired state
   const scroller = document.scrollingElement ?? document.documentElement
   const before = compensate ? scroller.scrollHeight : 0
   if (!exhaustedTop) {
      existing!.remove()
   } else {
      const top = el("div", "srr-wire-top")
      const rule = el("div", "srr-wire-end-rule")
      rule.textContent = "LATEST" // the top of a newest-first list is its newest end
      top.append(rule)
      rowsEl.insertBefore(top, rowsEl.firstChild)
   }
   if (compensate) {
      const delta = scroller.scrollHeight - before
      if (delta) {
         window.scrollTo(0, window.scrollY + delta)
         notifyScroll()
      }
   }
}

// Walk the filtered feed from `from` (inclusive) collecting up to `max` matching
// chronIdxs. "older" walks feedLeft downward (returns DESCENDING chrons, so the
// caller can append them newest-first); "newer" walks feedRight upward (returns
// ASCENDING chrons). `exhausted` is true when the walk ran off the end of the
// feed (a -1 lookup or out-of-range index), as opposed to merely filling `max`.
async function walk(
   my: object,
   from: number,
   max: number,
   dir: "older" | "newer",
): Promise<{ chrons: number[]; exhausted: boolean }> {
   const chrons: number[] = []
   const n = data.db.total_art
   let i = from
   while (chrons.length < max) {
      if (dir === "older" ? i < 0 : i >= n) return { chrons, exhausted: true }
      const found = await (dir === "older" ? nav.feedLeft(i) : nav.feedRight(i))
      if (my !== tok) return { chrons, exhausted: false }
      if (found === -1) return { chrons, exhausted: true }
      chrons.push(found)
      i = dir === "older" ? found - 1 : found + 1
   }
   return { chrons, exhausted: false }
}

// Full (re)build: clears the list, resolves the anchor (the reader's article when
// it matches, else newest), loads a batch older (incl. the anchor) and — when
// anchored mid-feed — a batch newer above it, then positions the anchor. `center`
// (set when returning from the reader) centers the anchor in the viewport instead
// of top-aligning it — but only the live reader article (seed === anchorChron),
// never a resume/oldest anchor. Sets builtKey so show() can later refresh-vs-rebuild.
export async function render(center = false): Promise<void> {
   const my = (tok = {})
   teardownObserver()
   newest = oldest = -1
   exhaustedTop = exhaustedBottom = false
   loadingTop = loadingBottom = false
   pumping = false
   builtKey = nav.filterKey()
   rowsEl = null
   container.replaceChildren()

   if (data.db.total_art === 0) {
      emptyState()
      return
   }

   const anchor = await nav.listAnchor()
   // The seed is the topmost row of the older batch: the anchor itself when it's
   // a real match, the newest match when anchored at -1, and (defensively) the
   // nearest match below a non-matching anchor.
   let seed = await nav.feedLeft(anchor === -1 ? data.db.total_art - 1 : anchor)
   if (my !== tok) return
   if (seed === -1 && anchor !== -1) seed = await nav.feedLeft(data.db.total_art - 1)
   if (my !== tok) return
   if (seed === -1) {
      emptyState()
      return
   }
   const anchoredMid = anchor !== -1 && seed === anchor

   const older = await walk(my, seed, BATCH, "older") // [seed, ...older], descending
   if (my !== tok) return
   const newer = anchoredMid
      ? await walk(my, seed + 1, BATCH, "newer") // matches above the seed, ascending
      : { chrons: [], exhausted: true }
   if (my !== tok) return
   if (older.chrons.length === 0) {
      emptyState()
      return
   }

   oldest = older.chrons[older.chrons.length - 1]
   newest = newer.chrons.length ? newer.chrons[newer.chrons.length - 1] : older.chrons[0]
   exhaustedBottom = older.exhausted || oldest === 0
   exhaustedTop = newer.exhausted || newest === data.db.total_art - 1

   const chronsDesc = newer.chrons.slice().reverse().concat(older.chrons) // newest-first
   const seen = nav.getSeenMap()
   const arts = await Promise.all(chronsDesc.map((c) => data.loadMeta(c)))
   if (my !== tok) return

   rowsEl = el("div", "srr-list-rows")
   topSentinel = el("div", "srr-list-sentinel")
   bottomSentinel = el("div", "srr-list-sentinel")
   const frag = document.createDocumentFragment()
   chronsDesc.forEach((c, k) => frag.appendChild(rowEl(c, arts[k], seen)))
   rowsEl.appendChild(frag)
   container.append(topSentinel, rowsEl, bottomSentinel)
   relabelDividers()
   syncBottomTerminus() // cap the rows when the whole view fits one batch
   syncTopTerminus() // and cap the top when we're already anchored at the newest

   if (anchoredMid) scrollChronToView(seed, center && seed === nav.anchorChron())
   else window.scrollTo(0, 0)
   notifyScroll()
   observe(my)
}

// Re-show an already-built list (same filter). When the reader's article is
// already a rendered row — the common return path: you stepped a few articles
// within the loaded window — re-anchor by scrolling to it, with NO feed walk,
// fetch or rebuild. Filter change, or an article outside the window (you jumped,
// or navigated past the loaded batch), falls through to a bounded rebuild.
// `center` (returning from the reader) centers the article instead of
// top-aligning it; the rebuild path forwards it to render().
export async function show(center = false): Promise<void> {
   const pos = nav.currentChron()
   if (builtKey === nav.filterKey() && rowsEl && pos >= 0 && findRow(pos)) {
      refresh()
      scrollChronToView(pos, center)
      notifyScroll()
      return
   }
   await render(center)
}

// Re-derive read/unread dots + saved stars + the current-article highlight from
// the live state (you may have read or saved some in the reader), and in the
// Saved view drop rows un-saved elsewhere. Does NOT move scroll — show() owns
// re-anchoring.
export function refresh(): void {
   if (!rowsEl) return
   const seen = nav.getSeenMap()
   const savedView = nav.filter.saved
   const current = nav.currentChron()
   rowsEl.querySelectorAll<HTMLElement>("a.srr-row").forEach((a) => {
      const chron = Number(a.dataset.chron)
      a.classList.toggle("srr-row-unread", nav.isRowUnread(chron, Number(a.dataset.feed), seen))
      a.classList.toggle("srr-row-current", chron === current)
      const saved = nav.isSaved(chron)
      a.classList.toggle("srr-row-saved", saved)
      a.querySelector(".srr-row-star")?.setAttribute("aria-pressed", String(saved))
      // In the Saved view, an article un-saved from the reader is gone from the
      // feed — drop its row on the way back.
      if (savedView && !saved) a.remove()
   })
   if (savedView && rowsEl.childElementCount === 0) showEmptyState()
}

// Force a rebuild regardless of builtKey — used after an unseen-only toggle or a
// search-query change, where the filter token may be unchanged but its
// membership (raised bounds / new hit set) is not.
export function rerender(): Promise<void> {
   builtKey = null
   return render()
}

function findRow(chron: number): HTMLElement | null {
   return rowsEl ? rowsEl.querySelector<HTMLElement>(`a.srr-row[data-chron="${chron}"]`) : null
}

// Scroll the row for `chron` into view: `center` puts its vertical midpoint at
// the center of the area below the sticky search bar (returning from the reader —
// keep what you were reading in the middle, with context above and below); else
// it's aligned to the top of that area (the start-of-backlog / date-scrub
// framing). window.scrollTo clamps to [0, maxScroll], so an anchor near the top
// or bottom of the feed lands as close to centered as the content allows. A no-op
// if the row isn't rendered (e.g. saved view dropped it on return) — the caller
// then keeps the current scroll.
function scrollChronToView(chron: number, center: boolean): void {
   const row = findRow(chron)
   if (!row) return
   const rect = row.getBoundingClientRect()
   const top = rect.top + window.scrollY
   const sticky = stickyOffset()
   const target = center ? top + rect.height / 2 - (window.innerHeight + sticky) / 2 : top - sticky
   window.scrollTo(0, Math.max(0, target))
}

function stickyOffset(): number {
   const bar = document.querySelector<HTMLElement>(".srr-searchbar")
   return bar && bar.offsetParent !== null ? bar.offsetHeight : 0
}

// Pull the next older batch and append it below. Guarded against re-entry; bails
// on a stale token without touching the DOM.
async function fetchOlder(my: object): Promise<void> {
   if (my !== tok || exhaustedBottom || loadingBottom || !rowsEl) return
   loadingBottom = true
   try {
      const { chrons, exhausted } = await walk(my, oldest - 1, BATCH, "older")
      if (my !== tok) return
      if (chrons.length === 0) {
         exhaustedBottom = true
         return
      }
      oldest = chrons[chrons.length - 1]
      if (exhausted || oldest === 0) exhaustedBottom = true
      const seen = nav.getSeenMap()
      const arts = await Promise.all(chrons.map((c) => data.loadMeta(c)))
      if (my !== tok) return
      const frag = document.createDocumentFragment()
      chrons.forEach((c, k) => frag.appendChild(rowEl(c, arts[k], seen)))
      rowsEl.appendChild(frag)
      relabelDividers()
   } finally {
      if (my === tok) {
         loadingBottom = false
         syncBottomTerminus() // append the terminus the moment we page off the oldest end
      }
   }
}

// Pull the next newer batch and PREPEND it above, compensating window scroll so
// the viewport stays put (the content above the fold shifts down by the new
// rows' height). overflow-anchor:none on the list (see styles.css) keeps the
// browser from also adjusting — manual compensation is the sole adjuster, so it
// behaves the same on engines with and without scroll anchoring (Safari has none).
async function fetchNewer(my: object): Promise<void> {
   if (my !== tok || exhaustedTop || loadingTop || newest === -1 || !rowsEl) return
   loadingTop = true
   try {
      const { chrons, exhausted } = await walk(my, newest + 1, BATCH, "newer") // ascending
      if (my !== tok) return
      if (chrons.length === 0) {
         exhaustedTop = true
         return
      }
      newest = chrons[chrons.length - 1]
      if (exhausted || newest === data.db.total_art - 1) exhaustedTop = true
      const seen = nav.getSeenMap()
      const arts = await Promise.all(chrons.map((c) => data.loadMeta(c)))
      if (my !== tok) return
      const frag = document.createDocumentFragment()
      // chrons is ascending; prepend newest-first so the block reads top-down.
      for (let k = chrons.length - 1; k >= 0; k--) frag.appendChild(rowEl(chrons[k], arts[k], seen))
      const scroller = document.scrollingElement ?? document.documentElement
      const before = scroller.scrollHeight
      rowsEl.insertBefore(frag, rowsEl.firstChild)
      // Relabel inside the measure bracket so the day strata that shift across the
      // new seam ride the same scrollHeight delta as the prepended rows.
      relabelDividers()
      const delta = scroller.scrollHeight - before
      if (delta) {
         window.scrollTo(0, window.scrollY + delta)
         notifyScroll()
      }
   } finally {
      if (my === tok) {
         loadingTop = false
         syncTopTerminus(true) // prepend the terminus the moment we page off the newest end
      }
   }
}

// Public for the IntersectionObserver and tests: page one batch in either
// direction under the current freshness token. loadMore keeps its name (older
// paging) for back-compat; loadNewer pages upward.
export function loadMore(): Promise<void> {
   return fetchOlder(tok)
}
export function loadNewer(): Promise<void> {
   return fetchNewer(tok)
}

function observe(my: object): void {
   if (typeof IntersectionObserver === "undefined") return // jsdom: no layout/IO
   observer = new IntersectionObserver(
      (entries) => {
         if (my !== tok) return
         for (const e of entries) {
            if (!e.isIntersecting) continue
            if (e.target === topSentinel) void fetchNewer(my)
            else void pump(my)
         }
      },
      { rootMargin: ROOT_MARGIN },
   )
   observer.observe(topSentinel)
   observer.observe(bottomSentinel)
   // The older batch below the anchor may not fill the viewport (tall screen /
   // sparse filter); pump until the bottom sentinel sits below the fold or the
   // feed is exhausted. The newer side above needs no initial pump — it's
   // off-screen until the user scrolls up, where the observer pages it in.
   void pump(my)
}

async function pump(my: object): Promise<void> {
   if (pumping) return
   pumping = true
   try {
      while (my === tok && !exhaustedBottom && rowsEl) {
         const rect = bottomSentinel.getBoundingClientRect()
         if (rect.top > window.innerHeight + 800) break
         const before = rowsEl.childElementCount
         await fetchOlder(my)
         // No progress and not exhausted (a transient fetchOlder no-op) — stop to
         // avoid a busy spin; the next scroll/observer tick will retry.
         if (rowsEl && rowsEl.childElementCount === before && !exhaustedBottom) break
      }
   } finally {
      pumping = false
   }
}

function teardownObserver(): void {
   observer?.disconnect()
   observer = null
}

// ── Keyboard selection cursor ────────────────────────────────────────────────
// The list is a window over the SAME feed sequence the reader steps through, so
// its rows top→bottom are strictly newest→oldest (the filter's order). A/← select
// the OLDER neighbor (the row below) and D/→ the NEWER (the row above), mirroring
// the reader's left()/right() so the same key reaches the same article on either
// surface. The selected row carries .srr-row-current (the reader's highlight) and
// nav.select() tracks it in nav.pos, so opening it (tap) or re-anchoring the list
// later stays consistent. The neighbor is just the adjacent row — no feed walk —
// and the infinite window pages one batch when the neighbor isn't loaded yet.
// Returns the now-selected chronIdx, or -1 when there's nowhere to move.
export async function moveSelection(dir: "older" | "newer"): Promise<number> {
   if (!rowsEl) return -1
   const my = tok
   const cur = rowsEl.querySelector<HTMLElement>("a.srr-row.srr-row-current")
   if (!cur) {
      // No cursor yet (fresh list, or the reader's article isn't a rendered row):
      // the first key just drops the cursor on the topmost row in view, no step.
      const start = firstVisibleRow()
      if (!start) return -1
      selectRow(start)
      return Number(start.dataset.chron)
   }
   let target = rowSibling(cur, dir)
   if (!target) {
      // At the loaded edge — page one batch that way (append older / prepend
      // newer), then retry the sibling once. A stale token or an in-flight load
      // leaves target null and the keypress no-ops; the next press retries.
      await (dir === "older" ? fetchOlder(my) : fetchNewer(my))
      if (my !== tok || !rowsEl) return -1
      target = rowSibling(cur, dir)
   }
   if (!target) {
      // Still no neighbor. When the feed is genuinely exhausted that way we're at
      // the end/beginning of the list — bump the current row to make the boundary
      // clear. (A null target while NOT exhausted is a transient in-flight page;
      // no cue, since the next press will advance once it lands.)
      if (dir === "older" ? exhaustedBottom : exhaustedTop) bumpEdge(cur, dir)
      return -1
   }
   selectRow(target)
   return Number(target.dataset.chron)
}

// Nudge the current row toward the edge it can't pass and let it spring back — a
// localized "rubber-band" so a key press at the start/end of the list reads as a
// boundary, not a dropped input. Direction-aware (down at the oldest end, up at
// the newest); the animation self-clears, and a remove+reflow restarts it on a
// rapid repeat. Honors prefers-reduced-motion via the CSS (animation: none).
function bumpEdge(row: HTMLElement, dir: "older" | "newer"): void {
   const cls = dir === "older" ? "srr-row-bump-down" : "srr-row-bump-up"
   row.classList.remove("srr-row-bump-down", "srr-row-bump-up")
   void row.offsetWidth // force reflow so re-adding restarts the keyframes
   row.classList.add(cls)
   setTimeout(() => row.classList.remove(cls), 220) // > the 0.2s animation
}

// The adjacent row in `dir` (older = below / next sibling, newer = above /
// previous sibling), or null at the loaded edge. Skips day-strata dividers, which
// sit between rows inside rowsEl.
function rowSibling(row: HTMLElement, dir: "older" | "newer"): HTMLElement | null {
   let sib = (dir === "older" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null
   while (sib && !sib.classList.contains("srr-row")) {
      sib = (dir === "older" ? sib.nextElementSibling : sib.previousElementSibling) as HTMLElement | null
   }
   return sib
}

// Make `row` the cursor: move the highlight, sync nav.pos (so the selection IS
// the reader's "current article"), and scroll it into view. notifyScroll resyncs
// the gesture toolbar baseline so the programmatic scroll doesn't read as a
// downward swipe and hide the toolbar (same contract as render/fetchNewer).
function selectRow(row: HTMLElement): void {
   if (!rowsEl) return
   rowsEl.querySelector(".srr-row-current")?.classList.remove("srr-row-current")
   row.classList.add("srr-row-current")
   nav.select(Number(row.dataset.chron), Number(row.dataset.feed))
   scrollRowIntoView(row)
   notifyScroll()
}

// The topmost row at least partly below the sticky search bar — where the cursor
// lands when none is set yet, so it appears where you're looking rather than at a
// fixed end. Falls back to the last (oldest) row when geometry is unavailable
// (jsdom reports zero rects).
function firstVisibleRow(): HTMLElement | null {
   if (!rowsEl) return null
   const sticky = stickyOffset()
   const rows = rowsEl.querySelectorAll<HTMLElement>("a.srr-row")
   for (const r of rows) if (r.getBoundingClientRect().bottom > sticky + 1) return r
   return (rows[rows.length - 1] as HTMLElement | undefined) ?? null
}

// Bring the selected row fully into the live band — below the sticky search bar
// (top) and ABOVE the toolbar fixed to the bottom of the viewport — but only when
// it isn't already there (a keyboard step shouldn't recenter on every press,
// unlike the return-from-reader centering). Without the bottom inset a row
// stepped downward parks flush against the viewport bottom, hidden behind the
// toolbar (which selectRow's notifyScroll always reveals). window.scrollTo clamps
// to [0, maxScroll].
function scrollRowIntoView(row: HTMLElement): void {
   const rect = row.getBoundingClientRect()
   const top = stickyOffset()
   const bottom = window.innerHeight - toolbarInset()
   const margin = 8 // breathing room so the row clears the sticky bar / toolbar
   if (rect.top < top + margin) window.scrollTo(0, Math.max(0, window.scrollY + rect.top - top - margin))
   else if (rect.bottom > bottom - margin) window.scrollTo(0, window.scrollY + rect.bottom - bottom + margin)
}

// Height the bottom-fixed toolbar occupies. selectRow reveals it after every move
// (notifyScroll), so its full rendered height is reserved unconditionally of the
// current slide state — offsetHeight ignores the slide transform and reads 0 only
// when the toolbar is display:none (no list surface).
function toolbarInset(): number {
   const bar = document.querySelector<HTMLElement>(".srr-toolbar")
   return bar ? bar.offsetHeight : 0
}
