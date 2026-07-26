// ★ Saved — the device-local saved-article collection and the queue arithmetic
// over it, split out of nav.ts (finding ENG3). nav owns the MODE (filter.saved);
// this module owns the SET: its storage shape, its save order, the unsave-of-
// current ghost, and every count derived from them. Nothing here reads nav
// state — the two facts it needs (is ★ Saved the active mode, and which chron is
// on screen) arrive as explicit arguments, so the module graph stays acyclic.
//
// Saved articles ("★ Saved") — a per-article collection orthogonal to the
// feed/tag axes and the positional seen frontier. Stored device-local as a
// chronIdx set in localStorage (srr-saved), like srr-seen. chronIdx is a
// permanent article address — finalized packs are immutable and never GC'd — so
// a saved id stays loadable indefinitely (it survives even its feed being
// deleted; data.feedTitle then shows the "[DELETED]" tombstone). "★ Saved" is
// a distinct nav MODE (filter.saved): navigation walks the explicit set, not the
// idx packs, so it needs no fetch and is feed-agnostic. The reserved token
// "~saved" addresses the mode in the #hash and the filter rotation; a
// (vanishingly unlikely) real tag literally named "~saved" is shadowed by it.
import * as data from "./data"
import { savedKey, savedTsKey } from "./keys"
import * as sync from "./sync"

// Per-store key (docs/MULTI-STORE-SPEC.md §4.2): namespaced by the ACTIVE
// store's mid, the lane nav is reading. For the home store (mid "0") this
// resolves to the bare legacy name (srr-saved), so a single-store user's state
// is unchanged.
const savedK = () => savedKey(data.activeStore().mid)
const savedTsK = () => savedTsKey(data.activeStore().mid)

export const SAVED_TOKEN = "~saved"

// Re-read on each access (no module-level cache): the set is small and
// user-curated, so the localStorage parse is cheap, and reading fresh stays
// correct across tabs and keeps tests/`vi.resetModules` free of stale state.
function readSavedSet(): Set<number> {
   try {
      const raw = localStorage.getItem(savedK())
      const arr = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : [])
   } catch {
      return new Set()
   }
}
// Save order (Set iteration == insertion order): the ★ Saved queue read
// front-to-back. NOT sorted by chronIdx — new saves append to the end.
export function savedOrder(): number[] {
   return [...readSavedSet()]
}
// ★ Saved unsave-of-current anchor (the saved cousin of filter.anchor). Un-saving
// the article on screen drops it from the queue but leaves it in the reader
// (toggleSave is a state flip, not a navigation). Its save-index neighbors then
// vanish — savedNeighbor(pos) can't find a chron that left the set — so prev/next
// would dead-end on "no right match". Remember the just-unsaved chron plus the
// queue neighbors and ahead-count it held, so savedNeighbor/savedAhead still
// answer for it until the reader steps off (resolve) or the filter changes
// (resolveNoMatch). Set by toggleSaved, cleared on any landing. null = none.
let savedGhost: { chron: number; older: number; newer: number; ahead: number } | null = null

// Any real landing moves off the just-unsaved ghost article onto a genuine
// member (or another article entirely), so the saved ghost is spent. Called by
// nav's resolve()/resolveNoMatch().
export function clearSavedGhost(): void {
   savedGhost = null
}

// Save-order neighbor of member `chron`: "older" = the earlier save (toward the
// front of the queue, lower index), "newer" = the later save (higher index,
// toward the newest save). -1 at the ends or if `chron` isn't saved. Steps by
// save-INDEX, so — unlike the chronIdx ±1 trick the value seam uses — it never
// aliases two numerically-adjacent saved articles. A `chron` no longer in the set
// falls back to savedGhost (the article was just un-saved on screen).
export function savedNeighbor(chron: number, dir: "older" | "newer"): number {
   const order = savedOrder()
   const i = order.indexOf(chron)
   if (i < 0) return savedGhost?.chron === chron ? savedGhost[dir] : -1
   return dir === "older" ? (order[i - 1] ?? -1) : (order[i + 1] ?? -1)
}

// The ★ Saved half of the reader's pending readout (nav's pendingRight): the
// saves still AHEAD of `pos` — a front-to-back countdown by save-index. A `pos`
// that just left the set answers from the ghost's captured ahead-count.
export function savedAhead(pos: number): number {
   const order = savedOrder()
   const i = order.indexOf(pos)
   if (i < 0) return savedGhost?.chron === pos ? savedGhost.ahead : 0
   return order.length - 1 - i
}

// Stamp this chron's membership change (RDR18) — the exact seam writeSeen is
// for the seen frontier: srr-saved-ts records the unix-second of each chron's
// last LOCAL save/un-save, and profile.ts merges the set per key by it, in
// EITHER direction. That is what makes a save on one device and an un-save of
// the same article on another converge to the newer intent instead of to
// whichever blob happened to carry the newer blob-level `ts` (which silently
// dropped one of them). An UN-save stamps too, leaving a TOMBSTONE: its stamp
// is the only record that the removal is newer than a peer's still-live save.
// Best-effort like every other localStorage write here — a device that cannot
// stamp degrades to exactly the blob-level ordering it had before.
function stampSaved(chron: number): void {
   try {
      const raw = localStorage.getItem(savedTsK())
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      const map =
         parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, number>)
            : {}
      map[chron] = Math.floor(Date.now() / 1000)
      localStorage.setItem(savedTsK(), JSON.stringify(map))
   } catch {}
}

export function isSaved(chron: number): boolean {
   return readSavedSet().has(chron)
}
// The bulk-read twin of getSeenMap: one parse for a whole render/refresh pass
// (list.ts threads it through rowEl) instead of a localStorage read per row.
export function getSavedSet(): Set<number> {
   return readSavedSet()
}
export function savedCount(): number {
   return readSavedSet().size
}
// Toggle one article's saved state; returns the new state. A save APPENDS to the
// queue (Set.add keeps insertion order — written unsorted), so the ★ Saved view
// reads in save order.
//
// `ctx` is the nav state this needs and does not own: `savedMode`/`pos` are the
// active mode and the article on screen (the unsave-of-current ghost case), and
// `onQueueChange` is nav's neighbor-cache drop — called at exactly the point the
// pre-split body cleared it, since the saved queue's neighbors may have shifted.
export function toggleSaved(
   chron: number,
   ctx: { savedMode: boolean; pos: number; onQueueChange: () => void },
): boolean {
   const set = readSavedSet()
   const nowSaved = !set.has(chron)
   // Un-saving the article currently on screen in ★ Saved mode: capture its queue
   // neighbors + ahead-count from the pre-removal order so the reader can still
   // step off it (savedGhost, consulted by savedNeighbor/savedAhead while pos is
   // a non-member). Re-saving that same article — or any state flip that returns
   // it to the set — drops the ghost.
   if (!nowSaved && ctx.savedMode && chron === ctx.pos) {
      const order = [...set]
      const i = order.indexOf(chron)
      savedGhost = { chron, older: order[i - 1] ?? -1, newer: order[i + 1] ?? -1, ahead: order.length - 1 - i }
   } else if (savedGhost?.chron === chron) {
      savedGhost = null
   }
   if (nowSaved) set.add(chron)
   else set.delete(chron)
   try {
      localStorage.setItem(savedK(), JSON.stringify([...set]))
   } catch {}
   stampSaved(chron)
   sync.pushSoon()
   ctx.onQueueChange()
   savedHook?.(chron, nowSaved)
   return nowSaved
}

// The saved-set transition hook (FMT2a). ★ Saved keeps an article's TEXT forever
// — packs are immutable — but its self-hosted images and media are deleted when
// the feed's retention window passes, so a read-later queue quietly rots into
// text with broken pictures. The backend cannot help: the saved set is
// device-local, so only this device knows which assets to keep, and only the
// service worker can keep them. Both save paths (the reader's star and the
// list row's) come through toggleSaved, so this is the one seam; app.ts owns
// what actually happens, since talking to the SW is not nav's job.
let savedHook: ((chron: number, saved: boolean) => void) | null = null

export function setSavedHook(fn: (chron: number, saved: boolean) => void): void {
   savedHook = fn
}
