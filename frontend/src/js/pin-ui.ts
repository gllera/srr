// pin-ui.ts — the offline-pin controller and the page half of the service-worker
// message protocol: the "pin"/"unpin"/"mounts" messages, the transient progress
// toast, the storage-persistence request, and the ★-Saved asset pinning that
// rides the same registry.
//
// A LEAF controller: it imports data/nav/fmt/pin/els and nothing from its sibling
// controllers, so the whole SW conversation can be read (and reasoned about) in
// one place. The single app-level dependency — how to surface an error from the
// menu row's action — arrives as an explicit argument to pinMenuEntry rather than
// through a setup call, because it is the only one.
import * as data from "./data"
import { el } from "./els"
import { extractAssetKeys } from "./fmt"
import * as nav from "./nav"
import { isPinned, listPins, pinFilter, unpinFilter } from "./pin"

// Offline-pin progress: show a transient "Downloading N / M…" note in the
// status bar while the SW caches the filter's packs, then restore.
let pinProgressTimer: ReturnType<typeof setTimeout> | undefined
// Whether the current pin was started in unread-only mode (snapshot note).
let pinIsUnreadSnapshot = false

function showPinProgress(done: number, total: number, cached?: number): void {
   clearTimeout(pinProgressTimer)
   let text: string
   const finished = done >= total
   if (finished) {
      // `cached` is the real success count from the SW; absent (older message)
      // falls back to `total`. Zero cached = nothing saved (offline/degraded).
      const ok = cached ?? total
      if (ok === 0) {
         text = "Couldn't save offline copy — you may be offline"
      } else {
         text = `Offline copy saved (${ok} file${ok === 1 ? "" : "s"})`
         // The pin is a snapshot — unread that arrives later isn't auto-pinned.
         if (pinIsUnreadSnapshot) text += " — new unread won't update automatically"
      }
   } else {
      text = `Downloading ${done} / ${total}…`
   }
   // A dedicated node (.srr-pin-progress), separate from the settings menu's
   // status footer (picker.renderStatus) — the menu closes when the pin row is
   // clicked, so the toast is the only feedback surface left. Per-pack ticks
   // stay SILENT (no live role) so they don't flood screen readers; only the
   // final outcome becomes a role=status live region, so the single
   // success/failure message is announced once.
   if (finished) el.pinProgress.setAttribute("role", "status")
   else el.pinProgress.removeAttribute("role")
   el.pinProgress.textContent = text
   el.pinProgress.hidden = false
   if (finished) {
      pinProgressTimer = setTimeout(() => {
         el.pinProgress.hidden = true
         el.pinProgress.textContent = ""
         el.pinProgress.removeAttribute("role")
      }, 3000)
   }
}

// The offline-pin registry key. Distinct from nav.filterKey() (which the list
// reuses for scroll memory): the pinned pack SET differs by unread-only mode
// (raised bounds enumerate only the unread tail), so the key must encode it too.
function pinKey(): string {
   const base = nav.filterKey()
   return nav.isUnreadOnly() && nav.filter.active ? base + " #unread" : base
}

// Enumerate the packs for the current filter and cache them in the SW's
// eviction-exempt PINNED bucket. Records the pin in the localStorage registry
// so the overflow menu can show "Remove offline copy" on the next open.
// Scoped to [ALL] / feed / tag / unread — saved and search scopes are deferred
// (the pinMenuHook returns null for them).
async function pinCurrentFilter(): Promise<void> {
   const controller = navigator.serviceWorker?.controller
   if (!controller) return // dev / harness / insecure context — silent no-op
   const key = pinKey()
   // [ALL] => empty Map, the documented fast path; a populated map is a feed/tag
   // scope (filter.feeds is fully populated even for [ALL], so pass empty here).
   const feeds = nav.filter.active ? nav.filter.feeds : new Map<number, number>()
   const names = await data.packNamesForFilter(feeds)
   if (names.length === 0) return
   // Track whether this pin was taken in unread-only mode so the completion
   // message can surface the snapshot caveat (new unread won't auto-update).
   pinIsUnreadSnapshot = nav.isUnreadOnly() && nav.filter.active
   const { port1, port2 } = new MessageChannel()
   port1.onmessage = (e: MessageEvent<{ type: string; done: number; total: number; cached?: number }>) => {
      if (e.data?.type !== "pin-progress") return
      showPinProgress(e.data.done, e.data.total, e.data.cached)
      // Record the pin in the registry only once the SW confirms it actually
      // cached something. A fully-failed (offline) pin reports cached === 0 on
      // completion; recording it then would leave a phantom "Remove offline
      // copy" entry over bytes that were never saved. (The pin row lives in the
      // settings menu, which is rebuilt fresh on every open — nothing on screen
      // to re-render here.)
      if (e.data.done >= e.data.total) {
         if ((e.data.cached ?? 0) > 0) pinFilter(key, names, data.activeStore().mid)
         else unpinFilter(key, data.activeStore().mid)
      }
   }
   // base = the URL the page resolves pack names against (the active store's
   // root), so the SW pins at the exact URLs it will later fetch (self-hosted
   // store root, hosted /packs/, a mounted peer, …).
   controller.postMessage({ type: "pin", names, base: data.activeStore().base.href }, [port2])
   showPinProgress(0, names.length)
   requestPersistentStorage()
}

// Drop one pin scope from the registry and return the names that are now
// genuinely unreferenced. The subtraction is the point: shared latest packs
// (idx/L, data/L, meta/L), overlapping finalized packs, and an asset two saved
// articles both show must NOT be deleted while another pin still needs them.
// Shared by the filter-scope unpin and the ★-Saved asset release.
function dropPinScope(key: string): string[] {
   const mid = data.activeStore().mid
   const pins = listPins(mid)
   const names = pins.get(key)?.names ?? []
   const stillNeeded = new Set<string>()
   for (const [k, entry] of pins) if (k !== key) for (const n of entry.names) stillNeeded.add(n)
   unpinFilter(key, mid)
   return names.filter((n) => !stillNeeded.has(n))
}

function unpinCurrentFilter(): void {
   const controller = navigator.serviceWorker?.controller
   const toDelete = dropPinScope(pinKey())
   if (controller) controller.postMessage({ type: "unpin", names: toDelete, base: data.activeStore().base.href })
   // The pin row reads its state fresh on the next settings-menu open — the
   // menu that triggered this unpin closed when the row was clicked.
}

// PWA2 — ask the browser to make this origin's storage persistent, the first
// time the user does something that means "keep these bytes".
//
// The SW's PINNED bucket is exempt from SRR's OWN eviction, which is all the
// eviction SRR controls: under storage pressure the browser can still evict the
// whole origin, taking the pinned packs and every saved article's media with it.
// One call converts the offline-pin feature from best-effort to durable, and it
// is the pin that earns it — asking on boot would be a prompt for something the
// user has not asked for yet. Fire-and-forget: a refusal (or a browser with no
// such API) leaves today's behaviour exactly as it was.
let persistenceAsked = false

function requestPersistentStorage(): void {
   if (persistenceAsked) return
   persistenceAsked = true
   void navigator.storage
      ?.persist?.()
      .then((granted) => console.info(granted ? "storage: persistent" : "storage: best-effort (not granted)"))
      .catch(() => {})
}

// FMT2a — a ★-saved article's self-hosted media, pinned for as long as it is
// saved. Its TEXT already survives forever (immutable packs); its images and
// video do not, because expiration deletes the assets/ objects once the feed's
// retention window passes. Nothing server-side can help — the saved set is
// device-local — so the device that saved it is the one that has to keep them.
//
// One registry scope per saved article, so releasing one never touches an asset
// another saved article (or a pinned filter) still shows.
function savedPinKey(chron: number): string {
   return nav.SAVED_TOKEN + ":" + chron
}

export async function syncSavedAssets(chron: number, saved: boolean): Promise<void> {
   const controller = navigator.serviceWorker?.controller
   if (!controller) return // dev / harness / insecure context — the SW is inert
   const store = data.activeStore()
   const key = savedPinKey(chron)
   if (!saved) {
      const toDelete = dropPinScope(key)
      if (toDelete.length) controller.postMessage({ type: "unpin", names: toDelete, base: store.base.href })
      return
   }
   // Warm for the article on screen; one data-pack read when the save came from
   // a list row instead.
   const article = await data.loadArticle(chron)
   // Re-check the set: the un-save path is SYNCHRONOUS, so a star tapped twice
   // over a cold pack runs it to completion inside this await and finds no
   // registry entry to release yet. Pinning after that would leave an un-saved
   // article's media in PINNED — a bucket enforceCacheBounds never touches and
   // only a matching unpin clears — with a registry entry that also makes those
   // names read as "still needed" when some other scope is released.
   if (!nav.isSaved(chron)) return
   const names = extractAssetKeys(article?.c ?? "")
   if (names.length === 0) return
   pinFilter(key, names, store.mid)
   controller.postMessage({ type: "pin", names, base: store.base.href })
   requestPersistentStorage()
}

// Tell the service worker which store roots are mounted (docs/MULTI-STORE-SPEC.md
// §5.1) — the FIX for PWA0: the deployed reader's home base (cdn.llera.eu) is
// cross-origin to its shell origin, so the SW's old origin-equality gate never
// cached a production pack. Posting the mounted roots lets it route + cache them.
// Called on boot, on every mount-table change, and whenever a new SW takes
// control (a fresh worker starts with no roots and falls back to own-origin).
export function postMounts(): void {
   const controller = navigator.serviceWorker?.controller
   if (!controller) return // dev / harness / insecure context — the SW is inert anyway
   // Built from the mount TABLE, not the booted stores, so it is valid BEFORE
   // data.init() (which is what lets the SW route a peer's boot fetches). A root
   // that never boots is harmless — the SW just knows it may cache under it.
   const roots = data
      .mountRecords()
      .filter((r) => !r.del)
      .map((r) => ({
         mid: r.id,
         base: r.url,
         cred: r.cred ? "include" : "same-origin",
         role: r.role,
      }))
   controller.postMessage({ type: "mounts", roots })
}

// Returns the pin menu row entry for the current filter, or null when pinning
// is not available (no SW controller, or a saved/search scope). `onError` is the
// app's error popup — the one app-level dependency in this module, passed in by
// the caller (menus.ts) rather than imported, so nothing here points back at the
// orchestrator.
export function pinMenuEntry(onError: (e: unknown) => void): { label: string; action: () => void } | null {
   if (!navigator.serviceWorker?.controller) return null
   if (nav.filter.saved || nav.filter.search) return null
   const key = pinKey()
   if (isPinned(key, data.activeStore().mid)) {
      return { label: "Remove offline copy", action: unpinCurrentFilter }
   }
   return {
      label: "Download for offline",
      action: () => void pinCurrentFilter().catch((e) => onError(e)),
   }
}
