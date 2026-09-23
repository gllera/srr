// player.ts — RDR16: the persistent mini-player. The public face of player/.
//
// FEB2 (reader.ts) made stepping away from an article non-destructive to media
// POSITIONS. The player makes it non-destructive to PLAYBACK: the episode keeps
// playing while you read something else, with a transport that follows you.
//
// The mechanism is relocation, not reconstruction. Rendering an article calls
// `el.content.replaceChildren`, which would REMOVE a playing <audio>/<video> and
// stop it dead. So just before that happens the live element is MOVED — one
// appendChild, an atomic remove+insert — into the player's own host node. Per
// the HTML spec the "removed from a Document" steps queue a task that runs the
// internal pause steps only if the element is NOT in a document at stable
// state; an atomic move passes that check, so the audio never even hiccups.
// There is no second element, no src/currentTime handoff, and no re-buffer gap
// — and video rides the identical path.
//
// TWO SEPARATE CONCERNS, deliberately not conflated:
//
//   * RELOCATION is about SURVIVAL (player/relocation.ts). The element moves
//     only when its article stops being rendered, and moves back when you
//     return to it. Imperative, at fixed points of reader.ts's render.
//   * THE PLAYER is about CONTROL. It shows whenever an episode is active (or a
//     queue is waiting), whatever article is on screen — and everything it
//     shows is an EFFECT over the state in player/state.ts, so a state write is
//     the whole update.
//
// The modules:
//   state.ts       the atoms (signals) and pure helpers over them
//   engine.ts      claim / release / transport / queue advance / error retry /
//                  boot restore — writes state, never paints
//   persist.ts     the srr-player localStorage blob + its effect
//   relocation.ts  the reader.ts seam (adopt / rehome)
//   chips.ts       the in-article queue chips + their effect
//   view.ts        the sheet, its clock and the Up next list + their effects
//   session.ts     the lock screen (Media Session) + its effects
//
// None of them imports `nav` or `reader`: reader.ts imports THIS, and what the
// player needs from the router arrives through PlayerDeps — keeping the graph
// acyclic with app.ts on top. reader.ts also has to TELL the player what is on
// screen (noteMounted), because the chron of the mounted article is its state.
import { injectQueueChips, onMediaStateForChips, queueKey, watchChips } from "./player/chips"
import { onPlay, restorePersisted } from "./player/engine"
import { save, watchPersist } from "./player/persist"
import { adoptFromContent, rehomeInto } from "./player/relocation"
import { watchSession } from "./player/session"
import { active, setDeps, setMounted, type MountedArticle, type PlayerDeps } from "./player/state"
import { isViewOpen, setUnfolded, watchView } from "./player/view"

export type { MountedArticle, PlayerDeps }
export { adoptFromContent, injectQueueChips, queueKey, rehomeInto, restorePersisted }

// reader.ts tells us which article is on screen. Called with null for the empty
// states, whose content host holds reader chrome rather than an article.
export function noteMounted(info: MountedArticle | null): void {
   setMounted(info)
}

// The player VIEW — a full-viewport overlay like the filter picker. app.ts
// gates its keymap on it and routes a stray Escape to closeView.
export { isViewOpen }
export function closeView(): void {
   setUnfolded(false)
}

export function isActive(): boolean {
   return active() !== null
}

export function setup(deps: PlayerDeps): void {
   setDeps(deps)
   // Capture phase: `play` does not bubble (see engine.ts onPlay).
   document.addEventListener("play", onPlay, { capture: true })
   // The video corner chip's offstage sync (same capture rule, its own pair).
   document.addEventListener("play", onMediaStateForChips, { capture: true })
   document.addEventListener("pause", onMediaStateForChips, { capture: true })
   watchView()
   watchChips()
   watchSession()
   watchPersist()
   // A reload is the one exit we can still write through.
   window.addEventListener("pagehide", save)
}
