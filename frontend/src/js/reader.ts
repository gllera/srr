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
import { makeLRU } from "./cache"
import * as data from "./data"
import { el } from "./els"
import { countBadge, readerDateline, sanitizeFragment, srcColorIndex } from "./fmt"
import * as list from "./list"
import { mountLabel } from "./mounts"
import * as nav from "./nav"
import * as player from "./player"
import { URL_DENY } from "./urlish"

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

// The §9.3 compaction tombstone body: an expired article whose payload `srr
// compact` reclaimed. A sibling of the "[DELETED]" feed tombstone (feedTitle) —
// the source · date masthead still renders correctly, only the content is gone.
function expiredTombstone(): HTMLElement {
   const p = document.createElement("p")
   p.className = "srr-expired-note"
   p.textContent = "This article is no longer stored"
   return p
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
   if (o.placeholder) return renderEmptyReader(o)
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
   // §9.3 (docs/MANIFEST-SPEC.md): `srr compact` replaces an expired article's
   // payload with a tombstone that keeps f/a/p and DROPS c/t/l — so `c` is
   // absent on the wire (`c` is typed string, but omitempty means undefined at
   // runtime for a compacted line). Reachable only via a ★-Saved / deep-linked
   // expired chron (normal nav filters chron < add_idx). Render an explicit
   // "no longer stored" state — source · date intact, a sibling of feedTitle's
   // "[DELETED]" feed tombstone — instead of the literal "undefined"
   // sanitizeFragment(undefined) would produce.
   const body = o.article.c as string | undefined
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
   // The article's own language (`g` on the wire, from the backend's always-on
   // detection). Without it the whole reader inherits <html lang="en">: a
   // screen reader pronounces a Spanish body in an English voice, hyphenation
   // applies English patterns, and an undeclared-RTL body renders LTR.
   //
   // `g` is absent for anything the detector wasn't confident about and for
   // every article written before 2026-07-19, and the fallback is `lang=""` —
   // which declares the language UNKNOWN, not "inherit". That distinction is
   // the point, and it is deliberate: unknown is what stops `hyphens: auto`
   // (styles.css) from breaking possibly-non-English prose on English patterns,
   // where REMOVING the attribute would inherit <html lang="en"> and do exactly
   // that. renderEmptyReader removes it instead, because reader chrome IS ours
   // to declare.
   //
   // dir=auto lets the browser infer direction from the first strong character,
   // which is the only honest answer when the feed declares none.
   el.content.lang = o.article.g ?? ""
   el.content.dir = "auto"
   // Adopt the sanitized nodes directly — an innerHTML string round-trip would
   // re-parse the whole article on every prev/next step (see sanitizeFragment).
   if (body == null) el.content.replaceChildren(expiredTombstone())
   else el.content.replaceChildren(sanitizeFragment(body, data.activeStore().base))
   mountedChron = nav.currentChron()
   mountedMid = data.activeStore().mid
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
   } else player.noteMounted(null)
   // Reject javascript:/data:/vbscript:/file: in case the writer pipeline let one
   // through. The whole masthead row (source · date · title) is the one permalink;
   // an href makes it a link, its absence leaves it inert chrome (titleless feeds
   // hide the <h1> but the source · date kicker still carries the link).
   const safeLink = o.article.l && !URL_DENY.test(o.article.l) ? o.article.l : ""
   if (safeLink) el.titleRow.href = safeLink
   else el.titleRow.removeAttribute("href")
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right
   syncNextCount(o)

   // p is omitted (=> undefined) when the writer couldn't parse a date
   const currentPublished = o.article.p ?? 0
   // A recent article leads with its relative age ("5h ago"); an older one leads
   // with the absolute date (an archived dispatch's real date matters more than
   // "5h ago"). Either way the other form is on the hover title — see readerDateline.
   const dateline = currentPublished ? readerDateline(currentPublished) : null
   el.date.textContent = dateline ? dateline.text : ""
   el.date.title = dateline ? dateline.title : ""
   // Hide the date (and its leading "·" separator) in the kicker when undated,
   // so the source name doesn't trail a dangling middot.
   el.date.hidden = !currentPublished

   // Key the reader's masthead to the article's source color (same ramp as the
   // list rails — see styles.css [data-src]).
   el.article.dataset.src = String(srcColorIndex(o.article.f))
   el.source.textContent = data.feedTitle(o.article.f)
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
   requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

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
function renderEmptyReader(o: IShowFeed) {
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
   // an article of uncertain origin (see render) and the wrong one for our own
   // words — it would leave assistive tech picking a fallback voice to read
   // "All caught up" in. `dir` goes with it for the same reason.
   el.content.removeAttribute("lang")
   el.content.removeAttribute("dir")
   el.content.replaceChildren(list.emptyStateEl({ notStarted: o.notStarted, startFeed: o.startFeed }))

   refreshFeedLabel()
   d.setTitle("SRR")
   scrollReaderTop()
   // The empty state hides the whole title row; focus the (visible) content host,
   // which carries the directed empty-state element.
   el.content.tabIndex = -1
   // keep keyboard focus inside the reader region; preventScroll as in render()
   el.content.focus({ preventScroll: true })
   d.persistHash(location.hash)
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
export function reprobeReaderChrome(pulseOnGrowth = false) {
   const probed = nav.currentChron()
   void nav
      .probeCurrent()
      .then((o) => {
         if (o && d.view() === "reader" && nav.currentChron() === probed) {
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
