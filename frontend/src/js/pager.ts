// pager.ts — the DOM half of the reader swipe pager (spec
// docs/superpowers/specs/2026-07-27-reader-pager-carousel-design.md).
//
// gestures.ts owns the geometry (axis lock, thresholds, the commit decision);
// this module owns what the drag LOOKS like and what a commit DOES: the reader
// <article> tracking the finger, the lazily built preview PAGE — a real
// `.srr-reader` subtree inside a fixed clip box, showing the neighbour's ACTUAL
// content with every <audio>/<video> replaced by an inert same-box stub
// (article-view.ts makeMediaInert, which is what keeps FEB2's audio/video index
// pairing and the mini-player entirely out of this feature) — the damped
// dead-edge resistance, and the handoff to app.ts's guarded step. The commit
// path is the SAME guard(nav.left/right) the keyboard uses — zero
// navigation-semantics change.
import { buildContent, paintMasthead, stampContentHost, type ArticleRefs } from "./article-view"
import * as data from "./data"
import { el } from "./els"
import { srcColorIndex, timeAgo } from "./fmt"
import { setPager, type PagerSide } from "./gestures"
import * as nav from "./nav"

export interface PagerDeps {
   // app.ts's guarded step. Resolves false when nothing moved — a busy mutex or
   // a failed load (guard owns the error popup) — which is the snap-back signal.
   commit: (side: PagerSide) => Promise<boolean>
   // "Stop expecting a slide arrival": called ONLY when the watchdog gives up on
   // a commit still in flight (see commitStep). app.ts set the reader's entry
   // transition before awaiting and clears it in a finally that has not run yet,
   // so without this the eventual render consumes a "slide" whose slide we have
   // already undone — arriving with no transition at all instead of the fade.
   abandon: () => void
}

// Dead-edge damping: the article follows at 0.3× the finger, capped, so the
// wall is FELT rather than announced after the fact (the bell stays for keys).
const PAGE_RESIST = 0.3
const RESIST_MAX = 64
// The settle is velocity-CARRIED, not fixed: the finger's release speed decides
// how long the remaining travel takes, so a hard flick lands crisply and a
// considered release eases out. One fixed duration for both was the last rubbery
// tell in this gesture — a flick decelerated exactly like a slow deliberate lift,
// which reads as the surface having its own idea of the pace rather than
// finishing the movement the hand started. The curve is the matching half: an
// ease-out starts at full speed and decays, which is what a released flick
// actually does, where the old symmetric ease-out lingered at the end.
const SETTLE_MIN_MS = 120
const SETTLE_MAX_MS = 260
const SETTLE_EASE = "cubic-bezier(0.2, 0, 0, 1)"
// The timer that closes a settle, a hair past the longest it can run.
const SETTLE_CLOSE_PAD_MS = 50
// How long a committed step may hold the surface parked off-screen before the
// pager takes it back (see commitStep). Comfortably under app.ts's
// BUSY_STUCK_MS (60s) — that relationship is the point, not the number: raising
// this past the stale-mutex window reopens the invisible-article hole below it.
const COMMIT_WAIT_MS = 15_000

let d: PagerDeps
// The preview page and the nodes inside it, kept together: the box is what
// moves and what gets torn down, the refs are what article-view paints into.
let page: { box: HTMLElement; refs: ArticleRefs } | null = null
let side: PagerSide = "next"
let mode: "page" | "resist" = "page"
// A committed step is still animating/loading — a new drag must not fight it.
let committing = false
// Freshness token: a page fill that resolves after its drag ended (or after a
// newer drag began) must not paint over the newer state.
let fillTok = 0
let settleTimer: ReturnType<typeof setTimeout> | undefined
let commitTimer: ReturnType<typeof setTimeout> | undefined
// The finger's speed at the lift (px/ms, signed), handed over by gestures.ts.
// Recorded here rather than passed down because the settle it feeds is not the
// call that receives it: the release is one act, the animation that carries it
// out is another, and commitStep/settleBack are both reached without it.
let releaseVx = 0
// The drag's last offset — the other half of settleDuration's input, since a
// speed alone cannot say how far is left to go. It lives here, and is written by
// move() rather than end(), for the same reason releaseVx does and one more:
// `cancel` (a second finger, a touchcancel) reaches settleBack carrying NO
// offset at all, and a cancelled drag has still travelled the distance it has to
// settle over. Reading it from end()'s dx would leave exactly that path
// measuring from 0 and snapping a fully-dragged article back at the floor
// duration.
let lastDx = 0

export function setup(deps: PagerDeps): void {
   d = deps
   // A re-registration means a fresh surface (a rebuilt document, a test's next
   // case). Any page built against the OLD one is orphaned chrome — and this one
   // is opaque and full-viewport, so leaving it would sit over the reader and
   // make the app look dead. Every other exit path tears it down too; this is
   // the one that has no gesture to reach it.
   teardownPage()
   // `cancel` is settleBack unguarded, unlike engage/move: it leans on gestures
   // calling it only for an ENGAGED drag, never a skipped one.
   setPager(el.article, { engage, move, end, cancel: settleBack })
}

function reducedMotion(): boolean {
   return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

// Remaining travel ÷ release speed, clamped: "carry on at the pace the finger
// was already going". That is what makes the animation read as the CONTINUATION
// of the drag rather than a separate act performed on it — the whole point of
// spending a velocity on this at all.
//
// The 0.1 px/ms floor is load-bearing, not a rounding nicety. A dead-stop
// release — holding still for a moment before lifting, which is what a careful
// gesture looks like — arrives with `vx` at or near 0, and the unfloored
// quotient is then Infinity: a transition that never visibly ends, with
// `settleTimer` armed at Infinity so the preview page is never torn down and
// stays parked opaque over the reader. The clamp alone does NOT save it, because
// the degenerate case is not only large: a dead-stop release with no travel at
// all is 0/0 = NaN, and Math.max/Math.min propagate NaN straight into the style
// string and into setTimeout. The floor turns both back into arithmetic, and the
// clamp then only has to express taste.
function settleDuration(dist: number, vx: number): number {
   const ms = Math.abs(dist) / Math.max(Math.abs(vx), 0.1)
   return Math.max(SETTLE_MIN_MS, Math.min(SETTLE_MAX_MS, ms))
}

// Built lazily and reused, never declared in index.html — the lightbox/pull
// precedent, which also keeps it out of design.html's skeleton drift guard.
//
// The inner subtree uses the SAME classes index.html declares for the reader,
// which is the load-bearing decision of this whole feature: identical classes
// mean identical typography, measure and spacing by construction, so the commit
// handoff (commitStep) can swap this for the real article without a visible
// shift. A parallel skin would drift, and the drift would show up as exactly the
// jump this replaced.
function ensurePage(): { box: HTMLElement; refs: ArticleRefs } {
   if (page?.box.isConnected) return page
   const box = document.createElement("div")
   box.className = "srr-pager-page"
   // Decorative during the drag; the committed article announces itself.
   box.setAttribute("aria-hidden", "true")
   // ...and `inert` because aria-hidden alone is only half of it: the masthead
   // row is an <a href> and buildContent's prose carries the article's own
   // links, so the subtree holds focusable nodes — a Tab trap the user cannot
   // see, and the aria-hidden-focus violation axe would raise if it ever caught
   // the page up. `inert` takes the whole subtree out of the tab order and out
   // of hit-testing in one declaration, which is why it is here rather than a
   // tabindex on each node the fill might produce. (jsdom ignores the attribute;
   // in a browser without support it is simply inert-as-in-no-op.)
   box.setAttribute("inert", "")
   const root = document.createElement("article")
   root.className = "srr-reader"
   const titleRow = document.createElement("a")
   titleRow.className = "srr-title-row"
   titleRow.rel = "noreferrer"
   const kicker = document.createElement("div")
   kicker.className = "srr-kicker"
   const source = document.createElement("span")
   source.className = "srr-source"
   const desk = document.createElement("span")
   desk.className = "srr-desk"
   const date = document.createElement("time")
   date.className = "srr-date"
   kicker.append(source, desk, date)
   const title = document.createElement("h1")
   title.className = "srr-title"
   titleRow.append(kicker, title)
   const content = document.createElement("div")
   content.className = "srr-content"
   root.append(titleRow, content)
   box.append(root)
   document.body.appendChild(box)
   page = { box, refs: { root, titleRow, source, desk, date, title, content } }
   return page
}

// Remove the preview entirely. Called from EVERY exit path — rest, settleBack's
// completion, cancel, and setup's re-registration — because a leaked page is an
// opaque full-viewport element sitting over the reader, the highest-severity
// failure this design can have.
function teardownPage(): void {
   page?.box.remove()
   page = null
}

// Three dim bars standing in for prose, so a cold page reads as a page that is
// loading rather than an article with no body.
function skeleton(): DocumentFragment {
   const frag = document.createDocumentFragment()
   for (let i = 0; i < 3; i++) {
      const bar = document.createElement("div")
      bar.className = "srr-pager-skeleton"
      frag.append(bar)
   }
   return frag
}

function engage(s: PagerSide): "page" | "resist" | "skip" {
   if (committing) return "skip"
   // A settle armed by the PREVIOUS gesture must not fire into this one: its
   // rest() would clear the transform this drag is about to write (a one-frame
   // flash back to origin mid-drag) or, worse, land during a commit's slide-out
   // and leave the arriving article a bare snap. A new gesture cycle owns the
   // surface, so it invalidates the old timer rather than racing it. (Below the
   // committing check only because no timer can be live there anyway: gestures
   // withholds move/end/cancel from a skipped drag, so nothing can arm one while
   // a commit is in flight. The skip branch is inert; the clear belongs to a
   // real gesture cycle.)
   clearTimeout(settleTimer)
   // ENGAGE IS RE-ENTRANT WITHIN ONE GESTURE. Since the reversal tuning,
   // gestures.ts calls this again mid-drag when the finger crosses back through
   // the origin — no end(), no cancel(), the same touch — because the other
   // neighbour is what the finger is now asking for. So this is not "start of a
   // drag" code any more; it is "re-derive everything this side implies", and
   // anything the previous side left on the surface is stale from here down.
   //
   // Invalidating the fill is therefore unconditional rather than something the
   // page path does on its way past: it is a property of engage, not of filling.
   // fillPage bumps again on its own (`const my = ++fillTok`), so the page path
   // pays one redundant increment — the alternative is a rule that has to be
   // re-derived for every future mode, and the resist mode is exactly the one
   // that already got it wrong.
   fillTok++
   side = s
   // The neighbor probes already answered availability — the disabled state IS
   // has_left/has_right (reader.render/showList keep it current).
   const dead = s === "prev" ? el.prev.disabled : el.next.disabled
   mode = dead ? "resist" : "page"
   if (mode === "page") void fillPage(s)
   // The other half of that re-derivation, and the reason the bump alone is not
   // enough: a resist drag's move() returns before it touches the box, so
   // nothing else would ever take the preview down. Reversing from a live side
   // onto a dead one would leave the PREVIOUS neighbour's page still displayed,
   // frozen at the previous side's transform — and settleBack's
   // "is it shown?" test would then slide that stale content out along the NEW
   // side's axis, sweeping the wrong article across the viewport on release.
   // Hiding rather than tearing down keeps the built subtree for a reversal back
   // toward the live side, which refills it through fillPage as usual.
   else page?.box.classList.remove("srr-pager-show")
   return mode
}

// Best-effort: a probe/meta blip leaves the skeleton, and the commit still
// renders the real article through the normal path.
async function fillPage(s: PagerSide): Promise<void> {
   const my = ++fillTok
   const { box, refs } = ensurePage()
   refs.source.textContent = ""
   refs.desk.textContent = ""
   refs.date.textContent = ""
   refs.title.textContent = ""
   refs.content.replaceChildren()
   delete refs.root.dataset.src
   box.classList.remove("srr-pager-filled")
   try {
      const from = nav.currentChron()
      const target = await (s === "prev" ? nav.neighborOlder(from) : nav.neighborNewer(from))
      if (my !== fillTok || target < 0) return
      // The article is normally already warm — prefetch.ts loads the speculative
      // neighbour after every step — but not always (a deep link, a filter
      // change, an evicted entry). So paint the masthead from the cheap meta card
      // FIRST and show a skeleton, rather than holding an empty page on the
      // uncommon path. Today's masthead-only pane is now the degraded state.
      const card = await data.loadMeta(target)
      if (my !== fillTok) return
      refs.root.dataset.src = String(srcColorIndex(card.f))
      refs.source.textContent = data.feedTitle(card.f)
      refs.date.textContent = timeAgo(card.w)
      refs.title.textContent = card.t ?? ""
      refs.content.replaceChildren(skeleton())
      const article = await data.loadArticle(target)
      if (my !== fillTok) return
      const feed = data.db.feeds[article.f]
      paintMasthead(refs, article, feed)
      stampContentHost(refs.content, article)
      // inert: the preview never holds live audio/video (article-view §2).
      refs.content.replaceChildren(buildContent(article, data.activeStore().base, { inert: true }))
      box.classList.add("srr-pager-filled")
   } catch {}
}

function move(dx: number): void {
   if (committing) return
   // Above the branch split on purpose, so it covers BOTH: a dead-edge resist
   // drag settles too (from its damped offset, at most RESIST_MAX), and
   // recording only in the page branch would hand that settle whatever distance
   // the last PAGE drag happened to end on.
   lastDx = dx
   el.article.style.transition = "none"
   if (mode === "resist") {
      const damped = Math.max(-RESIST_MAX, Math.min(RESIST_MAX, dx * PAGE_RESIST))
      el.article.style.transform = `translateX(${damped}px)`
      return
   }
   // Clamp to the engaged direction: prev tracks rightward travel only, and a
   // reversed finger parks at 0 rather than dragging the article the wrong way.
   const cl = side === "prev" ? Math.max(0, dx) : Math.min(0, dx)
   el.article.style.transform = `translateX(${cl}px)`
   const { box } = ensurePage()
   box.classList.add("srr-pager-show")
   box.style.transition = "none"
   box.style.transform = side === "prev" ? `translateX(calc(-100% + ${cl}px))` : `translateX(calc(100% + ${cl}px))`
}

function end(dx: number, commit: boolean, vx: number): void {
   releaseVx = vx
   if (mode === "page" && commit) void commitStep(side)
   else settleBack()
}

async function commitStep(s: PagerSide): Promise<void> {
   committing = true
   fillTok++ // the page now shows what it shows; a late fill must not repaint it
   const { box } = ensurePage()
   // Normally move() already revealed it, but a commit is allowed to arrive
   // without one and the covering guarantee below is unconditional — an unshown
   // page would leave the viewport bare for exactly the window this exists to
   // close.
   box.classList.add("srr-pager-show")
   // The remaining travel is whatever is LEFT of a full surface width: the
   // article still has to clear the viewport entirely, and the finger already
   // did |lastDx| of that work, so a release at 90% of the way across finishes
   // in the time the last 10% deserves instead of restarting the movement.
   // (Where the surface reports no width — jsdom — this reads as a plain
   // magnitude, which is also the right answer for a drag that ran past the
   // surface's own width.)
   const dur = settleDuration(el.article.offsetWidth - Math.abs(lastDx), releaseVx)
   if (!reducedMotion()) {
      el.article.style.transition = `transform ${dur}ms ${SETTLE_EASE}`
      box.style.transition = `transform ${dur}ms ${SETTLE_EASE}`
   }
   // Finish the turn visually. The preview lands OPAQUE and covering, which is
   // what makes the rest of this invisible: the guarded step renders the real
   // article and scrolls it to the top underneath a page that already shows
   // exactly that article at exactly that geometry. A slow load holds a correct
   // page longer instead of showing a blank screen — the failure mode this
   // replaced. The watchdog below is unchanged in mechanism and its guarantee is
   // strengthened, not replaced: while it waits the surface is COVERED, not bare.
   el.article.style.transform = s === "prev" ? "translateX(100%)" : "translateX(-100%)"
   box.style.transform = "translateX(0)"
   try {
      // Whichever settles first wins. The watchdog is not a nicety: while we
      // wait, `el.article` is parked fully off-screen, and rest()/settleBack()
      // are the ONLY writers of that transform anywhere in the frontend — so
      // anything that repaints the reader meanwhile paints into an invisible
      // surface. app.ts's guard() treats a mutex hold past BUSY_STUCK_MS (60s)
      // as stale and lets the next arrow/button reclaim it; that reclaimed step
      // renders the right article INTO our parked <article> and leaves it
      // invisible until our own step finally settles, with `committing` still
      // skip-locking the pager on top. Releasing at 15s means the surface is
      // never parked by the time that reclaim becomes possible — and since
      // reader.render()'s ONE call site is inside guard(), holding the live
      // mutex is what makes this the only window there is. The late step still
      // lands and renders through the normal path.
      const ok = await Promise.race([d.commit(s), stalled()])
      // STALLED and a plain `false` snap back identically but leave the ENTRY
      // TRANSITION in opposite states, which is the whole reason the watchdog
      // answers with its own value rather than a second `false`. A `false` from
      // the step means it SETTLED — app.ts's finally has already run and the
      // "slide" flag is clear. STALLED means it is still in flight with that
      // flag armed, and the slide it names is about to be undone by settleBack:
      // whenever the step finally lands, its render would consume "slide",
      // suppress the fade, and swap with NO transition at all. Handing the flag
      // back makes that late arrival fade in like any keyboard step.
      if (ok === true) rest()
      else {
         if (ok === STALLED) d.abandon()
         settleBack()
      }
   } catch {
      settleBack()
   } finally {
      clearTimeout(commitTimer)
      committing = false
   }
}

// The watchdog's answer — deliberately not `false`; see the race above.
const STALLED = Symbol("pager-commit-stalled")

// The watchdog half of that race. A plain timer, so a commit that resolves
// first simply clears it in the finally above; a late rejection from the loser
// stays handled (Promise.race attached to it) and its resolution is ignored.
function stalled(): Promise<typeof STALLED> {
   return new Promise((r) => {
      commitTimer = setTimeout(() => r(STALLED), COMMIT_WAIT_MS)
   })
}

// Animate everything back to rest, then clear the inline styles. Under reduced
// motion the settle is instant: the drag tracked the finger (direct
// manipulation), but nothing moves on its own after the lift.
function settleBack(): void {
   fillTok++
   if (reducedMotion()) return rest()
   // Snapping back, so the remaining travel simply IS the offset the drag
   // reached — the mirror of commitStep's "what is left of a surface width".
   const dur = settleDuration(lastDx, releaseVx)
   el.article.style.transition = `transform ${dur}ms ${SETTLE_EASE}`
   el.article.style.transform = ""
   if (page?.box.classList.contains("srr-pager-show")) {
      page.box.style.transition = `transform ${dur}ms ${SETTLE_EASE}`
      page.box.style.transform = side === "prev" ? "translateX(-100%)" : "translateX(100%)"
   }
   clearTimeout(settleTimer)
   // transitionend is unreliable (jsdom never fires it; a mid-flight rebuild
   // detaches the node) — a timer a hair past the transition is the settle. It
   // is also the page's teardown, via rest(): the preview must not outlive the
   // animation that carried it back off-screen. The pad rides the COMPUTED
   // duration rather than a constant now, so a 120ms flick-back tears down at
   // 170ms instead of waiting out the old worst case, and a 260ms one is still
   // never cut off mid-animation.
   settleTimer = setTimeout(rest, dur + SETTLE_CLOSE_PAD_MS)
}

function rest(): void {
   clearTimeout(settleTimer)
   el.article.style.transition = ""
   el.article.style.transform = ""
   // Same frame as the transform clear: on the commit path the real article is
   // already rendered and scrolled underneath, so the page and the surface it
   // covers show the same content at the same geometry and removing the cover is
   // invisible. Splitting the two — clearing the transform now and removing the
   // page a task later, or the reverse — is what a blink looks like.
   teardownPage()
}
