import * as data from "./data"
import * as nav from "./nav"

const menus = document.querySelectorAll<HTMLElement>(".srr-dropdown-menu")
const btns = document.querySelectorAll<HTMLElement>(".srr-dropdown-btn")

let isOpen = false

export function closeAllDropdowns(): void {
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
   dd.replaceChildren()
   const frag = document.createDocumentFragment()
   buildContent(frag)
   dd.onclick = (e) => {
      const a = (e.target as HTMLElement).closest("a[data-value]") as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      onClick(a.dataset.value!)
   }
   dd.appendChild(frag)
}

export function showSourceMenu(currentTag: string, guard: (fn: () => Promise<IShowFeed>) => void): void {
   const { tagged, sortedTags, untagged } = data.groupSubsByTag()
   const current = nav.getCurrentFilterKey()
   const cls = (base: string, v: string) => (v === current ? `${base} srr-active`.trim() : base)

   toggleDropdown(
      "srr-source-menu",
      (frag) => {
         const since = divEl("srr-chip-row")
         since.appendChild(createLink("!last", "last"))
         since.appendChild(createLink("t:43200", "12h"))
         since.appendChild(createLink("t:86400", "1d"))
         since.appendChild(createLink("t:604800", "7d"))
         since.appendChild(createLink("t:2592000", "1mo"))
         frag.appendChild(since)

         frag.appendChild(divEl("srr-tag-sep"))

         frag.appendChild(createLink("", "[ALL]", cls("", "")))
         for (const tag of sortedTags) {
            const group = tagged.get(tag)!
            const expanded = tag === current || tag === currentTag
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
            for (const sub of group) {
               const sid = String(sub.id)
               div.appendChild(createLink(sid, sub.title, cls("srr-tag-item", sid)))
            }
            frag.appendChild(div)
         }
         if (sortedTags.length > 0 && untagged.length > 0) frag.appendChild(divEl("srr-tag-sep"))
         for (const sub of untagged) {
            const sid = String(sub.id)
            frag.appendChild(createLink(sid, sub.title, cls("", sid)))
         }
      },
      (value) =>
         guard(() => {
            if (value === "!last") return nav.last()
            if (value.startsWith("t:")) {
               const ts = Math.floor(Date.now() / 1000) - Number(value.slice(2))
               return nav.goTo(data.findChronForTimestamp(ts))
            }
            return nav.switchFilter(value)
         }),
   )
}
