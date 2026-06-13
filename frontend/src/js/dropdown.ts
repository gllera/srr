import * as data from "./data"
import { getImgProxy, isValidProxy, setImgProxy, timeAgo } from "./fmt"
import { SEARCH_GRAM } from "./format.gen"
import * as nav from "./nav"
import * as search from "./search"

const menus = document.querySelectorAll<HTMLElement>(".srr-dropdown-menu")
const btns = document.querySelectorAll<HTMLElement>(".srr-dropdown-btn")

// The list surface hooks the channel menu's filter actions: when the app is on
// the list, picking a channel/tag/[ALL] (or flipping unseen-only) re-filters the
// list in place instead of opening the reader at a resume position. Optional so
// the reader-only callers (and the whole existing test suite) keep the original
// behavior unchanged — the default host reports "not the list" and the menu
// falls through to its guard(switchFilter)/guard(fromHash) reader paths.
export interface ChannelMenuHost {
   viewIsList: () => boolean
   selectFilter: (token: string) => void // "" = [ALL]; token = tag name or channel id
   reapplyFilter: () => void // re-render the list after an unseen-only flip, menu stays open
}
const READER_HOST: ChannelMenuHost = {
   viewIsList: () => false,
   selectFilter: () => {},
   reapplyFilter: () => {},
}

let isOpen = false
// Whether the chip row currently shows the image-proxy editor or the date
// editor instead of the chips. Reset on close so reopening starts collapsed.
let imgProxyEditing = false
let dateEditing = false

export function closeAllDropdowns(): void {
   imgProxyEditing = false
   dateEditing = false
   unreadFill = null
   peekFill = null
   searchFill = null
   clearTimeout(searchTimer)
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

// Keyboard-reachable rows of an open menu: menuitem anchors not hidden inside
// a collapsed tag group (the header itself stays reachable) and not hidden by
// the unseen-only filter (`.srr-hidden`, on the row or its tag group).
function menuItems(menu: HTMLElement): HTMLElement[] {
   return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
      (el) =>
         !el.closest(".srr-hidden") &&
         !(el.classList.contains("srr-tag-item") && el.parentElement?.classList.contains("srr-tag-collapsed")),
   )
}

// Roving menu focus — the keyboard contract role="menu" promises. Capture
// phase + stopPropagation, because app.ts binds the same arrow keys to filter
// cycling on the document bubble path; with a menu open the arrows must move
// through it instead. Inline-editor inputs keep their own keys (date/proxy
// editors handle Enter/Escape themselves). Enter already activates a focused
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

// editorRow is the inline-editor row scaffold (date/proxy editors, search
// input): clicks inside it configure, they don't navigate — both events stop
// propagating so app.ts's window-level "any click closes dropdowns" handler
// (and the menu's delegated onclick) never fire.
function editorRow(className: string): HTMLDivElement {
   const row = divEl(className)
   row.addEventListener("mousedown", (e) => e.stopPropagation())
   row.addEventListener("click", (e) => e.stopPropagation())
   return row
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

const IMG_PROXY_SENTINEL = "__imgproxy__"
const DATE_SENTINEL = "__date__"
const UNREAD_SENTINEL = "__unread__"

const IMG_ICON_SVG =
   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
   '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
   '<circle cx="9" cy="9" r="2"/>' +
   '<path d="M21 15l-5-5L5 21"/>' +
   "</svg>"

const LAST_ICON_SVG =
   '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
   '<path d="M4 5l12 7L4 19z"/>' +
   '<rect x="17" y="5" width="3" height="14"/>' +
   "</svg>"

const CAL_ICON_SVG =
   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
   '<rect x="3" y="4" width="18" height="17" rx="2"/>' +
   '<path d="M8 2v4M16 2v4M3 10h18"/>' +
   "</svg>"

// An eye: "show only what I haven't seen". On = unseen-only navigation active.
const UNREAD_ICON_SVG =
   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
   '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>' +
   '<circle cx="12" cy="12" r="3"/>' +
   "</svg>"

function iconChip(value: string, label: string, className: string, svg: string): HTMLAnchorElement {
   const a = createLink(value, "", className)
   a.setAttribute("aria-label", label)
   a.title = label
   a.innerHTML = svg
   return a
}

function lastChip(): HTMLAnchorElement {
   return iconChip("!last", "latest", "srr-last-chip", LAST_ICON_SVG)
}

function imgProxyIcon(): HTMLAnchorElement {
   const state = getImgProxy() === "" ? "off" : "on"
   return iconChip(IMG_PROXY_SENTINEL, `image proxy: ${state}`, `srr-imgproxy-icon srr-imgproxy-${state}`, IMG_ICON_SVG)
}

function dateIcon(): HTMLAnchorElement {
   return iconChip(DATE_SENTINEL, "jump to date", "srr-date-icon", CAL_ICON_SVG)
}

function unreadIcon(): HTMLAnchorElement {
   const state = nav.isUnreadOnly() ? "on" : "off"
   return iconChip(
      UNREAD_SENTINEL,
      `unseen-only (tags): ${state}`,
      `srr-unread-icon srr-unread-${state}`,
      UNREAD_ICON_SVG,
   )
}

// dateEditor swaps the chip row for a native date input: picking a day (the
// input's change event, or Enter) jumps to the first article at-or-after
// local midnight of that day — the same findChronForTimestamp path as the
// preset chips, but reaching arbitrarily deep into the archive. The input
// starts empty so change only fires once the date is complete. Since clicks
// here never bubble to the window close-handler (editorRow), commit closes
// the menu itself.
function dateEditor(guard: (fn: () => Promise<IShowFeed>) => void, rebuild: () => void): HTMLDivElement {
   const row = editorRow("srr-date-edit")
   const input = editorInput("date", "srr-date-input", "Jump to date")
   const dateValue = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
   input.max = dateValue(new Date())
   if (data.db.first_fetched) input.min = dateValue(new Date(data.db.first_fetched * 1000))

   // Browsers fire change again when Enter commits the typed value — `done`
   // keeps the pair from navigating twice.
   let done = false
   const commit = () => {
      if (done) return
      if (!input.value) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      const [y, m, d] = input.value.split("-").map(Number)
      const ts = new Date(y, m - 1, d).getTime() / 1000
      done = true
      closeAllDropdowns()
      guard(async () => nav.goTo(await data.findChronForTimestamp(ts)))
   }
   const cancel = () => {
      dateEditing = false
      rebuild()
   }

   input.addEventListener("change", commit)
   editorKeys(input, commit, cancel)
   row.append(input, btn("srr-date-cancel", "cancel date jump", "✕", cancel))
   return row
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

function channelLink(ch: IChannel, className: string): HTMLAnchorElement {
   const a = createLink(String(ch.id), ch.title, className)
   const err = channelErr(ch)
   if (err) {
      a.title = err
      a.setAttribute("aria-label", `${ch.title} — feed error: ${err}`)
      a.prepend(errDot())
   }
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

// imgProxyEditor is the inline editor row that replaces the chip row while
// configuring the proxy prefix: type + Enter/✓ commits (after isValidProxy),
// Escape cancels, ✕ commits "" (disables).
function imgProxyEditor(
   guard: (fn: () => Promise<IShowFeed>) => void,
   rebuild: () => void,
   reapply: () => void,
): HTMLDivElement {
   const row = editorRow("srr-imgproxy-edit")
   const input = editorInput("url", "srr-imgproxy-input", "Image proxy URL prefix (empty disables)")
   input.placeholder = "https://proxy/?url="
   input.value = getImgProxy()

   const commit = (raw: string, fromKeyboard = false) => {
      const next = raw.trim()
      if (!isValidProxy(next)) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      imgProxyEditing = false
      if (next !== getImgProxy()) {
         setImgProxy(next)
         // Re-render the active surface so the new prefix takes effect: the
         // reader re-renders the current article's images (fromHash), the list
         // re-renders its rows. On the list, fromHash would jump to the last
         // article (its hash has no position) — hence the surface-aware reapply.
         reapply()
      }
      rebuild()
      // rebuild() detaches the focused ✓/input, and the gated render() (from the
      // guard re-apply) won't steal focus to the title while the menu stays open
      // — so an Enter commit would strand focus on <body>. Mirror the eye-toggle:
      // hand focus back to the freshly-rebuilt chip on the keyboard (Enter) path.
      // A mouse user clicking ✓/✕ doesn't need it, so the button path is left be.
      if (fromKeyboard)
         document.querySelector<HTMLElement>(`#srr-channel-menu a[data-value="${IMG_PROXY_SENTINEL}"]`)?.focus()
   }

   editorKeys(
      input,
      () => commit(input.value, true),
      () => {
         imgProxyEditing = false
         rebuild()
      },
   )
   row.append(
      input,
      btn("srr-imgproxy-save", "save image proxy", "✓", () => commit(input.value)),
      btn("srr-imgproxy-clear", "disable image proxy", "✕", () => commit("")),
   )
   return row
}

// The headlines peek: a second toolbar dropdown (anchored on the counter
// button) listing the titles around the current position under the current
// filter — navigation stops being blind without any new data: titles already
// ride in the data packs the LRU holds. Rendered newest-first like a feed;
// rows fill in async after the menu opens (same freshness-token discipline as
// fillUnread) so a pack-boundary fetch never delays the menu itself.
let peekFill: object | null = null

// headlineRow is the peek-style result row shared by the headlines peek and
// the search results: title over "channel · age" meta, click = goTo(chron).
// Both display fallbacks — the "(untitled)" placeholder and the "[DELETED]"
// channel tombstone — live here, at the layer that renders them, so every
// consumer hands over raw wire fields and gets the same treatment.
function headlineRow(chron: number, titleText: string, chanId: number, when: number): HTMLAnchorElement {
   const a = createLink(String(chron), "")
   const title = divEl("srr-peek-title")
   title.textContent = titleText || "(untitled)"
   const meta = divEl("srr-peek-meta")
   meta.textContent = `${data.channelTitle(chanId)} · ${timeAgo(when)}`
   a.append(title, meta)
   return a
}

async function fillPeek(dd: HTMLElement): Promise<void> {
   const my = {}
   peekFill = my
   try {
      const items = await nav.peek()
      if (my !== peekFill) return
      const frag = document.createDocumentFragment()
      for (const it of items.reverse()) {
         const a = headlineRow(it.chron, it.title, it.s, it.when)
         if (it.current) {
            a.className = "srr-active"
            a.setAttribute("aria-current", "true")
         }
         frag.appendChild(a)
      }
      dd.replaceChildren(frag)
      // Center the current row in the scrollable menu (no-op under jsdom,
      // where offsetTop/clientHeight are 0).
      const cur = dd.querySelector<HTMLElement>("[aria-current]")
      if (cur) dd.scrollTop = Math.max(0, cur.offsetTop - (dd.clientHeight - cur.offsetHeight) / 2)
   } catch {
      // Best-effort: the menu just keeps its placeholder.
   }
}

export function showPeekMenu(guard: (fn: () => Promise<IShowFeed>) => void): void {
   toggleDropdown(
      "srr-peek-menu",
      (frag) => {
         const loading = divEl("srr-peek-loading")
         loading.textContent = "…"
         frag.appendChild(loading)
         void fillPeek(document.getElementById("srr-peek-menu")!)
      },
      async (value) => guard(() => nav.goTo(Number(value))),
   )
}

// The title search: a third toolbar dropdown (anchored on the magnifier
// button, `/` shortcut). The input row follows the inline-editor pattern
// (clicks inside it configure, they don't navigate); results stream in per
// shard from search.search() under the usual freshness-token discipline,
// rendered as peek-style rows (title over channel · age), click =
// nav.goTo(chron). An active channel/tag filter intersects results via
// nav.filter.matches on each hit's chan_id.
let searchFill: object | null = null
let searchTimer: ReturnType<typeof setTimeout> | undefined

const SEARCH_MAX = 100
const SEARCH_DEBOUNCE_MS = 200

async function fillSearch(q: string, results: HTMLElement): Promise<void> {
   const my = {}
   searchFill = my
   results.replaceChildren()
   if (!q.trim()) return
   // The status row doubles as the insertion anchor: hit rows land before it,
   // so batches streaming in per shard keep newest-first order.
   const status = divEl("srr-search-note")
   const short = search.shortQuery(q)
   status.textContent = short
      ? `Searching recent articles (a ${SEARCH_GRAM}+ letter word reaches the archive)…`
      : "Searching…"
   results.appendChild(status)
   let count = 0
   try {
      // The filter predicate rides into search() so the cap counts only
      // surviving hits — filtered and unfiltered queries get the same bound.
      const accept = (s: number, chron: number) => !nav.filter.active || nav.filter.matches(s, chron)
      for await (const batch of search.search(q, SEARCH_MAX, accept)) {
         if (my !== searchFill) return
         for (const hit of batch) results.insertBefore(headlineRow(hit.chron, hit.t, hit.s, hit.w), status)
         count += batch.length
      }
   } catch {
      if (my === searchFill) status.textContent = "Search failed — try again"
      return
   }
   if (my !== searchFill) return
   if (count === 0)
      status.textContent = short
         ? `No recent matches (a ${SEARCH_GRAM}+ letter word searches the archive)`
         : "No matches"
   else if (count >= SEARCH_MAX) status.textContent = `First ${SEARCH_MAX} matches — refine to reach older ones`
   else status.remove()
}

export function showSearchMenu(guard: (fn: () => Promise<IShowFeed>) => void): void {
   toggleDropdown(
      "srr-search-menu",
      (frag) => {
         if (!search.available()) {
            const note = divEl("srr-search-note")
            note.textContent = "Search index not published for this store yet"
            frag.appendChild(note)
            return
         }
         const row = editorRow("srr-search-edit")
         const input = editorInput("search", "srr-search-input", "Search article titles")
         input.placeholder = "Search titles…"
         const results = divEl("srr-search-results")
         input.addEventListener("input", () => {
            clearTimeout(searchTimer)
            searchTimer = setTimeout(() => void fillSearch(input.value, results), SEARCH_DEBOUNCE_MS)
         })
         // No Escape handling (editorKeys): this input IS the menu's main UI,
         // so Escape closing the whole dropdown is the right behavior.
         input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
               e.preventDefault()
               clearTimeout(searchTimer)
               void fillSearch(input.value, results)
            } else if (e.key === "ArrowDown") {
               // The roving-focus handler skips INPUT targets; hand off to the
               // first result row explicitly.
               const first = results.querySelector<HTMLElement>('[role="menuitem"]')
               if (first) {
                  e.preventDefault()
                  first.focus()
               }
            }
         })
         row.appendChild(input)
         frag.append(row, results)
      },
      async (value) => guard(() => nav.goTo(Number(value))),
   )
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
      if (imgProxyEditing) {
         frag.appendChild(imgProxyEditor(guard, rebuild, reapply))
      } else if (dateEditing) {
         frag.appendChild(dateEditor(guard, rebuild))
      } else {
         const since = divEl("srr-chip-row")
         since.appendChild(imgProxyIcon())
         since.appendChild(unreadIcon())
         since.appendChild(lastChip())
         since.appendChild(createLink("t:28800", "8h"))
         since.appendChild(createLink("t:57600", "16h"))
         since.appendChild(createLink("t:86400", "1d"))
         since.appendChild(createLink("t:604800", "7d"))
         since.appendChild(dateIcon())
         frag.appendChild(since)
      }

      frag.appendChild(divEl("srr-tag-sep"))

      frag.appendChild(createLink("", "[ALL]", cls("", "")))
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
   const rebuild = () => fillMenu(document.getElementById("srr-channel-menu")!, buildContent)
   // Re-render the active surface after an image-proxy change: the list in place,
   // the reader by replaying its hash (the list's hash carries no position).
   const reapply = () => {
      if (host.viewIsList()) host.reapplyFilter()
      else guard(() => nav.fromHash(location.hash.substring(1)))
   }

   toggleDropdown("srr-channel-menu", buildContent, async (value, e) => {
      // Swap to an inline editor without letting the click reach the window
      // close handler, which would otherwise shut the menu the instant it opens.
      if (value === IMG_PROXY_SENTINEL) {
         e.stopPropagation()
         imgProxyEditing = true
         rebuild()
         return
      }
      if (value === DATE_SENTINEL) {
         e.stopPropagation()
         dateEditing = true
         rebuild()
         return
      }
      if (value === UNREAD_SENTINEL) {
         // A mode toggle, not a selection: keep the menu open. Do the flip + chip
         // rebuild + nav re-apply ATOMICALLY inside the guard so a busy click (a
         // nav already in flight, or a rapid double-click) is a true no-op — the
         // chip can never get ahead of the applied nav state. Restore focus to
         // the freshly-rebuilt chip when this came from the keyboard (Space),
         // since rebuild() detaches the focused element.
         e.stopPropagation()
         // Capture the target mode ONCE, outside the guarded fn: guard's error
         // path re-invokes the SAME fn on Retry, so reading live !isUnreadOnly()
         // inside it would flip back the already-applied toggle on a retry.
         const want = !nav.isUnreadOnly()
         // Keyboard activation (Space → synthetic .click()) carries detail === 0;
         // a real mouse click has detail >= 1. activeElement can't tell them
         // apart once the chip stays focused through the click.
         const fromKeyboard = e.detail === 0
         // On the list surface the flip re-renders the list in place (host owns
         // the busy-guarded re-render); the menu stays open and focus returns to
         // the chip, mirroring the reader path below.
         if (host.viewIsList()) {
            nav.setUnreadOnly(want)
            rebuild()
            if (fromKeyboard)
               document.querySelector<HTMLElement>('#srr-channel-menu a[data-value="__unread__"]')?.focus()
            host.reapplyFilter()
            return
         }
         guard(() => {
            nav.setUnreadOnly(want)
            rebuild()
            if (fromKeyboard)
               document.querySelector<HTMLElement>('#srr-channel-menu a[data-value="__unread__"]')?.focus()
            // Re-resolve the current single-tag filter via switchFilter (which
            // resumes at the tag's current position, matching tag-select) so
            // toggling ON lands on where you left off, not fromHash's
            // last()-fallback newest. Other filters (channel / [ALL] /
            // multi-token) ignore unseen-only, so replay the raw hash unchanged.
            const key = nav.getCurrentFilterKey()
            const isTag = key !== "" && !Number.isFinite(Number(key))
            return isTag ? nav.switchFilter(key) : nav.fromHash(location.hash.substring(1))
         })
         return
      }
      // "Jump to a specific article" actions (latest / time-range) open the
      // reader from either surface — they target one article, not a feed.
      if (value === "!last") {
         guard(() => nav.last())
         return
      }
      if (value.startsWith("t:")) {
         const ts = Math.floor(Date.now() / 1000) - Number(value.slice(2))
         guard(async () => nav.goTo(await data.findChronForTimestamp(ts)))
         return
      }
      // A channel/tag/[ALL] selection: on the list surface, re-filter the list
      // (the host shows that filter's feed); in the reader, resume that filter
      // at its current position as before.
      if (host.viewIsList()) {
         host.selectFilter(value)
         return
      }
      guard(() => nav.switchFilter(value))
   })
}
