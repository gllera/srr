// player/session.ts — the lock screen / notification transport (Media Session),
// as two effects over the player's state.
import * as data from "../data"
import { arrayEqual, diffed, onChange } from "../signals"
import { advance, close, pause, play, prevTrack, seekTo, skip, SKIP_SECONDS } from "./engine"
import { active, entryLabel, playback, queue, type Active } from "./state"

// Metadata + playbackState follow the claimed episode and its play/pause. The
// action handlers are (re)bound on every NEW claim — engines drop them when the
// session goes idle — never on a play/pause of the same one.
function syncMetadata(a: Active | null, paused: boolean): void {
   const ms = navigator.mediaSession
   if (!ms) return
   if (!a) {
      ms.metadata = null
      ms.playbackState = "none"
      return
   }
   if (typeof MediaMetadata === "function") {
      ms.metadata = new MediaMetadata({ title: entryLabel(a.title), artist: data.feedTitle(a.feedId), album: "SRR" })
   }
   ms.playbackState = paused ? "paused" : "playing"
}

function bindHandlers(): void {
   const ms = navigator.mediaSession
   if (!ms) return
   const handlers: [MediaSessionAction, () => void][] = [
      ["play", () => void play()],
      ["pause", () => pause()],
      ["stop", () => close()],
      ["seekbackward", () => skip(-SKIP_SECONDS)],
      ["seekforward", () => skip(SKIP_SECONDS)],
   ]
   for (const [action, fn] of handlers) {
      // Engines reject actions they do not implement; one unsupported action
      // must not take the supported ones down with it.
      try {
         ms.setActionHandler(action, fn)
      } catch {}
   }
   try {
      ms.setActionHandler("seekto", (e) => {
         if (typeof e.seekTime === "number") seekTo(e.seekTime)
      })
   } catch {}
}

// The lock screen gains real track buttons ONLY while a queue exists — with
// one, nexttrack/previoustrack step QUEUE items; without one they stay unset so
// the platform greys them out (RDR16's original rule stands: they must never
// map to prev/next ARTICLE and skip the listener out of an episode).
function syncQueueHandlers(has: boolean): void {
   const ms = navigator.mediaSession
   if (!ms) return
   try {
      ms.setActionHandler("nexttrack", has ? () => advance(true) : null)
   } catch {}
   try {
      ms.setActionHandler("previoustrack", has ? prevTrack : null)
   } catch {}
}

export function watchSession(): () => void {
   const stopMeta = diffed(
      () => {
         const a = active()
         return [a, a ? playback().paused : true] as const
      },
      ([a, paused], prev) => {
         if (a && a !== prev?.[0]) bindHandlers()
         syncMetadata(a, paused)
      },
      { equals: arrayEqual },
   )
   const stopQueue = onChange(() => queue().length > 0, syncQueueHandlers)
   return () => {
      stopMeta()
      stopQueue()
   }
}
