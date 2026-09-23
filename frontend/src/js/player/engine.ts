// player/engine.ts — what the player DOES: claim and release episodes, the
// transport, the queue's advance, the error retry and the boot restore.
//
// It writes state (state.ts) and never paints: every surface re-derives from
// those writes through the effects the other player modules register. Multi-atom
// updates run in batch() so the effects see one consistent state, once.
import { mediaList } from "../article-view"
import * as data from "../data"
import { el } from "../els"
import { PLAYER_RATE_KEY } from "../keys"
import { batch } from "../signals"
import { lsSet } from "../storage"
import { clearSaved, quietly, readSaved, safeSrc, save, saveSoon } from "./persist"
import { discardAdopted } from "./relocation"
import {
   active,
   buffering,
   deps,
   entryOf,
   isGifIdiom,
   mounted,
   queue,
   queuePos,
   RATES,
   ratePref,
   readRate,
   sample,
   unfolded,
   withoutEntry,
   type Active,
   type QueueEntry,
} from "./state"

// One-deep history for the lock screen's previoustrack (the podcast convention:
// early in an episode, "previous" means the one before). Deliberately not a
// full history — a reader's queue is a to-listen list, not a DJ deck.
let lastPlayed: QueueEntry | null = null
// previoustrack past this many seconds restarts the episode instead.
const PREV_RESTART_S = 3
export const SKIP_SECONDS = 15
// The beat before an error retry reloads: an immediate reload would land inside
// the same network blip that caused the error.
const RETRY_DELAY_MS = 2000
let retryTimer = 0
// A remembered position this close to the end reads as "finished" — start over.
const RESUME_END_S = 2

// ---------------------------------------------------------------------------
// Claim / release
// ---------------------------------------------------------------------------

// The player controls its QUEUE and nothing else (user call 2026-09-23): an
// in-article element played directly stays the article's own — native controls,
// no player, and it stops when its article leaves the screen, as any page media
// does. What a `play` event CAN still claim is an element whose episode is
// queued: pressing play on it is "play that one from the playlist now".
// `play` does not bubble, but non-bubbling events still traverse the CAPTURE
// phase — the same property fmt.ts's collapseBrokenMedia relies on for
// `error` — so one capture listener on the document sees every media element.
export function onPlay(e: Event): void {
   const m = e.target
   if (!(m instanceof HTMLMediaElement)) return
   const a = active()
   if (a && a.media === m) {
      // Re-play of the episode we already own: nothing to re-derive.
      pauseOthers(m)
      return sample()
   }
   // The GIF idiom fires `play` on its own the moment it renders, so it must
   // neither claim nor silence anything — a decoration is not a second voice.
   if (isGifIdiom(m)) return
   const at = mounted()
   const index = at && el.content.contains(m) ? mediaList(el.content).indexOf(m) : -1
   if (!at || index < 0 || queuePos(at.mid, at.chron, index) < 0) {
      // Outside media: not ours to control, but one thing audible at a time —
      // the episode steps aside (paused, still claimed, one tap to resume).
      if (a && !a.media.paused) a.media.pause()
      return
   }
   batch(() => {
      releaseOutgoing()
      active.set({ ...at, index, media: m })
      pauseOthers(m)
      // The claimed entry is now the active episode; leaving it queued would
      // replay it later.
      queue.set(withoutEntry(at.mid, at.chron, index))
      // Apply the device's standing speed preference, but only when it was
      // actually set: at the default 1 we leave the element alone so a rate FEB2
      // restored (or one set through native in-content controls) is not reset.
      const rate = readRate()
      if (rate !== 1) m.playbackRate = rate
      finishClaim(m)
   })
}

// The other half of "one thing audible at a time": the episode starting pauses
// any outside media still playing (never the GIF idiom — decorations loop on).
function pauseOthers(m: HTMLMediaElement): void {
   for (const o of document.querySelectorAll<HTMLMediaElement>("audio, video"))
      if (o !== m && !o.paused && !isGifIdiom(o)) o.pause()
}

// One episode at a time — the module's central invariant, in one place. Hand the
// outgoing episode's position back to FEB2, and if it was ADOPTED take it out of
// the player host too: release() deliberately never touches parents, so without
// this the old node would stay there still playing, inaudibly orphaned behind
// the new episode's chrome (two things playing at once).
function releaseOutgoing(): void {
   const a = active()
   const outgoingAdopted = a !== null && !el.content.contains(a.media)
   release()
   if (outgoingAdopted) discardAdopted()
}

// The tail every claim ends with, whatever route reached it (a queued in-content
// play, a queue entry, a boot restore in place or detached). `active` must
// already be assigned.
function finishClaim(m: HTMLMediaElement): void {
   bindMedia(m)
   ratePref.set(readRate())
   sample()
}

// Give the current position back to FEB2 and drop every hook. Does NOT touch the
// element's parent: whoever calls this decides whether the node goes home, stays
// in the player, or is discarded.
function release(): void {
   const a = active()
   if (!a) return
   const m = a.media
   deps().rememberPosition(a.mid, a.chron, a.index, { time: m.currentTime, rate: m.playbackRate })
   unbindMedia(m)
   if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = 0
   }
   batch(() => {
      active.set(null)
      buffering.set(false)
      sample()
   })
}

// The claimed element's event/handler pairs, as ONE table: bind and unbind walk
// it, so a handler can never be added to one and missed by the other (the leak
// that mirrored lists invite — a claim would then outlive its release).
// Function declarations hoist, so the later-defined handlers are fine here.
const MEDIA_EVENTS: ReadonlyArray<[string, EventListener]> = [
   ["timeupdate", onTimeUpdate],
   ["pause", onPauseOrPlay],
   ["play", onPauseOrPlay],
   ["ended", onEnded],
   ["error", onError],
   ["loadedmetadata", sample],
   ["durationchange", sample],
   ["waiting", onBufferStall],
   ["stalled", onBufferStall],
   ["playing", onBufferClear],
   ["canplay", onBufferClear],
]

function bindMedia(m: HTMLMediaElement): void {
   for (const [ev, fn] of MEDIA_EVENTS) m.addEventListener(ev, fn)
}

function unbindMedia(m: HTMLMediaElement): void {
   for (const [ev, fn] of MEDIA_EVENTS) m.removeEventListener(ev, fn)
}

function onTimeUpdate(): void {
   sample()
   saveSoon()
}

function onPauseOrPlay(): void {
   batch(() => {
      // A pause drops any spinner: the wait is over because nobody is waiting.
      if (active()?.media.paused) buffering.set(false)
      sample()
   })
   // The position at a play/pause is the one a reload should come back to.
   save()
}

// `waiting` = playback stopped for data; `stalled` = the fetch went quiet. Both
// only matter while something is actually trying to play — a preload hiccup on
// a paused element must not spin the toggle.
function onBufferStall(): void {
   const a = active()
   if (!a || a.media.paused) return
   buffering.set(true)
}

function onBufferClear(): void {
   buffering.set(false)
}

// The shared dismissal tail of ended/error: forget the episode wholesale —
// release the claim, drop its persisted entry, take an adopted node out of the
// player — then advance the playlist if there is one. One body, because the
// release/clearSaved/discardAdopted ordering is load-bearing (release reads
// active; discard only after the claim is gone; the clear before any advance,
// whose own save must not be wiped after it).
function dismissActive(): void {
   const mid = active()?.mid
   batch(() => {
      release()
      if (mid) clearSaved(mid)
      discardAdopted()
      if (queue().length) advance(true)
   })
}

function onEnded(): void {
   // A finished episode has nothing left to resume; drop it wholesale rather
   // than leaving a player parked at the end — unless something is queued, in
   // which case finishing is exactly when the playlist advances, with the
   // finished episode as the prev-track target.
   const a = active()
   if (queue().length) lastPlayed = a ? entryOf(a) : null
   dismissActive()
}

function onError(): void {
   // One retry before giving up: a transient network blip mid-commute must not
   // end a 90-minute episode. The first error keeps the claim and retries the
   // SAME element in place — reload after a beat, reseek at metadata, resume if
   // it was playing. The second error falls through to the dismissal below.
   const a = active()
   if (a && !a.retried) {
      const m = a.media
      a.retried = true
      const t = m.currentTime
      const wasPlaying = !m.paused
      // The toggle reads as "working on it", not frozen — the same spinner a
      // plain stall shows. A paused element waits silently.
      if (wasPlaying) buffering.set(true)
      retryTimer = window.setTimeout(() => {
         retryTimer = 0
         if (active() !== a) return
         m.addEventListener(
            "loadedmetadata",
            () => {
               if (active() !== a) return
               if (t > 0) {
                  try {
                     m.currentTime = t
                  } catch {}
               }
               // collapseBrokenMedia hid an in-content <video> on the same
               // error event; a working retry earns the frame back.
               m.classList.remove("srr-broken")
               if (wasPlaying) void play()
               sample()
            },
            { once: true },
         )
         m.load()
      }, RETRY_DELAY_MS)
      return
   }
   // Old articles outlive their media hosts (the same reality collapseBrokenMedia
   // exists for). An unplayable episode is not an app error: dismiss quietly —
   // or, with a queue, skip to the next entry (each attempt consumes one, so a
   // run of dead episodes terminates at the plain dismissal). The dead episode
   // deliberately does NOT become the prev-track target.
   dismissActive()
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

// Play a specific entry NOW. Claims the on-screen element when the entry's own
// article is the mounted one (the restore live path — no second element, no
// re-buffer); otherwise builds a detached element in the player host (the
// boot-restore detached path). Returns false — with the current episode
// untouched — when the entry is unplayable, so advance() can skip it.
export function playEntry(entry: QueueEntry, autoplay: boolean): boolean {
   const at = mounted()
   const live = at && at.mid === entry.mid && at.chron === entry.chron ? mediaList(el.content)[entry.index] : undefined
   let src: string | null = null
   if (!live) {
      // In-session captures came off a sanitized element and persisted ones
      // were validated at restore, but safeSrc is one call — run it anyway.
      src = safeSrc(entry.src, data.activeStore().base)
      if (!src) return false
   }
   batch(() => {
      releaseOutgoing()
      let m: HTMLMediaElement
      if (live) m = live
      else {
         m = document.createElement(entry.kind === "video" ? "video" : "audio")
         m.src = src as string
         m.preload = "metadata"
         resumeRemembered(m, entry)
         el.playerMedia.replaceChildren(m)
      }
      const rate = readRate()
      if (rate !== 1) m.playbackRate = rate
      const claim: Active = {
         mid: entry.mid,
         chron: entry.chron,
         index: entry.index,
         title: entry.title,
         feedId: entry.feedId,
         media: m,
      }
      active.set(claim)
      finishClaim(m)
   })
   if (autoplay) void play()
   return true
}

// Seek a freshly built (detached) element to where FEB2 last saw this episode,
// so a half-listened queue entry resumes instead of restarting. Positions at
// the very end are ignored: onEnded hands FEB2 the finished position (time ==
// duration), and resuming there would re-end instantly and cascade the queue.
function resumeRemembered(m: HTMLMediaElement, entry: QueueEntry): void {
   const pos = deps().readPosition(entry.mid, entry.chron, entry.index)
   if (!pos || !(pos.time > 0)) return
   const apply = (): void => {
      const dur = m.duration
      if (Number.isFinite(dur) && pos.time >= dur - RESUME_END_S) return
      try {
         m.currentTime = pos.time
      } catch {}
   }
   // currentTime is only settable once metadata is known (the FEB2 pattern) —
   // and the end guard needs the duration anyway.
   if (m.readyState >= 1) apply()
   else m.addEventListener("loadedmetadata", apply, { once: true })
}

// Advance to the next playable queue entry. The outgoing active episode (if
// still claimed — onEnded releases before calling this and sets lastPlayed
// itself) becomes the prev-track target; unplayable entries are consumed and
// skipped, so the loop terminates.
export function advance(autoplay: boolean): void {
   batch(() => {
      for (let q = queue(); q.length; q = queue()) {
         const next = q[0]
         queue.set(q.slice(1))
         const a = active()
         if (a) lastPlayed = entryOf(a) ?? lastPlayed
         if (playEntry(next, autoplay)) break
      }
   })
}

// Remove one entry (the list's ✕ and swipe, a chip toggling off).
export function dropEntry(entry: QueueEntry): void {
   queue.set(queue().filter((e) => e !== entry))
}

// Play one queued entry now (a list row's play button).
export function playNow(entry: QueueEntry): void {
   batch(() => {
      dropEntry(entry)
      playEntry(entry, true) // a false return just drops the dead entry
   })
}

// Reorder one entry by one step. Returns the new index, or -1 at a dead end.
export function moveEntry(entry: QueueEntry, delta: -1 | 1): number {
   const q = queue().slice()
   const i = q.indexOf(entry)
   const j = i + delta
   if (i < 0 || j < 0 || j >= q.length) return -1
   q.splice(i, 1)
   q.splice(j, 0, entry)
   queue.set(q)
   return j
}

// The podcast convention: early in an episode "previous" means the one before;
// past PREV_RESTART_S it means "start this one over". Stepping back pushes the
// current episode onto the head of the queue, so ⏮ then ⏭ round-trips.
export function prevTrack(): void {
   const a = active()
   if (!a) return
   if (a.media.currentTime > PREV_RESTART_S || !lastPlayed) return seekTo(0)
   const prev = lastPlayed
   const cur = entryOf(a)
   batch(() => {
      if (!playEntry(prev, true)) return seekTo(0)
      lastPlayed = null
      if (cur) queue.set([cur, ...queue()])
   })
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export async function play(): Promise<void> {
   const a = active()
   if (!a) return
   try {
      await a.media.play()
   } catch {
      // Autoplay policy refused, or the source is gone. Staying paused IS the
      // correct outcome and is not a fault worth a popup.
   }
   batch(() => {
      // A refusal leaves the element paused with nothing on the way — a spinner
      // over a paused toggle would be a lie (the same rule onBufferStall applies).
      if (active()?.media.paused) buffering.set(false)
      sample()
   })
}

export function pause(): void {
   active()?.media.pause()
}

// The toggle: the READY state (nothing claimed, something queued) starts the
// head of the queue — a user gesture, so autoplay policy has nothing to refuse.
export function toggle(): void {
   const a = active()
   if (!a) {
      if (queue().length) advance(true)
      return
   }
   if (a.media.paused) void play()
   else pause()
}

export function skip(delta: number): void {
   const a = active()
   if (!a) return
   seekTo(a.media.currentTime + delta)
}

export function seekTo(t: number): void {
   const a = active()
   if (!a) return
   const m = a.media
   const max = Number.isFinite(m.duration) ? m.duration : Infinity
   try {
      m.currentTime = Math.max(0, Math.min(t, max))
   } catch {
      // currentTime is not settable before metadata; the restore path covers it.
   }
   sample()
   save()
}

export function cycleRate(): void {
   const a = active()
   if (!a) return
   const next = RATES[(RATES.indexOf(readRate()) + 1) % RATES.length] ?? 1
   lsSet(PLAYER_RATE_KEY, String(next))
   a.media.playbackRate = next
   ratePref.set(next)
}

// The ✕. Pauses, hands the position to FEB2 (so the article still resumes) and
// forgets the episode AND the queue — including the persisted entry, since
// closing is an explicit "I am done with this"; a mistapped ✕ costs re-tapping
// chips, which is cheaper than a player that will not go away.
export function close(): void {
   const a = active()
   if (!a && !queue().length) return
   const mid = a?.mid ?? data.activeStore().mid
   a?.media.pause()
   const wasAdopted = a !== null && !el.content.contains(a.media)
   lastPlayed = null
   batch(() => {
      queue.set([])
      unfolded.set(false)
      release()
      clearSaved(mid)
      if (wasAdopted) discardAdopted()
   })
}

// The title button: jump to the article that owns the episode (or, in the READY
// state, the queue head's).
export function openOwner(): void {
   const a = active() ?? queue()[0]
   if (a) deps().openArticle(a.mid, a.chron)
}

// ---------------------------------------------------------------------------
// Boot restore
// ---------------------------------------------------------------------------

// Re-claim a persisted episode, PAUSED. Never autoplays: browsers block it
// without a gesture, and audio starting by itself on a cold boot is the exact
// behaviour people disable autoplay to avoid — so this offers the episode back
// rather than resuming it.
//
// Two paths, and picking the right one is the whole subtlety (see below): when
// the episode's own article is the one reader.ts just rendered, the element is
// ALREADY in the document and gets claimed in place; only when it is not does
// the player get a detached element to hold.
//
// Runs `quietly`: restoring is not a change worth persisting — and must not be
// persisted, since a claim whose metadata has not landed reads as position 0,
// which save() treats as "never played" and would drop the head from the blob.
export function restorePersisted(): void {
   const store = data.activeStore()
   const saved = readSaved(store)
   if (!saved) return
   // The queue half first — every entry validated by readSaved (localStorage is
   // untrusted input), invalid ones dropped.
   if (saved.queue) quietly(() => queue.set(saved.queue as QueueEntry[]))
   const head = saved.head
   if (!head) {
      // No restorable active half. A queue alone still presents the player (the
      // READY state); nothing at all clears the entry, as before.
      if (!queue().length) return clearSaved(store.mid)
      return save()
   }
   const seek = (m: HTMLMediaElement): void => {
      if (head.rate !== null) m.playbackRate = head.rate
      const apply = (): void => {
         try {
            m.currentTime = head.time
         } catch {}
         sample()
      }
      // HAVE_METADATA. A live in-content element may already be past it.
      if (m.readyState >= 1) apply()
      else m.addEventListener("loadedmetadata", apply, { once: true })
   }

   // The persisted episode's OWN article may already be on screen — and that is
   // the normal case, not an exotic one: `srr-hash` restores the last reading
   // position, so someone who closed the tab mid-episode boots straight back
   // into it. reader.ts has already rendered its sanitized <audio>/<video> by
   // the time this runs, so building a second element here would give one
   // episode two transports, and the later rehomeInto would substitute the
   // synthetic node for the article's real one — dropping the
   // playsinline/poster/controls the sanitizer force-sets. Claim the element
   // that is already there instead. There is no second element.
   const at = mounted()
   if (at && at.mid === store.mid && at.chron === head.chron) {
      const live = mediaList(el.content)[head.index]
      if (live) {
         quietly(() =>
            batch(() => {
               active.set({ ...at, index: head.index, media: live })
               finishClaim(live)
            }),
         )
         seek(live)
         return
      }
   }

   // No upper bound check on the chron: the store may have been compacted or the
   // article expired since, and nav already clamps an unaddressable chron to the
   // last article. The player's own label comes from the persisted title, so a
   // stale entry costs a wrong caption on the jump target at worst.
   const m = document.createElement(head.kind)
   m.src = head.src
   m.preload = "metadata"
   el.playerMedia.replaceChildren(m)
   quietly(() =>
      batch(() => {
         active.set({
            mid: store.mid,
            chron: head.chron,
            index: head.index,
            title: head.title,
            feedId: head.feedId,
            media: m,
         })
         finishClaim(m)
      }),
   )
   seek(m)
}
