import * as data from "./data"
import { timeAgo, srcColorIndex, dayLabelCtx, dayLabelWith, CHECK_SVG } from "./fmt"
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

// Max meta-card fetches in flight while filling a freshly-rendered batch. Bounds
// concurrency so the packs NEAREST the navigation anchor (filled first, see
// render) actually win the network before off-screen rows, instead of all BATCH
// fetches racing. ~the classic per-origin connection budget.
const FILL_CONCURRENCY = 6

// Start fetching the next batch this far beyond the fold (a scroll runway so
// rows are ready before they're scrolled into view), in either direction.
const ROOT_MARGIN = "800px"

// Per-row save star. Tapping it toggles nav.toggleSaved without opening the
// reader; the row carries .srr-row-saved for the filled look.
const STAR_SVG =
   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>'

let container: HTMLElement
let rowsEl: HTMLElement | null = null
let topSentinel: HTMLElement
let bottomSentinel: HTMLElement
let onOpen: (chron: number) => void = () => {}
// Called after every programmatic scroll the list performs (anchor positioning,
// prepend compensation) so the gesture layer can resync its toolbar-hide
// baseline — otherwise the jump reads as a downward scroll and hides the toolbar.
let notifyScroll: () => void = () => {}
// Surfaces a scroll-paging failure (a meta pack 404/network drop during fetchOlder/
// fetchNewer). The initial render reports errors through its awaited show() chain;
// the incremental paging fired off the IntersectionObserver has no such caller, so
// without this its rejection would be an unhandled promise — the list would just
// stop growing with no feedback. app wires this to its retry-able error popup.
let onError: (e: unknown) => void = () => {}

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
let growing = false // an onStoreGrown reopen/rebuild is in flight (re-entry guard)
let builtKey: string | null = null // filterKey() the current DOM was built for
let observer: IntersectionObserver | null = null
// Set by a genuine user scroll gesture (wheel/touch/key) during a render, so the
// post-fill anchor re-assert never yanks the page out from under the reader.
// Programmatic scrolls (window.scrollTo) don't fire these, so they don't trip it.
let userScrolled = false

export function setup(
   el: HTMLElement,
   open: (chron: number) => void,
   onScroll?: () => void,
   onPageError?: (e: unknown) => void,
): void {
   container = el
   onOpen = open
   notifyScroll = onScroll ?? (() => {})
   onError = onPageError ?? (() => {})
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
            else syncRovingTab() // the removed row may have held the lone Tab stop
         }
         return
      }
      onOpen(chron)
   })
   // A genuine scroll gesture during a progressive render disables the post-fill
   // anchor re-assert (the user's position wins). Programmatic window.scrollTo
   // fires "scroll" but NOT these, so it never trips the flag.
   const markScrolled = () => {
      userScrolled = true
   }
   container.ownerDocument.addEventListener("wheel", markScrolled, { passive: true })
   container.ownerDocument.addEventListener("touchstart", markScrolled, { passive: true })
   container.ownerDocument.addEventListener("keydown", markScrolled)
}

function el(tag: string, className: string): HTMLElement {
   const e = document.createElement(tag)
   e.className = className
   return e
}

// One headline row: a source-colored rail + ("source · age" eyebrow over the
// title). Unread reads as full-ink weight + saturated rail, read as dimmed.
// Display fallbacks ("(untitled)", the "[DELETED]" feed tombstone) live here.
// One headline row. With a card it is born complete (search hits, paging); with
// `art === null` it is a height-reserved SKELETON that fillRow() later populates
// in place (the feed/[ALL]/saved progressive path). Chron-derived bits (href,
// saved star, current highlight) are set up front; feed-derived bits (source
// color/name, age, title, unread weight, data-ts) arrive with the card.
export function rowEl(
   chron: number,
   art: import("./format.gen").IMetaWire | null,
   seen: Record<string, number>,
   // One saved-set parse per BATCH, threaded by the render/page/refresh passes
   // (the default covers direct one-off callers, e.g. tests).
   savedSet: Set<number> = nav.getSavedSet(),
): HTMLElement {
   const a = document.createElement("a")
   a.className = "srr-row"
   a.href = "#" + chron + nav.tokensSuffix()
   a.dataset.chron = String(chron)
   // Roving tabindex: every row defaults OUT of the Tab order; syncRovingTab puts
   // exactly one back in (the cursor, or the first row), so Tab lands on the
   // selection instead of stepping through every article.
   a.tabIndex = -1
   // The article currently in the reader (the one you were just reading) is
   // highlighted wherever it appears, so returning to the list lands you on it.
   if (chron === nav.currentChron()) a.classList.add("srr-row-current")
   const saved = savedSet.has(chron)
   if (saved) a.classList.add("srr-row-saved")
   const body = el("div", "srr-row-body")
   // Source-first head: the source name (the primary triage key) leads as a
   // colored mono eyebrow, with the age right-aligned beside it; the title
   // follows beneath.
   const head = el("div", "srr-row-head")
   const source = el("span", "srr-row-source")
   const age = el("time", "srr-row-age")
   head.append(source, age)
   const title = el("div", "srr-row-title")
   body.append(head, title)
   const star = el("span", "srr-row-star")
   star.setAttribute("role", "button")
   star.setAttribute("aria-label", "Save article")
   star.setAttribute("aria-pressed", String(saved))
   star.innerHTML = STAR_SVG
   a.append(body, star)
   if (art) fillRow(a, art, seen)
   else a.classList.add("srr-row-skeleton")
   return a
}

// Populate a skeleton row's feed-derived content in place once its meta card
// lands. Idempotent: also used as rowEl's content path when a card is present.
export function fillRow(a: HTMLElement, art: import("./format.gen").IMetaWire, seen: Record<string, number>): void {
   const chron = Number(a.dataset.chron)
   // Stable per-source color slot (see styles.css [data-src]): the source-colored
   // left rail + eyebrow let the feed be triaged by origin.
   a.dataset.feed = String(art.f)
   a.dataset.src = String(srcColorIndex(art.f))
   // The article's own timestamp — relabelDividers buckets rows into day strata
   // by comparing the dayLabel of consecutive rows.
   a.dataset.ts = String(art.w)
   a.classList.toggle("srr-row-unread", nav.isRowUnread(chron, art.f, seen))
   a.querySelector(".srr-row-source")!.textContent = data.feedTitle(art.f)
   a.querySelector(".srr-row-age")!.textContent = timeAgo(art.w)
   a.querySelector(".srr-row-title")!.textContent = art.t || "(untitled)"
   a.classList.remove("srr-row-skeleton")
   // If selectRow placed the cursor on this row while it was still a skeleton
   // (feed unknown → nav.select was deferred via data-select-pending), sync now —
   // but only when the row is still the current cursor.  refresh() can move
   // .srr-row-current to a different row (e.g. the reader navigated away during
   // the skeleton window) without clearing selectPending, so we clear the marker
   // unconditionally and re-select only if this row is still highlighted.
   if (a.dataset.selectPending) {
      delete a.dataset.selectPending
      if (a.classList.contains("srr-row-current")) nav.select(chron, art.f)
   }
}

// Pin each row's REAL height as its content-visibility intrinsic size. Rows are
// virtualized with `content-visibility: auto; contain-intrinsic-size: auto 4rem`
// (styles.css) — but a real row is 1- or 2-line (≈60 vs 80px), so the 4rem (64px)
// placeholder is wrong for every row. With the list's browser scroll anchoring
// off (overflow-anchor:none, for Safari parity), nothing absorbs a placeholder→
// real correction happening ABOVE the viewport: the moment a skipped row renders
// (scrolled into view, or swept past by a prepend's compensation scroll) its size
// jumps and shoves the viewport — the upward-scroll jump. Measuring each row once
// and pinning its true height makes the reserved space exact, so a row's size
// never changes when it later renders or skips, on any engine. Called at every
// insertion path so the invariant "every loaded row's intrinsic size is its real
// height" holds, keeping the fetchNewer prepend compensation exact. One forced
// layout per batch (the offsetHeight read); the rows stay virtualized afterward.
//
// `contain-intrinsic-size` sizes the CONTENT box, but offsetHeight is the
// border-box (box-sizing:border-box). Pinning offsetHeight directly makes a
// skipped row reserve offsetHeight + padding + border — ~19px too tall per row,
// which over-scrolls the prepend compensation. Subtract the row chrome (identical
// for every .srr-row) so the reserved border-box equals the real rendered height.
function pinHeights(rows: HTMLElement[]): void {
   if (!rows.length) return
   for (const r of rows) r.style.setProperty("content-visibility", "visible")
   const heights = rows.map((r) => r.offsetHeight) // single forced layout, then cached reads
   const cs = getComputedStyle(rows[0])
   const px = (v: string): number => parseFloat(v) || 0 // "" (jsdom) / "auto" → 0
   const chrome = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth)
   rows.forEach((r, i) => {
      r.style.setProperty("contain-intrinsic-size", `auto ${Math.max(0, heights[i] - chrome)}px`)
      r.style.removeProperty("content-visibility")
   })
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
      eyebrow("Not started feed")
      // Name WHICH feed the unread backlog starts with — startFeed (the oldest
      // unread's own feed, threaded from nav.switchFilter), tinted with its
      // source color like every other feed identity: under a tag lane the label
      // alone couldn't say which member feed is the never-read one. Fallback
      // (probe blip): the lane label.
      if (opts.startFeed !== undefined) {
         const name = em(data.feedTitle(opts.startFeed))
         name.dataset.src = String(srcColorIndex(opts.startFeed))
         msg.append("Tap Next to start reading ", name, ".")
      } else {
         const key = nav.getCurrentFilterKey()
         if (key) msg.append("Tap Next to start reading ", em(nav.filterLabel(key)), ".")
         else msg.textContent = "Tap Next to start reading."
      }
   } else if (nav.isSearchFilter()) {
      const q = nav.searchQuery()
      if (q) msg.append("No titles match ", em(`“${q}”`), ". Try fewer or different words.")
      else {
         eyebrow("Search")
         msg.textContent = "Find any article by its title."
      }
   } else if (nav.filter.saved) {
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
   } else if (nav.filter.active) {
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

function emptyState(): void {
   container.appendChild(emptyStateEl())
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
// Re-assert the anchor after a progressive fill changed row heights, unless the
// user has scrolled (then their position wins). Only meaningful for an
// anchoredMid seed (rows above it can grow/shrink); a newest-top anchor is at
// scroll 0 and grows downward, so it never needs this.
function reassertAnchor(seed: number, center: boolean): void {
   if (userScrolled) return
   scrollChronToView(seed, center)
}

function relabelDividers(): void {
   if (!rowsEl) return
   rowsEl.querySelectorAll(".srr-day-divider").forEach((d) => d.remove())
   if (nav.isSearchFilter()) return
   let prev: string | null = null
   const ctx = dayLabelCtx() // hoisted: the pass walks every loaded row
   for (const row of rowsEl.querySelectorAll<HTMLElement>("a.srr-row")) {
      if (row.dataset.ts === undefined) continue // skeleton: no timestamp yet
      const label = dayLabelWith(Number(row.dataset.ts), ctx)
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
// end. Idempotent (one terminus at most) and cleared on every rebuild via
// replaceChildren; rowSibling skips it, so it never intercepts cursor stepping.
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
// reads as a definite end. Same idempotent/cleared-on-rebuild/rowSibling-skipped
// contract as the bottom. When
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

// Run `items` through `worker` with at most `limit` in flight, pulling them in
// the given order — so the earliest items (here: nearest the anchor) dispatch and
// resolve before later ones, regardless of transport (HTTP/2 would otherwise race
// them all at once). Each worker is token-guarded by its caller.
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
   let next = 0
   let failed = false
   const run = async (): Promise<void> => {
      while (next < items.length && !failed) {
         const i = next++
         try {
            await worker(items[i])
         } catch (e) {
            // First failure rejects the whole pool (render surfaces it). Flip the
            // flag so the other lanes stop claiming work instead of running on as
            // orphans — writing to detached rows and raising further unhandled
            // rejections after Promise.all has already settled.
            failed = true
            throw e
         }
      }
   }
   await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
}

// Full (re)build: clears the list, resolves the anchor (the reader's article when
// it matches, else newest), loads a batch older (incl. the anchor) and — when
// anchored mid-feed — a batch newer above it, then positions the anchor. `center`
// (set when returning from the reader) centers the anchor in the viewport instead
// of top-aligning it — but only the live reader article (seed === anchorChron),
// never an oldest-unread anchor. When the filter resolves to a SPECIFIC article
// (anchoredMid — a fresh feed/tag's oldest-unread position), that article also
// becomes the current selection (nav.select), so the highlighted row tracks what
// the reader would open; the newest-default anchor (-1: [ALL]/saved/search) is
// left unselected. `renderSearch` selects the newest hit for a query. Sets
// builtKey so show() can later refresh-vs-rebuild.
export async function render(center = false, onInteractive?: () => void): Promise<void> {
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
      onInteractive?.()
      return
   }

   // Search is always newest-top (listAnchor returns -1 for search) and discovers
   // its rows by walking nav's pre-loaded hit-set snapshot — a different path from
   // the feed walk + skeleton-fill below.
   if (nav.isSearchFilter()) return renderSearch(my, onInteractive)

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
      onInteractive?.()
      return
   }
   const anchoredMid = anchor !== -1 && seed === anchor

   // When the filter resolves to a SPECIFIC article — the anchoredMid seed, i.e.
   // a fresh feed/tag's oldest-unread position — make it the current selection so
   // the list highlight tracks the article the reader would open under that
   // filter. Returning from the reader already holds it as pos (guard no-ops). The
   // newest-default anchor (-1: [ALL]/saved/search, or a caught-up feed/tag) is
   // deliberately left unselected, so the first arrow still establishes the cursor
   // on the row in view (moveSelection) and a fresh [ALL] boot shows no selection.
   // getFeedId is resident — feedLeft just walked the seed's idx pack — no fetch.
   if (anchoredMid && seed !== nav.currentChron()) {
      nav.select(seed, await data.getFeedId(seed))
      if (my !== tok) return
   }

   const older = await walk(my, seed, BATCH, "older") // [seed, ...older], descending
   if (my !== tok) return
   const newer = anchoredMid
      ? await walk(my, seed + 1, BATCH, "newer") // matches above the seed, ascending
      : { chrons: [], exhausted: true }
   if (my !== tok) return
   if (older.chrons.length === 0) {
      emptyState()
      onInteractive?.()
      return
   }

   oldest = older.chrons[older.chrons.length - 1]
   newest = newer.chrons.length ? newer.chrons[newer.chrons.length - 1] : older.chrons[0]
   exhaustedBottom = older.exhausted || oldest === 0
   exhaustedTop = newer.exhausted || newest === data.db.total_art - 1

   const chronsDesc = newer.chrons.slice().reverse().concat(older.chrons) // newest-first
   const seen = nav.getSeenMap()
   const savedSet = nav.getSavedSet()

   rowsEl = el("div", "srr-list-rows")
   topSentinel = el("div", "srr-list-sentinel")
   bottomSentinel = el("div", "srr-list-sentinel")
   const frag = document.createDocumentFragment()
   const rows = chronsDesc.map((c) => rowEl(c, null, seen, savedSet)) // skeletons, in order
   rows.forEach((r) => frag.appendChild(r))
   rowsEl.appendChild(frag)
   container.append(topSentinel, rowsEl, bottomSentinel)
   syncBottomTerminus() // cap the rows when the whole view fits one batch
   syncTopTerminus() // and cap the top when we're already anchored at the newest
   syncRovingTab() // the seed row (or, with no selection, the first row) is the lone Tab stop

   // Position the surface, then hand it over (interactive) before the fills land.
   // Returning from the reader (center) lands on the live article immediately — its
   // pack is warm, so it anchors before the fill and re-asserts as neighbors grow.
   // A FRESH anchor (boot/filter change — landOnceMode) instead stays at the top
   // during load and lands ONCE after layout settles (below): scrolling onto
   // still-skeleton, pre-font rows and then correcting as they paint/reflow taller
   // is exactly the visible "bump". The newest-default (-1) is plain top.
   const landOnceMode = anchoredMid && !center
   if (anchoredMid && center) scrollChronToView(seed, true)
   else window.scrollTo(0, 0)
   notifyScroll()
   userScrolled = false
   onInteractive?.()
   // Hold the infinite-scroll observer until the land-once scroll: at the top during
   // load its top sentinel would page newer rows in (a large filter could runaway)
   // before we've reached the seed. The centered/newest paths observe right away.
   if (!landOnceMode) observe(my)

   // Fill rows NEAREST the anchor first (bounded concurrency), so the packs for
   // what you're looking at resolve before off-screen rows — progressive fill
   // prioritized by navigation position. Out-of-order arrival within a wave is
   // fine: each card fills its own row. Pin the rows' real heights, relabel
   // dividers (which skip still-skeleton rows), and re-assert the anchor (centered
   // reader-return only) so a height change above the seed doesn't drift it —
   // coalesced to ONE flush per animation frame, not per card: pinHeights'
   // offsetHeight read after relabelDividers' divider churn forces a full
   // synchronous relayout, and per-card that's O(rows) forced reflows packed into
   // first paint (the fetchOlder/fetchNewer paths already batch per fetch). A
   // warm cache drains every card in one task, so without the frame gate the
   // whole batch still thrashed. No requestAnimationFrame (jsdom) → flush per
   // card, the order the unit tests observe.
   const pendingFill: HTMLElement[] = []
   let fillFrame = 0
   const flushFill = (): void => {
      fillFrame = 0
      if (my !== tok || !pendingFill.length) return
      pinHeights(pendingFill.splice(0))
      relabelDividers()
      if (anchoredMid && center) reassertAnchor(seed, true)
   }
   const anchorIdx = chronsDesc.indexOf(seed)
   const fillOrder = chronsDesc.map((_, k) => k).sort((a, b) => Math.abs(a - anchorIdx) - Math.abs(b - anchorIdx))
   await runPool(fillOrder, FILL_CONCURRENCY, async (k) => {
      if (my !== tok) return
      const card = await data.loadMeta(chronsDesc[k])
      if (my !== tok) return
      fillRow(rows[k], card, seen)
      pendingFill.push(rows[k])
      if (typeof requestAnimationFrame !== "function") flushFill()
      else if (!fillFrame) fillFrame = requestAnimationFrame(flushFill)
   })
   if (my !== tok) return
   if (fillFrame) cancelAnimationFrame(fillFrame)
   // Final authoritative pass: pin whatever a cancelled frame left pending, then
   // the full divider/anchor sync (keeps the every-row-pinned invariant — see
   // pinHeights — before the land-once measurement below).
   if (pendingFill.length) pinHeights(pendingFill.splice(0))
   relabelDividers()
   if (anchoredMid && center) reassertAnchor(seed, true)

   // Land-once for a fresh anchor: content-visibility rows paint taller and web
   // fonts reflow AFTER the fill, so scrolling now would land short and then bump as
   // the rows grow. Instead CONVERGE THE MEASUREMENT without moving: each frame
   // re-pin every row's current true height (so even off-screen rows reserve their
   // real size) and compute where the seed WOULD scroll to; once that target stops
   // changing for two frames, the layout has settled — scroll there a single time
   // and only now start the observer. Bounded so a never-settling layout can't spin;
   // abandoned if the user scrolls first. No requestAnimationFrame (jsdom) → land
   // synchronously.
   if (landOnceMode) {
      const allRows = (): HTMLElement[] => (rowsEl ? [...rowsEl.querySelectorAll<HTMLElement>("a.srr-row")] : [])
      const commit = (): void => {
         if (!userScrolled) {
            scrollChronToView(seed, false)
            notifyScroll()
            userScrolled = false
         }
         observe(my)
      }
      if (typeof requestAnimationFrame === "function") {
         let lastTarget = -1
         let stable = 0
         let tries = 0
         const tick = (): void => {
            if (my !== tok) return
            if (userScrolled || !rowsEl) return commit()
            pinHeights(allRows()) // re-measure true (post-paint/post-font) heights
            const target = chronScrollTarget(seed, false) ?? -1
            if (target === lastTarget) stable++
            else {
               stable = 0
               lastTarget = target
            }
            if (stable >= 2 || tries++ > 20) return commit()
            requestAnimationFrame(tick)
         }
         const fontsReady = document.fonts?.ready ?? Promise.resolve()
         void fontsReady.then(() => requestAnimationFrame(tick))
      } else {
         pinHeights(allRows())
         commit()
      }
   }
}

// Search render: the full hit-set is pre-loaded into nav's snapshot via
// feedLeft/feedRight → ensureSearchSet (search.ts caches results per query).
// Rows are built directly from the search snapshot's per-hit {f,w,t} cards
// (nav.searchCard) — no per-row meta fetch, since search.loadHits already parsed
// them during the scan. Search suppresses day dividers (relabelDividers returns
// early in search mode).
async function renderSearch(my: object, onInteractive?: () => void): Promise<void> {
   // Walk newest-first from the total_art ceiling to get the first batch.
   const seed = await nav.feedLeft(data.db.total_art - 1)
   if (my !== tok) return
   if (seed === -1) {
      emptyState()
      onInteractive?.()
      return
   }
   // The newest hit is the cursor position for a search render (the article
   // switchFilter → last() opens); select it before building rows so
   // rowEl paints .srr-row-current on it.
   if (seed !== nav.currentChron()) nav.select(seed, await data.getFeedId(seed))
   if (my !== tok) return

   const older = await walk(my, seed, BATCH, "older")
   if (my !== tok) return
   if (older.chrons.length === 0) {
      emptyState()
      onInteractive?.()
      return
   }
   oldest = older.chrons[older.chrons.length - 1]
   newest = older.chrons[0]
   exhaustedBottom = older.exhausted || oldest === 0
   exhaustedTop = true // nothing newer than the newest hit

   const seen = nav.getSeenMap()
   const savedSet = nav.getSavedSet()
   rowsEl = el("div", "srr-list-rows")
   topSentinel = el("div", "srr-list-sentinel")
   bottomSentinel = el("div", "srr-list-sentinel")
   const frag = document.createDocumentFragment()
   const rows = older.chrons.map((c) => rowEl(c, nav.searchCard(c) ?? null, seen, savedSet))
   rows.forEach((r) => frag.appendChild(r))
   rowsEl.appendChild(frag)
   container.append(topSentinel, rowsEl, bottomSentinel)
   syncBottomTerminus()
   syncTopTerminus()
   syncRovingTab() // the newest hit (selected by renderSearch) is the lone Tab stop
   window.scrollTo(0, 0)
   notifyScroll()
   userScrolled = false
   onInteractive?.()
   observe(my)

   // Rows already carry their {f,w,t} from the search snapshot (no extra fetch).
   // Pin the heights of those filled rows; only a chron missing from the snapshot
   // (defensive — shouldn't happen) falls back to a lazy meta fill.
   const prefilled = rows.filter((_, k) => nav.searchCard(older.chrons[k]))
   if (prefilled.length) pinHeights(prefilled)
   const missing = older.chrons.map((c, k) => (nav.searchCard(c) ? -1 : k)).filter((k) => k >= 0)
   if (missing.length) {
      await runPool(missing, FILL_CONCURRENCY, async (k) => {
         if (my !== tok) return
         const card = await data.loadMeta(older.chrons[k])
         if (my !== tok) return
         fillRow(rows[k], card, seen)
         pinHeights([rows[k]])
      })
   }
}

// Drop the built-window claim so the NEXT show() takes the rebuild path even
// under an unchanged filter key. For actions that change the filter's
// MEMBERSHIP while the list is hidden behind the reader (markUnreadFrom
// re-raising the unseen bounds: newly-unread rows are missing from the loaded
// window) — rebuilding the display:none list immediately would pin zero row
// heights, so invalidate now, rebuild on return.
export function invalidate(): void {
   builtKey = null
}

// Re-show an already-built list (same filter). When the reader's article is
// already a rendered row — the common return path: you stepped a few articles
// within the loaded window — re-anchor by scrolling to it, with NO feed walk,
// fetch or rebuild. Filter change, or an article outside the window (you jumped,
// or navigated past the loaded batch), falls through to a bounded rebuild.
// `center` (returning from the reader) centers the article instead of
// top-aligning it; the rebuild path forwards it to render().
export async function show(center = false, onInteractive?: () => void): Promise<void> {
   const pos = nav.currentChron()
   if (builtKey === nav.filterKey() && rowsEl && pos >= 0 && findRow(pos)) {
      refresh()
      scrollChronToView(pos, center)
      notifyScroll()
      onInteractive?.() // reuse path is already interactive
      return
   }
   await render(center, onInteractive)
}

// Re-derive read/unread dots + saved stars + the current-article highlight from
// the live state (you may have read or saved some in the reader), and in the
// Saved view drop rows un-saved elsewhere. Does NOT move scroll — show() owns
// re-anchoring.
export function refresh(): void {
   if (!rowsEl) return
   const seen = nav.getSeenMap()
   const savedSet = nav.getSavedSet()
   const savedView = nav.filter.saved
   const current = nav.currentChron()
   let removedAny = false
   rowsEl.querySelectorAll<HTMLElement>("a.srr-row").forEach((a) => {
      const chron = Number(a.dataset.chron)
      a.classList.toggle("srr-row-unread", nav.isRowUnread(chron, Number(a.dataset.feed), seen))
      a.classList.toggle("srr-row-current", chron === current)
      const saved = savedSet.has(chron)
      a.classList.toggle("srr-row-saved", saved)
      a.querySelector(".srr-row-star")?.setAttribute("aria-pressed", String(saved))
      // In the Saved view, an article un-saved from the reader is gone from the
      // feed — drop its row on the way back.
      if (savedView && !saved) {
         a.remove()
         removedAny = true
      }
   })
   if (savedView && removedAny) {
      relabelDividers() // drop any day divider orphaned by the removed rows (#11)
      if (rowsEl && !rowsEl.querySelector("a.srr-row")) showEmptyState() // (#1)
   }
   syncRovingTab() // the live current highlight (or a saved-view removal) may have moved the cursor
}

// Force a rebuild regardless of builtKey — used after an unseen-only toggle or a
// search-query change, where the filter token may be unchanged but its
// membership (raised bounds / new hit set) is not.
export function rerender(): Promise<void> {
   builtKey = null
   return render()
}

// After a store refresh grew the feed: reopen the top of the list WITHOUT
// rebuilding or moving the viewport (the fully-silent contract). Probes for a
// newer MATCH first so the LATEST terminus doesn't flicker off when the refresh
// brought nothing for this filter; when one exists, the terminus comes off
// (scroll-compensated) and the top sentinel resumes paging — parked at the very
// top (the usual exhaustedTop position) the reopened runway pages in immediately
// but invisibly (the prepend compensation keeps the viewport pinned, so the new
// rows sit above the fold until the user scrolls up); away from the top it pages
// in when the sentinel next enters its rootMargin. An empty state (fresh store,
// all-caught-up, no rows) rebuilds instead: there is nothing on screen to
// disturb.
export async function onStoreGrown(): Promise<void> {
   if (growing) return
   growing = true
   try {
      if (!rowsEl || !rowsEl.querySelector("a.srr-row")) {
         await rerender()
         return
      }
      refresh() // re-derive row state; cheap, covers a gen-rebuild's changed feeds
      // refresh() can collapse a now-empty Saved view to its empty state
      // (showEmptyState nulls rowsEl) — nothing left to reopen.
      if (!rowsEl) return
      if (!exhaustedTop || newest < 0) return
      const my = tok
      const found = await nav.feedRight(newest + 1).catch(() => -1)
      if (my !== tok || found === -1) return // superseded by a rebuild, or nothing newer
      exhaustedTop = false
      syncTopTerminus(true)
      // Kick the observer: IntersectionObserver only fires on intersection
      // CHANGES, and at the usual exhaustedTop position (parked at scroll 0) the
      // top sentinel is ALREADY intersecting — removing the terminus doesn't
      // change that, and from scroll 0 there is no upward scroll left to create
      // a re-entry edge. Re-observing re-delivers the sentinel's CURRENT
      // intersection state, so the reopened runway still pages in through the
      // normal fetchNewer path (loadingTop + tok + scroll compensation keep it
      // silent: the viewport stays pinned, the new rows become visible when the
      // user scrolls up).
      if (observer) {
         observer.unobserve(topSentinel)
         observer.observe(topSentinel)
      }
   } finally {
      growing = false
   }
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
   const target = chronScrollTarget(chron, center)
   if (target !== null) window.scrollTo(0, target)
}

// The clamped scrollY that would bring `chron`'s row into view — the pure
// computation behind scrollChronToView, also used by the land-once loop to detect
// when the target has stopped moving (layout settled) BEFORE committing a single
// scroll. null if the row isn't rendered. Top-align clears the whole top chrome
// (topInset = sticky bar + day divider), the same inset scrollRowIntoView uses;
// centering parks the row mid-band, away from the divider, reserving only the bar.
function chronScrollTarget(chron: number, center: boolean): number | null {
   const row = findRow(chron)
   if (!row) return null
   const rect = row.getBoundingClientRect()
   const top = rect.top + window.scrollY
   const target = center ? top + rect.height / 2 - (window.innerHeight + stickyOffset()) / 2 : top - topInset()
   return Math.max(0, target)
}

function stickyOffset(): number {
   const bar = document.querySelector<HTMLElement>(".srr-searchbar")
   return bar && bar.offsetParent !== null ? bar.offsetHeight : 0
}

// The day-strata dividers are sticky at the top of the list viewport
// (position:sticky; top:0), so a row aligned to just the sticky search bar would
// land hidden beneath the divider parked there. Any top-alignment must reserve a
// divider's height on top of stickyOffset. 0 in search mode (dividers suppressed,
// none in the DOM) and before the first render — uniform height, so the first one
// stands in for whichever is currently stuck.
function dividerInset(): number {
   const d = rowsEl?.querySelector<HTMLElement>(".srr-day-divider")
   return d ? d.offsetHeight : 0
}

// Top of the live band: below the sticky search bar AND the day divider parked at
// top:0. The single inset every top-alignment measures against (scrollRowIntoView,
// the cursor seed in firstVisibleRow), so they all clear the same chrome.
function topInset(): number {
   return stickyOffset() + dividerInset()
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
      const seen = nav.getSeenMap()
      const savedSet = nav.getSavedSet()
      const arts = await Promise.all(chrons.map((c) => data.loadMeta(c)))
      if (my !== tok || !rowsEl) return
      // Commit the window cursor only after loadMeta resolves: a transient
      // rejection must not advance oldest/exhaustedBottom past a batch that never
      // rendered, which would permanently skip those rows on the next page.
      oldest = chrons[chrons.length - 1]
      if (exhausted || oldest === 0) exhaustedBottom = true
      const frag = document.createDocumentFragment()
      const older: HTMLElement[] = []
      chrons.forEach((c, k) => {
         const row = rowEl(c, arts[k], seen, savedSet)
         older.push(row)
         frag.appendChild(row)
      })
      rowsEl.appendChild(frag)
      relabelDividers()
      pinHeights(older) // keep the every-row-pinned invariant (see pinHeights)
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
      const seen = nav.getSeenMap()
      const savedSet = nav.getSavedSet()
      const arts = await Promise.all(chrons.map((c) => data.loadMeta(c)))
      if (my !== tok) return
      // Commit the cursor only after loadMeta resolves (see fetchOlder).
      newest = chrons[chrons.length - 1]
      if (exhausted || newest === data.db.total_art - 1) exhaustedTop = true
      const frag = document.createDocumentFragment()
      // chrons is ascending; prepend newest-first so the block reads top-down.
      const fresh: HTMLElement[] = []
      for (let k = chrons.length - 1; k >= 0; k--) {
         const row = rowEl(chrons[k], arts[k], seen, savedSet)
         fresh.push(row)
         frag.appendChild(row)
      }
      // Pick the compensation anchor — the first row reaching into the viewport
      // (bottom past the top edge) — BEFORE the insert. Compensating by how far a
      // VIEWPORT row actually moves (then scrolling to put it back) keeps the
      // visible content fixed across the insert regardless of ANY height change
      // above it (the prepended block, or day-divider churn from relabelDividers).
      // Anchoring to the topmost row or to a scrollHeight delta is wrong: either
      // folds in changes that aren't directly above the viewport and lurches it.
      // Rows are never removed, so the anchor survives the mutation.
      const anchor =
         [...rowsEl.querySelectorAll<HTMLElement>("a.srr-row")].find((r) => r.getBoundingClientRect().bottom > 0) ??
         rowsEl.querySelector<HTMLElement>("a.srr-row")
      const anchorBefore = anchor ? anchor.getBoundingClientRect().top : 0
      rowsEl.insertBefore(frag, rowsEl.firstChild)
      relabelDividers()
      // Pin the prepended rows to their real height so their reserved space is
      // exact: the anchor measurement below then reflects the true inserted height,
      // AND the rows never correct when scrolled up into later. pinHeights leaves
      // them content-visibility:auto with a contain-intrinsic-size matching their
      // measured height (getBoundingClientRect forces the layout it relies on).
      pinHeights(fresh)
      const shift = anchor ? anchor.getBoundingClientRect().top - anchorBefore : 0
      if (shift) {
         window.scrollTo(0, window.scrollY + shift)
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

// Token-guarded paging-error sink: a fetchOlder/fetchNewer rejection from the
// fire-and-forget IO paths below surfaces through app's error popup — but only
// while still current, so a superseded render's late failure stays silent.
function reportPageError(my: object, e: unknown): void {
   if (my === tok) onError(e)
}

function observe(my: object): void {
   if (typeof IntersectionObserver === "undefined") return // jsdom: no layout/IO
   observer = new IntersectionObserver(
      (entries) => {
         if (my !== tok) return
         for (const e of entries) {
            if (!e.isIntersecting) continue
            if (e.target === topSentinel) fetchNewer(my).catch((err) => reportPageError(my, err))
            else pump(my).catch((err) => reportPageError(my, err))
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
   pump(my).catch((err) => reportPageError(my, err))
}

async function pump(my: object): Promise<void> {
   if (pumping) return
   pumping = true
   try {
      while (my === tok && !exhaustedBottom && rowsEl) {
         // Offscreen guard. pump exists to FILL A VIEWPORT — with no viewport it
         // must not run. A hidden list (display:none behind the reader, via
         // el.listView.hidden = true) has no layout box, so getClientRects() is
         // empty and getBoundingClientRect() below returns all-zeros — making the
         // below-the-fold break (rect.top > …) never fire. pump would then page to
         // EXHAUSTION, walking the whole archive. This is the unread-only freeze:
         // the toggle lives in config, so its list.rerender() runs while the list
         // is hidden; with a live anchor that has a long older-unread tail (e.g. a
         // list-cursor selection near the newest end) pump fetched every pack and
         // hung the tab. Bailing loses nothing — the IntersectionObserver re-pumps
         // when the list is shown and the sentinel intersects.
         if (!bottomSentinel.getClientRects().length) break
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

// Roving tabindex: keep exactly ONE row in the Tab order — the selected
// (.srr-row-current) row, or the first row when nothing is selected yet — so Tab
// lands on the cursor and then leaves the list, rather than stepping through every
// article. A/←·D/→ (moveSelection) move the cursor between rows; .focus() still
// works on the off-tab-order rows since tabindex -1 is programmatically focusable.
let lastTabbable: HTMLElement | null = null
function syncRovingTab(): void {
   if (!rowsEl) return
   const tabbable =
      rowsEl.querySelector<HTMLElement>("a.srr-row.srr-row-current") ?? rowsEl.querySelector<HTMLElement>("a.srr-row")
   if (tabbable === lastTabbable) return
   // Flip only the two affected rows — every row is born tabIndex -1 (rowEl),
   // so the previous tabbable is the one stray to clear. A rebuild replaces
   // the rows wholesale; the disconnected old ref is simply dropped (no reset
   // hook needed in every rebuild path).
   if (lastTabbable?.isConnected) lastTabbable.tabIndex = -1
   if (tabbable) tabbable.tabIndex = 0
   lastTabbable = tabbable
}

// Make `row` the cursor: move the highlight, sync nav.pos (so the selection IS
// the reader's "current article"), and scroll it into view. notifyScroll resyncs
// the gesture toolbar baseline so the programmatic scroll doesn't read as a
// downward swipe and hide the toolbar (same contract as render/fetchNewer).
function selectRow(row: HTMLElement): void {
   if (!rowsEl) return
   // Clear any pending deferred-select marker left by a prior selectRow call
   // (regardless of whether that skeleton is still .srr-row-current).
   rowsEl.querySelector("[data-select-pending]")?.removeAttribute("data-select-pending")
   rowsEl.querySelector(".srr-row-current")?.classList.remove("srr-row-current")
   row.classList.add("srr-row-current")
   syncRovingTab() // the cursor moved — it is now the one tabbable row
   // Move DOM focus to the row anchor so the keyboard selection is announced to
   // screen readers and the focus ring tracks the cursor; preventScroll leaves
   // positioning to scrollRowIntoView below (the visual highlight alone never
   // moves focus, so the cursor was invisible to assistive tech).
   row.focus({ preventScroll: true })
   // Skeleton rows have no dataset.feed yet — Number(undefined) = NaN which
   // poisons nav.currentFeed and breaks anchorChron().  Defer nav.select until
   // fillRow stamps the feed; mark the row so fillRow knows to pick it up.
   if (row.dataset.feed !== undefined) {
      nav.select(Number(row.dataset.chron), Number(row.dataset.feed))
   } else {
      row.dataset.selectPending = "1"
   }
   scrollRowIntoView(row)
   notifyScroll()
}

// The topmost row at least partly below the top chrome (sticky search bar + day
// divider) — where the cursor lands when none is set yet, so it appears where
// you're looking rather than at a fixed end, and clear of the divider like every
// scrolled-to row. Falls back to the last (oldest) row when geometry is
// unavailable (jsdom reports zero rects).
function firstVisibleRow(): HTMLElement | null {
   if (!rowsEl) return null
   const top = topInset()
   const rows = rowsEl.querySelectorAll<HTMLElement>("a.srr-row")
   for (const r of rows) if (r.getBoundingClientRect().bottom > top + 1) return r
   return (rows[rows.length - 1] as HTMLElement | undefined) ?? null
}

// True when a same-day row sits directly above `row` (its previous sibling is a
// row, not the day divider) and is clipped by the pinned divider — straddling the
// divider's bottom edge at `inset`. Its empty lower edge would otherwise show as a
// gap above the selection, so scrollRowIntoView snaps flush past it. First-of-day
// rows (previous sibling IS the divider) have no same-day neighbour → false.
function clippedAbove(row: HTMLElement, inset: number): boolean {
   const prev = row.previousElementSibling as HTMLElement | null
   if (!prev || !prev.classList.contains("srr-row")) return false
   const r = prev.getBoundingClientRect()
   return r.top < inset && r.bottom > inset
}

// Bring the selected row fully into the live band — below the sticky search bar +
// day divider (top) and ABOVE the toolbar fixed to the bottom of the viewport —
// but only when it isn't already there (a keyboard step shouldn't recenter on
// every press, unlike the return-from-reader centering). Without the bottom inset
// a row stepped downward parks flush against the viewport bottom, hidden behind
// the toolbar (which selectRow's notifyScroll always reveals). window.scrollTo
// clamps to [0, maxScroll].
//
// Both ends land the row FLUSH against the chrome (no inner margin): the row's own
// padding already separates its text from the divider/toolbar, and a top margin
// would reveal a clipped same-day row above (clippedAbove) as a gap. The
// clippedAbove probe is short-circuited — only measured when the row isn't already
// behind the top inset.
function scrollRowIntoView(row: HTMLElement): void {
   const rect = row.getBoundingClientRect()
   const top = topInset()
   const bottom = window.innerHeight - toolbarInset()
   const margin = 8 // snap tolerance: how close to the chrome before re-aligning flush
   if (rect.top < top + margin || clippedAbove(row, top))
      window.scrollTo(0, Math.max(0, window.scrollY + rect.top - top))
   else if (rect.bottom > bottom - margin) window.scrollTo(0, window.scrollY + rect.bottom - bottom)
}

// Height the bottom-fixed toolbar occupies. selectRow reveals it after every move
// (notifyScroll), so its full rendered height is reserved unconditionally of the
// current slide state — offsetHeight ignores the slide transform and reads 0 only
// when the toolbar is display:none (no list surface).
function toolbarInset(): number {
   const bar = document.querySelector<HTMLElement>(".srr-toolbar")
   return bar ? bar.offsetHeight : 0
}

// ── test seams (jsdom drives module-private DOM state) ───────────────────────
export function __setRowsForTest(rows: HTMLElement | null): void {
   rowsEl = rows
}
export function __relabelDividersForTest(): void {
   relabelDividers()
}
