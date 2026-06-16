import * as data from "./data"
import { getImgProxy, isValidProxy, setImgProxy, srcColorIndex } from "./fmt"
import * as nav from "./nav"

const menus = document.querySelectorAll<HTMLElement>(".srr-dropdown-menu")
const btns = document.querySelectorAll<HTMLElement>(".srr-dropdown-btn")
const imgProxyDialog = document.querySelector<HTMLElement>(".srr-imgproxy-dialog")

// The list surface hooks the channel menu's filter actions: when the app is on
// the list, picking a channel/tag/[ALL]/★ Saved re-filters the list in place
// instead of opening the reader at a resume position. Optional so the reader-only
// callers (and the existing test suite) keep the original behavior — the default
// host reports "not the list" and the menu falls through to guard(switchFilter).
export interface ChannelMenuHost {
   viewIsList: () => boolean
   selectFilter: (token: string) => void // "" = [ALL]; token = tag name, channel id, or ~saved
}
const READER_HOST: ChannelMenuHost = {
   viewIsList: () => false,
   selectFilter: () => {},
}

// Sentinel data-values for the overflow menu's action rows — UI actions, not
// filter tokens, so the onClick intercepts them instead of routing anywhere.
const JUMP_DATE = "~jump-date"
const IMG_PROXY = "~img-proxy"

let isOpen = false

export function closeAllDropdowns(): void {
   unreadFill = null
   if (!isOpen) return
   menus.forEach((m) => {
      // Closing a menu the user was keyboard-navigating must not drop focus
      // on <body>; hand it back to the menu's button (the standard menu
      // pattern, and the only way Escape keeps a keyboard user oriented).
      if (m.contains(document.activeElement)) (m.previousElementSibling as HTMLElement | null)?.focus()
      m.classList.remove("srr-open")
   })
   btns.forEach((b) => b.setAttribute("aria-expanded", "false"))
   isOpen = false
}

// Keyboard-reachable rows of an open menu: menuitem (and the "Unseen only"
// menuitemcheckbox) anchors not hidden inside a collapsed tag group (the header
// itself stays reachable) and not hidden by the unseen-only filter (`.srr-hidden`,
// on the row or its tag group).
function menuItems(menu: HTMLElement): HTMLElement[] {
   return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"]')).filter(
      (el) =>
         !el.closest(".srr-hidden") &&
         !(el.classList.contains("srr-tag-item") && el.parentElement?.classList.contains("srr-tag-collapsed")),
   )
}

// Roving menu focus — the keyboard contract role="menu" promises. Capture
// phase + stopPropagation, because app.ts binds the same arrow keys to filter
// cycling on the document bubble path; with a menu open the arrows must move
// through it instead. Inline-editor inputs keep their own keys (the proxy
// editor handles Enter/Escape itself). Enter already activates a focused
// anchor natively; Space is the menu-pattern addition.
document.addEventListener(
   "keydown",
   (e) => {
      if (!isOpen || (e.target as HTMLElement).tagName === "INPUT") return
      // Own captured menus only, and only while still attached — a re-imported
      // module instance (tests) or a swapped skeleton must never double-handle.
      const menu = Array.from(menus).find((m) => m.classList.contains("srr-open") && document.contains(m))
      if (!menu) return
      const items = menuItems(menu)
      if (items.length === 0) return
      const idx = items.indexOf(document.activeElement as HTMLElement)
      const move = (to: number) => {
         e.preventDefault()
         e.stopPropagation()
         items[((to % items.length) + items.length) % items.length].focus()
      }
      if (e.key === "ArrowDown") move(idx + 1)
      else if (e.key === "ArrowUp") move(idx === -1 ? items.length - 1 : idx - 1)
      else if (e.key === "Home") move(0)
      else if (e.key === "End") move(items.length - 1)
      else if (e.key === " " && idx !== -1) {
         e.preventDefault()
         e.stopPropagation()
         items[idx].click()
      }
   },
   true,
)

function createLink(value: string, text: string, className?: string): HTMLAnchorElement {
   const a = document.createElement("a")
   a.href = "#"
   a.dataset.value = value
   a.textContent = text
   a.setAttribute("role", "menuitem")
   if (className) a.className = className
   return a
}

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

// fillMenu (re)builds an open menu's content in place. The delegated onclick
// lives on the menu element itself, so it survives replaceChildren — the
// editor swap re-renders without touching open/close state.
function fillMenu(dd: HTMLElement, buildContent: (frag: DocumentFragment) => void): void {
   dd.replaceChildren()
   const frag = document.createDocumentFragment()
   buildContent(frag)
   dd.appendChild(frag)
}

function toggleDropdown(
   id: string,
   buildContent: (frag: DocumentFragment) => void,
   onClick: (value: string, e: MouseEvent) => Promise<void>,
): void {
   const dd = document.getElementById(id)!
   const wasOpen = dd.classList.contains("srr-open")
   // One menu at a time: opening one closes the other (and resets the editor
   // flags + fill tokens), so the two toolbar dropdowns can't stack.
   closeAllDropdowns()
   if (wasOpen) return
   const btn = dd.previousElementSibling as HTMLElement
   dd.classList.add("srr-open")
   isOpen = true
   btn?.setAttribute("aria-expanded", "true")
   // The delegated click bubbles on to app.ts's window-level close handler,
   // which is what auto-closes the menu after a navigation selection. Handlers
   // that instead keep the menu open (the inline-editor swaps) get the event so
   // they can stopPropagation() and survive that close.
   dd.onclick = (e) => {
      const a = (e.target as HTMLElement).closest("a[data-value]") as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      onClick(a.dataset.value!, e)
   }
   fillMenu(dd, buildContent)
}

// A non-empty ferr on any of a channel's feeds marks the channel row (and the
// tag header hiding it when collapsed) with a dot; the row's title/aria-label
// carry the error text. The evidence already rides in db.gz — this only makes
// silent feed rot visible.
function channelErr(ch: IChannel): string {
   return (ch.feeds ?? [])
      .map((f) => f.ferr)
      .filter((e): e is string => !!e)
      .join("\n")
}

function errDot(): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-err-dot"
   s.setAttribute("aria-hidden", "true")
   return s
}

// The channel's source-color chip — the same per-channel color (data-src → --src)
// as its list rail and reader spine, so you pick a source here by the color you
// then see everywhere it appears.
function srcChip(chanId: number): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-src-chip"
   s.dataset.src = String(srcColorIndex(chanId))
   s.setAttribute("aria-hidden", "true")
   return s
}

function channelLink(ch: IChannel, className: string): HTMLAnchorElement {
   const a = createLink(String(ch.id), ch.title, className)
   const err = channelErr(ch)
   if (err) {
      a.title = err
      a.setAttribute("aria-label", `${ch.title} — feed error: ${err}`)
      a.prepend(errDot())
   }
   // Chip leftmost — color identity first, then any error dot, then the title.
   a.prepend(srcChip(ch.id))
   return a
}

// Unread badges fill in after the menu renders so a cold seen position (one
// lazy idx-pack fetch) never delays the menu itself; the common case (recent
// seen → resident latest pack) resolves in a microtask. `unreadFill` is the
// freshness token: a rebuild or close orphans a stale pass before it touches
// the DOM. Every channel with unseen articles badges its count — including one
// never seen on this device, which badges its full backlog (chanUnread) so a
// fresh device shows counts on the channels too and the row badges sum to their
// tag header (nav.tagUnreadFromCounts, the same counts map: a collapsed group
// still surfaces the activity inside it and the badge equals the unseen-only
// toolbar counter you land on when you open the tag). A channel read down to 0
// unseen badges nothing. When unseen-only is on, the same pass hides fully-read
// rows and tags (`.srr-hidden`): a per-channel count of 0 = nothing unseen and
// hides; any positive count (including a never-seen channel's backlog) has
// unseen content, so it stays.
let unreadFill: object | null = null

function unreadBadge(n: number): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-unread"
   s.textContent = n > 999 ? "999+" : String(n)
   return s
}

async function fillUnread(rows: [HTMLAnchorElement, IChannel][], headers: [HTMLAnchorElement, IChannel[]][]) {
   const my = {}
   unreadFill = my
   try {
      // One batched call reads the localStorage seen blob once for every row,
      // instead of nav.unreadCount per row re-parsing it. The single freshness
      // check guards every DOM write below — the tag header badge is derived
      // synchronously from this same counts map (nav.tagUnreadFromCounts:
      // never-seen members counted as fully unread, == the unseen-only toolbar
      // counter), so there's no second await pass re-scanning the idx packs.
      const counts = await nav.unreadCounts(rows.map(([, ch]) => ch))
      if (my !== unreadFill) return
      const hideRead = nav.isUnreadOnly()
      // The row/group you're currently viewing must never self-hide mid-session:
      // reading the active tag/channel down to 0 unseen THIS session would else
      // drop its `.srr-active` styling and make it keyboard-unreachable
      // (menuItems skips `.srr-hidden`) while you're still on it. The toolbar
      // counter uses a frozen snapshot, so it stays visible regardless. The
      // active key is `""` (no exemption), a single tag name, or a channel id.
      const activeKey = nav.getCurrentFilterKey()
      for (const [a, ch] of rows) {
         const n = counts.get(ch.id)!
         if (n > 0) a.prepend(unreadBadge(n))
         if (hideRead && n === 0 && String(ch.id) !== activeKey) a.classList.add("srr-hidden")
      }
      headers.forEach(([h, group]) => {
         const n = nav.tagUnreadFromCounts(group, counts)
         if (n > 0) h.insertBefore(unreadBadge(n), h.querySelector(".srr-tag-toggle"))
         // Hide the whole group when no member has unseen content (>0 or -1) —
         // unless it's the active tag, which stays put while you read it down.
         if (hideRead && h.dataset.value !== activeKey && group.every((ch) => counts.get(ch.id) === 0))
            h.closest(".srr-tag-group")?.classList.add("srr-hidden")
      })
   } catch {
      // Best-effort decoration; the menu works without badges.
   }
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
   input.placeholder = "https://proxy/?url="
   input.value = getImgProxy()

   const commit = (raw: string) => {
      const next = raw.trim()
      if (!isValidProxy(next)) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      if (next !== getImgProxy()) setImgProxy(next)
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

// showImgProxyDialog opens the centered image-proxy modal (built fresh each time
// so the input re-seeds from storage). It's a real modal — dimmed backdrop, focus
// trapped inside, Escape and a backdrop click both cancel — distinct from the
// toast-style .srr-popup. The keydown handler is capture-phase + stopPropagation
// so Escape closes only the dialog (not app.ts's document-level Escape) and Tab
// wraps within it; on close, focus returns to whatever opened it (the ⋯ button
// when launched from the overflow menu, since closeAllDropdowns hands focus there).
let closeImgProxy: (() => void) | null = null

export function showImgProxyDialog(): void {
   const dialog = imgProxyDialog
   if (!dialog) return
   closeAllDropdowns() // hands focus to the ⋯ button when launched from the menu
   if (closeImgProxy) closeImgProxy() // never stack two opens
   const body = dialog.querySelector<HTMLElement>(".srr-imgproxy-body")!
   const restore = document.activeElement as HTMLElement | null

   const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
         e.preventDefault()
         e.stopPropagation()
         close()
      } else if (e.key === "Tab") {
         const f = dialog.querySelectorAll<HTMLElement>("input, button")
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
      closeImgProxy = null
      restore?.focus()
   }
   closeImgProxy = close

   body.replaceChildren(imgProxyBody(close)) // editorInput focuses the field on attach
   dialog.classList.add("srr-open")
   document.addEventListener("keydown", onKey, true)
   dialog.addEventListener("mousedown", onDown)
}

// The overflow / settings menu (toolbar ⋯ button, list-only): "Jump to a date"
// (relocated off the toolbar — a lower-frequency navigation aid) and "Image
// proxy…" (opens the centered settings dialog). Both rows are navigable anchors;
// the proxy editing moved out of the menu into showImgProxyDialog's modal.
export function showOverflowMenu(onJumpDate: () => void = () => {}): void {
   toggleDropdown(
      "srr-overflow-menu",
      (frag) => {
         frag.append(createLink(JUMP_DATE, "Jump to a date…"), createLink(IMG_PROXY, "Image proxy…"))
      },
      async (value) => {
         if (value === JUMP_DATE) {
            // Open the native picker while the click's transient activation is
            // still live (showPicker needs it), then close the menu.
            onJumpDate()
            closeAllDropdowns()
         } else if (value === IMG_PROXY) {
            showImgProxyDialog() // closes the menu itself, then opens the modal
         }
      },
   )
}

// The jump control (toolbar 🗓 button, list-only): no dropdown, no time presets,
// no text-entry step — clicking it opens the browser's *native* date picker
// straight away on its paired hidden <input type="date">. openDatePicker clamps
// the calendar to the archive span [first_fetched, today] and pops it (showPicker
// rides the button click's transient activation; focus is the fallback where
// showPicker is unavailable — older engines, jsdom). dateJump, wired to the
// input's change, hands local midnight of the chosen day to onPick; app.ts then
// repositions the LIST to the first article at-or-after that day (nav.seek + the
// list's anchor) — it does NOT open the reader, so picking a date scrubs the
// timeline of the list you're browsing. ("Latest" lives on the resume button.)
function dateValue(d: Date): string {
   return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function openDatePicker(input: HTMLInputElement): void {
   input.max = dateValue(new Date())
   input.min = data.db.first_fetched ? dateValue(new Date(data.db.first_fetched * 1000)) : ""
   // Start empty so picking the same day twice still fires change (= re-jumps).
   input.value = ""
   try {
      input.showPicker()
   } catch {
      input.focus()
   }
}

export function dateJump(input: HTMLInputElement, onPick: (ts: number) => void): void {
   if (!input.value) return
   const [y, m, d] = input.value.split("-").map(Number)
   onPick(new Date(y, m - 1, d).getTime() / 1000)
}

export function showChannelMenu(
   currentTag: string,
   guard: (fn: () => Promise<IShowFeed>) => void,
   host: ChannelMenuHost = READER_HOST,
): void {
   const { tagged, sortedTags, untagged } = data.groupChannelsByTag()
   const current = nav.getCurrentFilterKey()
   const cls = (base: string, v: string) => (v === current ? `${base} srr-active`.trim() : base)

   const buildContent = (frag: DocumentFragment) => {
      const unreadRows: [HTMLAnchorElement, IChannel][] = []
      const headerRows: [HTMLAnchorElement, IChannel[]][] = []
      // Filter selector — [ALL] / ★ Saved / tags / channels. (Unseen-only moved to
      // a toolbar toggle; the image-proxy + date-jump live in the ⋯ overflow menu.)
      frag.appendChild(createLink("", "[ALL]", cls("", "")))
      // "★ Saved" — the per-article collection, surfaced once there's something
      // in it. Same selection path as a channel/tag (host.selectFilter on the
      // list, guard(switchFilter) in the reader); the count rides as a badge.
      const savedN = nav.savedCount()
      if (savedN > 0) {
         const savedRow = createLink(nav.SAVED_TOKEN, "★ Saved", cls("", nav.SAVED_TOKEN))
         const num = document.createElement("span")
         num.className = "srr-saved-num"
         num.textContent = String(savedN)
         savedRow.appendChild(num)
         frag.appendChild(savedRow)
      }
      for (const tag of sortedTags) {
         const group = tagged.get(tag)!
         const expanded = tag === currentTag && tag !== current
         const div = divEl(expanded ? "srr-tag-group" : "srr-tag-group srr-tag-collapsed")
         const header = createLink(tag, tag, cls("srr-tag-header", tag))
         if (group.some((ch) => channelErr(ch))) header.prepend(errDot())
         headerRows.push([header, group])
         const toggle = document.createElement("span")
         toggle.className = "srr-tag-toggle"
         toggle.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            div.classList.toggle("srr-tag-collapsed")
         })
         header.appendChild(toggle)
         div.appendChild(header)
         for (const ch of group) {
            const item = channelLink(ch, cls("srr-tag-item", String(ch.id)))
            unreadRows.push([item, ch])
            div.appendChild(item)
         }
         frag.appendChild(div)
      }
      if (sortedTags.length > 0 && untagged.length > 0) frag.appendChild(divEl("srr-tag-sep"))
      for (const ch of untagged) {
         const item = channelLink(ch, cls("", String(ch.id)))
         unreadRows.push([item, ch])
         frag.appendChild(item)
      }
      void fillUnread(unreadRows, headerRows)
   }

   toggleDropdown("srr-channel-menu", buildContent, async (value) => {
      // A channel/tag/[ALL]/★ Saved selection: on the list surface, re-filter the
      // list (the host shows that filter's feed); in the reader, resume that
      // filter at its current position. (switchFilter maps ""→[ALL] and ~saved.)
      if (host.viewIsList()) {
         host.selectFilter(value)
         return
      }
      guard(() => nav.switchFilter(value))
   })
}
