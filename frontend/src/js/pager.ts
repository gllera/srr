// pager.ts — the DOM half of the reader swipe pager (spec
// docs/superpowers/specs/2026-07-27-reader-swipe-pager-design.md).
//
// gestures.ts owns the geometry (axis lock, thresholds, the commit decision);
// this module owns what the drag LOOKS like and what a commit DOES: the reader
// <article> tracking the finger, the lazily built masthead-only preview pane
// (never content — that is what keeps FEB2's audio/video index pairing and the
// mini-player entirely out of this feature), the damped dead-edge resistance,
// and the handoff to app.ts's guarded step. The commit path is the SAME
// guard(nav.left/right) the keyboard uses — zero navigation-semantics change.
import * as data from "./data"
import { el } from "./els"
import { srcColorIndex, timeAgo } from "./fmt"
import { setPager, type PagerSide } from "./gestures"
import * as nav from "./nav"

export interface PagerDeps {
   // app.ts's guarded step. Resolves false when nothing moved — a busy mutex or
   // a failed load (guard owns the error popup) — which is the snap-back signal.
   commit: (side: PagerSide) => Promise<boolean>
}

// Dead-edge damping: the article follows at 0.3× the finger, capped, so the
// wall is FELT rather than announced after the fact (the bell stays for keys).
const PAGE_RESIST = 0.3
const RESIST_MAX = 64
const SETTLE_MS = 200

let d: PagerDeps
let pane: HTMLElement | null = null
let side: PagerSide = "next"
let mode: "page" | "resist" = "page"
// A committed step is still animating/loading — a new drag must not fight it.
let committing = false
// Freshness token: a pane fill that resolves after its drag ended (or after a
// newer drag began) must not paint over the newer state.
let fillTok = 0
let settleTimer: ReturnType<typeof setTimeout> | undefined

export function setup(deps: PagerDeps): void {
   d = deps
   // `cancel` is settleBack unguarded, unlike engage/move: it leans on gestures
   // calling it only for an ENGAGED drag, never a skipped one.
   setPager(el.article, { engage, move, end, cancel: settleBack })
}

function reducedMotion(): boolean {
   return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

// Built lazily and reused, never declared in index.html — the lightbox/pull
// precedent, which also keeps it out of design.html's skeleton drift guard.
function ensurePane(): HTMLElement {
   if (pane?.isConnected) return pane
   const box = document.createElement("div")
   box.className = "srr-pager-pane"
   // Decorative during the drag; the committed article announces itself.
   box.setAttribute("aria-hidden", "true")
   const kicker = document.createElement("div")
   kicker.className = "srr-pager-kicker"
   const source = document.createElement("span")
   source.className = "srr-pager-source"
   const date = document.createElement("span")
   date.className = "srr-pager-date"
   kicker.append(source, date)
   const title = document.createElement("h2")
   title.className = "srr-pager-title"
   box.append(kicker, title)
   document.body.appendChild(box)
   pane = box
   return box
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
   side = s
   // The neighbor probes already answered availability — the disabled state IS
   // has_left/has_right (reader.render/showList keep it current).
   const dead = s === "prev" ? el.prev.disabled : el.next.disabled
   mode = dead ? "resist" : "page"
   if (mode === "page") void fillPane(s)
   return mode
}

// Masthead-only, best-effort: a probe/meta blip leaves the skeleton pane, and
// the commit still renders the real article through the normal path.
async function fillPane(s: PagerSide): Promise<void> {
   const my = ++fillTok
   const box = ensurePane()
   box.querySelector(".srr-pager-source")!.textContent = ""
   box.querySelector(".srr-pager-date")!.textContent = ""
   box.querySelector(".srr-pager-title")!.textContent = ""
   delete box.dataset.src
   try {
      const from = nav.currentChron()
      const target = await (s === "prev" ? nav.neighborOlder(from) : nav.neighborNewer(from))
      if (my !== fillTok || target < 0) return
      const card = await data.loadMeta(target)
      if (my !== fillTok) return
      box.dataset.src = String(srcColorIndex(card.f))
      box.querySelector(".srr-pager-source")!.textContent = data.feedTitle(card.f)
      box.querySelector(".srr-pager-date")!.textContent = timeAgo(card.w)
      box.querySelector(".srr-pager-title")!.textContent = card.t ?? ""
   } catch {}
}

function move(dx: number): void {
   if (committing) return
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
   const box = ensurePane()
   box.classList.add("srr-pager-show")
   box.style.transition = "none"
   box.style.transform = side === "prev" ? `translateX(calc(-100% + ${cl}px))` : `translateX(calc(100% + ${cl}px))`
}

function end(dx: number, commit: boolean): void {
   if (mode === "page" && commit) void commitStep(side)
   else settleBack()
}

async function commitStep(s: PagerSide): Promise<void> {
   committing = true
   fillTok++ // the pane now shows what it shows; a late fill must not repaint it
   const box = ensurePane()
   if (!reducedMotion()) {
      el.article.style.transition = `transform ${SETTLE_MS}ms ease-out`
      box.style.transition = `transform ${SETTLE_MS}ms ease-out`
   }
   // Finish the turn visually while the guarded step loads underneath; when
   // render() lands (fade suppressed — reader.setEntryTransition) the pane
   // lifts off an already-painted article whose masthead matches it.
   el.article.style.transform = s === "prev" ? "translateX(100%)" : "translateX(-100%)"
   box.style.transform = "translateX(0)"
   try {
      const ok = await d.commit(s)
      if (ok) rest()
      else settleBack()
   } catch {
      settleBack()
   } finally {
      committing = false
   }
}

// Animate everything back to rest, then clear the inline styles. Under reduced
// motion the settle is instant: the drag tracked the finger (direct
// manipulation), but nothing moves on its own after the lift.
function settleBack(): void {
   fillTok++
   if (reducedMotion()) return rest()
   el.article.style.transition = `transform ${SETTLE_MS}ms ease-out`
   el.article.style.transform = ""
   if (pane?.classList.contains("srr-pager-show")) {
      pane.style.transition = `transform ${SETTLE_MS}ms ease-out`
      pane.style.transform = side === "prev" ? "translateX(-100%)" : "translateX(100%)"
   }
   clearTimeout(settleTimer)
   // transitionend is unreliable (jsdom never fires it; a mid-flight rebuild
   // detaches the node) — a timer a hair past the transition is the settle.
   settleTimer = setTimeout(rest, SETTLE_MS + 50)
}

function rest(): void {
   clearTimeout(settleTimer)
   el.article.style.transition = ""
   el.article.style.transform = ""
   if (pane) {
      pane.classList.remove("srr-pager-show")
      pane.style.transition = ""
      pane.style.transform = ""
   }
}
