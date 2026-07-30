// reader.ts — the reader VIEW: everything that paints the <article> drill-down
// surface and its toolbar chrome.
//
// One article at a time (render), the shared directed empty state
// (renderEmptyReader), the toolbar's now-viewing readout + back-button
// breadcrumb (refreshFeedLabel), the next pill's pending readout and its
// arrivals pulse (syncNextCount / pulseNextPill / reprobeReaderChrome), the
// margin bell at a dead edge (bumpReaderEdge), the landing scroll, and the
// media position harvest/restore that makes prev/next non-destructive.
//
// It imports no sibling controller: the router (which surface is showing, the
// hash, the title, the save button) and the two cross-surface follow-ups (the
// frontier-undo offer, the unread badge) arrive through ReaderDeps, so the
// module graph stays acyclic with app.ts at the top.
import { buildContent, paintMasthead, stampContentHost, type ArticleRefs } from "./article-view"
import { makeLRU } from "./cache"
import * as data from "./data"
import { el } from "./els"
import { countBadge, srcColorIndex } from "./fmt"
import * as list from "./list"
import { mountLabel } from "./mounts"
import * as nav from "./nav"
import * as player from "./player"
import { isSplit } from "./split"
import { wireTTS } from "./tts"

// The real reader's nodes in article-view's shape. index.html declares these; the
// pager builds its own set with the same classes.
const readerRefs: ArticleRefs = {
   root: el.article,
   titleRow: el.titleRow,
   source: el.source,
   desk: el.desk,
   date: el.date,
   title: el.title,
   content: el.content,
}

export interface ReaderDeps {
   // Which surface is showing. A silent chrome re-probe must not paint over a
   // list that took over while its probe was in flight.
   view: () => "list" | "reader"
   // Flip the app to the reader surface (body class, list/article visibility).
   showReader: () => void
   // Remember the hash so a reload resumes where you were.
   persistHash: (hash: string) => void
   // The single writer of document.title (it folds the unread count in).
   setTitle: (base: string) => void
   // The ★ toggle's state for the article just painted.
   refreshSaveButton: (hasArticle: boolean) => void
   // Resync the toolbar auto-hide baseline after a programmatic scroll
   // (gestures.resetScroll — wired only once gestures are up, hence the closure).
   resetScroll: () => void
   // Showing the reader supersedes a pending debounced search query.
   clearSearchDebounce: () => void
   // RDR1/RDR2 — offer to take back a landing that swallowed a backlog.
   offerFrontierUndo: () => Promise<void>
   // RDR12 — reading is what moves the unread total.
   syncUnreadBadge: () => Promise<void>
}

let d: ReaderDeps

export function setup(deps: ReaderDeps): void {
   d = deps
}

function clearContentTransition() {
   el.content.style.transition = ""
   el.content.style.opacity = ""
   el.content.style.transform = ""
}

// The arrival transition the NEXT render should use: "slide" while a committed
// pager drag is driving the step (app.ts brackets the guarded nav call with
// it), null for every other entry — keyboard, buttons, deep links — which keep
// the fade. THREE things clear it, and each covers a hole the others cannot:
//   - render() CONSUMES it (reads, then immediately nulls), so a set can never
//     outlive the ONE render it was meant for. app.ts's finally alone could not
//     promise that: it only runs when its guarded step settles, and a pager
//     step can chain two 30s-bounded fetches — right at BUSY_STUCK_MS, past
//     which a different action reclaims the stale mutex and renders through a
//     flag still reading "slide" (and a step that never settles would strand it
//     for the life of the page).
//   - app.ts still clears it in a finally, for the case where NO render happens
//     at all — a guard() that skips on a busy mutex, or a step that rejects —
//     which consume-on-read cannot see.
//   - app.ts ALSO clears it from pager.ts's `abandon`, when the pager's watchdog
//     gives up on a step still in flight. Neither of the above reaches that: the
//     finally is still blocked on the step, and consume-on-read would fire on
//     the render that eventually lands — suppressing the fade for a slide the
//     pager has by then undone, so the article would swap with NO transition.
// None is redundant; dropping any one reopens its own hole.
let entryTransition: "slide" | null = null
export function setEntryTransition(t: "slide" | null): void {
   entryTransition = t
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
// The count syncNextCount last painted (-1 = unknown/hidden), so the silent
// post-refresh re-derive can tell a GROWN pending count — fresh arrivals — from
// the ordinary tick-down of reading. Remembering it is the whole trick: nothing
// here re-counts anything (nav.pendingRight/tallyWith owns that).
let lastNextCount = -1
function syncNextCount(o: IShowFeed | null) {
   const n = o ? o.right_count : -1
   lastNextCount = n
   el.nextCount.textContent = n >= 0 ? countBadge(n) : ""
   const base = "Next article"
   el.next.setAttribute("aria-label", n >= 0 ? `${base} — ${n} remaining` : base)
   el.next.title = n >= 0 ? `${base} — ${n} remaining (→/D)` : `${base} (→/D)`
}

// One-shot pulse on the reader's pending pill — the reader-side twin of the
// list's "N new" overlay. The reader has no list to prepend to, so the only
// place new arrivals can show up is this number changing under you; one quiet
// flare says it did. Re-added after a forced reflow so a second arrival
// restarts it mid-run, and the CSS drops the animation entirely under
// prefers-reduced-motion.
function pulseNextPill() {
   el.next.classList.remove("srr-next-pulse")
   void el.next.offsetWidth
   el.next.classList.add("srr-next-pulse")
   setTimeout(() => el.next.classList.remove("srr-next-pulse"), 900) // > the 0.5s animation
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
   d.resetScroll()
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
// you were.
//
// Media that keeps PLAYING across articles is the mini-player (RDR16,
// player.ts), which is layered on top of this rather than replacing it: the
// player relocates the one live element, and everything else on the page — every
// other <audio>/<video>, and the live one once you close the player — still
// relies on the position memory here.
export interface MediaState {
   time: number
   rate: number
}
// Keyed `<mid>:<chron>`, bounded: a long session must not accumulate one entry
// per article ever opened, and the value is only interesting for the handful you
// might step back to.
//
// The mid is part of the key because chronIdx is only unique WITHIN a mount
// (S38 multi-store): two mounted stores both have a chron 42, so a bare-chron
// key would restore one store's playback position onto a different store's
// article the first time you stepped between them.
const mediaStates = makeLRU<MediaState[], string>(20)
const stateKey = (mid: string, chron: number): string => `${mid}:${chron}`
// The article whose content is currently mounted, so the harvest knows whose
// positions it is taking. chron -1 = nothing to harvest (boot, or an empty state).
let mountedChron = -1
let mountedMid = ""
// The mounted article's FEED, tracked beside its chron for mountedArticle()'s
// pair — nav.select needs both, and data.getFeedId(chron) would be a second
// source of truth for something render() already has in hand.
let mountedFeed = -1
// State a restore has QUEUED but not yet applied (currentTime is only settable
// once duration is known). Without this a second render of the same article
// before the metadata lands — a re-route, a post-refresh re-probe — would
// harvest the element's still-untouched values and throw the real ones away.
const pendingRestore = new WeakMap<HTMLMediaElement, MediaState>()

function harvestMediaState(): void {
   if (mountedChron < 0) return
   const key = stateKey(mountedMid, mountedChron)
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
   if (worthKeeping) mediaStates.put(key, out)
   else mediaStates.drop(key)
}

// player.ts's release path hands a live episode's position back here, so closing
// the mini-player leaves the article exactly as resumable as if the player had
// never been opened. Injected as a PlayerDeps callback rather than imported,
// because player.ts must not depend on reader.ts (reader imports player).
export function rememberPosition(mid: string, chron: number, index: number, s: MediaState): void {
   if (chron < 0 || s.time <= 0) return
   const key = stateKey(mid, chron)
   const out = mediaStates.get(key)?.slice() ?? []
   out[index] = s
   mediaStates.put(key, out)
}

// The read half of the same seam: player.ts's detached playEntry path asks for
// the position the harvest (or a release) stored, so a half-listened queued
// episode resumes instead of restarting. Injected like rememberPosition.
export function readPosition(mid: string, chron: number, index: number): MediaState | undefined {
   return mediaStates.get(stateKey(mid, chron))?.[index]
}

function restoreMediaState(mid: string, chron: number): void {
   const saved = mediaStates.get(stateKey(mid, chron))
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

export function render(o: IShowFeed) {
   d.showReader()
   // Showing the reader supersedes any pending debounced search query. A row-tap
   // commit can land within the 200ms search debounce; without this the stale
   // timer fires applySearchQuery under the now-hidden list and rewrites the
   // reader's hash to the positionless #!q:<query>, losing the resume position.
   d.clearSearchDebounce()
   // A slide entry (a committed pager drag) already animated the transition;
   // dimming for the fade would double-transition the arrival. Reading the flag
   // CONSUMES it (see setEntryTransition above) — it names exactly one render,
   // and this is that render whatever it turns out to be, the placeholder branch
   // below included (the empty state clears the transition either way).
   const slide = entryTransition === "slide"
   entryTransition = null
   if (o.placeholder) return renderEmptyReader(o)
   painted = true
   el.article.classList.remove("srr-reader-empty")
   const feed = data.db.feeds[o.article.f]
   // Source tint, source name, desk, title, permalink and dateline in one call —
   // shared with the pager's preview page, so the two surfaces cannot drift (the
   // per-field prose lives in article-view.ts paintMasthead).
   paintMasthead(readerRefs, o.article, feed)
   // The slide's arrival is already animated (flag consumed above); every other
   // entry dims first and fades in over the two rAFs below.
   if (slide) clearContentTransition()
   else {
      el.content.style.transition = "none"
      el.content.style.opacity = "0"
      el.content.style.transform = "translateY(6px)"
   }
   // RDR16 — the five steps below run in a FIXED order, and the order is not
   // recoverable by reading any one of them alone:
   //
   //   1. harvest  — read every outgoing element's position, the playing one
   //                 included, while they are all still in the content host.
   //   2. adopt    — MOVE the playing element into the mini-player, so the
   //                 replaceChildren immediately after cannot destroy it.
   //   3. replace  — install the new article.
   //   4. restore  — apply saved positions to the fresh elements.
   //   5. rehome   — if this article owns the live element, swap it back in.
   //
   // harvest MUST precede adopt: both pair state to elements BY INDEX over
   // querySelectorAll("audio,video"), so moving the live element out first would
   // shift every index after it and misalign the whole article's saved positions.
   harvestMediaState()
   player.adoptFromContent()
   // The article's own language + direction, stamped on the host this surface
   // owns (article-view.ts stampContentHost documents why `lang=""` rather than
   // no attribute; renderEmptyReader REMOVES it instead, because reader chrome
   // IS ours to declare).
   stampContentHost(el.content, o.article)
   el.content.replaceChildren(buildContent(o.article, data.activeStore().base, { inert: false }))
   mountedChron = nav.currentChron()
   mountedMid = data.activeStore().mid
   mountedFeed = o.article.f
   if (mountedChron >= 0) {
      restoreMediaState(mountedMid, mountedChron)
      // Tell the player what is on screen: a `play` in this article needs an
      // identity, and the bar needs a title/feed it can label itself with
      // without a pack fetch.
      player.noteMounted({
         mid: mountedMid,
         chron: mountedChron,
         title: o.article.t ?? "",
         feedId: o.article.f,
      })
      player.rehomeInto(mountedMid, mountedChron)
      // 6. chips — the playlist add-affordance beside each eligible media
      //    element. After rehome so the walk sees the final element set; a chip
      //    is a <button>, never audio/video, so the index pairing the steps
      //    above rely on is untouched.
      player.injectQueueChips()
      // 7. narration sync — after rehome so the scan sees the final element
      //    set (a relocated narration element included).
      wireTTS({ title: el.title, content: el.content })
   } else {
      player.noteMounted(null)
      wireTTS({ title: el.title, content: el.content }) // rebind or clear for this surface
   }
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right
   syncNextCount(o)

   refreshFeedLabel()
   d.refreshSaveButton(!o.placeholder)

   d.setTitle("SRR - " + (o.article.t ?? ""))
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
   if (!slide) requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

   d.persistHash(location.hash)
   // If this landing consumed a backlog, say so and offer one way back (RDR1).
   // Un-awaited: it measures the move against the idx and must not hold up paint.
   void d.offerFrontierUndo()
   // Reading is what moves the unread total; the badge follows it (RDR12).
   void d.syncUnreadBadge()
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
// `resting` = the split view's idle pane (renderResting below), which is NOT a
// navigation: the LIST still owns the surface, so the three tail steps that
// belong to an arrival — the document title, the reader's scroll, and the focus
// grab — are skipped. Everything above them is the same panel either way.
function renderEmptyReader(o: IShowFeed, resting = false) {
   painted = false
   el.article.classList.add("srr-reader-empty")
   el.article.classList.remove("srr-reader-titleless")
   delete el.article.dataset.src
   el.desk.textContent = ""
   el.title.textContent = ""
   el.titleRow.removeAttribute("href")
   el.prev.disabled = true
   el.next.disabled = !o.has_right
   syncNextCount(o.has_right ? o : null)
   d.refreshSaveButton(false)

   // Static panel: no fade-in (clear any inline opacity/transform a prior article
   // render left behind), and swap the body for the shared empty-state element.
   clearContentTransition()
   // Same fixed order as render()'s: harvest before adopt, both before the
   // replaceChildren below. An empty state mounts no article, so there is
   // nothing to rehome into and nothing for a `play` to claim.
   harvestMediaState()
   player.adoptFromContent()
   player.noteMounted(null)
   // Reader chrome, not article prose: the empty state is OUR copy, in the UI's
   // language, so the host goes back to INHERITING <html lang> rather than
   // keeping the last article's. Removing the attribute is what inherits;
   // `lang=""` would declare the language unknown, which is the right answer for
   // an article of uncertain origin (see article-view.ts stampContentHost) and
   // the wrong one for our own
   // words — it would leave assistive tech picking a fallback voice to read
   // "All caught up" in. `dir` goes with it for the same reason.
   el.content.removeAttribute("lang")
   el.content.removeAttribute("dir")
   el.content.replaceChildren(list.emptyStateEl({ notStarted: o.notStarted, startFeed: o.startFeed }))
   // Narration sync: the empty state has no narration; drop any binding so a
   // mini-player-adopted episode can't paint or ghost-seek this surface.
   wireTTS({ title: el.title, content: el.content })

   refreshFeedLabel()
   if (resting) return
   d.setTitle("SRR")
   scrollReaderTop()
   // The empty state hides the whole title row; focus the (visible) content host,
   // which carries the directed empty-state element.
   el.content.tabIndex = -1
   // keep keyboard focus inside the reader region; preventScroll as in render()
   el.content.focus({ preventScroll: true })
   d.persistHash(location.hash)
}

// Has an article been PAINTED into this surface and not replaced since? Set by
// render()'s article branch, cleared by every placeholder path — rather than
// inferred from nav.pos, which is the shared cursor the LIST also moves (its
// anchor seed, its keyboard row selection). Under split those two questions come
// apart constantly: pos can name an article the pane has never rendered.
//
// The flag is what makes the answer true only where a render actually happened.
// The DOM alone cannot say so at BOOT: index.html ships `.srr-reader` empty, with
// neither an article in it nor `.srr-reader-empty` on it, so a pure class test
// reads a never-painted surface as holding an article — and split's showList,
// which unhides the host before asking, would then skip the resting paint and
// leave the pane blank. The class test stays beside it: it is the invariant a
// stray class toggle would otherwise break silently.
let painted = false
export function hasArticle(): boolean {
   return painted && !el.article.hidden && !el.article.classList.contains("srr-reader-empty")
}

// What this surface has MOUNTED, or null when it holds no article. Not nav.pos:
// that is the shared cursor the list moves too, so under split the two come
// apart routinely. The question this answers is narrower and physical — "which
// exact article is on screen?" — which is what lets split's Escape treat
// re-entering the reader as a focus change rather than a navigation, and what
// lets a breakpoint crossing hand the cursor back to the pane. The FEED rides
// along because nav.select takes the pair: re-seating the cursor with a stale
// feed id would leave the toolbar's readout and the save button describing an
// article nothing is showing.
export function mountedArticle(): { chron: number; feedId: number } | null {
   return painted && mountedChron >= 0 ? { chron: mountedChron, feedId: mountedFeed } : null
}

// There USED to be a `restingPane` flag here, telling the split view's resting
// panel apart from a navigational placeholder so app.ts could route their armed
// Next differently: the placeholder's premise was "pos is -1 (nav.switchFilter
// put it there), so a →-step resolves the first match itself". Under split that
// premise is false for BOTH panels — they paint the same panel, and the list
// beside either one has already seeded the shared cursor at the lane's anchor,
// so nav.right() steps one PAST it. Distinguishing them just moved the skip from
// one panel to the other. app.ts now asks the physical question instead
// (`isSplit() && !hasArticle()`); see its el.next handler.

// The split view's RESTING pane. Both surfaces are on screen there, so "nothing
// open yet" is not an absence to hide — it is two thirds of the window, and a
// blank one reads as a broken app with dead arrows. Mount the reader's own empty
// panel instead: the same directed copy the reader shows at a dead end, with
// Next armed off o.has_right so "Tap Next to start reading" is a true sentence.
// Not a navigation — no surface flip, no title change, no focus grab (the list
// keeps the keyboard), no hash write.
export function renderResting(o: IShowFeed): void {
   el.article.hidden = false
   renderEmptyReader(o, true)
}

// The active mount's display label, or "" when only one store is mounted (the
// single-store case shows no mount prefix — §6.3).
function activeMountName(): string {
   if (data.mountedStores().length <= 1) return ""
   const mid = data.activeStore().mid
   const rec = data.mountRecords().find((r) => r.id === mid)
   return rec ? mountLabel(rec) : mid
}

// The toolbar readout's memo key (mount + lane), so an unchanged label is not
// repainted; see refreshFeedLabel.
let lastFeedLabel: string | null = null

export function refreshFeedLabel() {
   // The article's source now lives in the header kicker, so the toolbar label
   // is the active-filter indicator: "All", a tag name, or a single feed.
   // An UNSCOPED query is orthogonal to the feed axis (the pinned search bar owns
   // the query), so the button stays neutral ("All", unhighlighted) rather than
   // showing the raw "q:<query>" token getCurrentFilterKey returns. A SCOPED one
   // (RDR8) reads as its LANE — that lane is what prev/next walk and what the
   // back button returns to, and getCurrentFilterKey collapses the two-token
   // filter to "" and would otherwise claim the query spans everything.
   const key = nav.isSearchFilter() ? nav.searchScope() : nav.getCurrentFilterKey() // "" (all/multi) | tag name | numeric feed id
   // Multi-store breadcrumb (docs/MULTI-STORE-SPEC.md §6.3): prefix the readout
   // with the active mount "MOUNT · LANE" ONLY when more than one store is
   // mounted — a single-store user sees byte-identical chrome. The mount rides in
   // the early-return cache key so a mount switch repaints even at the same lane.
   const mountName = activeMountName()
   const cacheKey = mountName + "\0" + key
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

// Silently re-derive the reader's prev/next + pending pill for the article
// already on screen after its filter bounds shift under it (a frontier gesture,
// a Show-read flip) — no content re-render, no scroll. loadArticle(pos) is
// cache-warm, so probeCurrent costs at most an idx/meta probe; the chron guard
// drops a stale probe if navigation moved on in the meantime.
//
// `pulseOnGrowth` is set by the ONE caller whose re-derive can raise the count
// without the user doing anything — the post-store-refresh reconciliation. A
// count that merely ticked down (reading), came back from an unknown probe
// (-1), or moved because the user just flipped Show-read / rewound a frontier
// is not an arrival and stays silent.
//
// "Is there a reader to re-derive?" is a LAYOUT question under split, and this
// is the site that WRITES the answer: every caller asks it because the pane's
// arrows and pill went stale, and gating the write on `view` discarded the probe
// whenever the LIST held focus — which is most of the time, since the pane is
// always on screen. That silently defeated all four callers at once (a
// mark-all-read made from the list left "13 ›" armed beside an All-caught-up
// list; a Show-read flip left ‹ dead). hasArticle() is the same reader-owned
// test readerLive() uses, and it excludes the resting panel, which owns its own
// chrome via renderResting.
export function reprobeReaderChrome(pulseOnGrowth = false) {
   const probed = nav.currentChron()
   void nav
      .probeCurrent()
      .then((o) => {
         if (o && (d.view() === "reader" || (isSplit() && hasArticle())) && nav.currentChron() === probed) {
            el.prev.disabled = !o.has_left
            el.next.disabled = !o.has_right
            const before = lastNextCount
            syncNextCount(o)
            if (pulseOnGrowth && before >= 0 && o.right_count > before) pulseNextPill()
         }
      })
      .catch(() => {})
}

// Margin bell — a step toward an edge with no neighbor (prev/next disabled) kicks
// the reader toward that wall and springs it back, and pulses the dead control,
// so a swipe or arrow at the first/last article reads as a boundary instead of a
// dropped input — the reader's counterpart to the list's row bump (list.ts
// bumpEdge). Reduced motion drops the kick (styles.css); the greyed button stays
// as the static cue.
export function bumpReaderEdge(side: "prev" | "next") {
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
