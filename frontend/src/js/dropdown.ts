import * as data from "./data"
import { getImgProxy, isValidProxy, setImgProxy } from "./fmt"
import * as nav from "./nav"

const menus = document.querySelectorAll<HTMLElement>(".srr-dropdown-menu")
const btns = document.querySelectorAll<HTMLElement>(".srr-dropdown-btn")

let isOpen = false
// Whether the chip row currently shows the image-proxy editor instead of the
// chips. Reset on close so reopening always starts collapsed.
let imgProxyEditing = false

export function closeAllDropdowns(): void {
   imgProxyEditing = false
   if (!isOpen) return
   menus.forEach((m) => m.classList.remove("srr-open"))
   btns.forEach((b) => b.setAttribute("aria-expanded", "false"))
   isOpen = false
}

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
   onClick: (value: string) => Promise<void>,
): void {
   const dd = document.getElementById(id)!
   const btn = dd.previousElementSibling as HTMLElement
   const opened = dd.classList.toggle("srr-open")
   if (opened) isOpen = true
   btn?.setAttribute("aria-expanded", String(opened))
   if (!opened) return
   imgProxyEditing = false
   dd.onclick = (e) => {
      const a = (e.target as HTMLElement).closest("a[data-value]") as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      onClick(a.dataset.value!)
   }
   fillMenu(dd, buildContent)
}

const IMG_PROXY_SENTINEL = "__imgproxy__"

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

function iconChip(value: string, label: string, className: string, svg: string): HTMLAnchorElement {
   const a = document.createElement("a")
   a.href = "#"
   a.dataset.value = value
   a.setAttribute("role", "menuitem")
   a.setAttribute("aria-label", label)
   a.title = label
   a.className = className
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

// imgProxyEditor is the inline editor row that replaces the chip row while
// configuring the proxy prefix: type + Enter/✓ commits (after isValidProxy),
// Escape cancels, ✕ commits "" (disables). Clicks inside it stop propagating
// so app.ts's window-level "any click closes dropdowns" handler never fires —
// clicks here configure, they don't navigate.
function imgProxyEditor(guard: (fn: () => Promise<IShowFeed>) => void, rebuild: () => void): HTMLDivElement {
   const row = divEl("srr-imgproxy-edit")
   row.addEventListener("mousedown", (e) => e.stopPropagation())
   row.addEventListener("click", (e) => e.stopPropagation())

   const input = document.createElement("input")
   input.type = "url"
   input.className = "srr-imgproxy-input"
   input.placeholder = "https://proxy/?url="
   input.value = getImgProxy()
   input.setAttribute("aria-label", "Image proxy URL prefix (empty disables)")
   input.addEventListener("input", () => input.classList.remove("srr-input-invalid"))

   const commit = (raw: string) => {
      const next = raw.trim()
      if (!isValidProxy(next)) {
         input.classList.add("srr-input-invalid")
         input.focus()
         return
      }
      imgProxyEditing = false
      if (next !== getImgProxy()) {
         setImgProxy(next)
         guard(() => nav.fromHash(location.hash.substring(1)))
      }
      rebuild()
   }

   input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
         e.preventDefault()
         commit(input.value)
      } else if (e.key === "Escape") {
         // Cancel the edit only — keep the document-level Escape handler from
         // also closing the whole dropdown.
         e.preventDefault()
         e.stopPropagation()
         imgProxyEditing = false
         rebuild()
      }
   })

   const btn = (className: string, label: string, text: string, onClick: () => void) => {
      const b = document.createElement("button")
      b.type = "button"
      b.className = className
      b.textContent = text
      b.setAttribute("aria-label", label)
      b.addEventListener("click", onClick)
      return b
   }
   row.append(
      input,
      btn("srr-imgproxy-save", "save image proxy", "✓", () => commit(input.value)),
      btn("srr-imgproxy-clear", "disable image proxy", "✕", () => commit("")),
   )
   queueMicrotask(() => input.focus())
   return row
}

export function showChannelMenu(currentTag: string, guard: (fn: () => Promise<IShowFeed>) => void): void {
   const { tagged, sortedTags, untagged } = data.groupChannelsByTag()
   const current = nav.getCurrentFilterKey()
   const cls = (base: string, v: string) => (v === current ? `${base} srr-active`.trim() : base)

   const buildContent = (frag: DocumentFragment) => {
      if (imgProxyEditing) {
         frag.appendChild(imgProxyEditor(guard, rebuild))
      } else {
         const since = divEl("srr-chip-row")
         since.appendChild(imgProxyIcon())
         since.appendChild(lastChip())
         since.appendChild(createLink("t:28800", "8h"))
         since.appendChild(createLink("t:57600", "16h"))
         since.appendChild(createLink("t:86400", "1d"))
         since.appendChild(createLink("t:604800", "7d"))
         frag.appendChild(since)
      }

      frag.appendChild(divEl("srr-tag-sep"))

      frag.appendChild(createLink("", "[ALL]", cls("", "")))
      for (const tag of sortedTags) {
         const group = tagged.get(tag)!
         const expanded = tag === currentTag && tag !== current
         const div = divEl(expanded ? "srr-tag-group" : "srr-tag-group srr-tag-collapsed")
         const header = createLink(tag, tag, cls("srr-tag-header", tag))
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
            const cid = String(ch.id)
            div.appendChild(createLink(cid, ch.title, cls("srr-tag-item", cid)))
         }
         frag.appendChild(div)
      }
      if (sortedTags.length > 0 && untagged.length > 0) frag.appendChild(divEl("srr-tag-sep"))
      for (const ch of untagged) {
         const cid = String(ch.id)
         frag.appendChild(createLink(cid, ch.title, cls("", cid)))
      }
   }
   const rebuild = () => fillMenu(document.getElementById("srr-channel-menu")!, buildContent)

   toggleDropdown("srr-channel-menu", buildContent, async (value) => {
      if (value === IMG_PROXY_SENTINEL) {
         imgProxyEditing = true
         rebuild()
         return
      }
      guard(async () => {
         if (value === "!last") return nav.last()
         if (value.startsWith("t:")) {
            const ts = Math.floor(Date.now() / 1000) - Number(value.slice(2))
            return nav.goTo(await data.findChronForTimestamp(ts))
         }
         return nav.switchFilter(value)
      })
   })
}
