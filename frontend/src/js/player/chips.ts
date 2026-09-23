// player/chips.ts — the in-article queue chips: the add affordance after every
// eligible <audio>/<video>, its long-press menu, the `p` key, and the first-add
// autoplay rule. Chips are injected by reader.ts (step 6 of its media order) and
// re-derived by one effect whenever the queue changes.
import { mediaList } from "../article-view"
import { bindPressMenu, type MenuItem } from "../dropdown"
import { el } from "../els"
import { restartAnimation } from "../motion"
import { batch, onChange } from "../signals"
import { dropEntry, insertNext, playCursor, playEntry } from "./engine"
import { active, isGifIdiom, mounted, QUEUE_MAX, queue, queuePos, unfolded, type QueueEntry } from "./state"
import { setUnfolded } from "./view"

// One chip, a glyph vocabulary: "+" add, the entry's 1-based queue POSITION
// while queued (the chips effect re-derives every chip after every queue change,
// so the numeral can never lie), and "≡" when the queue is full — the door
// state: toggleQueued unfolds the player (its Up next list) to prune instead of
// dead-ending, so the cap never reads as a broken button. aria-pressed stays the
// toggle truth.
function setChipState(chip: HTMLButtonElement, pos: number): void {
   const door = pos < 0 && queue().length >= QUEUE_MAX
   chip.classList.toggle("srr-chip-door", door)
   chip.textContent = pos >= 0 ? String(pos + 1) : door ? "≡" : "+"
   chip.setAttribute("aria-pressed", String(pos >= 0))
   chip.setAttribute(
      "aria-label",
      pos >= 0
         ? `Remove from playlist — position ${pos + 1}`
         : door
           ? "Playlist full — open playlist"
           : "Add to playlist",
   )
}

// The video CORNER chip exists only while its video is stopped (queueing is a
// decision about a video you haven't started); audio chips never hide. The
// class is inert under the @supports fallback, where the chip sits below the
// frame and occludes nothing.
function syncChipOffstage(m: HTMLMediaElement, chip: HTMLElement): void {
   chip.classList.toggle("srr-chip-offstage", m.tagName === "VIDEO" && !m.paused)
}

// play/pause don't bubble (the claim listener's rule), so the offstage sync
// rides its own capture-phase pair instead of per-element listeners a re-render
// would re-bind.
export function onMediaStateForChips(e: Event): void {
   const t = e.target
   if (!(t instanceof HTMLMediaElement) || t.tagName !== "VIDEO") return
   const sib = t.nextElementSibling
   if (sib instanceof HTMLElement && sib.classList.contains("srr-queue-chip")) syncChipOffstage(t, sib)
}

function pulseOnce(n: Element | null): void {
   if (n instanceof HTMLElement) restartAnimation(n, "srr-chip-pop")
}

// Feedback at both ends of an add: the chip pops under the finger, and where
// the episode went pulses — the Up next count, or (folded) the dock.
function pulseAdd(chip: Element | null): void {
   pulseOnce(chip)
   pulseOnce(unfolded() ? el.playerCount : el.playerDock)
}

// The FIRST entry into an idle player starts playing it (user call
// 2026-09-23): with nothing claimed and the queue just gone from empty to one,
// the add IS the "play this". The tap is a user gesture, so autoplay policy has
// nothing to refuse. Anything added behind an episode (active or already
// queued, e.g. a READY queue restored at boot) just waits its turn.
function startIfIdle(): boolean {
   if (active() || queue().length !== 1) return false
   playCursor()
   return true
}

// The chip's long-press menu — the power layer over the tap (append): "Play
// next" puts the enclosure right AFTER the current entry (the podcast verb the
// list's reorder arrows only reach one step at a time; a listed entry MOVES,
// never duplicates), "Play now" does the same and then plays it at once —
// through the playlist, since the player plays nothing else. Items derive at
// open and RE-CHECK at action:
// showContextMenu outlives this tick, and an auto-advance or a navigation can
// move the queue (or the article) under an open menu.
function chipMenuItems(index: number): MenuItem[] {
   const at = mounted()
   if (!at) return []
   const m = mediaList(el.content)[index]
   if (!m?.getAttribute("src")) return []
   const { mid, chron, title, feedId } = at
   const stale = (): boolean => {
      const now = mounted()
      return !now || now.mid !== mid || now.chron !== chron
   }
   // Put the enclosure right after the current entry (a listed one MOVES).
   // A NEW entry at the cap is refused — the list is where to prune.
   const toNext = (): { media: HTMLMediaElement; entry: QueueEntry; added: boolean } | null => {
      if (stale()) return null
      const media = mediaList(el.content)[index]
      const src = media?.getAttribute("src") ?? ""
      if (!src) return null
      if (queuePos(mid, chron, index) < 0 && queue().length >= QUEUE_MAX) return null
      const listed = queue().find((e) => e.mid === mid && e.chron === chron && e.index === index)
      const entry: QueueEntry = listed ?? {
         mid,
         chron,
         index,
         src,
         kind: media.tagName === "VIDEO" ? "video" : "audio",
         title,
         feedId,
      }
      return { media, entry, added: insertNext(entry) }
   }
   return [
      {
         label: "Play next",
         // A NEW head entry would breach the cap; a queued one just moves.
         disabled: queuePos(mid, chron, index) < 0 && queue().length >= QUEUE_MAX,
         action: () => {
            const r = toNext()
            if (!r || startIfIdle()) return
            if (r.added) pulseAdd(r.media.nextElementSibling)
            else pulseOnce(r.media.nextElementSibling)
         },
      },
      {
         label: "Play now",
         // At the cap only an already-listed enclosure can play now (a new one
         // would breach it); the chip's own door covers pruning.
         disabled: queuePos(mid, chron, index) < 0 && queue().length >= QUEUE_MAX,
         action: () =>
            batch(() => {
               const r = toNext()
               if (r) playEntry(r.entry, true)
            }),
      },
   ]
}

function toggleQueued(index: number): void {
   const at = mounted()
   if (!at) return
   const { mid, chron, title, feedId } = at
   const listed = queue().find((e) => e.mid === mid && e.chron === chron && e.index === index)
   if (listed) return dropEntry(listed)
   // The cap as a DOOR: a full queue unfolds the player, whose Up next list
   // is where to prune, instead of silently eating the tap (the chip already
   // reads ≡ / "Playlist full").
   if (queue().length >= QUEUE_MAX) return setUnfolded(true)
   const m = mediaList(el.content)[index]
   const src = m?.getAttribute("src") ?? ""
   if (!src) return
   queue.set([...queue(), { mid, chron, index, src, kind: m.tagName === "VIDEO" ? "video" : "audio", title, feedId }])
   if (startIfIdle()) return
   pulseAdd(m.nextElementSibling)
}

// The reader's `p` key (app.ts KEY_ACTIONS): toggle the article's FIRST
// enclosure in the playlist — keyboard parity with b-for-save, so queueing
// never needs a pointer. Routed through the chip's own click so there is ONE
// path (the full-queue door included); a no-enclosure article is a quiet no-op.
//
// FIRST as the reader SEES it: media that failed to load is collapsed
// (fmt.ts stamps .srr-broken, styles.css display:none) and takes its chip with
// it, so keying the first chip in DOM ORDER would queue an invisible dead
// enclosure ahead of the playable one below it. Keyed on the same class the
// stylesheet hides them by — one fact, not two that can disagree.
export function queueKey(): void {
   for (const chip of el.content.querySelectorAll<HTMLButtonElement>(".srr-queue-chip")) {
      // The chip is inserted directly after its media element (injectQueueChips).
      if (chip.previousElementSibling?.classList.contains("srr-broken")) continue
      chip.click()
      return
   }
}

// Called by reader.ts as step 6 of its fixed media order (after rehome): one
// toggle chip per eligible media element, inserted AFTER it — a chip is a
// <button>, never audio/video, so the index pairing FEB2 and rehome rely on is
// untouched. Eligible = not the GIF idiom (a decoration must no more enter the
// playlist than claim the transport) and carrying a src attribute (a
// <source>-only element cannot be rebuilt detached — the same bar save() sets).
export function injectQueueChips(): void {
   const at = mounted()
   if (!at) return
   const { mid, chron } = at
   const list = mediaList(el.content)
   for (let i = 0; i < list.length; i++) {
      const m = list[i]
      if (isGifIdiom(m)) continue
      if (!m.getAttribute("src")) continue
      // On the rehome path the chip is already sitting after the element
      // (replaceWith swaps the node, not its siblings) — re-derive its state.
      const existing = m.nextElementSibling
      if (existing instanceof HTMLButtonElement && existing.classList.contains("srr-queue-chip")) {
         pairAnchor(m, existing, i)
         setChipState(existing, queuePos(mid, chron, i))
         syncChipOffstage(m, existing)
         continue
      }
      const chip = document.createElement("button")
      chip.type = "button"
      chip.className = "srr-queue-chip"
      const index = i
      chip.addEventListener("click", () => toggleQueued(index))
      // The long-press power layer (Play next / Play now) — dropdown owns the
      // secondary-gesture wiring; the swallowed finger-lift click is what keeps
      // a held chip from also toggling the queue.
      bindPressMenu(chip, () => chipMenuItems(index))
      setChipState(chip, queuePos(mid, chron, i))
      m.insertAdjacentElement("afterend", chip)
      pairAnchor(m, chip, i)
      syncChipOffstage(m, chip)
   }
}

// Bind a VIDEO's corner chip to THAT video, per pair. The stylesheet used one
// shared `anchor-name` for every video and relied on "nearest preceding element
// wins" — which is not the rule: CSS anchor positioning resolves a name to the
// LAST element carrying it in tree order, so in an article with two or more
// videos every chip stacked on the corner of the last one (measured: three
// chips, one position). Names have to be unique per pair, and only JS can mint
// them — the index the chips are already keyed by is exactly that. Audio chips
// are in normal flow (no anchoring) and are left alone.
function pairAnchor(m: HTMLMediaElement, chip: HTMLElement, index: number): void {
   if (m.tagName !== "VIDEO") return
   const name = `--srr-qmedia-${index}`
   m.style.setProperty("anchor-name", name)
   chip.style.setProperty("position-anchor", name)
}

// The chips effect: every rendered chip re-derives when the queue changes (a
// list removal, a consume-on-play, ✕, a restore) so a pressed state never lies
// about membership. The first run is skipped — no chip exists before reader.ts
// injects them, and injection derives each chip's state itself.
export function watchChips(): () => void {
   return onChange(queue, () => {
      const at = mounted()
      if (!at) return
      const list = mediaList(el.content)
      for (let i = 0; i < list.length; i++) {
         const sib = list[i].nextElementSibling
         if (sib instanceof HTMLButtonElement && sib.classList.contains("srr-queue-chip"))
            setChipState(sib, queuePos(at.mid, at.chron, i))
      }
   })
}
