// player.ts — RDR16: the persistent mini-player.
//
// FEB2 (reader.ts) made stepping away from an article non-destructive by remembering
// media POSITIONS. This module makes it non-destructive to PLAYBACK: the episode
// keeps playing while you read something else, with a transport that follows you.
//
// The mechanism is relocation, not reconstruction. Rendering an article calls
// `el.content.replaceChildren`, which would REMOVE a playing <audio>/<video> and
// stop it dead. So just before that happens the live element is MOVED — one
// appendChild, an atomic remove+insert — into this bar's own host node. Per the
// HTML spec the "removed from a Document" steps queue a task that runs the
// internal pause steps only if the element is NOT in a document at stable state;
// an atomic move passes that check, so the audio never even hiccups. There is no
// second element, no src/currentTime handoff, and no re-buffer gap — and video
// rides the identical path, just CSS-constrained to a compact frame.
//
// TWO SEPARATE CONCERNS, deliberately not conflated:
//
//   * RELOCATION is about SURVIVAL. The element moves only when its article
//     stops being rendered, and moves back when you return to it.
//   * THE BAR is about CONTROL. It shows whenever an episode is active (or a
//     queue is waiting), whatever article is on screen — the episode's own
//     included — and its controls target the live element wherever it lives.
//     The element never relocates while its article is rendered, so it does
//     not leap out of the prose; only the bar follows you.
//
// The module imports neither `nav` nor `reader`: reader.ts imports THIS, and
// what this needs from the router arrives through PlayerDeps — the same shape
// ReaderDeps established, keeping the graph acyclic with app.ts on top. reader.ts
// also has to TELL us what is on screen (noteMounted), because the chron of the
// mounted article is its state, not ours.
import { mediaList } from "./article-view"
import * as data from "./data"
import { bindPressMenu, btn, type MenuItem } from "./dropdown"
import { el } from "./els"
import { isRelative, resolvePackRelative, stampSrc } from "./fmt"
import { AXIS_SLOP, ROW_SWIPE_TRIGGER, verticalDominant } from "./gestures"
import { PLAYER_RATE_KEY, playerStateKey } from "./keys"
import { restartAnimation } from "./motion"
import { lsSet } from "./storage"
import { URL_DENY } from "./urlish"

export interface PlayerDeps {
   // The bar's title button — jump to the article that owns the active media.
   openArticle: (mid: string, chron: number) => void
   // Hand a position back to FEB2's store (which lives in reader.ts, so this is
   // injected rather than imported). Closing the bar therefore still leaves the
   // article resumable exactly as if you had never opened the player.
   rememberPosition: (mid: string, chron: number, index: number, s: { time: number; rate: number }) => void
   // The read half of the same store: what FEB2 last saw for that element, so a
   // half-listened episode played from the QUEUE resumes instead of restarting.
   // Only the detached playEntry path consults it — a live in-content element
   // already carries its truth (restoreMediaState applied it at render).
   readPosition: (mid: string, chron: number, index: number) => { time: number; rate: number } | undefined
}

let d: PlayerDeps

// Which article reader.ts currently has mounted. The player needs the chron to
// give a claimed element an identity, and the title/feed to label the bar
// without a pack fetch.
export interface MountedArticle {
   mid: string
   chron: number
   title: string
   feedId: number
}
let mounted: MountedArticle | null = null

// The claimed episode. `index` is the element's position among the article's
// "audio,video" elements — the same positional identity FEB2 pairs on, because
// the same immutable article always renders the same media in the same order
// (src would break on a re-proxied or re-resolved URL).
interface Active extends MountedArticle {
   index: number
   media: HTMLMediaElement
   // One retry per claim: set by the first `error`, so the second one takes the
   // dismissal path. Fresh claims build fresh Active objects, which resets it.
   retried?: boolean
}
let active: Active | null = null

// The "up next" queue — strictly what plays AFTER the active episode, which is
// never itself a member (playing an entry consumes it, manual claims included).
// Entries carry everything needed to play with zero pack fetches: the Persisted
// shape plus mid, because a queue outlives navigation and may hold episodes of
// articles that are no longer rendered anywhere.
interface QueueEntry {
   mid: string
   chron: number
   index: number
   src: string
   kind: "audio" | "video"
   title: string
   feedId: number
}
let queue: QueueEntry[] = []
// One-deep history for the lock screen's previoustrack (the podcast convention:
// early in an episode, "previous" means the one before). Deliberately not a
// full history — a reader's queue is a to-listen list, not a DJ deck.
let lastPlayed: QueueEntry | null = null
const QUEUE_MAX = 50
// previoustrack past this many seconds restarts the episode instead.
const PREV_RESTART_S = 3

// Whether the active episode is stalled waiting on the network. Between play()
// and audio actually flowing the bar otherwise looks frozen — the "is it
// broken?" moment on a slow connection. Rendered as a spinner on the toggle.
let buffering = false

// Whether the bar is UNFOLDED. It starts folded — just the corner button that
// says something is playing — and only the button unfolds it: the transport is
// there when asked for, not whenever an episode leaves the screen. Deliberately
// not persisted: every boot starts minimal, and ✕ folds it again for the next
// episode.
let unfolded = false

// The speed ladder the rate button cycles. 1 is first so the cycle returns to
// normal rather than dead-ending at 2x.
const RATES = [1, 1.25, 1.5, 2]

const SKIP_SECONDS = 15
// timeupdate fires ~4x/second; persisting that often would write ~14k times an
// hour for a value nobody reads until the next boot.
const SAVE_INTERVAL_MS = 5000
let lastSave = 0
// The beat before an error retry reloads: an immediate reload would land inside
// the same network blip that caused the error.
const RETRY_DELAY_MS = 2000
let retryTimer = 0

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// What survives a reload. `src`/`kind`/`title`/`feedId` ride along so the bar can
// render at boot with ZERO pack fetches, preserving the reader's O(1) boot.
// A blob may be active-only (pre-playlist builds wrote just that), active+queue,
// or queue-only (`{queue}` with no src field at all) — restore treats the two
// halves independently. Queue entries drop `mid`: it is implicit in the storage
// key, which is per-mount exactly because chron is only unique within a mount.
interface Persisted {
   chron: number
   index: number
   time: number
   rate: number
   src: string
   kind: "audio" | "video"
   title: string
   feedId: number
   queue?: Omit<QueueEntry, "mid">[]
}

function readRate(): number {
   const raw = Number(localStorage.getItem(PLAYER_RATE_KEY))
   // Only a value actually on the ladder is honoured — a hand-edited 0 or NaN
   // would otherwise freeze or crash playback.
   return RATES.includes(raw) ? raw : 1
}

function save(): void {
   // The key follows the active episode's store, falling back to the mounted
   // store for a queue with nothing playing. Entries of another mount stay
   // in-memory only — a documented non-goal, not an accident.
   const mid = active?.mid ?? data.activeStore().mid
   const qlist = queue
      .filter((e) => e.mid === mid)
      .map((e) => ({ chron: e.chron, index: e.index, src: e.src, kind: e.kind, title: e.title, feedId: e.feedId }))
   let head: Omit<Persisted, "queue"> | null = null
   if (active) {
      const m = active.media
      head = {
         chron: active.chron,
         index: active.index,
         time: m.currentTime,
         rate: m.playbackRate,
         src: m.getAttribute("src") ?? "",
         kind: m.tagName === "VIDEO" ? "video" : "audio",
         title: active.title,
         feedId: active.feedId,
      }
      // A position of 0 is indistinguishable from "never played", and `src` is
      // what makes the entry restorable at all.
      if (!head.src || head.time <= 0) head = null
   }
   if (!head && !qlist.length) return clearSaved(mid)
   const state = { ...(head ?? {}), ...(qlist.length ? { queue: qlist } : {}) }
   // A full or blocked localStorage must never break playback — lsSet swallows.
   lsSet(playerStateKey(mid), JSON.stringify(state))
   lastSave = Date.now()
}

function clearSaved(mid: string): void {
   lsSet(playerStateKey(mid), null)
}

// The persisted `src` comes back from localStorage, which makes it UNTRUSTED
// input on a path that ends in an assignment the browser will fetch. It gets the
// same treatment article content gets in fmt.ts: never a javascript:/data:/
// vbscript:/file: scheme, and a relative key must resolve INSIDE the store base
// (a "//host" or "../" escape is an info-leak vector, exactly as it is in
// sanitizeFragment's bounds check).
function safeSrc(raw: string, base: URL): string | null {
   if (!raw || URL_DENY.test(raw)) return null
   let u: URL
   try {
      u = new URL(raw, base)
   } catch {
      return null
   }
   if (u.protocol !== "http:" && u.protocol !== "https:") return null
   // An absolute http(s) media URL is whatever the feed carried — same trust
   // level as any <audio src> the sanitizer already lets through. A RELATIVE one
   // names a store object, so it must stay within the store.
   //
   // Both halves come from fmt.ts rather than being restated here, because the
   // restatement had already drifted on the case that matters: it excluded a
   // protocol-relative "//host" from `isRelative` and so skipped the bounds
   // check entirely, returning a foreign origin verbatim — where fmt counts
   // "//host" as relative precisely SO the bounds check drops it. That is the
   // one shape this function exists to catch, since its input is the untrusted
   // srr-player localStorage blob.
   if (isRelative(raw) && resolvePackRelative(raw, base) === null) return null
   return u.href
}

// ---------------------------------------------------------------------------
// Media Session — lock screen / notification transport
// ---------------------------------------------------------------------------

// Deliberately NO previoustrack/nexttrack handlers. Mapping those to prev/next
// ARTICLE would turn the lock screen into a navigation surface and skip the
// listener out of the episode they are in the middle of; leaving them unset lets
// the platform grey them out, which is the honest answer.
function syncMediaSession(): void {
   const ms = navigator.mediaSession
   if (!ms) return
   if (!active) {
      ms.metadata = null
      ms.playbackState = "none"
      return
   }
   if (typeof MediaMetadata === "function") {
      ms.metadata = new MediaMetadata({
         title: entryLabel(active.title),
         artist: data.feedTitle(active.feedId),
         album: "SRR",
      })
   }
   ms.playbackState = active.media.paused ? "paused" : "playing"
}

function bindMediaSession(): void {
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
         if (active && typeof e.seekTime === "number") seekTo(e.seekTime)
      })
   } catch {}
}

// ---------------------------------------------------------------------------
// Claim / release
// ---------------------------------------------------------------------------

// The GIF idiom: #embed and srr-x emit muted+loop+autoplay <video> for what
// used to be a GIF, and fmt.ts deliberately leaves those chrome-less. One
// predicate for the transport claim (onPlay) AND chip eligibility
// (injectQueueChips) — a decoration that can't claim must also not get a chip.
function isGifIdiom(m: HTMLMediaElement): boolean {
   return m.autoplay || (m.muted && m.loop)
}

// The player controls its QUEUE and nothing else (user call 2026-09-23): an
// in-article element played directly stays the article's own — native controls,
// no bar, and it stops when its article leaves the screen, as any page media
// does. What a `play` event CAN still claim is an element whose episode is
// queued: pressing play on it is "play that one from the playlist now".
// `play` does not bubble, but non-bubbling events still traverse the CAPTURE
// phase — the same property fmt.ts's collapseBrokenMedia relies on for
// `error` — so one capture listener on the document sees every media element.
function onPlay(e: Event): void {
   const m = e.target
   if (!(m instanceof HTMLMediaElement)) return
   if (active && active.media === m) {
      // Re-play of the episode we already own: nothing to re-derive.
      pauseOthers(m)
      syncMediaSession()
      return syncBar()
   }
   // The GIF idiom fires `play` on its own the moment it renders, so it must
   // neither claim nor silence anything — a decoration is not a second voice.
   if (isGifIdiom(m)) return
   const index = mounted && el.content.contains(m) ? mediaList(el.content).indexOf(m) : -1
   if (!mounted || index < 0 || queuePos(mounted.mid, mounted.chron, index) < 0) {
      // Outside media: not ours to control, but one thing audible at a time —
      // the episode steps aside (paused, still claimed, one tap to resume).
      if (active && !active.media.paused) active.media.pause()
      return
   }
   releaseOutgoing()
   active = { ...mounted, index, media: m }
   pauseOthers(m)
   // The claimed entry is now the active episode; leaving it queued would
   // replay it later.
   dropQueued(mounted.mid, mounted.chron, index)
   const rate = readRate()
   // Apply the device's standing speed preference, but only when it was actually
   // set: at the default 1 we leave the element alone so a rate FEB2 restored
   // (or one set through native in-content controls) is not silently reset.
   if (rate !== 1) m.playbackRate = rate
   finishClaim(m)
}

// The other half of "one thing audible at a time": the episode starting pauses
// any outside media still playing (never the GIF idiom — decorations loop on).
function pauseOthers(m: HTMLMediaElement): void {
   for (const o of document.querySelectorAll<HTMLMediaElement>("audio, video"))
      if (o !== m && !o.paused && !isGifIdiom(o)) o.pause()
}

// One episode at a time — the module's central invariant, in one place. Hand the
// outgoing episode's position back to FEB2, and if it was ADOPTED take it out of
// the bar host too: release() deliberately never touches parents, so without this
// the old node would stay there still playing, inaudibly orphaned behind the new
// episode's chrome (two things playing at once).
function releaseOutgoing(): void {
   const outgoingAdopted = active !== null && !el.content.contains(active.media)
   release()
   if (outgoingAdopted) discardAdopted()
}

// The tail every claim ends with, whatever route reached it (a manual in-content
// play, a queue entry, a boot restore in place or detached). `active` must
// already be assigned: save() reads it.
function finishClaim(m: HTMLMediaElement): void {
   bindMedia(m)
   bindMediaSession()
   syncMediaSession()
   syncBar()
}

// Give the current position back to FEB2 and drop every hook. Does NOT touch the
// element's parent: whoever calls this decides whether the node goes home, stays
// in the bar, or is discarded.
function release(): void {
   if (!active) return
   const m = active.media
   d.rememberPosition(active.mid, active.chron, active.index, {
      time: m.currentTime,
      rate: m.playbackRate,
   })
   unbindMedia(m)
   active = null
   buffering = false
   if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = 0
   }
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
   ["loadedmetadata", syncBar],
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
   syncTime()
   if (Date.now() - lastSave >= SAVE_INTERVAL_MS) save()
}

function onPauseOrPlay(): void {
   // A pause drops any spinner: the wait is over because nobody is waiting.
   if (active?.media.paused) buffering = false
   save()
   syncMediaSession()
   syncBar()
}

// `waiting` = playback stopped for data; `stalled` = the fetch went quiet. Both
// only matter while something is actually trying to play — a preload hiccup on
// a paused element must not spin the bar.
function onBufferStall(): void {
   if (!active || active.media.paused) return
   buffering = true
   syncBar()
}

function onBufferClear(): void {
   if (!buffering) return
   buffering = false
   syncBar()
}

// The shared dismissal tail of ended/error: forget the episode wholesale —
// release the claim, drop its persisted entry, take an adopted node out of the
// bar — then either advance the playlist or clear the chrome. One body, because
// the release/clearSaved/discardAdopted ordering is load-bearing (release reads
// active; discard only after the claim is gone).
function dismissActive(): void {
   const mid = active?.mid
   release()
   if (mid) clearSaved(mid)
   discardAdopted()
   if (queue.length) return advance(true)
   syncMediaSession()
   syncBar()
}

function onEnded(): void {
   // A finished episode has nothing left to resume; drop it wholesale rather
   // than leaving a bar parked at the end — unless something is queued, in
   // which case finishing is exactly when the playlist advances, with the
   // finished episode as the prev-track target.
   if (queue.length) lastPlayed = active ? entryOf(active) : null
   dismissActive()
}

function onError(): void {
   // One retry before giving up: a transient network blip mid-commute must not
   // end a 90-minute episode. The first error keeps the claim and retries the
   // SAME element in place — reload after a beat, reseek at metadata, resume if
   // it was playing. The second error falls through to the dismissal below.
   if (active && !active.retried) {
      const a = active
      const m = a.media
      a.retried = true
      const t = m.currentTime
      const wasPlaying = !m.paused
      if (wasPlaying) {
         // The bar reads as "working on it", not frozen — the same spinner a
         // plain stall shows. A paused element waits silently.
         buffering = true
         syncBar()
      }
      retryTimer = window.setTimeout(() => {
         retryTimer = 0
         if (active !== a) return
         m.addEventListener(
            "loadedmetadata",
            () => {
               if (active !== a) return
               if (t > 0) {
                  try {
                     m.currentTime = t
                  } catch {}
               }
               // collapseBrokenMedia hid an in-content <video> on the same
               // error event; a working retry earns the frame back.
               m.classList.remove("srr-broken")
               if (wasPlaying) void play()
               syncBar()
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
// Playlist — the "up next" queue
// ---------------------------------------------------------------------------

// Snapshot the active episode as a queue entry (the prev-track target, and the
// re-queue when previoustrack steps back). Null when the element carries no src
// attribute to rebuild from — the same reason save() refuses to persist one.
function entryOf(a: Active): QueueEntry | null {
   const src = a.media.getAttribute("src") ?? ""
   if (!src) return null
   return {
      mid: a.mid,
      chron: a.chron,
      index: a.index,
      src,
      kind: a.media.tagName === "VIDEO" ? "video" : "audio",
      title: a.title,
      feedId: a.feedId,
   }
}

function dropQueued(mid: string, chron: number, index: number): void {
   const n = queue.length
   queue = queue.filter((e) => !(e.mid === mid && e.chron === chron && e.index === index))
   if (queue.length !== n) afterQueueChange()
}

// Every queue mutation funnels here: the chips, the lock-screen buttons, the
// Up next list, its count and the persisted blob must all tell one story.
function afterQueueChange(): void {
   syncChips()
   syncQueueHandlers()
   renderList()
   save()
   syncBar()
}

// Play a specific entry NOW. Claims the on-screen element when the entry's own
// article is the mounted one (the restorePersisted live path — no second
// element, no re-buffer); otherwise builds a detached element in the bar host
// (the boot-restore detached path). Returns false — with the current episode
// untouched — when the entry is unplayable, so advance() can skip it.
function playEntry(entry: QueueEntry, autoplay: boolean): boolean {
   const live =
      mounted && mounted.mid === entry.mid && mounted.chron === entry.chron
         ? mediaList(el.content)[entry.index]
         : undefined
   let src: string | null = null
   if (!live) {
      // In-session captures came off a sanitized element and persisted ones
      // were validated at restore, but safeSrc is one call — run it anyway.
      src = safeSrc(entry.src, data.activeStore().base)
      if (!src) return false
   }
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
   active = {
      mid: entry.mid,
      chron: entry.chron,
      index: entry.index,
      title: entry.title,
      feedId: entry.feedId,
      media: m,
   }
   finishClaim(m)
   if (autoplay) void play()
   return true
}

// A remembered position this close to the end reads as "finished" — start over.
const RESUME_END_S = 2

// Seek a freshly built (detached) element to where FEB2 last saw this episode,
// so a half-listened queue entry resumes instead of restarting. Positions at
// the very end are ignored: onEnded hands FEB2 the finished position (time ==
// duration), and resuming there would re-end instantly and cascade the queue.
function resumeRemembered(m: HTMLMediaElement, entry: QueueEntry): void {
   const pos = d.readPosition(entry.mid, entry.chron, entry.index)
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
function advance(autoplay: boolean): void {
   for (let next = queue.shift(); next; next = queue.shift()) {
      if (active) lastPlayed = entryOf(active) ?? lastPlayed
      if (playEntry(next, autoplay)) break
   }
   afterQueueChange()
}

// The podcast convention: early in an episode "previous" means the one before;
// past PREV_RESTART_S it means "start this one over". Stepping back pushes the
// current episode onto the head of the queue, so ⏮ then ⏭ round-trips.
function prevTrack(): void {
   if (!active) return
   if (active.media.currentTime > PREV_RESTART_S || !lastPlayed) return seekTo(0)
   const prev = lastPlayed
   const cur = entryOf(active)
   if (!playEntry(prev, true)) return seekTo(0)
   lastPlayed = null
   if (cur) queue.unshift(cur)
   afterQueueChange()
}

// The lock screen gains real track buttons ONLY while a queue exists — with
// one, nexttrack/previoustrack step QUEUE items; without one they stay unset so
// the platform greys them out (RDR16's original rule stands: they must never
// map to prev/next ARTICLE and skip the listener out of an episode).
function syncQueueHandlers(): void {
   const ms = navigator.mediaSession
   if (!ms) return
   try {
      ms.setActionHandler("nexttrack", queue.length ? () => advance(true) : null)
   } catch {}
   try {
      ms.setActionHandler("previoustrack", queue.length ? prevTrack : null)
   } catch {}
}

// ---------------------------------------------------------------------------
// Queue chips — the in-content add affordance
// ---------------------------------------------------------------------------

// The queue's display name for an entry. Spelled six times before this, five of
// them inside renderPanel/moveBtn alone.
const entryLabel = (title: string): string => title || "(untitled)"

function queuePos(mid: string, chron: number, index: number): number {
   return queue.findIndex((e) => e.mid === mid && e.chron === chron && e.index === index)
}

// One chip, a glyph vocabulary: "+" add, the entry's 1-based queue POSITION
// while queued (every chip re-derives after every queue mutation via syncChips,
// so the numeral can never lie), and "≡" when the queue is full — the door
// state: toggleQueued unfolds the player (its Up next list) to prune instead of dead-ending, so the
// cap never reads as a broken button. aria-pressed stays the toggle truth.
function setChipState(chip: HTMLButtonElement, pos: number): void {
   const door = pos < 0 && queue.length >= QUEUE_MAX
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

// play/pause don't bubble (the onPlay rule), so the offstage sync rides its own
// capture-phase pair instead of per-element listeners a re-render would re-bind.
function onMediaStateForChips(e: Event): void {
   const t = e.target
   if (!(t instanceof HTMLMediaElement) || t.tagName !== "VIDEO") return
   const sib = t.nextElementSibling
   if (sib instanceof HTMLElement && sib.classList.contains("srr-queue-chip")) syncChipOffstage(t, sib)
}

function pulseOnce(n: Element | null): void {
   if (n instanceof HTMLElement) restartAnimation(n, "srr-chip-pop")
}

// The chip's long-press menu — the power layer over the tap (append): "Play
// next" puts the enclosure at the HEAD of the queue (the podcast verb the
// list's reorder arrows only reach one step at a time; a queued entry MOVES,
// never duplicates), "Play now" does the same and then advances onto it at
// once — through the QUEUE, since the player plays nothing else; the entry is
// consumed on the same tick, so it never grows the queue and stays the door
// state's escape hatch at the cap. Items derive
// at open and RE-CHECK at action: showContextMenu outlives this tick, and an
// auto-advance or a navigation can move the queue (or the article) under an
// open menu.
function chipMenuItems(index: number): MenuItem[] {
   if (!mounted) return []
   const m = mediaList(el.content)[index]
   if (!m?.getAttribute("src")) return []
   const { mid, chron, title, feedId } = mounted
   const stale = (): boolean => !mounted || mounted.mid !== mid || mounted.chron !== chron
   // Put the enclosure at the queue's head (a queued one MOVES). `now` lets
   // it past the cap: advance() consumes it on the same tick.
   const toHead = (now: boolean): { media: HTMLMediaElement; added: boolean } | null => {
      if (stale()) return null
      const media = mediaList(el.content)[index]
      const src = media?.getAttribute("src") ?? ""
      if (!src) return null
      const pos = queuePos(mid, chron, index)
      if (pos < 0 && queue.length >= QUEUE_MAX && !now) return null
      if (pos >= 0) queue.splice(pos, 1)
      queue.unshift({ mid, chron, index, src, kind: media.tagName === "VIDEO" ? "video" : "audio", title, feedId })
      return { media, added: pos < 0 }
   }
   return [
      {
         label: "Play next",
         // A NEW head entry would breach the cap; a queued one just moves.
         disabled: queuePos(mid, chron, index) < 0 && queue.length >= QUEUE_MAX,
         action: () => {
            const r = toHead(false)
            if (!r) return
            afterQueueChange()
            if (startIfIdle()) return
            pulseOnce(r.media.nextElementSibling)
            if (r.added) pulseOnce(unfolded ? el.playerCount : el.playerFab)
         },
      },
      {
         label: "Play now",
         action: () => {
            if (toHead(true)) advance(true)
         },
      },
   ]
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
   if (!mounted) return
   const { mid, chron } = mounted
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

// Re-derive every rendered chip after a queue mutation (a list removal, a
// consume-on-play, ✕) so a pressed state never lies about membership.
function syncChips(): void {
   if (!mounted) return
   const { mid, chron } = mounted
   const list = mediaList(el.content)
   for (let i = 0; i < list.length; i++) {
      const sib = list[i].nextElementSibling
      if (sib instanceof HTMLButtonElement && sib.classList.contains("srr-queue-chip"))
         setChipState(sib, queuePos(mid, chron, i))
   }
}

// The FIRST entry into an idle player starts playing it (user call
// 2026-09-23): with nothing claimed and the queue just gone from empty to one,
// the add IS the "play this". The tap is a user gesture, so autoplay policy has
// nothing to refuse. Anything added behind an episode (active or already
// queued, e.g. a READY queue restored at boot) just waits its turn.
function startIfIdle(): boolean {
   if (active || queue.length !== 1) return false
   advance(true)
   return true
}

function toggleQueued(index: number): void {
   if (!mounted) return
   const { mid, chron, title, feedId } = mounted
   if (queuePos(mid, chron, index) >= 0) return dropQueued(mid, chron, index)
   // The cap as a DOOR: a full queue unfolds the player, whose Up next list
   // is where to prune, instead of silently eating the tap (the chip already
   // reads ≡ / "Playlist full").
   if (queue.length >= QUEUE_MAX) return setUnfolded(true)
   const m = mediaList(el.content)[index]
   const src = m?.getAttribute("src") ?? ""
   if (!src) return
   queue.push({ mid, chron, index, src, kind: m.tagName === "VIDEO" ? "video" : "audio", title, feedId })
   afterQueueChange()
   if (startIfIdle()) return
   // Feedback at both ends of the gesture: the chip pops under the finger, and
   // where the episode went pulses — the Up next count, or the fold button.
   pulseOnce(m.nextElementSibling)
   pulseOnce(unfolded ? el.playerCount : el.playerFab)
}

// ---------------------------------------------------------------------------
// Up next list
// ---------------------------------------------------------------------------

// The Up next list is part of the full player, always rendered (not a popover):
// the queue is the player's whole subject, so it is never one tap away.
function renderList(): void {
   el.playerCount.textContent = queue.length ? String(queue.length) : ""
   el.playerEmpty.hidden = queue.length > 0
   el.playerList.replaceChildren(
      ...queue.map((entry, i) => {
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
            queue = queue.filter((e) => e !== entry)
            playEntry(entry, true) // a false return just drops the dead entry
            afterQueueChange()
            el.playerToggle.focus()
         })
         const remove = btn("srr-player-row-remove", `Remove from playlist — ${entryLabel(entry.title)}`, "×", () => {
            queue = queue.filter((e) => e !== entry)
            afterQueueChange()
         })
         row.append(play, moveBtn(entry, -1, i === 0), moveBtn(entry, 1, i === queue.length - 1), remove)
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
   const i = queue.indexOf(entry)
   const j = i + delta
   if (i < 0 || j < 0 || j >= queue.length) return
   queue.splice(i, 1)
   queue.splice(j, 0, entry)
   afterQueueChange()
   // The list just re-rendered under the press: keep the keyboard on the row
   // that moved — the same-direction handle so repeated presses keep walking,
   // its opposite when the row just hit a dead end.
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
      if (Math.abs(dx) >= ROW_SWIPE_TRIGGER) {
         queue = queue.filter((e) => e !== entry)
         return afterQueueChange()
      }
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

// Fold / unfold the full player. Folding with focus inside hands it to the
// fold button, so the keyboard never lands on a now-invisible control.
function setUnfolded(open: boolean): void {
   if (unfolded === open) return
   unfolded = open
   const f = document.activeElement
   if (!open && f && f !== el.playerFab && el.player.contains(f)) el.playerFab.focus()
   syncBar()
}

// ---------------------------------------------------------------------------
// Relocation — the reader.ts seam
// ---------------------------------------------------------------------------

// reader.ts tells us which article is on screen. Called with null for the empty
// states, whose content host holds reader chrome rather than an article.
export function noteMounted(info: MountedArticle | null): void {
   mounted = info
}

// Called by reader.ts BEFORE replaceChildren and AFTER harvestMediaState.
//
// The ordering is load-bearing and not recoverable from either function alone:
// FEB2 pairs its saved state to elements BY INDEX over querySelectorAll, so
// moving the live element out first would shift every index after it and
// misalign the whole article's saved positions.
export function adoptFromContent(): void {
   if (!active || !el.content.contains(active.media)) return
   const m = active.media
   // One appendChild = remove + insert in a single synchronous operation, so the
   // spec's "not in a document at stable state" pause check never fires. This is
   // the line the whole feature rests on.
   el.playerMedia.appendChild(m)
   // Custom chrome drives it in the bar; fmt.ts's forced `controls` would render
   // a full native widget inside a 3rem-tall strip.
   m.removeAttribute("controls")
   syncBar()
}

// Called by reader.ts AFTER replaceChildren and restoreMediaState. Swaps the live
// element back in for the freshly parsed one at the same index — the fresh
// element's just-restored position is discarded, because the live element is the
// one carrying the truth.
export function rehomeInto(mid: string, chron: number): void {
   if (!active || active.mid !== mid || active.chron !== chron) return
   if (el.content.contains(active.media)) return
   const fresh = mediaList(el.content)[active.index]
   // The article no longer renders media at that index (a compacted payload, a
   // changed pipeline). Keep playing in the bar rather than dropping the episode.
   if (!fresh) return
   // replaceWith moves the live element in and takes the fresh one out; the live
   // element is in the document throughout, so playback continues. It stays this
   // way round even though `fresh` is the authoritative sanitized node: by now
   // the live element may be PLAYING (the bar has a play button, and restore
   // hands the episode back paused), and handing playback to `fresh` would
   // reintroduce the re-buffer gap this module exists to avoid.
   fresh.replaceWith(active.media)
   // So carry the sanitizer's presentation attributes across instead. On the
   // claimed-element path this is a no-op — same node, same attributes — but the
   // restore path's element was built by us and has none of them: fmt.ts forces
   // `controls` on in-content audio (a control-less feed <audio> renders no
   // player at all) and `playsinline` on non-autoplay video, without which iOS
   // takes a returning episode fullscreen, plus whatever `poster` the feed
   // carried. Only attributes the live element LACKS are copied, which is what
   // keeps `src` — already set, and re-setting it would restart the load.
   for (const a of fresh.attributes) {
      if (!active.media.hasAttribute(a.name)) active.media.setAttribute(a.name, a.value)
   }
   active.media.setAttribute("controls", "")
   syncBar()
}

// Drop an adopted node from the bar. Only ever called for a released episode —
// the element is not going home, so nothing else can reach it.
function discardAdopted(): void {
   const held = el.playerMedia.firstElementChild
   if (held instanceof HTMLMediaElement) {
      held.pause()
      held.remove()
   }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function play(): Promise<void> {
   if (!active) return
   try {
      await active.media.play()
   } catch {
      // Autoplay policy refused, or the source is gone. Staying paused IS the
      // correct outcome and is not a fault worth a popup.
   }
   // A refusal leaves the element paused with nothing on the way — a spinner
   // over a paused bar would be a lie (the same rule onBufferStall applies).
   if (active?.media.paused) buffering = false
   syncMediaSession()
   syncBar()
}

function pause(): void {
   active?.media.pause()
}

function skip(delta: number): void {
   if (!active) return
   seekTo(active.media.currentTime + delta)
}

function seekTo(t: number): void {
   if (!active) return
   const m = active.media
   const max = Number.isFinite(m.duration) ? m.duration : Infinity
   try {
      m.currentTime = Math.max(0, Math.min(t, max))
   } catch {
      // currentTime is not settable before metadata; the restore path covers it.
   }
   syncTime()
   save()
}

function cycleRate(): void {
   if (!active) return
   const next = RATES[(RATES.indexOf(readRate()) + 1) % RATES.length] ?? 1
   lsSet(PLAYER_RATE_KEY, String(next))
   active.media.playbackRate = next
   save()
   syncBar()
}

// The ✕. Pauses, hands the position to FEB2 (so the article still resumes) and
// forgets the episode AND the queue — including the persisted entry, since
// closing is an explicit "I am done with this"; a mistapped ✕ costs re-tapping
// chips, which is cheaper than a bar that will not go away.
function close(): void {
   if (!active && !queue.length) return
   const mid = active?.mid ?? data.activeStore().mid
   active?.media.pause()
   const wasAdopted = active !== null && !el.content.contains(active.media)
   queue = []
   lastPlayed = null
   unfolded = false
   release()
   clearSaved(mid)
   if (wasAdopted) discardAdopted()
   syncChips()
   syncQueueHandlers()
   syncMediaSession()
   syncBar()
}

// ---------------------------------------------------------------------------
// Rendering
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

function syncTime(): void {
   if (!active) return
   const m = active.media
   const dur = m.duration
   el.playerTime.textContent = clock(m.currentTime)
   el.playerDuration.textContent = Number.isFinite(dur) ? clock(dur) : ""
   const pct = Number.isFinite(dur) && dur > 0 ? (m.currentTime / dur) * 100 : 0
   el.playerSeekFill.style.width = `${pct}%`
   el.playerSeek.setAttribute("aria-valuemax", String(Number.isFinite(dur) ? Math.floor(dur) : 0))
   el.playerSeek.setAttribute("aria-valuenow", String(Math.floor(m.currentTime)))
   el.playerSeek.setAttribute("aria-valuetext", clock(m.currentTime))
}

// The bar is shown whenever there IS an episode — whatever article is on screen,
// the episode's own included (user call 2026-09-23: the player ignores what you
// are reading; it used to hide while its element was on screen and in view).
// With nothing claimed but a queue built up, it shows in the READY state instead
// — a queue must be visible to be usable at all, and ✕ is how it goes away.
function barVisible(): boolean {
   return active !== null || queue.length > 0
}

// The bar's identity/transport controls, one painter for both bar states: the
// READY state is exactly the active state at paused = true — same writes, only
// the value source differs (queue head vs the claimed track).
function paintBar(kind: "audio" | "video", feedId: number, title: string, paused: boolean): void {
   el.player.dataset.kind = kind
   stampSrc(el.player, feedId)
   el.playerSource.textContent = data.feedTitle(feedId)
   el.playerName.textContent = entryLabel(title)
   el.playerTitle.setAttribute("aria-label", `Go to ${title || "this article"} — ${data.feedTitle(feedId)}`)
   el.playerToggle.setAttribute("aria-label", paused ? "Play" : "Pause")
   el.playerToggle.setAttribute("aria-pressed", String(!paused))
   el.playerToggle.classList.toggle("srr-player-playing", !paused)
   // The folded button's bars move while it plays — the one signal left when
   // the transport itself is folded away.
   el.player.classList.toggle("srr-player-on", !paused)
   const rate = readRate()
   el.playerRate.textContent = `${rate}×`
   el.playerRate.setAttribute("aria-label", `Playback speed — ${rate}×`)
}

function syncBar(): void {
   const show = barVisible()
   el.player.hidden = !show
   // Drives the container's bottom padding so the last paragraph clears the bar.
   document.body.classList.toggle("srr-playing", show)
   // Folded is a class, never the `hidden` attribute: the bar may be holding a
   // relocated <video>, which must stay rendered (see .srr-player-media).
   el.player.classList.toggle("srr-player-folded", !unfolded)
   el.playerFab.setAttribute("aria-expanded", String(unfolded))
   const fabLabel = unfolded ? "Hide player" : "Show player"
   el.playerFab.setAttribute("aria-label", fabLabel)
   el.playerFab.title = fabLabel
   // The buffering spinner replaces the toggle glyph; aria-busy is the same
   // state for assistive tech (the accessible name stays Play/Pause).
   const stalled = buffering && active !== null
   el.playerToggle.classList.toggle("srr-player-buffering", stalled)
   el.playerToggle.setAttribute("aria-busy", String(stalled))
   // » needs something to skip to (the Up next list keeps itself in step
   // through afterQueueChange).
   el.playerNext.hidden = !queue.length
   if (!active) {
      if (!queue.length) return
      // READY state: nothing claimed, something queued. The bar presents the
      // head of the queue behind a play button — the visible result of the
      // first chip tap, without autoplay and without secretly claiming an
      // element the user can already see in the article.
      const q0 = queue[0]
      paintBar(q0.kind, q0.feedId, q0.title, true)
      el.playerTime.textContent = ""
      el.playerDuration.textContent = ""
      el.playerSeekFill.style.width = "0%"
      return
   }
   paintBar(active.media.tagName === "VIDEO" ? "video" : "audio", active.feedId, active.title, active.media.paused)
   syncTime()
}

// ---------------------------------------------------------------------------
// Seek interaction
// ---------------------------------------------------------------------------

// The seek rail's box, captured at pointerdown and held for the drag. The rail is
// fixed chrome that cannot move while a finger is down, and measuring it per
// pointermove — interleaved with syncTime's width write on the fill — forced a
// layout on every move of the scrub.
let seekRect: DOMRect | null = null

function seekFromPointer(e: PointerEvent): void {
   if (!active) return
   const dur = active.media.duration
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
   // being scrubbed. This is the keyboard half of the guard gestures.ts
   // already installs for touch (`.srr-player` stops touchstart, or a scrub
   // reads as a prev/next swipe). ArrowUp/ArrowDown are in the step set for
   // the same reason AND for the ARIA slider pattern, which expects them to
   // step the value — unhandled, they fell through to the filter cycle.
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
// Boot
// ---------------------------------------------------------------------------

export function setup(deps: PlayerDeps): void {
   d = deps
   // Capture phase: `play` does not bubble (see onPlay).
   document.addEventListener("play", onPlay, { capture: true })
   // The video corner chip's offstage sync (same capture rule, its own pair).
   document.addEventListener("play", onMediaStateForChips, { capture: true })
   document.addEventListener("pause", onMediaStateForChips, { capture: true })
   el.playerToggle.addEventListener("click", () => {
      if (!active) {
         // READY state: the play button starts the head of the queue — a user
         // gesture, so autoplay policy has nothing to refuse.
         if (queue.length) advance(true)
         return
      }
      if (active.media.paused) void play()
      else pause()
   })
   el.playerBack15.addEventListener("click", () => skip(-SKIP_SECONDS))
   el.playerFwd15.addEventListener("click", () => skip(SKIP_SECONDS))
   el.playerRate.addEventListener("click", cycleRate)
   el.playerClose.addEventListener("click", close)
   el.playerTitle.addEventListener("click", () => {
      if (active) d.openArticle(active.mid, active.chron)
      else if (queue.length) d.openArticle(queue[0].mid, queue[0].chron)
   })
   el.playerNext.addEventListener("click", () => advance(true))
   el.playerFab.addEventListener("click", () => setUnfolded(!unfolded))
   // Escape folds the unfolded player — and is claimed, so it does not also
   // drop the reader to the list. Every other key still reaches the global
   // keymap: the player is a control you read beside, not a modal (a modal
   // owns every key — lightbox.ts — a control only its own).
   el.player.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !unfolded) return
      e.preventDefault()
      e.stopPropagation()
      setUnfolded(false)
   })
   renderList()
   bindSeek()
   // A reload is the one exit we can still write through.
   window.addEventListener("pagehide", save)
   syncBar()
}

// Re-claim a persisted episode, PAUSED. Never autoplays: browsers block it
// without a gesture, and audio starting by itself on a cold boot is the exact
// behaviour people disable autoplay to avoid — so this offers the episode back
// rather than resuming it.
//
// Two paths, and picking the right one is the whole subtlety (see below): when
// the episode's own article is the one reader.ts just rendered, the element is
// ALREADY in the document and gets claimed in place (no bar — you can see it);
// only when it is not does the bar get a detached element to hold.
export function restorePersisted(): void {
   const store = data.activeStore()
   let saved: Persisted
   try {
      const raw = localStorage.getItem(playerStateKey(store.mid))
      if (!raw) return
      saved = JSON.parse(raw) as Persisted
   } catch {
      return
   }
   // The queue half first — every entry validated exactly like the active src
   // below (localStorage is untrusted input), invalid ones dropped. Boot renders
   // the article before this runs, so the chips need a re-derive.
   if (Array.isArray(saved.queue)) {
      queue = saved.queue
         .filter(
            (e) =>
               !!e &&
               typeof e.src === "string" &&
               safeSrc(e.src, store.base) !== null &&
               typeof e.chron === "number" &&
               e.chron >= 0 &&
               typeof e.index === "number" &&
               e.index >= 0 &&
               (e.kind === "audio" || e.kind === "video"),
         )
         .slice(0, QUEUE_MAX)
         .map((e) => ({
            mid: store.mid,
            chron: e.chron,
            index: e.index,
            src: e.src,
            kind: e.kind,
            title: typeof e.title === "string" ? e.title : "",
            feedId: typeof e.feedId === "number" ? e.feedId : 0,
         }))
      syncChips()
      syncQueueHandlers()
      renderList()
   }
   const src = typeof saved.src === "string" ? safeSrc(saved.src, store.base) : null
   if (!src || !(saved.chron >= 0) || !(saved.time > 0)) {
      // No restorable active half. A queue alone still presents the bar (the
      // ready state); nothing at all clears the entry, as before.
      if (!queue.length) return clearSaved(store.mid)
      save()
      return syncBar()
   }
   const index = typeof saved.index === "number" ? saved.index : 0
   const title = typeof saved.title === "string" ? saved.title : ""
   const feedId = typeof saved.feedId === "number" ? saved.feedId : 0
   const seek = (m: HTMLMediaElement): void => {
      if (RATES.includes(saved.rate)) m.playbackRate = saved.rate
      const apply = (): void => {
         try {
            m.currentTime = saved.time
         } catch {}
         syncBar()
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
   // episode two transports (the bar shows, because a synthetic node is not in
   // el.content and therefore reads as "adopted"), and the later rehomeInto
   // would substitute the synthetic node for the article's real one — dropping
   // the playsinline/poster/controls the sanitizer force-sets. Claim the
   // element that is already there instead. There is no second element.
   if (mounted && mounted.mid === store.mid && mounted.chron === saved.chron) {
      const live = mediaList(el.content)[index]
      if (live) {
         active = { ...mounted, index, media: live }
         seek(live)
         finishClaim(live)
         return
      }
   }

   // No upper bound check on the chron: the store may have been compacted or the
   // article expired since, and nav already clamps an unaddressable chron to the
   // last article. The bar's own label comes from the persisted title, so a stale
   // entry costs a wrong caption on the jump target at worst — not a broken boot.
   const m = document.createElement(saved.kind === "video" ? "video" : "audio")
   m.src = src
   m.preload = "metadata"
   seek(m)
   el.playerMedia.replaceChildren(m)
   active = { mid: store.mid, chron: saved.chron, index, title, feedId, media: m }
   finishClaim(m)
}

export function isActive(): boolean {
   return active !== null
}
