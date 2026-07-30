// menus.ts — the two anchored menus and the frontier gestures behind one of them.
//
// The SETTINGS menu is the now-viewing readout's card (.srr-feed, list-only):
// search, the contextual offline-pin row, the Stores / image-proxy / backup /
// sync dialog openers, and the freshness status footer. The FRONTIER menu is the
// reader's next pill: the two seen-frontier gestures (mark all read / mark unread
// from here), deliberately off the visible chrome. Both are built fresh per open
// by dropdown.showContextMenu, so nothing here re-renders in place.
//
// It also owns the frontier gestures' UI half — the reconciliation every raise or
// rewind shares (afterFrontierMove) and the RDR1/RDR2 undo snackbar offer — plus
// the Stores dialog's mount-table mutations. Imports pin-ui and search-ui (the
// two menus' rows point at them) but never reader.ts or app.ts: the reader
// re-derive and everything app-level arrive through MenuDeps.
import * as data from "./data"
import {
   showBackupDialog,
   showContextMenu,
   showImgProxyDialog,
   showMountsDialog,
   showShortcutsDialog,
   showSyncDialog,
   type MenuItem,
} from "./dropdown"
import { el } from "./els"
import * as list from "./list"
import { addMount, forgetStoreState, removeMount, type MountRecord } from "./mounts"
import * as nav from "./nav"
import * as picker from "./picker"
import { listPins } from "./pin"
import { pinMenuEntry, postMounts } from "./pin-ui"
import { enterSearch } from "./search-ui"
import { isSplit } from "./split"

export interface MenuDeps {
   // Which surface is showing — the frontier reconciliation rebuilds the list only
   // when it is the visible one (a display:none rebuild would pin zero row heights).
   view: () => "list" | "reader"
   // The retryable error popup (the pin row's only app-level need).
   showError: (e: unknown, retry?: () => void) => void
   // The transient, focus-free notice — the undo offer's surface.
   showSnackbar: (text: string, action?: { label: string; run: () => void }) => void
   hideSnackbar: () => void
   // The launcher badge + tab-title readout (RDR12): reading is what moves it.
   syncUnreadBadge: () => Promise<void>
   // Re-derive the reader after its filter bounds/mode shifted — a silent chrome
   // re-probe on a real article, a re-run switch on a placeholder. app.ts owns it
   // (it needs the guard mutex and the router's view state).
   reReadReader: () => void
}

let d: MenuDeps

export function setup(deps: MenuDeps): void {
   d = deps
}

// RDR1/RDR2 — after a landing (or a Mark all read) has raised the frontier,
// report a LARGE consumption and offer to take it back. Ordinary reading moves
// the frontier by one article and says nothing; what needs a signal is the jump
// that swallows a backlog, which until now happened silently and for good.
//
// Deliberately after the fact and off the navigation path: the size is measured
// with the same tally the badges use (nav.frontierUndoSize), so the number shown
// is the number the badges just lost.
const UNDO_MIN_ARTICLES = 10

export async function offerFrontierUndo(): Promise<void> {
   const pending = nav.pendingFrontierUndo()
   // The MOUNT the offer is being made on, captured beside the snapshot itself.
   // The snackbar lives SNACKBAR_MS (8s) and nothing takes it down on a store
   // switch — app.ts's switchMount, a mount pick, and route()'s back/forward
   // setActive all leave it up and clickable — so by the time the button is
   // pressed the active lane may be a different store, where this snapshot's
   // feed keys and chrons mean different things entirely.
   const mid = data.activeStore().mid
   if (!pending) return
   let consumed: number
   try {
      consumed = await nav.frontierUndoSize(pending)
   } catch {
      return // a count blip is not worth an error popup for an optional offer
   }
   // A newer move superseded it mid-measurement: leave that one to its own
   // render rather than announcing a number we just recomputed against a
   // snapshot nobody is holding.
   if (nav.pendingFrontierUndo() !== pending) return
   // Asked and answered, whether or not it clears the bar below. This runs on
   // EVERY render, and a render that raised no frontier of its own (a step
   // backwards, a filter switch, any read under ★ Saved / search) leaves the
   // previous snapshot pending — so without marking it, one big landing would
   // re-announce itself for the rest of the session.
   nav.markFrontierUndoOffered()
   if (consumed < UNDO_MIN_ARTICLES) return
   d.showSnackbar(`Marked ${consumed} read`, {
      label: "Undo",
      run: () => {
         d.hideSnackbar()
         // The mount comes FIRST — every term after it is only meaningful
         // within one store, and afterFrontierMove() reconciles whichever lane
         // is showing NOW, not the one the raise happened in. `pending`, not
         // "whatever is pending now": the button undoes the move whose size it
         // is showing, even if reading has moved a frontier again in the
         // seconds it has been up.
         if (mid === data.activeStore().mid && nav.undoFrontierMove(pending)) afterFrontierMove()
      },
   })
}

// One reconciliation for both seen-frontier gestures (they differ only in the
// direction the frontier moved). Under unread-only the filter membership
// changed (each member's bound re-derives from the moved frontier): re-apply
// the filter, then rebuild the list if it's the visible surface — or just
// invalidate its built window when it's hidden behind the reader (rebuilding a
// display:none list would pin zero row heights; the next show() rebuilds).
// With read items shown the membership is untouched: re-grey the visible rows
// in place (a hidden list re-greys on its return path — show()'s refresh()).
// An open reader re-probes its chrome silently (prev/next + the pending pill
// re-derive from the re-raised bounds; no content re-render, no scroll),
// mirroring refreshAfterStore's reader branch.
// Split view flips "is the list the visible surface?" from a question about
// `view` to a question about the layout: the pane is on screen whatever surface
// holds focus, so both branches below must treat it as visible or it keeps
// showing the pre-move row set (stale membership under unread-only, stale dots
// otherwise) with its observer torn down and no rebuild scheduled.
function afterFrontierMove() {
   const listVisible = d.view() === "list" || isSplit()
   if (nav.isUnreadOnly()) {
      nav.applyFilter([...nav.filterTokens()])
      if (listVisible) void list.rerender()
      else list.invalidate()
   } else if (listVisible) {
      list.refresh()
   }
   void d.syncUnreadBadge()
   // A frontier move from the ARMED "not started" placeholder (pos is -1, always a
   // single-token filter — the only way nav.switchFilter produces it) re-runs the
   // switch so the surface re-derives — mark-all-read turns it into the caught-up
   // placeholder, Next disarmed. A real article just re-probes its chrome.
   d.reReadReader()
}

// Mark the whole current feed/tag/[ALL] selection read — the frontier menu's
// first action. A pure frontier raise in nav (sync-safe by construction).
function markAllRead() {
   if (!nav.markAllRead()) return
   afterFrontierMove()
   // Rides the same undo as a large landing (RDR2): one gesture, one way back,
   // and no confirm dialog standing in front of the common case.
   void offerFrontierUndo()
}

// The explicit unread rewind — the frontier menu's second action and the
// reader's U key: everything from the current article (inclusive) to the
// latest becomes unread across the current selection — the one gesture allowed
// to lower a seen frontier (nav.markUnreadFrom; plain backward navigation no
// longer does). The reader stays on the article; only its chrome re-derives.
export function markUnreadFromHere(): void {
   const chron = nav.currentChron()
   if (chron >= 0 && nav.markUnreadFrom(chron)) afterFrontierMove()
}

// The frontier menu — both seen-frontier gestures live behind a secondary
// gesture (right-click / long-press / the keyboard menu key), deliberately off
// the visible chrome: occasional whole-backlog actions don't earn a button.
// Its one anchor is the readout of exactly the walk the gestures operate on:
// the reader's next pill (the pending count they raise past or restore). The
// list's lane readout is deliberately NOT an anchor — it's the picker opener,
// and a second meaning there shadowed the browser's own menu. Saved/search are
// seen-neutral peek modes — no items, and the gesture falls through to the
// browser's own menu.
function frontierMenuItems(): { label: string; action: () => void }[] {
   if (nav.isSavedFilter() || nav.isSearchFilter()) return []
   const items: { label: string; action: () => void }[] = []
   if (nav.filterFeeds().size > 0) items.push({ label: "Mark all read", action: markAllRead })
   if (nav.currentChron() >= 0) items.push({ label: "Mark unread from here", action: markUnreadFromHere })
   return items
}

// Wire one frontier-menu anchor. Desktop right-click and Android long-press
// both arrive as `contextmenu` (so does Shift+F10 / the menu key on a focused
// anchor — the menu stays keyboard-reachable); iOS Safari never fires
// contextmenu on non-links, so a touch-held timer covers it there. `held`
// marks a timer-opened menu so the click that follows the finger lift is
// swallowed (it would otherwise also navigate) and so
// a late native contextmenu (Android fires both) doesn't reopen the menu it
// just opened; any new touch resets it.
export function bindFrontierMenu(anchor: HTMLElement): void {
   let hold = 0
   let held = false
   const open = (): boolean => {
      const items = frontierMenuItems()
      if (items.length > 0) showContextMenu(anchor, items)
      return items.length > 0
   }
   anchor.addEventListener("contextmenu", (e) => {
      clearTimeout(hold)
      if (held || open()) e.preventDefault()
   })
   anchor.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return
      held = false
      clearTimeout(hold)
      hold = window.setTimeout(() => (held = open()), 500)
   })
   for (const ev of ["pointerup", "pointercancel", "pointerleave"])
      anchor.addEventListener(ev, () => clearTimeout(hold))
   anchor.addEventListener(
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

// ── Filter picker & settings menu ─────────────────────────────────────────────

// The now-viewing readout's anchored settings menu — everything the retired
// config surface owned minus the filter picker (its own overlay now, opened
// from the filter button) and the Show-read toggle (moved to the picker's header):
// search, the contextual offline-pin row, and the three dialog openers, with the
// freshness / status readout as a quiet footer. Items derive fresh on every open
// (pin label, search availability), so nothing needs re-rendering in place.
function settingsMenuItems(): MenuItem[] {
   const items: MenuItem[] = [
      // Search leaves the menu for the list with the search bar open; inert
      // (listed but disabled) while the meta index is still rebuilding.
      { label: "Search articles…", action: () => void enterSearch(), disabled: !nav.searchAvailable() },
   ]
   const pin = pinMenuEntry(d.showError)
   if (pin) items.push(pin)
   items.push(
      // The shortcuts card's pointer home (RDR10). `?` opens the same card, but a
      // shortcut is the one place a keymap must not be the ONLY way in.
      { label: "Keyboard shortcuts…", action: showShortcutsDialog },
      { label: "Stores…", action: openMountsDialog },
      { label: "Image proxy…", action: showImgProxyDialog },
      { label: "Backup / Restore…", action: () => showBackupDialog() },
      { label: "Sync…", action: showSyncDialog },
   )
   return items
}

// The per-mount state chip for the Stores dialog (docs/MULTI-STORE-SPEC.md §8.3),
// same wording as the picker switcher's mountChip.
function mountChipText(mid: string): string {
   const s = data.mountStatus(mid)
   if (s.state === "ok") return ""
   if (s.kind === "toonew") return "Too new"
   if (s.kind === "offline") return navigator.onLine === false ? "Offline" : "Unreachable"
   return "Error"
}

// Apply a changed mount table: adopt it in data (boots new mounts, drops gone
// ones), re-post the roots to the SW (§5.1), and repaint an open picker. The
// list/reader keep their current lane unless it was unmounted (data falls back
// to home), so no forced re-render here.
export function afterMountChange(recs: MountRecord[]): void {
   void data.applyMountTable(recs).then(() => {
      postMounts()
      if (picker.isOpen()) picker.render()
   })
}

// Open the Stores dialog (§3): mount by URL, unmount a peer, or forget its
// history. The dialog is pure UI; this module owns the mounts.ts mutations here.
function openMountsDialog(): void {
   showMountsDialog({
      list: () =>
         data
            .mountRecords()
            .filter((r) => !r.del)
            .map((r) => ({ id: r.id, url: r.url, label: r.label, role: r.role, chip: mountChipText(r.id) })),
      add: (url) => {
         const res = addMount(data.mountRecords(), url)
         if (!res) return "Enter a full https:// store URL"
         afterMountChange(res.records)
         return null
      },
      remove: (mid) => afterMountChange(removeMount(data.mountRecords(), mid)),
      forget: (mid) => {
         // Drop this mount's pinned SW-cache entries BEFORE forgetStoreState
         // clears pinsKey(mid) — that registry is the only record of those
         // cached URLs, and the PINNED bucket is eviction-exempt, so a
         // pinned-then-forgotten peer would otherwise leak its bytes forever.
         // The mount's own url gives the same base the pin used (Store.base is
         // new URL(url)), so the SW resolves the identical absolute URLs; unpin
         // needs no live root (it deletes unconditionally, unlike pin).
         const controller = navigator.serviceWorker?.controller
         const rec = data.mountRecords().find((r) => r.id === mid)
         if (controller && rec) {
            const names = [...new Set([...listPins(mid).values()].flatMap((e) => e.names))]
            if (names.length) controller.postMessage({ type: "unpin", names, base: new URL(rec.url).href })
         }
         forgetStoreState(mid)
         afterMountChange(removeMount(data.mountRecords(), mid))
      },
   })
}

// The footer node of the open settings menu, kept so the sync status callback
// can refresh the readout in place while the menu is up; stale once the menu
// closes (isConnected gates the refill).
let settingsStatus: HTMLElement | null = null

export function openSettingsMenu(): void {
   const footer = document.createElement("div")
   picker.renderStatus(footer)
   settingsStatus = footer
   showContextMenu(el.feed, settingsMenuItems(), { footer })
}

// Refill an OPEN settings menu's status footer in place — sync's status hook
// after each cycle. A closed menu's footer is disconnected and skipped (it
// rebuilds on the next open).
export function refreshSettingsStatus(): void {
   if (settingsStatus?.isConnected) picker.renderStatus(settingsStatus)
}
