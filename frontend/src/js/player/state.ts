// player/state.ts — the mini-player's state, as signals.
//
// Everything the player SHOWS is a projection of the atoms below: player/view.ts
// registers one effect per surface (the player chrome, its clock, the Up next
// list, the in-article queue chips, the lock screen, the persisted blob), so a
// write here is the whole update — no caller has to remember which surfaces to
// re-sync. That hand-kept fan-out (58 sync calls over 18 mutation sites) is what
// this module replaced; its failure mode was a forgotten call, e.g. a restored
// queue that rendered no rows.
//
// What is NOT state: the media element's position in the document. Moving it
// (player/relocation.ts) is the reader's fixed-order render step, imperative on
// purpose — an effect firing mid-render would break harvest → adopt → replace →
// restore → rehome.
//
// The element itself stays the source of truth for playback; `playback` is its
// snapshot, refreshed by `sample()` from the claimed element's own events.
import { shallowEqual, signal } from "../signals"
import { PLAYER_RATE_KEY } from "../keys"

export interface PlayerDeps {
   // The title button — jump to the article that owns the active media.
   openArticle: (mid: string, chron: number) => void
   // Hand a position back to FEB2's store (which lives in reader.ts, so this is
   // injected rather than imported). Closing the player therefore still leaves
   // the article resumable exactly as if you had never opened it.
   rememberPosition: (mid: string, chron: number, index: number, s: { time: number; rate: number }) => void
   // The read half of the same store: what FEB2 last saw for that element, so a
   // half-listened episode played from the QUEUE resumes instead of restarting.
   // Only the detached playEntry path consults it — a live in-content element
   // already carries its truth (restoreMediaState applied it at render).
   readPosition: (mid: string, chron: number, index: number) => { time: number; rate: number } | undefined
}

let injected: PlayerDeps | null = null
export function setDeps(d: PlayerDeps): void {
   injected = d
}
export function deps(): PlayerDeps {
   if (!injected) throw new Error("player: setup() has not run")
   return injected
}

// Which article reader.ts currently has mounted. The player needs the chron to
// give a claimed element an identity, and the title/feed to label the player
// without a pack fetch. A plain variable, not a signal: nothing is a projection
// of it — reader.ts re-injects the chips itself after every render.
export interface MountedArticle {
   mid: string
   chron: number
   title: string
   feedId: number
}
let mountedArticle: MountedArticle | null = null
export const mounted = (): MountedArticle | null => mountedArticle
export function setMounted(info: MountedArticle | null): void {
   mountedArticle = info
}

// The claimed episode. `index` is the element's position among the article's
// "audio,video" elements — the same positional identity FEB2 pairs on, because
// the same immutable article always renders the same media in the same order
// (src would break on a re-proxied or re-resolved URL).
export interface Active extends MountedArticle {
   index: number
   media: HTMLMediaElement
   // One retry per claim: set by the first `error`, so the second one takes the
   // dismissal path. Fresh claims build fresh Active objects, which resets it.
   retried?: boolean
}
export const active = signal<Active | null>(null)

// The PLAYLIST (kept under its historical name `queue`): every episode added,
// in order — and an entry STAYS after it plays (user call 2026-09-23: "don't
// remove an element after played"), like a music playlist. The episode playing
// now is a member; `cursor` says which. Entries carry everything needed to play
// with zero pack fetches: the Persisted shape plus mid, because a playlist
// outlives navigation and may hold episodes of articles that are no longer
// rendered anywhere. Immutable: every write is a fresh array, so identity is the
// change signal every effect keys on.
export interface QueueEntry {
   mid: string
   chron: number
   index: number
   src: string
   kind: "audio" | "video"
   title: string
   feedId: number
}
export const queue = signal<readonly QueueEntry[]>([])
export const QUEUE_MAX = 50

// Which entry is CURRENT — the one playing, or (nothing playing) the one the
// play button will start: the READY state. An entry KEY rather than an index,
// so a reorder or a removal elsewhere in the list can never shift it onto a
// different episode. Null: no current entry (the play button starts the first).
export const cursor = signal<string | null>(null)
export const entryKey = (e: { mid: string; chron: number; index: number }): string => `${e.mid}:${e.chron}:${e.index}`
export function cursorIndex(): number {
   const k = cursor()
   return k === null ? -1 : queue().findIndex((e) => entryKey(e) === k)
}

// Whether the player is UNFOLDED to the full player. It starts folded — just the
// corner button — and only that button (or a full-queue chip) unfolds it.
// Deliberately not persisted: every boot starts minimal, and ✕ folds it again.
export const unfolded = signal(false)

// Whether the active episode is stalled waiting on the network — the toggle's
// spinner. Only ever true while something is actually trying to play.
export const buffering = signal(false)

// The claimed element's playback, as last sampled. Equal samples are no change
// (shallowEqual — NaN durations compare equal under Object.is), so a timeupdate
// that moved nothing wakes nothing.
export interface Playback {
   paused: boolean
   time: number
   duration: number
}
const IDLE: Playback = { paused: true, time: 0, duration: NaN }
export const playback = signal<Playback>(IDLE, shallowEqual)

export function sample(): void {
   const a = active()
   if (!a) return playback.set(IDLE)
   const m = a.media
   playback.set({ paused: m.paused, time: m.currentTime, duration: m.duration })
}

// The speed ladder the rate button cycles. 1 is first so the cycle returns to
// normal rather than dead-ending at 2x.
export const RATES = [1, 1.25, 1.5, 2]

export function readRate(): number {
   const raw = Number(localStorage.getItem(PLAYER_RATE_KEY))
   // Only a value actually on the ladder is honoured — a hand-edited 0 or NaN
   // would otherwise freeze or crash playback.
   return RATES.includes(raw) ? raw : 1
}
// The device's speed preference as the view paints it. Re-read from storage at
// every claim (another tab may have changed it) and written by cycleRate.
export const ratePref = signal(1)

// ---------------------------------------------------------------------------
// Pure helpers over the atoms
// ---------------------------------------------------------------------------

// The GIF idiom: #embed and srr-x emit muted+loop+autoplay <video> for what used
// to be a GIF, and fmt.ts deliberately leaves those chrome-less. One predicate for
// the transport claim AND chip eligibility — a decoration that can't claim must
// also not get a chip, and must never be paused as "a second voice".
export function isGifIdiom(m: HTMLMediaElement): boolean {
   return m.autoplay || (m.muted && m.loop)
}

// The queue's display name for an entry.
export const entryLabel = (title: string): string => title || "(untitled)"

export function queuePos(mid: string, chron: number, index: number): number {
   return queue().findIndex((e) => e.mid === mid && e.chron === chron && e.index === index)
}

export function withoutEntry(mid: string, chron: number, index: number): readonly QueueEntry[] {
   return queue().filter((e) => !(e.mid === mid && e.chron === chron && e.index === index))
}

// Snapshot an episode as a queue entry (the prev-track target, and the re-queue
// when previoustrack steps back). Null when the element carries no src attribute
// to rebuild from — the same reason a save refuses to persist one.
export function entryOf(a: Active): QueueEntry | null {
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
