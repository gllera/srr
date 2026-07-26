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
import { el } from "./els"
import { srcColorIndex } from "./fmt"
import { PLAYER_RATE_KEY, playerStateKey } from "./keys"
import { URL_DENY } from "./urlish"

export interface PlayerDeps {
   // The bar's title button — jump to the article that owns the active media.
   openArticle: (mid: string, chron: number) => void
   // Hand a position back to FEB2's store (which lives in reader.ts, so this is
   // injected rather than imported). Closing the bar therefore still leaves the
   // article resumable exactly as if you had never opened the player.
   rememberPosition: (mid: string, chron: number, index: number, s: { time: number; rate: number }) => void
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
}
let active: Active | null = null

// Whether the active element's own article is currently on screen and in view.
// Only meaningful while the element sits in the content host; an adopted element
// is by definition not visible in an article, so the bar always shows for it.
let inView = false
let observer: IntersectionObserver | null = null

// The speed ladder the rate button cycles. 1 is first so the cycle returns to
// normal rather than dead-ending at 2x.
const RATES = [1, 1.25, 1.5, 2]

const SKIP_SECONDS = 15
// timeupdate fires ~4x/second; persisting that often would write ~14k times an
// hour for a value nobody reads until the next boot.
const SAVE_INTERVAL_MS = 5000
let lastSave = 0

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// What survives a reload. `src`/`kind`/`title`/`feedId` ride along so the bar can
// render at boot with ZERO pack fetches, preserving the reader's O(1) boot.
interface Persisted {
   chron: number
   index: number
   time: number
   rate: number
   src: string
   kind: "audio" | "video"
   title: string
   feedId: number
}

function readRate(): number {
   const raw = Number(localStorage.getItem(PLAYER_RATE_KEY))
   // Only a value actually on the ladder is honoured — a hand-edited 0 or NaN
   // would otherwise freeze or crash playback.
   return RATES.includes(raw) ? raw : 1
}

function save(): void {
   if (!active) return
   const m = active.media
   const state: Persisted = {
      chron: active.chron,
      index: active.index,
      time: m.currentTime,
      rate: m.playbackRate,
      src: m.getAttribute("src") ?? "",
      kind: m.tagName === "VIDEO" ? "video" : "audio",
      title: active.title,
      feedId: active.feedId,
   }
   // A position of 0 is indistinguishable from "never played", and `src` is what
   // makes the entry restorable at all.
   if (!state.src || state.time <= 0) return clearSaved(active.mid)
   try {
      localStorage.setItem(playerStateKey(active.mid), JSON.stringify(state))
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
}

function bindMedia(m: HTMLMediaElement): void {
   m.addEventListener("timeupdate", onTimeUpdate)
   m.addEventListener("pause", onPauseOrPlay)
   m.addEventListener("play", onPauseOrPlay)
   m.addEventListener("ended", onEnded)
   m.addEventListener("error", onError)
   m.addEventListener("loadedmetadata", syncBar)
}

function unbindMedia(m: HTMLMediaElement): void {
   m.removeEventListener("timeupdate", onTimeUpdate)
   m.removeEventListener("pause", onPauseOrPlay)
   m.removeEventListener("play", onPauseOrPlay)
   m.removeEventListener("ended", onEnded)
   m.removeEventListener("error", onError)
   m.removeEventListener("loadedmetadata", syncBar)
}

function onTimeUpdate(): void {
   syncTime()
   if (Date.now() - lastSave >= SAVE_INTERVAL_MS) save()
}

function onPauseOrPlay(): void {
   save()
   syncMediaSession()
   syncBar()
}

function onEnded(): void {
   // A finished episode has nothing left to resume; drop it wholesale rather
   // than leaving a bar parked at the end.
   const mid = active?.mid
   release()
   if (mid) clearSaved(mid)
   discardAdopted()
   syncMediaSession()
   syncBar()
}

function onError(): void {
   // Old articles outlive their media hosts (the same reality collapseBrokenMedia
   // exists for). An unplayable episode is not an app error: dismiss quietly.
   const mid = active?.mid
   release()
   if (mid) clearSaved(mid)
   discardAdopted()
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
   // element is in the document throughout, so playback continues.
   fresh.replaceWith(active.media)
   // fmt.ts forces `controls` on in-content audio (a control-less feed <audio>
   // renders no player at all), so put back what adoptFromContent took away.
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
// forgets the episode — including its persisted entry, since closing is an
// explicit "I am done with this".
function close(): void {
   if (!active) return
   const mid = active.mid
   active.media.pause()
   const wasAdopted = !el.content.contains(active.media)
   release()
   clearSaved(mid)
   if (wasAdopted) discardAdopted()
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
// surface, or it is scrolled out of view.
function barVisible(): boolean {
   if (!active) return false
   const adopted = !el.content.contains(active.media)
   return adopted || el.article.hidden || !inView
}

function syncBar(): void {
   const show = barVisible()
   el.player.hidden = !show
   // Drives the container's bottom padding so the last paragraph clears the bar.
   document.body.classList.toggle("srr-playing", show)
   if (!active) return
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
   el.playerSeek.addEventListener("keydown", (e) => {
      const step =
         e.key === "ArrowRight"
            ? 5
            : e.key === "ArrowLeft"
              ? -5
              : e.key === "PageUp"
                ? 60
                : e.key === "PageDown"
                  ? -60
                  : 0
      if (step) {
         e.preventDefault()
         skip(step)
      } else if (e.key === "Home") {
         e.preventDefault()
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
   el.playerToggle.addEventListener("click", () => {
      if (!active) return
      if (active.media.paused) void play()
      else pause()
   })
   el.playerBack15.addEventListener("click", () => skip(-SKIP_SECONDS))
   el.playerFwd15.addEventListener("click", () => skip(SKIP_SECONDS))
   el.playerRate.addEventListener("click", cycleRate)
   el.playerClose.addEventListener("click", close)
   el.playerTitle.addEventListener("click", () => {
      if (active) d.openArticle(active.mid, active.chron)
   })
   bindSeek()
   // A reload is the one exit we can still write through.
   window.addEventListener("pagehide", save)
   syncBar()
}

// Restore a persisted episode into a PAUSED bar. Never autoplays: browsers block
// it without a gesture, and audio starting by itself on a cold boot is the exact
// behaviour people disable autoplay to avoid — so this offers the episode back
// rather than resuming it.
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
   const src = typeof saved.src === "string" ? safeSrc(saved.src, store.base) : null
   if (!src || !(saved.chron >= 0) || !(saved.time > 0)) return clearSaved(store.mid)
   // No upper bound check on the chron: the store may have been compacted or the
   // article expired since, and nav already clamps an unaddressable chron to the
   // last article. The bar's own label comes from the persisted title, so a stale
   // entry costs a wrong caption on the jump target at worst — not a broken boot.
   const m = document.createElement(saved.kind === "video" ? "video" : "audio")
   m.src = src
   m.preload = "metadata"
   if (RATES.includes(saved.rate)) m.playbackRate = saved.rate
   m.addEventListener(
      "loadedmetadata",
      () => {
         try {
            m.currentTime = saved.time
         } catch {}
         syncBar()
      },
      { once: true },
   )
   el.playerMedia.replaceChildren(m)
   active = {
      mid: store.mid,
      chron: saved.chron,
      index: typeof saved.index === "number" ? saved.index : 0,
      title: typeof saved.title === "string" ? saved.title : "",
      feedId: typeof saved.feedId === "number" ? saved.feedId : 0,
      media: m,
   }
   bindMedia(m)
   bindMediaSession()
   syncMediaSession()
   syncBar()
}

export function isActive(): boolean {
   return active !== null
}
