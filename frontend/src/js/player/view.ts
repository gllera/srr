// player/view.ts — the player's own surface: the sheet (folded corner button /
// full player), its clock and scrubber, and the Up next list. Every paint here
// is an effect over state.ts; the handlers only write state or call the engine.
import * as data from "../data"
import { bindSecondaryPress, btn } from "../dropdown"
import { el } from "../els"
import { stampSrc } from "../fmt"
import { prefersReducedMotion } from "../motion"
import { AXIS_SLOP, ROW_SWIPE_TRIGGER, verticalDominant } from "../gestures"
import { arrayEqual, computed, diffed, effect, onChange, untracked } from "../signals"
import {
   cycleRate,
   dropEntry,
   moveEntry,
   moveEntryTo,
   openOwner,
   advance,
   hasNext,
   hasPrev,
   prevTrack,
   playNow,
   seekTo,
   skip,
   SKIP_SECONDS,
   toggle,
} from "./engine"
import {
   active,
   buffering,
   cursor,
   cursorIndex,
   entryKey,
   entryLabel,
   playback,
   queue,
   ratePref,
   unfolded,
   type Active,
   type QueueEntry,
} from "./state"

// Open / close the player VIEW (`unfolded`). Opening puts focus on the view
// itself, so Escape lands there and nothing is pre-selected; closing with focus
// inside hands it back to the dock — the folded player — once the dock is shown
// again, so the keyboard never lands on a now-invisible control.
export function setUnfolded(open: boolean): void {
   if (unfolded() === open) return
   const f = document.activeElement
   const refocus = !open && !!f && el.player.contains(f)
   unfolded.set(open)
   if (open) el.player.focus()
   else if (refocus) el.playerDock.focus()
}

export const isViewOpen = (): boolean => unfolded()

// The view is a place you go, so the platform's Back leaves it: opening pushes
// one history entry (same URL — no hashchange, so the router never sees it) and
// Back pops it. Closing by any other route (⌄, Escape, ✕, a finished queue)
// pops that entry too, so it never lingers as a dead Back step. An effect over
// `unfolded`, so every close path is covered without each one remembering.
const VIEW_STATE = "srrPlayer"
function isOurEntry(): boolean {
   const st = history.state as Record<string, unknown> | null
   return !!st && st[VIEW_STATE] === true
}
function watchHistory(): () => void {
   window.addEventListener("popstate", () => {
      if (unfolded() && !isOurEntry()) setUnfolded(false)
   })
   return onChange(unfolded, (open) => {
      if (open) history.pushState({ [VIEW_STATE]: true }, "")
      else if (isOurEntry()) history.back()
   })
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function clock(seconds: number): string {
   if (!Number.isFinite(seconds) || seconds < 0) return "--:--"
   const s = Math.floor(seconds)
   const h = Math.floor(s / 3600)
   const m = Math.floor((s % 3600) / 60)
   const sec = s % 60
   const mm = h ? String(m).padStart(2, "0") : String(m)
   return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`
}

// Everything on the sheet except the clock, keyed on exactly what it shows —
// so the ~4/s timeupdate samples (which only move the clock) never repaint it.
// The player is shown whenever there IS an episode, whatever article is on
// screen (user call 2026-09-23); with nothing claimed but a queue, it shows the
// READY state — the queue head behind a play button — since a queue must be
// visible to be usable at all, and ✕ is how it goes away.
function chromeKey(): readonly unknown[] {
   const a = active()
   const q = queue()
   const i = cursorIndex()
   return [
      a,
      q[i] ?? q[0] ?? null,
      q.length > 0,
      i + 1 < q.length,
      i > 0,
      unfolded(),
      buffering(),
      a ? playback().paused : true,
      ratePref(),
   ]
}

function paintChrome(): void {
   const a = active()
   const q = queue()
   const show = a !== null || q.length > 0
   el.player.hidden = !show
   // Folded is a class, never the `hidden` attribute: the player may be holding
   // a relocated <video>, which must stay rendered (see .srr-player-media).
   const open = unfolded()
   el.player.classList.toggle("srr-player-folded", !open)
   // The dock — the folded player — floats in the corner while the view is
   // closed, and earns the container's bottom clearance (and lifts the snackbar
   // and pin lanes) so it never sits on the last line of text.
   el.playerDock.hidden = !show || open
   el.playerDock.setAttribute("aria-expanded", String(open))
   document.body.classList.toggle("srr-playing", show && !open)
   // The buffering spinner replaces the toggle glyph; aria-busy is the same
   // state for assistive tech (the accessible name stays Play/Pause).
   const stalled = buffering() && a !== null
   el.playerToggle.classList.toggle("srr-player-buffering", stalled)
   el.playerToggle.setAttribute("aria-busy", String(stalled))
   // » needs something after the current entry to skip to.
   el.playerNext.hidden = !hasNext()
   // « needs an episode to restart or an entry before the current one.
   el.playerPrev.hidden = !hasPrev()
   // One painter for both states: the READY state is exactly the active state
   // at paused = true, labelled from the current entry instead of the claim.
   const ready = q[cursorIndex()] ?? q[0]
   const who = a ?? ready
   if (!who) return
   const kind = a ? (a.media.tagName === "VIDEO" ? "video" : "audio") : ready.kind
   const paused = a ? playback().paused : true
   el.player.dataset.kind = kind
   stampSrc(el.player, who.feedId)
   el.playerSource.textContent = data.feedTitle(who.feedId)
   el.playerName.textContent = entryLabel(who.title)
   el.playerTitle.setAttribute("aria-label", `Go to ${who.title || "this article"} — ${data.feedTitle(who.feedId)}`)
   el.playerToggle.setAttribute("aria-label", paused ? "Play" : "Pause")
   el.playerToggle.setAttribute("aria-pressed", String(!paused))
   el.playerToggle.classList.toggle("srr-player-playing", !paused)
   // The dock: named with the episode (it is the only trace of the player
   // while folded), in the feed's colour, its level bars moving while it plays.
   stampSrc(el.playerDock, who.feedId)
   el.playerDock.setAttribute("aria-label", `Open the player — ${entryLabel(who.title)}${paused ? ", paused" : ""}`)
   el.playerDock.classList.toggle("srr-player-playing", !paused)
   // The audio cover's level bars move while it plays.
   el.player.classList.toggle("srr-player-on", !paused)
   const rate = ratePref()
   el.playerRate.textContent = `${rate}×`
   el.playerRate.setAttribute("aria-label", `Playback speed — ${rate}×`)
}

// The clock and the scrubber: the one part that moves while playing.
function paintClock(): void {
   const a = active()
   const p = playback()
   if (!a) {
      el.playerTime.textContent = ""
      el.playerDuration.textContent = ""
      el.playerSeekFill.style.width = "0%"
      el.playerDock.style.setProperty("--srr-progress", "0")
      return
   }
   const dur = p.duration
   el.playerTime.textContent = clock(p.time)
   el.playerDuration.textContent = Number.isFinite(dur) ? clock(dur) : ""
   const pct = Number.isFinite(dur) && dur > 0 ? (p.time / dur) * 100 : 0
   el.playerSeekFill.style.width = `${pct}%`
   // The dock's ring: the same progress, read at a glance while folded.
   el.playerDock.style.setProperty("--srr-progress", String(pct))
   el.playerSeek.setAttribute("aria-valuemax", String(Number.isFinite(dur) ? Math.floor(dur) : 0))
   el.playerSeek.setAttribute("aria-valuenow", String(Math.floor(p.time)))
   el.playerSeek.setAttribute("aria-valuetext", clock(p.time))
}

// ---------------------------------------------------------------------------
// Up next
// ---------------------------------------------------------------------------

// The playlist, always rendered in the view (not a popover), in its own order:
// entries STAY after they play. The current entry is marked in place — its
// row tinted in its feed's colour, aria-current for assistive tech, no label
// (user call 2026-09-23) — and the ones before it read as played. The player (and its dock) exists exactly while
// this list is non-empty.
function renderList(a: Active | null, q: readonly QueueEntry[], ci: number): void {
   el.playerCount.textContent = q.length ? String(q.length) : ""
   el.playerEmpty.hidden = q.length > 0
   el.playerList.replaceChildren(
      ...q.map((entry, i) => {
         const current = i === ci
         const row = document.createElement("div")
         row.setAttribute("role", "listitem")
         row.className = "srr-player-row"
         if (current) row.classList.add("srr-player-row-now")
         else if (ci >= 0 && i < ci) row.classList.add("srr-player-row-played")
         const play = document.createElement("button")
         play.type = "button"
         play.className = "srr-player-row-play"
         stampSrc(play, entry.feedId)
         const source = document.createElement("span")
         source.className = "srr-player-row-source"
         source.textContent = data.feedTitle(entry.feedId)
         const name = document.createElement("span")
         name.className = "srr-player-row-name"
         name.textContent = entryLabel(entry.title)
         play.append(source, name)
         // The current row's press is the transport's own toggle; any other
         // row's plays it now (it stays listed).
         const verb = current ? (a && !playback().paused ? "Pause" : "Play") : "Play now"
         play.setAttribute("aria-label", `${verb} — ${entryLabel(entry.title)} · ${data.feedTitle(entry.feedId)}`)
         if (current) play.setAttribute("aria-current", "true")
         play.addEventListener("click", () => {
            if (current) toggle()
            else playNow(entry)
            el.playerToggle.focus()
         })
         // ✕ is for a mouse; on a touch screen it is visually hidden (kept for
         // screen readers and shown on keyboard focus) since a swipe removes.
         const remove = btn("srr-player-row-remove", `Remove from playlist — ${entryLabel(entry.title)}`, "×", () =>
            dropEntry(entry),
         )
         row.append(play, remove, grip(row, entry))
         attachRowSwipe(row, entry)
         return row
      }),
   )
}

// Following the current episode. Played entries stay at the top, so the
// current row drifts down as a playlist is worked through; after each render
// the list scrolls it back near the top — the entry that just played peeking
// above it — when the view opens and whenever the current entry changes. Not
// mid-drag, and not while you are browsing the list yourself (a wheel or a
// finger on it in the last FOLLOW_PAUSE_MS): your scroll wins over the follow.
const FOLLOW_PAUSE_MS = 5000
let followed: string | null = null
let wasOpen = false
let dragging = false
let userScrolledAt = -Infinity

function followCurrent(current: QueueEntry | undefined, open: boolean): void {
   if (!open) {
      wasOpen = false
      return
   }
   const key = current ? entryKey(current) : null
   const opening = !wasOpen
   wasOpen = true
   if (!opening && key === followed) return
   followed = key
   if (!current || dragging) return
   if (!opening && performance.now() - userScrolledAt < FOLLOW_PAUSE_MS) return
   const rows = el.playerList.querySelectorAll<HTMLElement>(".srr-player-row")
   const i = queue().indexOf(current)
   const anchor = rows[Math.max(0, i - 1)]
   if (!anchor) return
   // Opening lands there at once; a change while you watch glides to it.
   el.playerList.scrollTo({
      top: anchor.offsetTop,
      behavior: opening || prefersReducedMotion() ? "instant" : "smooth",
   })
}

function bindListScrollIntent(): void {
   const mark = (): void => {
      userScrolledAt = performance.now()
   }
   el.playerList.addEventListener("wheel", mark, { passive: true })
   el.playerList.addEventListener("touchmove", mark, { passive: true })
}

// The drag handle — the row's one reorder control (user call 2026-09-23: one
// handle instead of ▲ ▼ ✕ on every row). Drag it to move the row; from the
// keyboard, ↑/↓ move it and Delete removes it.
function grip(row: HTMLElement, entry: QueueEntry): HTMLButtonElement {
   const label = entryLabel(entry.title)
   const b = document.createElement("button")
   b.type = "button"
   b.className = "srr-player-row-grip"
   b.setAttribute("aria-label", `Move or remove — ${label}`)
   b.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown Delete")
   b.title = "Drag to reorder"
   const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
   svg.setAttribute("viewBox", "0 0 24 24")
   svg.setAttribute("aria-hidden", "true")
   const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
   path.setAttribute("d", "M5 8h14M5 12h14M5 16h14")
   svg.append(path)
   b.append(svg)
   b.addEventListener("keydown", (e) => {
      const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
      if (delta) {
         e.preventDefault()
         e.stopPropagation()
         moveQueued(entry, delta)
      } else if (e.key === "Delete" || e.key === "Backspace") {
         e.preventDefault()
         e.stopPropagation()
         removeFromKeyboard(entry)
      }
   })
   b.addEventListener("pointerdown", (e) => startDrag(e, b, row, entry))
   return b
}

const grips = (): HTMLButtonElement[] => [...el.playerList.querySelectorAll<HTMLButtonElement>(".srr-player-row-grip")]

function moveQueued(entry: QueueEntry, delta: -1 | 1): void {
   const j = moveEntry(entry, delta)
   // The list re-rendered under the key (the write flushed synchronously):
   // keep the keyboard on the handle of the row that moved, so repeated
   // presses keep walking it.
   if (j >= 0) grips()[j]?.focus()
}

// Delete on a handle: the keyboard lands on the row that took its place (or
// the new last row), never on a control that no longer exists.
function removeFromKeyboard(entry: QueueEntry): void {
   const i = queue().indexOf(entry)
   dropEntry(entry)
   const left = grips()
   if (left.length) left[Math.min(i, left.length - 1)].focus()
   else if (!el.player.hidden) el.playerToggle.focus()
}

// How close to the list's top or bottom edge a drag starts scrolling it, and
// how far it scrolls per frame.
const EDGE_PX = 40
const EDGE_STEP = 8

// Dragging a row by its handle. Positions are in the list's CONTENT
// coordinates (offsetTop, plus scrollTop for the pointer), so they stay right
// while the list scrolls under a drag held at its edge. The dragged row follows
// the pointer; the rows it passes slide one row-height out of its way; the
// drop is one moveEntryTo, whose re-render clears every transform.
function startDrag(e: PointerEvent, handle: HTMLButtonElement, row: HTMLElement, entry: QueueEntry): void {
   if (e.button !== 0) return
   const list = el.playerList
   const rows = [...list.querySelectorAll<HTMLElement>(".srr-player-row")]
   const from = rows.indexOf(row)
   if (from < 0 || rows.length < 2) return
   e.preventDefault()
   handle.setPointerCapture?.(e.pointerId)
   const mids = rows.map((r) => r.offsetTop + r.offsetHeight / 2)
   const h = row.offsetHeight
   // The dragged row stays within the list's rows, and the list scrolls no
   // further than it could before the drag: a transform counts toward
   // scrollable overflow, so an unclamped row would grow the very area the
   // edge scroll then chases, running away from the pointer.
   const minDy = rows[0].offsetTop - row.offsetTop
   const last = rows[rows.length - 1]
   const maxDy = last.offsetTop + last.offsetHeight - (row.offsetTop + h)
   const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight)
   const contentY = (y: number): number => y - list.getBoundingClientRect().top + list.scrollTop
   const y0 = contentY(e.clientY)
   let lastY = e.clientY
   let to = from
   let frame = 0
   dragging = true
   row.classList.add("srr-player-row-dragging")
   const update = (): void => {
      const dy = Math.min(maxDy, Math.max(minDy, contentY(lastY) - y0))
      row.style.transform = `translateY(${dy}px)`
      // A neighbour is passed once the dragged row's LEADING edge crosses its
      // midpoint — the bottom edge going down, the top edge going up.
      const top = row.offsetTop + dy
      const below = mids.filter((m, k) => k > from && top + h > m).length
      const above = mids.filter((m, k) => k < from && top < m).length
      to = from + below - above
      rows.forEach((r, k) => {
         if (k === from) return
         const shift = from < to && k > from && k <= to ? -h : from > to && k >= to && k < from ? h : 0
         r.style.transform = shift ? `translateY(${shift}px)` : ""
      })
   }
   const edgeScroll = (): void => {
      const r = list.getBoundingClientRect()
      const step = lastY < r.top + EDGE_PX ? -EDGE_STEP : lastY > r.bottom - EDGE_PX ? EDGE_STEP : 0
      if (step) {
         const before = list.scrollTop
         list.scrollTop = Math.min(maxScroll, Math.max(0, before + step))
         if (list.scrollTop !== before) update()
      }
      frame = requestAnimationFrame(edgeScroll)
   }
   frame = requestAnimationFrame(edgeScroll)
   const move = (ev: PointerEvent): void => {
      lastY = ev.clientY
      update()
   }
   const end = (commit: boolean): void => {
      cancelAnimationFrame(frame)
      dragging = false
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", up)
      handle.removeEventListener("pointercancel", cancel)
      row.classList.remove("srr-player-row-dragging")
      for (const r of rows) r.style.transform = ""
      // A list re-rendered mid-drag (an episode ended) has other rows now:
      // drop nothing rather than guess.
      if (!commit || !row.isConnected || to === from) return
      if (moveEntryTo(entry, to) >= 0) grips()[to]?.focus()
   }
   const up = (): void => end(true)
   const cancel = (): void => end(false)
   handle.addEventListener("pointermove", move)
   handle.addEventListener("pointerup", up)
   handle.addEventListener("pointercancel", cancel)
}

// The rows' swipe-to-remove. LOCAL touch handling on purpose, not a
// gestures.ts registration: the document machine declines any touch starting
// inside .srr-player (the scrubber guard), so it can never reach these rows —
// and that is right, a drag here must never read as a reader page turn. The
// axis lock is the machine's own three faces at its own AXIS_SLOP.
function attachRowSwipe(row: HTMLElement, entry: QueueEntry): void {
   let x0 = 0
   let y0 = 0
   let dx = 0
   let mode: "idle" | "drag" | "veto" = "veto"
   let swallow = false
   const settle = (): void => {
      // Clearing the inline "none" first lets the CSS transition carry the
      // snap-back instead of teleporting the row home.
      row.style.transition = ""
      row.style.transform = ""
   }
   row.addEventListener("touchstart", (e) => {
      swallow = false
      // The handle's touches are a reorder drag (pointer events), never a swipe.
      if (e.touches.length !== 1 || (e.target as Element).closest?.(".srr-player-row-grip")) {
         mode = "veto"
         return settle()
      }
      mode = "idle"
      dx = 0
      x0 = e.touches[0].clientX
      y0 = e.touches[0].clientY
   })
   row.addEventListener("touchmove", (e) => {
      if (mode === "veto" || !e.touches.length) return
      dx = e.touches[0].clientX - x0
      const dy = e.touches[0].clientY - y0
      if (mode === "idle") {
         // Vertical-dominant past the slop is a scroll for the gesture's life.
         if (verticalDominant(dx, dy)) {
            mode = "veto"
            return
         }
         if (Math.abs(dx) <= AXIS_SLOP || Math.abs(dx) <= Math.abs(dy)) return
         mode = "drag"
         row.style.transition = "none"
      }
      // An engaged swipe owns the finger — the list must not scroll under it.
      e.preventDefault()
      row.style.transform = `translateX(${dx}px)`
   })
   row.addEventListener("touchend", () => {
      if (mode !== "drag") return
      mode = "veto"
      // The finger-lift's synthesized click lands on a row button; a drag is
      // not a tap (list.ts's swipeClickGuard, scoped to this row).
      swallow = true
      if (Math.abs(dx) >= ROW_SWIPE_TRIGGER) return dropEntry(entry)
      settle()
   })
   row.addEventListener("touchcancel", () => {
      mode = "veto"
      settle()
   })
   row.addEventListener(
      "click",
      (e) => {
         if (!swallow) return
         swallow = false
         e.preventDefault()
         e.stopPropagation()
      },
      true,
   )
}

// ---------------------------------------------------------------------------
// Seek interaction
// ---------------------------------------------------------------------------

// The seek rail's box, captured at pointerdown and held for the drag. The rail is
// fixed chrome that cannot move while a finger is down, and measuring it per
// pointermove — interleaved with the clock effect's width write on the fill —
// forced a layout on every move of the scrub.
let seekRect: DOMRect | null = null

function seekFromPointer(e: PointerEvent): void {
   // The element's own duration, not the last sample: a drag must never scale
   // against a length the next timeupdate has not reported yet.
   const dur = active()?.media.duration ?? NaN
   if (!Number.isFinite(dur) || dur <= 0) return
   const r = seekRect ?? el.playerSeek.getBoundingClientRect()
   if (r.width <= 0) return
   seekTo(((e.clientX - r.left) / r.width) * dur)
}

function bindSeek(): void {
   el.playerSeek.addEventListener("pointerdown", (e) => {
      // Pointer capture keeps the drag alive outside the 4px-tall track.
      el.playerSeek.setPointerCapture?.(e.pointerId)
      seekRect = el.playerSeek.getBoundingClientRect()
      seekFromPointer(e)
   })
   el.playerSeek.addEventListener("pointermove", (e) => {
      // buttons is a bitmask: nonzero means a button is still held (a drag).
      if (e.buttons) seekFromPointer(e)
      else seekRect = null // the drag ended somewhere we never saw the lift
   })
   for (const ev of ["pointerup", "pointercancel"] as const)
      el.playerSeek.addEventListener(ev, () => {
         seekRect = null
      })
   // stopPropagation beside every preventDefault — the dialog discipline
   // dropdown.ts / search-ui.ts / lightbox.ts already spell out, applied to a
   // control instead of a modal. The seek bar is a tabindex=0 role=slider DIV,
   // so it takes focus from Tab AND from a plain press on the track, and
   // app.ts's document-level keydown is bubble-phase with a tag-name-only
   // typing guard (INPUT/TEXTAREA/SELECT/contentEditable) and no
   // defaultPrevented check — a slider DIV walks straight through it. Without
   // this, one ArrowRight both seeks +5s AND runs the global action: in the
   // reader it steps to the NEXT ARTICLE, navigating away from the episode
   // being scrubbed. ArrowUp/ArrowDown are in the step set for the same reason
   // AND for the ARIA slider pattern, which expects them to step the value.
   el.playerSeek.addEventListener("keydown", (e) => {
      const step =
         e.key === "ArrowRight" || e.key === "ArrowUp"
            ? 5
            : e.key === "ArrowLeft" || e.key === "ArrowDown"
              ? -5
              : e.key === "PageUp"
                ? 60
                : e.key === "PageDown"
                  ? -60
                  : 0
      if (step) {
         e.preventDefault()
         e.stopPropagation()
         skip(step)
      } else if (e.key === "Home") {
         e.preventDefault()
         e.stopPropagation()
         seekTo(0)
      }
   })
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// The video thumbnail's expand button: the video itself goes full screen —
// where it is watched — wearing native controls while there, since the view's
// transport is out of sight. iOS Safari has no element fullscreen for video,
// only its own player (webkitEnterFullscreen), which ends with its own event.
function watchFullScreen(): void {
   const v = el.playerMedia.querySelector("video")
   if (!v) return
   v.setAttribute("controls", "")
   if (typeof v.requestFullscreen === "function") {
      v.requestFullscreen().catch(() => v.removeAttribute("controls"))
      return
   }
   const ios = v as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
   if (!ios.webkitEnterFullscreen) return v.removeAttribute("controls")
   v.addEventListener("webkitendfullscreen", () => v.removeAttribute("controls"), { once: true })
   ios.webkitEnterFullscreen()
}

function bindControls(): void {
   el.playerToggle.addEventListener("click", toggle)
   el.playerBack.addEventListener("click", () => skip(-SKIP_SECONDS))
   el.playerFwd.addEventListener("click", () => skip(SKIP_SECONDS))
   el.playerRate.addEventListener("click", cycleRate)
   // ✕ HIDES the view (user call 2026-09-23) — it never stops or clears
   // anything; emptying the playlist is what takes the player away.
   el.playerClose.addEventListener("click", () => setUnfolded(false))
   el.playerTitle.addEventListener("click", openOwner)
   el.playerNext.addEventListener("click", () => advance(true))
   el.playerPrev.addEventListener("click", prevTrack)
   el.playerExpand.addEventListener("click", watchFullScreen)
   // Leaving full screen: the view's own transport is back in sight, so the
   // native controls go again (a video that already went home to its article
   // has them from rehomeInto and is not in the host any more).
   document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) el.playerMedia.querySelector("video")?.removeAttribute("controls")
   })
   // The dock: a tap opens the player view; its secondary gesture (long-press,
   // right-click, Shift+F10) plays / pauses without opening anything.
   el.playerDock.addEventListener("click", () => setUnfolded(true))
   bindSecondaryPress(el.playerDock, () => {
      toggle()
      return true
   })
   // Escape closes the view — and is claimed, so it does not also drop the
   // reader to the list. The app's keymap stands down while the view is up
   // (app.ts overlayUp, the picker's rule): it is a view over the surfaces, and
   // an arrow must never walk the article hidden behind it.
   el.player.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !unfolded()) return
      e.preventDefault()
      e.stopPropagation()
      setUnfolded(false)
   })
   bindSeek()
   bindListScrollIntent()
}

const pausedNow = computed(() => (active() ? playback().paused : true))

// Wire the controls and register the sheet's three effects. Each effect paints
// under untracked(), so a DOM read inside a painter can never widen what it
// re-runs on.
export function watchView(): () => void {
   bindControls()
   const stops = [
      watchHistory(),
      diffed(chromeKey, () => paintChrome(), { equals: arrayEqual, fireOnFirst: true }),
      effect(() => {
         active()
         playback()
         untracked(paintClock)
      }),
      effect(() => {
         const a = active()
         const q = queue()
         cursor()
         const ci = cursorIndex()
         const open = unfolded()
         // A play/pause flips the current row's label (Play ↔ Pause). Through
         // a computed, never playback() itself: that moves ~4×/s while playing,
         // and a re-render would tear the rows out from under a drag or focus.
         pausedNow()
         untracked(() => {
            renderList(a, q, ci)
            followCurrent(q[ci], open)
         })
      }),
   ]
   return () => stops.forEach((s) => s())
}
