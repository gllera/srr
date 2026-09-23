// player/view.ts — the player's own surface: the sheet (folded corner button /
// full player), its clock and scrubber, and the Up next list. Every paint here
// is an effect over state.ts; the handlers only write state or call the engine.
import * as data from "../data"
import { btn } from "../dropdown"
import { el } from "../els"
import { stampSrc } from "../fmt"
import { AXIS_SLOP, ROW_SWIPE_TRIGGER, verticalDominant } from "../gestures"
import { arrayEqual, diffed, effect, untracked } from "../signals"
import {
   cycleRate,
   dropEntry,
   moveEntry,
   openOwner,
   advance,
   playNow,
   seekTo,
   skip,
   SKIP_SECONDS,
   toggle,
   close,
} from "./engine"
import { active, buffering, entryLabel, playback, queue, ratePref, unfolded, type QueueEntry } from "./state"

// Fold / unfold the full player. Folding with focus inside hands it to the
// fold button, so the keyboard never lands on a now-invisible control.
export function setUnfolded(open: boolean): void {
   if (unfolded() === open) return
   const f = document.activeElement
   if (!open && f && f !== el.playerFab && el.player.contains(f)) el.playerFab.focus()
   unfolded.set(open)
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
   return [a, q[0] ?? null, q.length > 0, unfolded(), buffering(), a ? playback().paused : true, ratePref()]
}

function paintChrome(): void {
   const a = active()
   const q = queue()
   const show = a !== null || q.length > 0
   el.player.hidden = !show
   // Drives the container's bottom clearance so the last paragraph clears it.
   document.body.classList.toggle("srr-playing", show)
   // Folded is a class, never the `hidden` attribute: the player may be holding
   // a relocated <video>, which must stay rendered (see .srr-player-media).
   const open = unfolded()
   el.player.classList.toggle("srr-player-folded", !open)
   el.playerFab.setAttribute("aria-expanded", String(open))
   const fabLabel = open ? "Hide player" : "Show player"
   el.playerFab.setAttribute("aria-label", fabLabel)
   el.playerFab.title = fabLabel
   // The buffering spinner replaces the toggle glyph; aria-busy is the same
   // state for assistive tech (the accessible name stays Play/Pause).
   const stalled = buffering() && a !== null
   el.playerToggle.classList.toggle("srr-player-buffering", stalled)
   el.playerToggle.setAttribute("aria-busy", String(stalled))
   // » needs something to skip to.
   el.playerNext.hidden = !q.length
   // One painter for both states: the READY state is exactly the active state
   // at paused = true, labelled from the queue head instead of the claim.
   const who = a ?? q[0]
   if (!who) return
   const kind = a ? (a.media.tagName === "VIDEO" ? "video" : "audio") : q[0].kind
   const paused = a ? playback().paused : true
   el.player.dataset.kind = kind
   stampSrc(el.player, who.feedId)
   el.playerSource.textContent = data.feedTitle(who.feedId)
   el.playerName.textContent = entryLabel(who.title)
   el.playerTitle.setAttribute("aria-label", `Go to ${who.title || "this article"} — ${data.feedTitle(who.feedId)}`)
   el.playerToggle.setAttribute("aria-label", paused ? "Play" : "Pause")
   el.playerToggle.setAttribute("aria-pressed", String(!paused))
   el.playerToggle.classList.toggle("srr-player-playing", !paused)
   // The folded button's bars move while it plays — the one signal left when
   // the transport itself is folded away.
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
      return
   }
   const dur = p.duration
   el.playerTime.textContent = clock(p.time)
   el.playerDuration.textContent = Number.isFinite(dur) ? clock(dur) : ""
   const pct = Number.isFinite(dur) && dur > 0 ? (p.time / dur) * 100 : 0
   el.playerSeekFill.style.width = `${pct}%`
   el.playerSeek.setAttribute("aria-valuemax", String(Number.isFinite(dur) ? Math.floor(dur) : 0))
   el.playerSeek.setAttribute("aria-valuenow", String(Math.floor(p.time)))
   el.playerSeek.setAttribute("aria-valuetext", clock(p.time))
}

// ---------------------------------------------------------------------------
// Up next
// ---------------------------------------------------------------------------

// The Up next list is part of the full player, always rendered (not a popover):
// the queue is the player's whole subject, so it is never one tap away.
function renderList(q: readonly QueueEntry[]): void {
   el.playerCount.textContent = q.length ? String(q.length) : ""
   el.playerEmpty.hidden = q.length > 0
   el.playerList.replaceChildren(
      ...q.map((entry, i) => {
         const row = document.createElement("div")
         row.setAttribute("role", "listitem")
         row.className = "srr-player-row"
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
         play.setAttribute("aria-label", `Play now — ${entryLabel(entry.title)} · ${data.feedTitle(entry.feedId)}`)
         play.addEventListener("click", () => {
            playNow(entry)
            el.playerToggle.focus()
         })
         const remove = btn("srr-player-row-remove", `Remove from playlist — ${entryLabel(entry.title)}`, "×", () =>
            dropEntry(entry),
         )
         row.append(play, moveBtn(entry, -1, i === 0), moveBtn(entry, 1, i === q.length - 1), remove)
         attachRowSwipe(row, entry)
         return row
      }),
   )
}

// A ▲/▼ reorder handle. Disabled at its dead end rather than hidden, so the
// four-button row keeps one geometry and a tap never lands on the wrong role.
function moveBtn(entry: QueueEntry, delta: -1 | 1, dead: boolean): HTMLButtonElement {
   const b = btn(
      delta < 0 ? "srr-player-row-up" : "srr-player-row-down",
      `${delta < 0 ? "Move up" : "Move down"} — ${entryLabel(entry.title)}`,
      delta < 0 ? "↑" : "↓",
      () => moveQueued(entry, delta),
   )
   b.disabled = dead
   return b
}

function moveQueued(entry: QueueEntry, delta: -1 | 1): void {
   const j = moveEntry(entry, delta)
   if (j < 0) return
   // The list re-rendered under the press (the write flushed synchronously):
   // keep the keyboard on the row that moved — the same-direction handle so
   // repeated presses keep walking, its opposite when the row hit a dead end.
   const row = el.playerList.querySelectorAll(".srr-player-row")[j]
   const same = row?.querySelector<HTMLButtonElement>(delta < 0 ? ".srr-player-row-up" : ".srr-player-row-down")
   if (same && !same.disabled) same.focus()
   else row?.querySelector<HTMLButtonElement>(delta < 0 ? ".srr-player-row-down" : ".srr-player-row-up")?.focus()
}

// The Up next rows' swipe-to-remove. LOCAL touch handling on purpose, not a
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
      if (e.touches.length !== 1) {
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

function bindControls(): void {
   el.playerToggle.addEventListener("click", toggle)
   el.playerBack15.addEventListener("click", () => skip(-SKIP_SECONDS))
   el.playerFwd15.addEventListener("click", () => skip(SKIP_SECONDS))
   el.playerRate.addEventListener("click", cycleRate)
   el.playerClose.addEventListener("click", close)
   el.playerTitle.addEventListener("click", openOwner)
   el.playerNext.addEventListener("click", () => advance(true))
   el.playerFab.addEventListener("click", () => setUnfolded(!unfolded()))
   // Escape folds the unfolded player — and is claimed, so it does not also
   // drop the reader to the list. Every other key still reaches the global
   // keymap: the player is a control you read beside, not a modal (a modal
   // owns every key — lightbox.ts — a control only its own).
   el.player.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !unfolded()) return
      e.preventDefault()
      e.stopPropagation()
      setUnfolded(false)
   })
   bindSeek()
}

// Wire the controls and register the sheet's three effects. Each effect paints
// under untracked(), so a DOM read inside a painter can never widen what it
// re-runs on.
export function watchView(): () => void {
   bindControls()
   const stops = [
      diffed(chromeKey, () => paintChrome(), { equals: arrayEqual, fireOnFirst: true }),
      effect(() => {
         active()
         playback()
         untracked(paintClock)
      }),
      effect(() => {
         const q = queue()
         untracked(() => renderList(q))
      }),
   ]
   return () => stops.forEach((s) => s())
}
