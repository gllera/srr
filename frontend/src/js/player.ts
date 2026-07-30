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
//   * THE BAR is about CONTROL. It shows whenever media is active and you
//     cannot see it — either its article is not rendered, or it IS rendered but
//     scrolled off-screen (the show-notes case: hit play, scroll down, the
//     transport comes with you). The element does NOT relocate on scroll, which
//     would make it leap out of the article under your eyes; only the bar
//     appears, and its controls target the live element wherever it lives.
//
// The module imports neither `nav` nor `reader`: reader.ts imports THIS, and
// what this needs from the router arrives through PlayerDeps — the same shape
// ReaderDeps established, keeping the graph acyclic with app.ts on top. reader.ts
// also has to TELL us what is on screen (noteMounted), because the chron of the
// mounted article is its state, not ours.
import * as data from "./data"
import { showContextMenu, type MenuItem } from "./dropdown"
import { el } from "./els"
import { srcColorIndex } from "./fmt"
import { ROW_SWIPE_TRIGGER } from "./gestures"
import { PLAYER_RATE_KEY, playerStateKey } from "./keys"
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

// Whether the active element's own article is currently on screen and in view.
// Only meaningful while the element sits in the content host; an adopted element
// is by definition not visible in an article, so the bar always shows for it.
let inView = false
let observer: IntersectionObserver | null = null

// Whether the active episode is stalled waiting on the network. Between play()
// and audio actually flowing the bar otherwise looks frozen — the "is it
// broken?" moment on a slow connection. Rendered as a spinner on the toggle.
let buffering = false

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
   try {
      localStorage.setItem(playerStateKey(mid), JSON.stringify(state))
      lastSave = Date.now()
   } catch {
      // A full or blocked localStorage must never break playback.
   }
}

function clearSaved(mid: string): void {
   try {
      localStorage.removeItem(playerStateKey(mid))
   } catch {}
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
   const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("//")
   if (isRelative && !u.href.startsWith(base.href)) return null
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
         title: active.title || "(untitled)",
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

function mediaList(root: ParentNode): HTMLMediaElement[] {
   return [...root.querySelectorAll<HTMLMediaElement>("audio,video")]
}

// A `play` event claims its element as the active episode. `play` does not
// bubble, but non-bubbling events still traverse the CAPTURE phase — the same
// property fmt.ts's collapseBrokenMedia relies on for `error` — so one capture
// listener on the document sees every media element in the page.
function onPlay(e: Event): void {
   const m = e.target
   if (!(m instanceof HTMLMediaElement)) return
   if (active && active.media === m) {
      // Re-play of the episode we already own: nothing to re-derive.
      syncMediaSession()
      return syncBar()
   }
   // The GIF idiom: #embed and srr-x emit muted+loop+autoplay <video> for what
   // used to be a GIF, and fmt.ts deliberately leaves those chrome-less. They
   // fire `play` on their own the moment they render, so claiming them would let
   // a decorative animation hijack the transport away from a real episode.
   if (m.autoplay || (m.muted && m.loop)) return
   if (!el.content.contains(m) || !mounted) return
   const index = mediaList(el.content).indexOf(m)
   if (index < 0) return
   // One episode at a time: hand the outgoing one's position back to FEB2 so
   // returning to it still resumes. If it was ADOPTED, it also has to be taken
   // out of the bar host — release() deliberately never touches parents, so
   // without this the old node would stay there still playing, inaudibly
   // orphaned behind the new episode's chrome (two things playing at once).
   const outgoingAdopted = active !== null && !el.content.contains(active.media)
   release()
   if (outgoingAdopted) discardAdopted()
   active = { ...mounted, index, media: m }
   // A manually played element that was sitting in the queue is now the active
   // episode; leaving it queued would replay it later.
   dropQueued(mounted.mid, mounted.chron, index)
   const rate = readRate()
   // Apply the device's standing speed preference, but only when it was actually
   // set: at the default 1 we leave the element alone so a rate FEB2 restored
   // (or one set through native in-content controls) is not silently reset.
   if (rate !== 1) m.playbackRate = rate
   bindMedia(m)
   watch(m)
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
   observer?.unobserve(m)
   active = null
   inView = false
   buffering = false
   if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = 0
   }
}

function bindMedia(m: HTMLMediaElement): void {
   m.addEventListener("timeupdate", onTimeUpdate)
   m.addEventListener("pause", onPauseOrPlay)
   m.addEventListener("play", onPauseOrPlay)
   m.addEventListener("ended", onEnded)
   m.addEventListener("error", onError)
   m.addEventListener("loadedmetadata", syncBar)
   m.addEventListener("waiting", onBufferStall)
   m.addEventListener("stalled", onBufferStall)
   m.addEventListener("playing", onBufferClear)
   m.addEventListener("canplay", onBufferClear)
}

function unbindMedia(m: HTMLMediaElement): void {
   m.removeEventListener("timeupdate", onTimeUpdate)
   m.removeEventListener("pause", onPauseOrPlay)
   m.removeEventListener("play", onPauseOrPlay)
   m.removeEventListener("ended", onEnded)
   m.removeEventListener("error", onError)
   m.removeEventListener("loadedmetadata", syncBar)
   m.removeEventListener("waiting", onBufferStall)
   m.removeEventListener("stalled", onBufferStall)
   m.removeEventListener("playing", onBufferClear)
   m.removeEventListener("canplay", onBufferClear)
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

function onEnded(): void {
   // A finished episode has nothing left to resume; drop it wholesale rather
   // than leaving a bar parked at the end — unless something is queued, in
   // which case finishing is exactly when the playlist advances.
   const mid = active?.mid
   const finished = active ? entryOf(active) : null
   release()
   if (mid) clearSaved(mid)
   discardAdopted()
   if (queue.length) {
      lastPlayed = finished
      return advance(true)
   }
   syncMediaSession()
   syncBar()
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
   const mid = active?.mid
   release()
   if (mid) clearSaved(mid)
   discardAdopted()
   if (queue.length) return advance(true)
   syncMediaSession()
   syncBar()
}

// The off-screen rule. Only the in-content case needs observing; while adopted
// the element is not in an article at all.
function watch(m: HTMLMediaElement): void {
   inView = true
   if (typeof IntersectionObserver !== "function") return
   observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
         if (active && entry.target === active.media) {
            inView = entry.isIntersecting
            syncBar()
         }
      }
   })
   observer.observe(m)
}

// ---------------------------------------------------------------------------
// Playlist — the "up next" queue
// ---------------------------------------------------------------------------

function isQueued(mid: string, chron: number, index: number): boolean {
   return queue.some((e) => e.mid === mid && e.chron === chron && e.index === index)
}

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
// open panel, the count button and the persisted blob must all tell one story.
function afterQueueChange(): void {
   syncChips()
   syncQueueHandlers()
   renderPanel()
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
   // One episode at a time — the onPlay discipline: hand the outgoing position
   // to FEB2, and take an adopted node out of the bar host or it would keep
   // playing behind the new episode's chrome.
   const outgoingAdopted = active !== null && !el.content.contains(active.media)
   release()
   if (outgoingAdopted) discardAdopted()
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
   if (live) watch(m)
   bindMedia(m)
   bindMediaSession()
   syncMediaSession()
   syncBar()
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

function queuePos(mid: string, chron: number, index: number): number {
   return queue.findIndex((e) => e.mid === mid && e.chron === chron && e.index === index)
}

// One chip, a glyph vocabulary: "+" add, the entry's 1-based queue POSITION
// while queued (every chip re-derives after every queue mutation via syncChips,
// so the numeral can never lie), and "≡" when the queue is full — the door
// state: toggleQueued opens the panel to prune instead of dead-ending, so the
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
   if (!(n instanceof HTMLElement)) return
   n.classList.remove("srr-chip-pop")
   void n.offsetWidth
   n.classList.add("srr-chip-pop")
}

// The chip's long-press menu — the power layer over the tap (append): "Play
// next" puts the enclosure at the HEAD of the queue (the podcast verb the
// panel's reorder arrows only reach one step at a time; a queued entry MOVES,
// never duplicates), "Play now" plays it outright through the element's own
// play() — the capture-phase claim then consumes any queued copy, identical to
// pressing play on the element, which also makes it the door state's escape
// hatch (it never grows the queue, so it stays live at the cap). Items derive
// at open and RE-CHECK at action: showContextMenu outlives this tick, and an
// auto-advance or a navigation can move the queue (or the article) under an
// open menu.
function chipMenuItems(index: number): MenuItem[] {
   if (!mounted) return []
   const m = mediaList(el.content)[index]
   if (!m?.getAttribute("src")) return []
   const { mid, chron, title, feedId } = mounted
   const stale = (): boolean => !mounted || mounted.mid !== mid || mounted.chron !== chron
   return [
      {
         label: "Play next",
         // A NEW head entry would breach the cap; a queued one just moves.
         disabled: queuePos(mid, chron, index) < 0 && queue.length >= QUEUE_MAX,
         action: () => {
            if (stale()) return
            const media = mediaList(el.content)[index]
            const src = media?.getAttribute("src") ?? ""
            if (!src) return
            const pos = queuePos(mid, chron, index)
            if (pos < 0 && queue.length >= QUEUE_MAX) return
            if (pos >= 0) queue.splice(pos, 1)
            queue.unshift({
               mid,
               chron,
               index,
               src,
               kind: media.tagName === "VIDEO" ? "video" : "audio",
               title,
               feedId,
            })
            afterQueueChange()
            pulseOnce(media.nextElementSibling)
            if (pos < 0) pulseOnce(el.playerQueue)
         },
      },
      {
         label: "Play now",
         action: () => {
            if (stale()) return
            // `void` discards the promise but not its REJECTION: play() rejects
            // on media whose bytes never arrive (and on an autoplay refusal),
            // which surfaced as an unhandled rejection in the console. The
            // element's own `error` handling owns the user-facing recovery, so
            // the catch here is deliberately silent.
            mediaList(el.content)
               [index]?.play()
               .catch(() => {})
         },
      },
   ]
}

// bindFrontierMenu's wiring restated (menus.ts is app-side chrome player must
// not import — the attachRowSwipe precedent): desktop right-click, Android
// long-press and Shift+F10 all arrive as `contextmenu`; iOS Safari fires none
// on non-links, so a 500ms touch-hold covers it, with `held` swallowing the
// finger-lift click (it would otherwise also toggle the queue) and a late
// native contextmenu (Android fires both).
function bindChipMenu(chip: HTMLButtonElement, index: number): void {
   let hold = 0
   let held = false
   const open = (): boolean => {
      const items = chipMenuItems(index)
      if (items.length > 0) showContextMenu(chip, items)
      return items.length > 0
   }
   chip.addEventListener("contextmenu", (e) => {
      clearTimeout(hold)
      if (held || open()) e.preventDefault()
   })
   chip.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return
      held = false
      clearTimeout(hold)
      hold = window.setTimeout(() => (held = open()), 500)
   })
   for (const ev of ["pointerup", "pointercancel", "pointerleave"]) chip.addEventListener(ev, () => clearTimeout(hold))
   chip.addEventListener(
      "click",
      (e) => {
         if (!held) return
         held = false
         e.preventDefault()
         e.stopImmediatePropagation()
      },
      true,
   )
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
      if (m.autoplay || (m.muted && m.loop)) continue
      if (!m.getAttribute("src")) continue
      // On the rehome path the chip is already sitting after the element
      // (replaceWith swaps the node, not its siblings) — re-derive its state.
      const existing = m.nextElementSibling
      if (existing instanceof HTMLButtonElement && existing.classList.contains("srr-queue-chip")) {
         setChipState(existing, queuePos(mid, chron, i))
         syncChipOffstage(m, existing)
         continue
      }
      const chip = document.createElement("button")
      chip.type = "button"
      chip.className = "srr-queue-chip"
      const index = i
      chip.addEventListener("click", () => toggleQueued(index))
      bindChipMenu(chip, index)
      setChipState(chip, queuePos(mid, chron, i))
      m.insertAdjacentElement("afterend", chip)
      syncChipOffstage(m, chip)
   }
}

// Re-derive every rendered chip after a queue mutation (a panel removal, a
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

function toggleQueued(index: number): void {
   if (!mounted) return
   const { mid, chron, title, feedId } = mounted
   if (isQueued(mid, chron, index)) return dropQueued(mid, chron, index)
   // The cap as a DOOR: a full queue opens the panel to prune instead of
   // silently eating the tap (the chip already reads ≡ / "Playlist full").
   // Edge accepted: with the bar hidden — an active on-screen episode — the
   // panel (its child) can't show, and the tap stays a no-op like before.
   if (queue.length >= QUEUE_MAX) return openPanel()
   const m = mediaList(el.content)[index]
   const src = m?.getAttribute("src") ?? ""
   if (!src) return
   queue.push({ mid, chron, index, src, kind: m.tagName === "VIDEO" ? "video" : "audio", title, feedId })
   afterQueueChange()
   // Feedback at both ends of the gesture: the chip pops under the finger, the
   // bar's ≡ count pulses where the episode went.
   pulseOnce(m.nextElementSibling)
   pulseOnce(el.playerQueue)
}

// ---------------------------------------------------------------------------
// Queue panel
// ---------------------------------------------------------------------------

let panel: HTMLElement | null = null

function buildPanel(): HTMLElement {
   const p = document.createElement("div")
   p.className = "srr-player-panel"
   p.setAttribute("role", "list")
   p.setAttribute("aria-label", "Playlist")
   p.tabIndex = -1
   p.hidden = true
   // Focused chrome: no key pressed over the panel may reach the global keymap
   // (an unguarded 'd' would walk articles and re-render the surface under the
   // open panel — the lightbox rule, scoped to a popover).
   p.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Escape") {
         e.preventDefault()
         closePanel(true)
      }
   })
   // A child of the bar: it inherits the scrub-gesture guard and the bar's
   // hidden state, and positions above it with plain CSS.
   el.player.appendChild(p)
   return p
}

function renderPanel(): void {
   if (!panel || panel.hidden) return
   if (!queue.length) return closePanel()
   panel.replaceChildren(
      ...queue.map((entry, i) => {
         const row = document.createElement("div")
         row.setAttribute("role", "listitem")
         row.className = "srr-player-panel-row"
         const play = document.createElement("button")
         play.type = "button"
         play.className = "srr-player-row-play"
         play.dataset.src = String(srcColorIndex(entry.feedId))
         const source = document.createElement("span")
         source.className = "srr-player-row-source"
         source.textContent = data.feedTitle(entry.feedId)
         const name = document.createElement("span")
         name.className = "srr-player-row-name"
         name.textContent = entry.title || "(untitled)"
         play.append(source, name)
         play.setAttribute("aria-label", `Play now — ${entry.title || "(untitled)"} · ${data.feedTitle(entry.feedId)}`)
         play.addEventListener("click", () => {
            queue = queue.filter((e) => e !== entry)
            closePanel(true)
            playEntry(entry, true) // a false return just drops the dead entry
            afterQueueChange()
         })
         const remove = document.createElement("button")
         remove.type = "button"
         remove.className = "srr-player-row-remove"
         remove.textContent = "×"
         remove.setAttribute("aria-label", `Remove from playlist — ${entry.title || "(untitled)"}`)
         remove.addEventListener("click", () => {
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
   const b = document.createElement("button")
   b.type = "button"
   b.className = delta < 0 ? "srr-player-row-up" : "srr-player-row-down"
   b.textContent = delta < 0 ? "↑" : "↓"
   b.disabled = dead
   b.setAttribute("aria-label", `${delta < 0 ? "Move up" : "Move down"} — ${entry.title || "(untitled)"}`)
   b.addEventListener("click", () => moveQueued(entry, delta))
   return b
}

function moveQueued(entry: QueueEntry, delta: -1 | 1): void {
   const i = queue.indexOf(entry)
   const j = i + delta
   if (i < 0 || j < 0 || j >= queue.length) return
   queue.splice(i, 1)
   queue.splice(j, 0, entry)
   afterQueueChange()
   // The panel just re-rendered under the press: keep the keyboard on the row
   // that moved — the same-direction handle so repeated presses keep walking,
   // its opposite when the row just hit a dead end.
   const row = panel?.querySelectorAll(".srr-player-panel-row")[j]
   const same = row?.querySelector<HTMLButtonElement>(delta < 0 ? ".srr-player-row-up" : ".srr-player-row-down")
   if (same && !same.disabled) same.focus()
   else row?.querySelector<HTMLButtonElement>(delta < 0 ? ".srr-player-row-down" : ".srr-player-row-up")?.focus()
}

// The panel rows' swipe-to-remove. LOCAL touch handling on purpose, not a
// gestures.ts registration: the document machine declines any touch starting
// inside .srr-player (the scrubber guard), so it can never reach these rows —
// and that is right, a drag here must never read as a reader page turn. The
// axis lock restates the machine's own three faces at the same slop.
const PANEL_AXIS_SLOP = 8 // gestures.ts's AXIS_SLOP, restated for the same feel
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
         if (Math.abs(dy) > PANEL_AXIS_SLOP && Math.abs(dy) >= Math.abs(dx)) {
            mode = "veto"
            return
         }
         if (Math.abs(dx) <= PANEL_AXIS_SLOP || Math.abs(dx) <= Math.abs(dy)) return
         mode = "drag"
         row.style.transition = "none"
      }
      // An engaged swipe owns the finger — the panel must not scroll under it.
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

function onOutsidePress(e: Event): void {
   const t = e.target as Node
   if (panel && !panel.hidden && !panel.contains(t) && !el.playerQueue.contains(t)) closePanel()
}

function openPanel(): void {
   if (!queue.length) return
   panel ??= buildPanel()
   panel.hidden = false
   el.playerQueue.setAttribute("aria-expanded", "true")
   renderPanel()
   document.addEventListener("pointerdown", onOutsidePress, true)
   panel.focus()
}

function closePanel(refocus = false): void {
   if (!panel || panel.hidden) return
   panel.hidden = true
   el.playerQueue.setAttribute("aria-expanded", "false")
   document.removeEventListener("pointerdown", onOutsidePress, true)
   if (refocus) el.playerQueue.focus()
}

function togglePanel(): void {
   if (panel && !panel.hidden) closePanel(true)
   else openPanel()
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
   observer?.unobserve(m)
   inView = false
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
   watch(active.media)
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
   try {
      localStorage.setItem(PLAYER_RATE_KEY, String(next))
   } catch {}
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
   release()
   clearSaved(mid)
   if (wasAdopted) discardAdopted()
   closePanel()
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
   el.playerTime.textContent = Number.isFinite(dur) ? `${clock(m.currentTime)} / ${clock(dur)}` : clock(m.currentTime)
   const pct = Number.isFinite(dur) && dur > 0 ? (m.currentTime / dur) * 100 : 0
   el.playerSeekFill.style.width = `${pct}%`
   el.playerSeek.setAttribute("aria-valuemax", String(Number.isFinite(dur) ? Math.floor(dur) : 0))
   el.playerSeek.setAttribute("aria-valuenow", String(Math.floor(m.currentTime)))
   el.playerSeek.setAttribute("aria-valuetext", clock(m.currentTime))
}

// The bar is shown when there IS an episode and you cannot see it playing: it is
// adopted (its article is not rendered), or the article is hidden behind the list
// surface, or it is scrolled out of view. With nothing claimed but a queue built
// up, it shows in the READY state instead — a queue must be visible to be usable
// at all, and ✕ is how it goes away.
function barVisible(): boolean {
   if (!active) return queue.length > 0
   const adopted = !el.content.contains(active.media)
   return adopted || el.article.hidden || !inView
}

function syncBar(): void {
   const show = barVisible()
   el.player.hidden = !show
   // Drives the container's bottom padding so the last paragraph clears the bar.
   document.body.classList.toggle("srr-playing", show)
   if (!show) closePanel()
   // The buffering spinner replaces the toggle glyph; aria-busy is the same
   // state for assistive tech (the accessible name stays Play/Pause).
   const stalled = buffering && active !== null
   el.playerToggle.classList.toggle("srr-player-buffering", stalled)
   el.playerToggle.setAttribute("aria-busy", String(stalled))
   // The queue chrome lives in both bar states.
   el.playerQueue.hidden = !queue.length
   el.playerNext.hidden = !queue.length
   if (queue.length) {
      el.playerQueue.textContent = `≡ ${queue.length}`
      el.playerQueue.setAttribute("aria-label", `Playlist — ${queue.length} queued`)
   }
   if (!active) {
      if (!queue.length) return
      // READY state: nothing claimed, something queued. The bar presents the
      // head of the queue behind a play button — the visible result of the
      // first chip tap, without autoplay and without secretly claiming an
      // element the user can already see in the article.
      const q0 = queue[0]
      el.player.dataset.kind = q0.kind
      el.player.dataset.src = String(srcColorIndex(q0.feedId))
      el.playerSource.textContent = data.feedTitle(q0.feedId)
      el.playerName.textContent = q0.title || "(untitled)"
      el.playerTitle.setAttribute("aria-label", `Go to ${q0.title || "this article"} — ${data.feedTitle(q0.feedId)}`)
      el.playerToggle.setAttribute("aria-label", "Play")
      el.playerToggle.setAttribute("aria-pressed", "false")
      el.playerToggle.classList.remove("srr-player-playing")
      el.playerRate.textContent = `${readRate()}×`
      el.playerRate.setAttribute("aria-label", `Playback speed — ${readRate()}×`)
      el.playerTime.textContent = ""
      el.playerSeekFill.style.width = "0%"
      return
   }
   const paused = active.media.paused
   el.player.dataset.kind = active.media.tagName === "VIDEO" ? "video" : "audio"
   el.player.dataset.src = String(srcColorIndex(active.feedId))
   el.playerSource.textContent = data.feedTitle(active.feedId)
   el.playerName.textContent = active.title || "(untitled)"
   el.playerTitle.setAttribute(
      "aria-label",
      `Go to ${active.title || "this article"} — ${data.feedTitle(active.feedId)}`,
   )
   el.playerToggle.setAttribute("aria-label", paused ? "Play" : "Pause")
   el.playerToggle.setAttribute("aria-pressed", String(!paused))
   el.playerToggle.classList.toggle("srr-player-playing", !paused)
   el.playerRate.textContent = `${readRate()}×`
   el.playerRate.setAttribute("aria-label", `Playback speed — ${readRate()}×`)
   syncTime()
}

// ---------------------------------------------------------------------------
// Seek interaction
// ---------------------------------------------------------------------------

function seekFromPointer(e: PointerEvent): void {
   if (!active) return
   const dur = active.media.duration
   if (!Number.isFinite(dur) || dur <= 0) return
   const r = el.playerSeek.getBoundingClientRect()
   if (r.width <= 0) return
   seekTo(((e.clientX - r.left) / r.width) * dur)
}

function bindSeek(): void {
   el.playerSeek.addEventListener("pointerdown", (e) => {
      // Pointer capture keeps the drag alive outside the 4px-tall track.
      el.playerSeek.setPointerCapture?.(e.pointerId)
      seekFromPointer(e)
   })
   el.playerSeek.addEventListener("pointermove", (e) => {
      // buttons is a bitmask: nonzero means a button is still held (a drag).
      if (e.buttons) seekFromPointer(e)
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
   el.playerQueue.addEventListener("click", togglePanel)
   el.playerNext.addEventListener("click", () => advance(true))
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
         bindMedia(live)
         watch(live)
         bindMediaSession()
         syncMediaSession()
         syncBar()
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
   bindMedia(m)
   bindMediaSession()
   syncMediaSession()
   syncBar()
}

export function isActive(): boolean {
   return active !== null
}
