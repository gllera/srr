// menus.ts — the two anchored menus and the frontier gestures behind one of them.
//
// The SETTINGS menu is the now-viewing readout's card (.srr-feed, list-only):
// search, the contextual offline-pin row, the Stores / image-proxy / backup /
// sync dialog openers, and the freshness status footer. The FRONTIER menu is the
// reader's next pill: the two seen-frontier gestures (mark all read / mark unread
// from here), deliberately off the visible chrome. Both are built fresh per open
// by dropdown.showContextMenu, so nothing here re-renders in place.
//
// It also owns the frontier gestures' UI half — the two write functions
// (markAllRead / markUnreadFromHere; the reconciliation itself is effects.ts's,
// over model.seen / model.frontierEpoch) and the RDR1/RDR2 undo snackbar offer —
// plus the Stores dialog's mount-table mutations. Imports pin-ui and search-ui (the
// two menus' rows point at them) but never reader.ts or app.ts: the reader
// re-derive and everything app-level arrive through MenuDeps.
import * as data from "./data"
import {
   bindPressMenu,
   showBackupDialog,
   showContextMenu,
   showImgProxyDialog,
   showMountsDialog,
   showReadingDialog,
   showShortcutsDialog,
   showSyncDialog,
   type MenuItem,
} from "./dropdown"
import { el } from "./els"
import { addMount, loadMounts, mountLabel, removeMount, type MountRecord } from "./mounts"
import * as model from "./model"
import * as nav from "./nav"
import * as picker from "./picker"
import { forgetMountState, pinMenuEntry, postMounts } from "./pin-ui"
import { enterSearch } from "./search-ui"
import { batch, onChange } from "./signals"

export interface MenuDeps {
   // The retryable error popup (the pin row's only app-level need).
   showError: (e: unknown, retry?: () => void) => void
   // The transient, focus-free notice — the undo offer's surface.
   showSnackbar: (text: string, action?: { label: string; run: () => void }) => void
   hideSnackbar: () => void
   // Re-run the lane switch under a reader PLACEHOLDER whose bounds just moved
   // (a real article's chrome is the readerChrome effect's). A navigation, so
   // app.ts owns it (S17).
   rerunPlaceholder: () => void
   // Run a mount-table adoption as ONE app command: `adopt` applies the table and
   // answers whether the ACTIVE store was unmounted, in which case app.ts lands on
   // the home store's [ALL] list. A navigation, so app.ts owns it — and holds
   // rendering across both, so no surface rebuilds under the unmounted store's
   // lane in between.
   rehome: (adopt: () => boolean) => void
}

let d: MenuDeps

// A merge that moved the mount table (a peer mounted on another device and
// pulled in by sync, or a restored backup) is adopted exactly as the Stores
// dialog adopts one (S14). One subscription however often setup() runs.
let stopMountMerge: (() => void) | null = null

export function setup(deps: MenuDeps): void {
   d = deps
   stopMountMerge?.()
   stopMountMerge = onChange(
      () => model.profileMountsRev(),
      () => afterMountChange(loadMounts()),
   )
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
         // within one store, and the write below is what every surface showing
         // NOW reconciles against, not the one the raise happened in. `pending`,
         // not "whatever is pending now": the button undoes the move whose size
         // it is showing, even if reading has moved a frontier again in the
         // seconds it has been up.
         if (mid === data.activeStore().mid) {
            // Batched: undoFrontierMove writes model.seen (and flushes) and
            // bumpFrontierEpoch writes model.frontierEpoch — one flush instead
            // of two, same reasoning as nav.markAllRead/markUnreadFrom.
            let moved = false
            batch(() => {
               moved = nav.undoFrontierMove(pending)
               if (moved) nav.bumpFrontierEpoch() // a bulk frontier move, like the raise it undoes (D1)
            })
            if (moved) d.rerunPlaceholder()
         }
      },
   })
}

// The two seen-frontier gestures. The frontier write IS the reconciliation: the
// list, the reader's chrome, the badge and an open picker are effects over
// model.seen / model.frontierEpoch. What is left here is the one thing an effect
// may not do — re-run the lane switch under a reader placeholder — and the undo
// offer, which answers this write rather than projecting any state.
function markAllRead() {
   if (!nav.markAllRead()) return
   // A frontier move from the ARMED "not started" placeholder (pos -1) re-runs
   // the switch, turning it into the caught-up placeholder.
   d.rerunPlaceholder()
   // Rides the same undo as a large landing (RDR2): one gesture, one way back.
   void offerFrontierUndo()
}

// The explicit unread rewind — the frontier menu's second action and the
// reader's U key: everything from the current article (inclusive) to the latest
// becomes unread across the current selection. The reader stays on the article.
export function markUnreadFromHere(): void {
   const chron = nav.currentChron()
   if (chron >= 0) nav.markUnreadFrom(chron)
}

// The frontier menu — both seen-frontier gestures live behind a secondary
// gesture (right-click / long-press / the keyboard menu key), deliberately off
// the visible chrome: occasional whole-backlog actions don't earn a button.
// Its one anchor is the readout of exactly the walk the gestures operate on:
// the reader's next pill (the pending count they raise past or restore). The
// list's lane readout is deliberately NOT an anchor — it's the picker opener,
// and a second meaning there shadowed the browser's own menu. Peek lanes (★
// Saved, search, …) are seen-neutral — no items, and the gesture falls
// through to the browser's own menu.
function frontierMenuItems(): MenuItem[] {
   if (nav.lanePeek()) return []
   const items: MenuItem[] = []
   if (nav.filterFeeds().size > 0) items.push({ label: "Mark all read", action: markAllRead })
   if (nav.currentChron() >= 0) items.push({ label: "Mark unread from here", action: markUnreadFromHere })
   return items
}

// Wire one frontier-menu anchor — dropdown.bindPressMenu owns the secondary-
// gesture wiring (right-click / long-press / menu key, and its platform quirks).
export function bindFrontierMenu(anchor: HTMLElement): void {
   bindPressMenu(anchor, frontierMenuItems)
}

// ── Admin navigation ──────────────────────────────────────────────────────────

// The admin page ships beside the reader (admin.html in the same bundle) and
// talks to `srr serve` on this origin. Resolved against the page, not "/", so a
// reader installed under a sub-path finds the admin installed with it.
function openAdmin(): void {
   location.assign(new URL("admin.html", location.href).href)
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
   // The visible home of the frontier menu's whole-backlog raise, which otherwise
   // lives only behind a long-press on the READER's next pill — a gesture nobody
   // finds, on a surface this menu isn't even on. Same function, same undo offer,
   // same scope (the lane the list is showing); absent where it would do nothing.
   if (!nav.lanePeek() && nav.filterFeeds().size > 0) items.push({ label: "Mark all as read", action: markAllRead })
   const pin = pinMenuEntry(d.showError)
   if (pin) items.push(pin)
   items.push(
      { label: "Reading…", action: showReadingDialog },
      // The shortcuts card's pointer home (RDR10). `?` opens the same card, but a
      // shortcut is the one place a keymap must not be the ONLY way in. It also
      // lists the touch gestures, each of which is otherwise invisible.
      { label: "Shortcuts and gestures…", action: showShortcutsDialog },
      { label: "Stores…", action: openMountsDialog },
      { label: "Image proxy…", action: showImgProxyDialog },
      { label: "Backup / Restore…", action: () => showBackupDialog() },
      { label: "Sync…", action: showSyncDialog },
      { label: "Admin…", action: openAdmin },
   )
   return items
}

// Apply a changed mount table: adopt it in data (boots new mounts, drops gone
// ones) and re-post the roots to the SW (§5.1). An open picker repaints through
// the pickerRows effect (data bumps mountsRev). The surfaces keep their lane —
// unless the ACTIVE store was unmounted: data then falls back to home before its
// first await, but the lane, the list and the hash still name the store that is
// gone, so the adoption runs inside app.ts's rehome command.
//
// The roots are posted as soon as data has applied the table (synchronously, so
// a new peer's fetches are routed from its first pack on) and again once the
// boots settle, success or not. A rejected adoption — the fallback's publish
// threw — is reported like any other failure, never left unhandled.
export function afterMountChange(recs: MountRecord[]): void {
   let adopted: Promise<string[]> = Promise.resolve([])
   d.rehome(() => {
      const was = data.activeStore().mid
      adopted = data.applyMountTable(recs)
      return data.activeStore().mid !== was
   })
   postMounts()
   void adopted.then(
      () => postMounts(),
      (e: unknown) => {
         postMounts()
         d.showError(e)
      },
   )
}

// Open the Stores dialog (§3): mount by URL, unmount a peer, or forget its
// history. The dialog is pure UI; this module owns the mounts.ts mutations here.
function openMountsDialog(): void {
   showMountsDialog({
      list: () =>
         data
            .mountRecords()
            .filter((r) => !r.del)
            // The chip wording is the picker switcher's mountChip — ONE owner for
            // the mount-status→text mapping (§8.3), so the two surfaces describing
            // the same mount cannot drift.
            .map((r) => ({
               id: r.id,
               url: r.url,
               // Through mountLabel, the one owner picker.ts and reader.ts
               // already use: an unlabeled HOME mount reads "Home" everywhere
               // else and its full URL here, and an unlabeled peer printed its
               // URL twice — once as the label line, once as the url line
               // directly below it.
               label: mountLabel(r),
               role: r.role,
               chip: picker.mountChip(data.mountStatus(r.id)),
            })),
      add: (url) => {
         const res = addMount(data.mountRecords(), url)
         if (!res) return "Enter a full https:// store URL"
         afterMountChange(res.records)
         return null
      },
      remove: (mid) => afterMountChange(removeMount(data.mountRecords(), mid)),
      forget: (mid) => {
         const rec = data.mountRecords().find((r) => r.id === mid)
         if (rec) forgetMountState(mid, rec.url)
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
