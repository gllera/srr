// player/persist.ts — the `srr-player` localStorage blob: writing it, clearing
// it, and reading it back VALIDATED (it is untrusted input on a path that ends
// in a src the browser will fetch). Which episode to claim from it is the
// engine's business (engine.ts restorePersisted); this module only speaks the
// shape.
import * as data from "../data"
import { isRelative, resolvePackRelative } from "../fmt"
import { playerStateKey } from "../keys"
import { lsSet } from "../storage"
import { arrayEqual, diffed } from "../signals"
import { URL_DENY } from "../urlish"
import { active, cursor, entryKey, QUEUE_MAX, queue, RATES, ratePref, type QueueEntry } from "./state"

// What survives a reload. `src`/`kind`/`title`/`feedId` ride along so the player
// can render at boot with ZERO pack fetches, preserving the reader's O(1) boot.
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
   // The current entry's position in `queue` while nothing plays (the READY
   // state); with an episode playing, `chron`/`index` above name it instead.
   c?: number
}

// timeupdate fires ~4x/second; persisting that often would write ~14k times an
// hour for a value nobody reads until the next boot.
const SAVE_INTERVAL_MS = 5000
let lastSave = 0

export function save(): void {
   const a = active()
   // The key follows the active episode's store, falling back to the mounted
   // store for a queue with nothing playing. Entries of another mount stay
   // in-memory only — a documented non-goal, not an accident.
   const mid = a?.mid ?? data.activeStore().mid
   const mine = queue().filter((e) => e.mid === mid)
   const qlist = mine.map((e) => ({
      chron: e.chron,
      index: e.index,
      src: e.src,
      kind: e.kind,
      title: e.title,
      feedId: e.feedId,
   }))
   const c = mine.findIndex((e) => entryKey(e) === cursor())
   let head: Omit<Persisted, "queue"> | null = null
   if (a) {
      const m = a.media
      head = {
         chron: a.chron,
         index: a.index,
         time: m.currentTime,
         rate: m.playbackRate,
         src: m.getAttribute("src") ?? "",
         kind: m.tagName === "VIDEO" ? "video" : "audio",
         title: a.title,
         feedId: a.feedId,
      }
      // A position of 0 is indistinguishable from "never played", and `src` is
      // what makes the entry restorable at all.
      if (!head.src || head.time <= 0) head = null
   }
   if (!head && !qlist.length) return clearSaved(mid)
   const state = {
      ...(head ?? {}),
      ...(qlist.length ? { queue: qlist } : {}),
      ...(!head && c >= 0 ? { c } : {}),
   }
   // A full or blocked localStorage must never break playback — lsSet swallows.
   lsSet(playerStateKey(mid), JSON.stringify(state))
   lastSave = Date.now()
}

// The rate-limited save a timeupdate asks for — a throttle, not a projection,
// which is why it is a call and not the persist effect.
export function saveSoon(): void {
   if (Date.now() - lastSave >= SAVE_INTERVAL_MS) save()
}

// Writes made inside quietly() persist nothing: the boot restore, whose claim
// has no position yet (metadata still loading reads as time 0, which save()
// treats as "never played" and would drop the episode from the blob).
let quiet = 0
export function quietly(fn: () => void): void {
   quiet++
   try {
      fn()
   } finally {
      quiet--
   }
}

// The persist effect: the blob follows the STATE it records — the queue and the
// speed. Not the first run (that is the empty boot state — persisting it would
// wipe the blob before restorePersisted reads it), and not a claim on its own
// (see quietly). The POSITION is event-driven instead: engine.ts saves on every
// play/pause event (the moment worth capturing) and saveSoon throttles the
// timeupdates between — moments, not a projection of state.
export function watchPersist(): () => void {
   return diffed(
      () => [queue(), cursor(), ratePref()] as const,
      () => {
         if (!quiet) save()
      },
      { equals: arrayEqual },
   )
}

export function clearSaved(mid: string): void {
   lsSet(playerStateKey(mid), null)
}

// The persisted `src` comes back from localStorage, which makes it UNTRUSTED
// input on a path that ends in an assignment the browser will fetch. It gets the
// same treatment article content gets in fmt.ts: never a javascript:/data:/
// vbscript:/file: scheme, and a relative key must resolve INSIDE the store base
// (a "//host" or "../" escape is an info-leak vector, exactly as it is in
// sanitizeFragment's bounds check).
export function safeSrc(raw: string, base: URL): string | null {
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

// The restorable halves of a store's blob, every field validated. `head` is the
// interrupted episode (null when there is none worth offering back); `queue` is
// the entries that survived validation, capped.
export interface SavedState {
   queue: QueueEntry[] | null
   // The READY cursor's index into `queue` (only meaningful without a head).
   cursor: number | null
   head: {
      src: string
      chron: number
      index: number
      time: number
      rate: number | null
      kind: "audio" | "video"
      title: string
      feedId: number
   } | null
}

export function readSaved(store: { mid: string; base: URL }): SavedState | null {
   let saved: Persisted
   try {
      const raw = localStorage.getItem(playerStateKey(store.mid))
      if (!raw) return null
      saved = JSON.parse(raw) as Persisted
   } catch {
      return null
   }
   if (!saved || typeof saved !== "object") return null
   const q = Array.isArray(saved.queue)
      ? saved.queue
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
      : null
   const src = typeof saved.src === "string" ? safeSrc(saved.src, store.base) : null
   const head =
      src && saved.chron >= 0 && saved.time > 0
         ? {
              src,
              chron: saved.chron,
              index: typeof saved.index === "number" ? saved.index : 0,
              time: saved.time,
              rate: RATES.includes(saved.rate) ? saved.rate : null,
              kind: saved.kind === "video" ? ("video" as const) : ("audio" as const),
              title: typeof saved.title === "string" ? saved.title : "",
              feedId: typeof saved.feedId === "number" ? saved.feedId : 0,
           }
         : null
   const cur = typeof saved.c === "number" && Number.isInteger(saved.c) && saved.c >= 0 ? saved.c : null
   return { queue: q, head, cursor: cur }
}
