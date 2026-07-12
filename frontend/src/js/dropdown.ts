import { getImgProxy, isValidProxy, normalizeProxy, setImgProxy } from "./fmt"
import { exportProfile, importProfile } from "./profile"
import { getSyncUrl, isValidSyncUrl, normalizeSyncUrl, setSyncUrl, syncNow } from "./sync"

const imgProxyDialog = document.querySelector<HTMLElement>(".srr-imgproxy-dialog")
const backupDialog = document.querySelector<HTMLElement>(".srr-backup-dialog")
const syncDialog = document.querySelector<HTMLElement>(".srr-sync-dialog")

// The original toolbar dropdown menus (filter picker + ⋯ settings) were retired
// when those moved into the config surface; that surface was itself dissolved —
// the filter picker is now its own full-viewport overlay (picker.ts) and the
// settings came back here as an anchored menu on the list's now-viewing
// readout (showContextMenu).
// closeAllDropdowns stays as a no-op so its remaining callers — gestures.ts
// (toolbar-hide) and the image-proxy / backup modals — keep working without a
// dropdown to close.
export function closeAllDropdowns(): void {}

function divEl(className: string): HTMLDivElement {
   const d = document.createElement("div")
   d.className = className
   return d
}

// editorInput builds an editor's <input> — typing clears any invalid marker,
// and the initial focus is scheduled for after the row is attached.
function editorInput(type: string, className: string, ariaLabel: string): HTMLInputElement {
   const input = document.createElement("input")
   input.type = type
   input.className = className
   input.setAttribute("aria-label", ariaLabel)
   input.addEventListener("input", () => input.classList.remove("srr-input-invalid"))
   queueMicrotask(() => input.focus())
   return input
}

// editorKeys wires the shared editor keymap: Enter commits; Escape cancels
// the edit only — stopPropagation keeps the document-level Escape handler
// from also closing the whole dropdown.
function editorKeys(input: HTMLInputElement, commit: () => void, cancel: () => void): void {
   input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
         e.preventDefault()
         commit()
      } else if (e.key === "Escape") {
         e.preventDefault()
         e.stopPropagation()
         cancel()
      }
   })
}

function btn(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
   const b = document.createElement("button")
   b.type = "button"
   b.className = className
   b.textContent = text
   b.setAttribute("aria-label", label)
   b.addEventListener("click", onClick)
   return b
}

// imgProxyBody is the editable content of the image-proxy dialog: a URL-prefix
// input plus the action row — Save commits after isValidProxy, Disable commits
// "" to turn the proxy off (shown only when one is currently set), Cancel
// discards. Enter commits from the input, Escape cancels — both via `close`,
// which the caller wires to tear the dialog down. Returns a fragment dropped into
// the dialog's stable .srr-imgproxy-body host (replaceChildren, so re-opens don't
// stack). The proxy only affects reader images, so a commit just persists the
// prefix for the next reader open; there's nothing on screen to re-render.
function imgProxyBody(close: () => void): DocumentFragment {
   const frag = document.createDocumentFragment()
   const input = editorInput("url", "srr-imgproxy-input", "Image proxy URL prefix (empty disables)")
   input.placeholder = "proxy.example/?url="
   input.value = getImgProxy()

   const commit = (raw: string) => {
      const next = raw.trim()
      if (!isValidProxy(next)) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      // Scheme is optional (https default) and a host/path gets a trailing "/".
      const value = normalizeProxy(next)
      if (value !== getImgProxy()) setImgProxy(value)
      close()
   }
   editorKeys(input, () => commit(input.value), close)

   const actions = divEl("srr-imgproxy-actions")
   // Disable sits apart (far left, CSS margin) — a destructive-ish "turn it off"
   // only worth offering when a proxy is actually set; otherwise Save-of-empty
   // already covers it.
   if (getImgProxy())
      actions.append(btn("srr-dialog-btn srr-imgproxy-clear", "disable image proxy", "Disable", () => commit("")))
   actions.append(
      btn("srr-dialog-btn srr-imgproxy-cancel", "cancel", "Cancel", close),
      btn("srr-dialog-btn srr-dialog-primary srr-imgproxy-save", "save image proxy", "Save", () => commit(input.value)),
   )
   frag.append(input, actions)
   return frag
}

// ── Modal shell ──────────────────────────────────────────────────────────────
// One shared shell for the centered modals (image proxy / backup / sync). They
// are real modals — dimmed backdrop, focus trapped inside, Escape and a backdrop
// click both cancel — distinct from the toast-style .srr-popup. The keydown
// handler is capture-phase + stopPropagation so Escape closes only the dialog
// (not app.ts's document-level Escape) and Tab wraps within it; on close, focus
// returns to whatever opened it. Body content is (re)built per open into the
// dialog's stable host node, so re-opens never stack a second editor; the single
// module-level closer also means opening any modal closes whichever was open.
let activeClose: (() => void) | null = null

function openModal(dialog: HTMLElement, body: HTMLElement, build: (close: () => void) => Node): void {
   if (activeClose) activeClose() // never stack two opens
   const restore = document.activeElement as HTMLElement | null

   const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
         e.preventDefault()
         e.stopPropagation()
         close()
      } else if (e.key === "Tab") {
         const f = dialog.querySelectorAll<HTMLElement>("input, button, textarea")
         if (f.length === 0) return
         const first = f[0]
         const last = f[f.length - 1]
         if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
         } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
         }
      }
   }
   // mousedown (like the popup's outside-close) only on the backdrop itself —
   // the card is a child, so a click on the input/buttons leaves target ≠ dialog.
   const onDown = (e: MouseEvent) => {
      if (e.target === dialog) close()
   }
   const close = () => {
      dialog.classList.remove("srr-open")
      body.replaceChildren()
      document.removeEventListener("keydown", onKey, true)
      dialog.removeEventListener("mousedown", onDown)
      activeClose = null
      restore?.focus()
   }
   activeClose = close

   body.replaceChildren(build(close)) // editorInput focuses the field on attach
   dialog.classList.add("srr-open")
   document.addEventListener("keydown", onKey, true)
   dialog.addEventListener("mousedown", onDown)
}

// showImgProxyDialog opens the centered image-proxy modal (built fresh each time
// so the input re-seeds from storage).
export function showImgProxyDialog(): void {
   if (!imgProxyDialog) return
   openModal(imgProxyDialog, imgProxyDialog.querySelector<HTMLElement>(".srr-imgproxy-body")!, imgProxyBody)
}

// syncBody is the editable content of the sync dialog: the endpoint-URL input
// plus the action row, the same editor shape as imgProxyBody. Saving a NEW url
// kicks a MANUAL cycle immediately (the one-reader merge: raise seen from the
// endpoint's blob, adopt its saved set when newer, then push) so enabling sync
// seeds the endpoint / takes over its stored progress without waiting for the
// next reading session — a fresh device's empty seen map takes the endpoint's
// progress wholesale, every value being a raise from absent. The config status
// footer reports how it went.
function syncBody(close: () => void): DocumentFragment {
   const frag = document.createDocumentFragment()
   const input = editorInput("url", "srr-sync-input", "Sync endpoint URL (empty disables)")
   input.placeholder = "sync.example.com/profile"
   input.value = getSyncUrl()

   const commit = (raw: string) => {
      const next = raw.trim()
      if (!isValidSyncUrl(next)) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      // Scheme is optional (https default); unlike the image proxy, no trailing
      // "/" is appended — the value is a full endpoint, not a prefix.
      const value = normalizeSyncUrl(next)
      if (value !== getSyncUrl()) {
         setSyncUrl(value)
         if (value) void syncNow({ manual: true })
      }
      close()
   }
   editorKeys(input, () => commit(input.value), close)

   const actions = divEl("srr-sync-actions")
   // Disable sits apart (far left, CSS margin), same as the image-proxy dialog.
   if (getSyncUrl()) actions.append(btn("srr-dialog-btn srr-sync-clear", "disable sync", "Disable", () => commit("")))
   actions.append(
      btn("srr-dialog-btn srr-sync-cancel", "cancel", "Cancel", close),
      btn("srr-dialog-btn srr-dialog-primary srr-sync-save", "save sync endpoint", "Save", () => commit(input.value)),
   )
   frag.append(input, actions)
   return frag
}

export function showSyncDialog(): void {
   if (!syncDialog) return
   openModal(syncDialog, syncDialog.querySelector<HTMLElement>(".srr-sync-body")!, syncBody)
}

// ── Anchored context menu ─────────────────────────────────────────────────────
// A minimal anchored menu of action rows floated above its anchor — every
// current anchor sits in the bottom toolbar, so "above" keeps it clear of the
// pinned bar. Two callers: the frontier menu (a secondary gesture — right-click
// / long-press / the keyboard menu key — on the next pill / lane readout) and
// the list's settings menu (a plain tap on the gear). Built on the fly and
// removed on close (no skeleton node to keep in sync). It shares the modals'
// activeClose slot, so a menu and a modal never stack. Escape / an outside
// press / a scroll all dismiss; focus lands on the container (arrows enter and
// step the items, wrapping) and returns to the anchor on close.
//
// Item shape: `checked` makes the row a menuitemcheckbox (aria-checked; CSS
// draws the ✓) — pass a boolean to mark a toggle row, leave undefined for a
// plain action row. `disabled` renders the row inert (skipped by the arrows,
// unclickable) — for an action whose precondition isn't met (e.g. search while
// the index rebuilds), kept visible so the capability isn't hidden.
// `opts.footer` appends a non-interactive block under the items (the settings
// menu's status readout), set off by a rule (CSS .srr-ctxmenu-footer).
export type MenuItem = { label: string; action: () => void; checked?: boolean; disabled?: boolean }

export function showContextMenu(anchor: HTMLElement, items: MenuItem[], opts?: { footer?: HTMLElement }): void {
   if (activeClose) activeClose() // never stack two opens
   if (items.length === 0) return
   const menu = divEl("srr-ctxmenu")
   menu.setAttribute("role", "menu")
   for (const item of items) {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "srr-ctxmenu-item"
      if (item.checked !== undefined) {
         b.setAttribute("role", "menuitemcheckbox")
         b.setAttribute("aria-checked", String(item.checked))
      } else {
         b.setAttribute("role", "menuitem")
      }
      if (item.disabled) b.disabled = true
      b.textContent = item.label
      b.addEventListener("click", () => {
         close()
         item.action()
      })
      menu.appendChild(b)
   }
   if (opts?.footer) {
      opts.footer.classList.add("srr-ctxmenu-footer")
      menu.appendChild(opts.footer)
   }

   const focusables = () => [...menu.querySelectorAll<HTMLButtonElement>(".srr-ctxmenu-item:not(:disabled)")]
   const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
         e.preventDefault()
         e.stopPropagation() // the dialog discipline: never reach app.ts's Escape
         close()
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
         e.preventDefault()
         e.stopPropagation() // ...nor the reader's arrow navigation
         const f = focusables()
         const at = f.indexOf(document.activeElement as HTMLButtonElement)
         // From the container (no item focused yet) the arrows enter at the
         // matching end; from an item they step with wrap-around.
         const next =
            at === -1
               ? e.key === "ArrowDown"
                  ? 0
                  : f.length - 1
               : (at + (e.key === "ArrowDown" ? 1 : -1) + f.length) % f.length
         f[next]?.focus()
      } else if (e.key === "Tab") {
         // Trap Tab within the items (wrapping), like the modal shell — otherwise
         // focus tabs out to the page behind the still-open floating menu.
         e.preventDefault()
         e.stopPropagation()
         const f = focusables()
         if (f.length === 0) return
         const at = f.indexOf(document.activeElement as HTMLButtonElement)
         const next = at === -1 ? (e.shiftKey ? f.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + f.length) % f.length
         f[next]?.focus()
      }
   }
   // pointerdown (not click) so the press that dismisses never also activates
   // whatever sits under the menu; a press inside the menu proceeds to its item.
   const onDown = (e: Event) => {
      if (!menu.contains(e.target as Node)) close()
   }
   // Capture phase (scroll doesn't bubble). A scroll of the surface UNDER the menu
   // displaces its anchor — dismiss. But the menu is height-capped + overflow-y:auto
   // (below), and its OWN overflow scroll reaches this same capture listener
   // (capture fires for a non-bubbling scroll targeted at a descendant), so ignore
   // scrolls that originate inside it — otherwise scrolling to the clipped rows
   // self-closes the menu, defeating the max-height cap.
   const onScroll = (e: Event) => {
      if (!menu.contains(e.target as Node)) close()
   }
   const close = () => {
      menu.remove()
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("scroll", onScroll, true)
      activeClose = null
      anchor.focus()
   }
   activeClose = close

   document.body.appendChild(menu)
   // Horizontally centered on the opener, clamped inside the viewport. Pinned
   // ABOVE the anchor by default (menus open off the bottom-fixed toolbar); but if
   // the space above can't hold the menu AND there's more room below, flip to a
   // top-pin under the anchor. Either way cap max-height to the chosen side and
   // scroll (overflow-y:auto in CSS) so no row clips off-screen — and a near-top
   // anchor flips down instead of collapsing to a ~0-height empty box.
   const margin = 8
   const gap = 6
   const r = anchor.getBoundingClientRect()
   menu.style.left = `${Math.max(margin, Math.min(r.left + r.width / 2 - menu.offsetWidth / 2, window.innerWidth - menu.offsetWidth - margin))}px`
   const above = r.top - gap - margin
   const below = window.innerHeight - r.bottom - gap - margin
   if (above >= menu.offsetHeight || above >= below) {
      menu.style.bottom = `${window.innerHeight - r.top + gap}px`
      menu.style.maxHeight = `${Math.max(0, above)}px`
   } else {
      menu.style.top = `${r.bottom + gap}px`
      menu.style.maxHeight = `${Math.max(0, below)}px`
   }
   document.addEventListener("keydown", onKey, true)
   document.addEventListener("pointerdown", onDown, true)
   // A scroll under the open menu displaces its context — dismiss (capture: the
   // list surface scrolls the window, but a scrollable article body may not bubble;
   // onScroll ignores the menu's own overflow scroll so the height cap stays usable).
   window.addEventListener("scroll", onScroll, true)
   // Focus the container, not the first item — a pointer-opened menu must not
   // paint an item pre-selected (:focus-visible fires on programmatic focus);
   // the arrows (above) enter the items, so Shift+F10 keyboard flows still work.
   menu.tabIndex = -1
   menu.focus()
}

// Hook set by app.ts so the backup dialog can trigger a list rerender +
// toolbar refresh after a successful import — without dropdown.ts importing app.ts.
// Tests can pass their own callback directly to showBackupDialog(cb).
let profileImportHook: (() => void) | undefined

export function setProfileImportHook(fn: () => void): void {
   profileImportHook = fn
}

// showBackupDialog opens the backup/restore modal. An optional `onImported`
// callback overrides the module-level hook (used by tests).
export function showBackupDialog(onImported?: () => void): void {
   if (!backupDialog) return
   openModal(backupDialog, backupDialog.querySelector<HTMLElement>(".srr-backup-body")!, (close) =>
      backupBody(close, onImported),
   )
}

// backupBody builds the backup/restore modal's content: the export textarea
// (+ copy / download), a divider, and the import textarea + prefs checkbox +
// Import button.
function backupBody(close: () => void, onImported?: () => void): DocumentFragment {
   const frag = document.createDocumentFragment()

   // Export section: read-only textarea pre-filled with the current profile.
   const exportLabel = document.createElement("label")
   exportLabel.className = "srr-backup-label"
   exportLabel.textContent = "Your current data (copy or download to back up)"
   const exportArea = document.createElement("textarea")
   exportArea.className = "srr-backup-export srr-backup-textarea"
   exportArea.readOnly = true
   exportArea.setAttribute("aria-label", "Export data")
   exportArea.rows = 4
   exportArea.value = exportProfile()

   const exportActions = divEl("srr-backup-export-actions")

   // Copy button: tries Clipboard API, falls back to select+execCommand.
   const copyBtn = btn("srr-dialog-btn srr-backup-copy", "copy to clipboard", "Copy", () => {
      const text = exportArea.value
      if (navigator.clipboard?.writeText) {
         void navigator.clipboard.writeText(text)
      } else {
         exportArea.select()
         document.execCommand("copy")
      }
   })

   // Download button: creates a temporary Blob + anchor.
   const dlBtn = btn("srr-dialog-btn srr-backup-download", "download as JSON file", "Download .json", () => {
      const blob = new Blob([exportArea.value], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "srr-profile.json"
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
   })

   exportActions.append(copyBtn, dlBtn)
   exportLabel.appendChild(exportArea)
   frag.append(exportLabel, exportActions)

   // Divider
   const hr = document.createElement("hr")
   hr.className = "srr-backup-sep"
   frag.append(hr)

   // Import section: paste textarea + prefs checkbox + Import button.
   const importLabel = document.createElement("label")
   importLabel.className = "srr-backup-label"
   importLabel.textContent = "Paste a backup here to restore"
   const importArea = document.createElement("textarea")
   importArea.className = "srr-backup-import srr-backup-textarea"
   importArea.setAttribute("aria-label", "Paste backup data")
   importArea.placeholder = '{"v":1,...}'
   importArea.rows = 4
   importArea.addEventListener("input", () => {
      errEl.textContent = ""
      errEl.hidden = true
   })
   importLabel.appendChild(importArea)

   // "Also import preferences" checkbox — default OFF.
   const prefsRow = divEl("srr-backup-prefs-row")
   const prefsCheck = document.createElement("input")
   prefsCheck.type = "checkbox"
   prefsCheck.className = "srr-backup-prefs"
   prefsCheck.id = "srr-backup-prefs-check"
   const prefsCheckLabel = document.createElement("label")
   prefsCheckLabel.htmlFor = "srr-backup-prefs-check"
   prefsCheckLabel.textContent = "Also import preferences (image proxy, unread-only filter)"
   prefsRow.append(prefsCheck, prefsCheckLabel)

   // Inline error message (hidden until an import fails). role=alert makes it an
   // assertive live region: the node is hidden+empty until a failure, so setting
   // its text and unhiding announces the message to screen readers.
   const errEl = document.createElement("span")
   errEl.className = "srr-backup-import-error"
   errEl.setAttribute("role", "alert")
   errEl.hidden = true

   const importBtn = btn("srr-dialog-btn srr-dialog-primary srr-backup-import-btn", "import backup", "Import", () => {
      const result = importProfile(importArea.value, { prefs: prefsCheck.checked })
      if (!result.ok) {
         errEl.textContent = result.error ?? "Import failed"
         errEl.hidden = false
         return
      }
      close()
      ;(onImported ?? profileImportHook)?.()
   })

   frag.append(importLabel, prefsRow, errEl, importBtn)
   return frag
}
