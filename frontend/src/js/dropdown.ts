import { getImgProxy, isValidProxy, normalizeProxy, setImgProxy } from "./fmt"
import { exportProfile, importProfile } from "./profile"
import { getSyncUrl, isValidSyncUrl, normalizeSyncUrl, setSyncUrl, syncNow } from "./sync"

const imgProxyDialog = document.querySelector<HTMLElement>(".srr-imgproxy-dialog")
const backupDialog = document.querySelector<HTMLElement>(".srr-backup-dialog")
const syncDialog = document.querySelector<HTMLElement>(".srr-sync-dialog")

// Exported for picker.ts, which builds its overlay rows the same way.
export function divEl(className: string): HTMLDivElement {
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

// The chrome-button factory — class + accessible name + glyph + click. Exported
// because it is the shape every icon/text button in the app is built from, and
// the surfaces that were re-typing it (player queue rows, the lightbox controls)
// already import this module.
export function btn(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
   const b = document.createElement("button")
   b.type = "button"
   b.className = className
   b.textContent = text
   b.setAttribute("aria-label", label)
   b.addEventListener("click", onClick)
   return b
}

// The one URL-editor dialog body shared by the image-proxy and sync modals: a
// URL input plus the action row — Save commits after `valid`, Disable commits
// "" to turn the feature off (shown only when a value is currently set —
// destructive-ish, sits apart far left via CSS margin; otherwise Save-of-empty
// already covers it), Cancel discards. Enter commits from the input, Escape
// cancels — both via `close`, which the caller wires to tear the dialog down.
// Returns a fragment dropped into the dialog's stable body host
// (replaceChildren, so re-opens don't stack). Class names derive from `cls`
// (srr-<cls>-input/-actions/-clear/-cancel/-save) — tests select on them.
interface UrlEditor {
   cls: string // class-name infix: "imgproxy" | "sync"
   placeholder: string
   ariaLabel: string // the input's aria-label
   disableLabel: string // the Disable button's aria-label
   saveLabel: string // the Save button's aria-label
   get: () => string
   valid: (v: string) => boolean
   normalize: (v: string) => string
   set: (v: string) => void
   onSet?: (v: string) => void // runs after a CHANGED value is stored
}

function urlEditorBody(close: () => void, ed: UrlEditor): DocumentFragment {
   const frag = document.createDocumentFragment()
   const input = editorInput("url", `srr-${ed.cls}-input`, ed.ariaLabel)
   input.placeholder = ed.placeholder
   input.value = ed.get()

   const commit = (raw: string) => {
      const next = raw.trim()
      if (!ed.valid(next)) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      // Scheme is optional (https default) — see urlish.ts for the shape rules.
      const value = ed.normalize(next)
      if (value !== ed.get()) {
         ed.set(value)
         ed.onSet?.(value)
      }
      close()
   }
   editorKeys(input, () => commit(input.value), close)

   const actions = divEl(`srr-${ed.cls}-actions`)
   if (ed.get()) actions.append(btn(`srr-dialog-btn srr-${ed.cls}-clear`, ed.disableLabel, "Disable", () => commit("")))
   actions.append(
      btn(`srr-dialog-btn srr-${ed.cls}-cancel`, "cancel", "Cancel", close),
      btn(`srr-dialog-btn srr-dialog-primary srr-${ed.cls}-save`, ed.saveLabel, "Save", () => commit(input.value)),
   )
   frag.append(input, actions)
   return frag
}

// imgProxyBody is the image-proxy flavor of the URL editor. The proxy only
// affects reader images, so a commit just persists the prefix for the next
// reader open; there's nothing on screen to re-render.
function imgProxyBody(close: () => void): DocumentFragment {
   return urlEditorBody(close, {
      cls: "imgproxy",
      placeholder: "proxy.example/?url=",
      ariaLabel: "Image proxy URL prefix (empty disables)",
      disableLabel: "disable image proxy",
      saveLabel: "save image proxy",
      get: getImgProxy,
      valid: isValidProxy,
      normalize: normalizeProxy,
      set: setImgProxy,
   })
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

// wrapTabFocus is the boundary half of a modal Tab trap, shared by the modal
// shell here, the error popup (app.ts), and the info dialog (picker.ts): on the
// container's first/last focusable (per the caller's selector), Tab/Shift+Tab
// wrap to the other end instead of escaping to the page behind; mid-list Tabs
// fall through to the browser's own order.
export function wrapTabFocus(e: KeyboardEvent, container: ParentNode, selector: string): void {
   const f = container.querySelectorAll<HTMLElement>(selector)
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

function openModal(dialog: HTMLElement, body: HTMLElement, build: (close: () => void) => Node): void {
   if (activeClose) activeClose() // never stack two opens
   const restore = document.activeElement as HTMLElement | null

   const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
         e.preventDefault()
         e.stopPropagation()
         close()
      } else if (e.key === "Tab") {
         wrapTabFocus(e, dialog, "input, button, textarea")
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

// syncBody is the sync flavor of the URL editor. Saving a NEW url kicks a
// MANUAL cycle immediately (the one-reader merge: raise seen from the
// endpoint's blob, adopt its saved set when newer, then push) so enabling sync
// seeds the endpoint / takes over its stored progress without waiting for the
// next reading session — a fresh device's empty seen map takes the endpoint's
// progress wholesale, every value being a raise from absent. The config status
// footer reports how it went.
function syncBody(close: () => void): DocumentFragment {
   return urlEditorBody(close, {
      cls: "sync",
      placeholder: "sync.example.com/profile",
      ariaLabel: "Sync endpoint URL (empty disables)",
      disableLabel: "disable sync",
      saveLabel: "save sync endpoint",
      get: getSyncUrl,
      valid: isValidSyncUrl,
      normalize: normalizeSyncUrl,
      set: setSyncUrl,
      onSet: (value) => {
         if (value) void syncNow({ manual: true })
      },
   })
}

export function showSyncDialog(): void {
   if (!syncDialog) return
   openModal(syncDialog, syncDialog.querySelector<HTMLElement>(".srr-sync-body")!, syncBody)
}

// ── Mounts dialog (docs/MULTI-STORE-SPEC.md §3, §6.3) ─────────────────────────
// Manage the mounted store table: mount a new store by URL, unmount a peer, or
// remove-and-forget its reading history. Built DYNAMICALLY (not from an
// index.html skeleton) so it needs no design.html drift-guard change; it reuses
// the shared modal CSS (.srr-mounts-dialog joins the grouped backdrop/card
// selectors). app.ts owns the mount mutations (mounts.ts + data.applyMountTable
// + the SW mounts post) and passes them as hooks; the dialog is pure UI and
// re-renders itself after each action.
export interface MountRow {
   id: string
   url: string
   label: string
   role: string
   chip: string // "" when healthy, else the state chip ("Offline" / "Too new" / …)
}
export interface MountsDialogHooks {
   list: () => MountRow[]
   add: (url: string) => string | null // returns an error message, or null on success
   remove: (mid: string) => void
   forget: (mid: string) => void
}

// The lazily-built modal skeleton both JS-only dialogs (Stores, Keyboard
// shortcuts) share — built on first open so index.html/design.html need no markup
// for them, then memoized in the returned closure. `label` is the accessible name
// where it differs from the visible title; passing undefined keeps the element
// without one, which is what the Stores dialog has always shipped.
function lazyDialog(cls: string, title: string, label?: string): () => HTMLElement {
   let dialog: HTMLElement | null = null
   return () => {
      if (dialog) return dialog
      const d = divEl(`srr-${cls}-dialog`)
      d.setAttribute("role", "dialog")
      d.setAttribute("aria-modal", "true")
      if (label) d.setAttribute("aria-label", label)
      const card = divEl(`srr-${cls}-card`)
      const h = document.createElement("h2")
      h.className = `srr-${cls}-title`
      h.textContent = title
      card.append(h, divEl(`srr-${cls}-body`))
      d.append(card)
      document.body.appendChild(d)
      dialog = d
      return d
   }
}

const ensureMountsDialog = lazyDialog("mounts", "Stores")

function mountsContent(close: () => void, hooks: MountsDialogHooks, rerender: () => void): DocumentFragment {
   const frag = document.createDocumentFragment()
   const listBox = divEl("srr-mounts-list")
   for (const m of hooks.list()) {
      const row = divEl("srr-mount-item")
      const label = document.createElement("div")
      label.className = "srr-mount-item-label"
      label.textContent = m.label // already resolved by menus.ts through mounts.mountLabel
      const url = document.createElement("div")
      url.className = "srr-mount-item-url"
      url.textContent = m.url
      row.append(label, url)
      if (m.chip) {
         const chip = document.createElement("span")
         chip.className = "srr-mount-item-chip"
         chip.textContent = m.chip
         label.appendChild(chip)
      }
      if (m.role !== "home") {
         const actions = divEl("srr-mount-item-actions")
         actions.append(
            btn("srr-dialog-btn srr-mount-remove", "unmount store", "Unmount", () => {
               hooks.remove(m.id)
               rerender()
            }),
            btn("srr-dialog-btn srr-mount-forget", "remove and forget reading history", "Forget", () => {
               hooks.forget(m.id)
               rerender()
            }),
         )
         row.appendChild(actions)
      }
      listBox.appendChild(row)
   }
   frag.appendChild(listBox)

   // Add-a-store row: a URL input + Add button. Invalid / unmountable URLs mark
   // the input and show the error, keeping the dialog open.
   const input = editorInput("url", "srr-mount-input", "Store URL to mount")
   input.placeholder = "cdn.example.org/store/"
   const err = document.createElement("div")
   err.className = "srr-mount-err"
   const doAdd = () => {
      const e = hooks.add(input.value.trim())
      if (e) {
         input.classList.add("srr-input-invalid")
         err.textContent = e
         input.focus()
         return
      }
      err.textContent = ""
      input.value = ""
      rerender()
   }
   editorKeys(input, doAdd, close)
   const addRow = divEl("srr-mount-add")
   addRow.append(input, btn("srr-dialog-btn srr-dialog-primary srr-mount-add-btn", "mount store", "Add", doAdd))
   frag.append(addRow, err)

   const actions = divEl("srr-mounts-actions")
   actions.append(btn("srr-dialog-btn srr-mounts-close", "close", "Close", close))
   frag.appendChild(actions)
   return frag
}

export function showMountsDialog(hooks: MountsDialogHooks): void {
   const dialog = ensureMountsDialog()
   const body = dialog.querySelector<HTMLElement>(".srr-mounts-body")!
   const build = (close: () => void): Node => {
      const rerender = () => body.replaceChildren(mountsContent(close, hooks, rerender))
      return mountsContent(close, hooks, rerender)
   }
   openModal(dialog, body, build)
}

// ── Keyboard shortcuts card (RDR10) ───────────────────────────────────────────
// The app has two keymaps — app.ts's KEY_ACTIONS (reader) and the list branch of
// the same keydown listener — and until now the only thing that ever named a key
// was a per-control `aria-keyshortcuts`, which nothing surfaces visually. This is
// the listing: static content, one row per binding, grouped by the surface the
// binding acts on.
//
// It lives HERE rather than in app.ts because two callers need it (the `?` key
// and the settings menu, and menus.ts must not import the orchestrator) and
// because every dialog in the app shares one shell. Built dynamically like the
// Stores dialog, so index.html/design.html need no matching skeleton.
//
// ⚠ This table is a hand-kept mirror of app.ts's keydown listener. A binding
// added, removed or re-lettered there belongs here in the same commit.
const SHORTCUT_GROUPS: ReadonlyArray<{ title: string; rows: ReadonlyArray<[string[], string]> }> = [
   {
      title: "Anywhere",
      rows: [
         [["/"], "Search titles"],
         [["?"], "This list"],
         [["Esc"], "Close an overlay, or switch list ⇄ reader"],
      ],
   },
   {
      title: "List",
      rows: [
         [["A", "←"], "Select the older article"],
         [["D", "→"], "Select the newer article"],
         [["W", "↑"], "Previous filter"],
         [["S", "↓"], "Next filter"],
         [["Enter"], "Open the selected article"],
      ],
   },
   {
      title: "Reader",
      rows: [
         [["A", "←"], "Previous article"],
         [["D", "→"], "Next article"],
         [["W", "↑"], "Previous filter"],
         [["S", "↓"], "Next filter"],
         [["Q"], "Oldest article in this filter"],
         [["E"], "Newest article in this filter"],
         [["B"], "Save / unsave (★)"],
         [["P"], "Add / remove the enclosure in the playlist"],
         [["U"], "Mark unread from here"],
         [["F"], "Open the original in a new tab"],
      ],
   },
   // Its own group rather than a fourth "Anywhere" row: `L` works on both
   // surfaces but only above the split breakpoint, and a key listed as working
   // anywhere that does nothing on a phone is worse documentation than none.
   {
      title: "Desktop",
      rows: [[["L"], "Hide or show the list pane"]],
   },
]

// The <h2> is the card's visible title AND its accessible name — a role=dialog
// without one announces as an unnamed group.
const ensureShortcutsDialog = lazyDialog("keys", "Keyboard shortcuts", "Keyboard shortcuts")

function shortcutsContent(close: () => void): DocumentFragment {
   const frag = document.createDocumentFragment()
   for (const group of SHORTCUT_GROUPS) {
      const section = divEl("srr-keys-group")
      const title = divEl("srr-keys-group-title")
      title.textContent = group.title
      section.appendChild(title)
      // A definition list is what a keymap IS — term (the keys) and description
      // (what they do) — so AT reads the pairing instead of two loose columns.
      const dl = document.createElement("dl")
      dl.className = "srr-keys-rows"
      for (const [keys, what] of group.rows) {
         const dt = document.createElement("dt")
         dt.className = "srr-keys-keys"
         keys.forEach((k, i) => {
            if (i > 0) {
               const or = document.createElement("span")
               or.className = "srr-keys-or"
               or.textContent = "or"
               dt.appendChild(or)
            }
            const kbd = document.createElement("kbd")
            kbd.textContent = k
            dt.appendChild(kbd)
         })
         const dd = document.createElement("dd")
         dd.className = "srr-keys-what"
         dd.textContent = what
         dl.append(dt, dd)
      }
      section.appendChild(dl)
      frag.appendChild(section)
   }
   const actions = divEl("srr-keys-actions")
   // The card is pure reading, so this button is also the modal shell's Tab-trap
   // anchor: openModal traps focus among "input, button, textarea", and a card
   // with none of those would have nothing to hold it.
   actions.append(btn("srr-dialog-btn srr-dialog-primary srr-keys-close", "close", "Close", close))
   frag.appendChild(actions)
   return frag
}

// Open the shortcuts card. Shares the modal shell with every other dialog —
// dimmed backdrop, Escape, backdrop press, the Tab trap and focus restored to
// whatever opened it (the `?` key's focus, or the settings-menu row).
export function showShortcutsDialog(): void {
   const dialog = ensureShortcutsDialog()
   openModal(dialog, dialog.querySelector<HTMLElement>(".srr-keys-body")!, shortcutsContent)
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

// Wire an anchor to open a context menu on the SECONDARY gesture, cross-platform.
// The menu's owner owns how a menu is summoned — the wiring encodes three
// platform facts that must not be re-discovered per anchor: desktop right-click,
// Android long-press AND Shift+F10 / the menu key on a focused anchor all arrive
// as `contextmenu`; iOS Safari fires none of them on non-links, so a 500ms
// touch-hold timer covers it there; and `held` marks a timer-opened menu so the
// click that follows the finger lift is swallowed (it would otherwise also run
// the anchor's primary action) and a late native contextmenu (Android fires
// both) doesn't reopen the menu it just opened — any new touch resets it.
// `items` derives fresh per open; an empty list falls through to the browser's
// own menu. Consumers: menus.ts's frontier menu, player.ts's queue-chip menu.
export function bindPressMenu(anchor: HTMLElement, items: () => MenuItem[]): void {
   let hold = 0
   let held = false
   const open = (): boolean => {
      const list = items()
      if (list.length > 0) showContextMenu(anchor, list)
      return list.length > 0
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
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
         // Arrows step; Tab is trapped within the items (wrapping), like the
         // modal shell — otherwise focus tabs out to the page behind the
         // still-open floating menu.
         e.preventDefault()
         e.stopPropagation() // ...nor the reader's arrow navigation
         const fwd = e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)
         const f = focusables()
         const at = f.indexOf(document.activeElement as HTMLButtonElement)
         // From the container (no item focused yet) enter at the matching end;
         // from an item, step with wrap-around.
         const next = at === -1 ? (fwd ? 0 : f.length - 1) : (at + (fwd ? 1 : -1) + f.length) % f.length
         f[next]?.focus()
      }
   }
   // Both dismissals are the same test — "did this happen OUTSIDE the menu?" — so
   // they are one function registered twice, for two reasons:
   //
   //   pointerdown (not click) so the press that dismisses never also activates
   //   whatever sits under the menu; a press inside the menu proceeds to its item.
   //
   //   scroll, capture phase (scroll doesn't bubble). A scroll of the surface UNDER
   //   the menu displaces its anchor — dismiss. But the menu is height-capped +
   //   overflow-y:auto (below) and its OWN overflow scroll reaches that same capture
   //   listener (capture fires for a non-bubbling scroll targeted at a descendant),
   //   so a scroll originating inside it must be ignored — otherwise scrolling to
   //   the clipped rows self-closes the menu, defeating the max-height cap.
   //
   // removeEventListener matches on (target, type, capture, reference), and the two
   // registrations differ in the first two, so sharing the reference is exact.
   const dismissOutside = (e: Event) => {
      if (!menu.contains(e.target as Node)) close()
   }
   const close = () => {
      menu.remove()
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("pointerdown", dismissOutside, true)
      window.removeEventListener("scroll", dismissOutside, true)
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
   document.addEventListener("pointerdown", dismissOutside, true)
   // A scroll under the open menu displaces its context — dismiss (capture: the
   // list surface scrolls the window, but a scrollable article body may not bubble;
   // onScroll ignores the menu's own overflow scroll so the height cap stays usable).
   window.addEventListener("scroll", dismissOutside, true)
   // Focus the container, not the first item — a pointer-opened menu must not
   // paint an item pre-selected (:focus-visible fires on programmatic focus);
   // the arrows (above) enter the items, so Shift+F10 keyboard flows still work.
   menu.tabIndex = -1
   menu.focus()
}

// showBackupDialog opens the backup/restore modal. An optional `onImported`
// callback hears about a successful import (tests use it); the app follows the
// import through the model, which profile.ts updates. Its `mountsChanged`
// argument lets the caller re-adopt the mount table at runtime when a RESTORE
// merged a differing `mnt` — the same re-adoption the sync-pull path does.
export function showBackupDialog(onImported?: (mountsChanged: boolean) => void): void {
   if (!backupDialog) return
   openModal(backupDialog, backupDialog.querySelector<HTMLElement>(".srr-backup-body")!, (close) =>
      backupBody(close, onImported),
   )
}

// backupBody builds the backup/restore modal's content: the export textarea
// (+ copy / download), a divider, and the import textarea + prefs checkbox +
// Import button.
function backupBody(close: () => void, onImported?: (mountsChanged: boolean) => void): DocumentFragment {
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
      // A restore runs mergeMountState (both modes), which may have moved the
      // `mnt` table; forward that so app.ts re-adopts it at runtime instead of
      // leaving the runtime mounts/SW routes/picker stale until a reload.
      onImported?.(result.mountsChanged === true)
   })

   frag.append(importLabel, prefsRow, errEl, importBtn)
   return frag
}
