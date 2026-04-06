import * as data from "./data"
import { formatDate, sanitizeHtml, timeAgo } from "./fmt"
import * as nav from "./nav"

const el = {
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleLink: document.querySelector(".srr-title-link") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   last: document.querySelector(".srr-last") as HTMLButtonElement,
   source: document.querySelector(".srr-source") as HTMLButtonElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   counter: document.querySelector(".srr-counter") as HTMLElement,
   floorBtn: document.querySelector(".srr-floor-btn") as HTMLButtonElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
}

// Distinguished from Error so guard() shows it as a dismissible notice, not a retryable error
class Notice extends Error {}

let busy = false
let retryFn: (() => void) | null = null
let currentPublished = 0
let previousFocus: HTMLElement | null = null
let dropdownOpen = false
const ddMenus = document.querySelectorAll<HTMLElement>(".srr-dropdown-menu")
const ddBtns = document.querySelectorAll<HTMLElement>(".srr-dropdown-btn")

function showError(e: unknown, retry?: () => void) {
   el.popupText.textContent = e instanceof Error ? e.message : String(e)
   retryFn = retry ?? null
   el.popupRetry.classList.toggle("srr-hidden", !retry)
   el.popupClose.classList.remove("srr-hidden")
   previousFocus = document.activeElement as HTMLElement
   el.popup.classList.add("srr-open")
   const focusTarget = retry ? el.popupRetry : (el.popup.querySelector(".srr-popup-close") as HTMLElement)
   focusTarget.focus()
}

function closeAllDropdowns() {
   if (!dropdownOpen) return
   ddMenus.forEach((m) => m.classList.remove("srr-open"))
   ddBtns.forEach((b) => b.setAttribute("aria-expanded", "false"))
   dropdownOpen = false
}

function showNotice(msg: string) {
   el.popupText.textContent = msg
   retryFn = null
   el.popupRetry.classList.add("srr-hidden")
   el.popupClose.classList.add("srr-hidden")
   el.popup.classList.add("srr-open")
}

function closePopup() {
   el.popup.classList.remove("srr-open")
   el.popupClose.classList.remove("srr-hidden")
   previousFocus?.focus()
}

async function guard(fn: () => Promise<IShowFeed>) {
   if (busy) return
   busy = true
   document.body.classList.add("srr-loading")
   try {
      render(await fn())
   } catch (e) {
      if (e instanceof Notice) showNotice(e.message)
      else showError(e, () => guard(fn))
   } finally {
      document.body.classList.remove("srr-loading")
      busy = false
   }
}

function clearContentTransition() {
   el.content.style.transition = ""
   el.content.style.opacity = ""
   el.content.style.transform = ""
}

function render(o: IShowFeed) {
   data.abortPending()
   el.title.textContent = o.article.t
   el.content.style.transition = "none"
   el.content.style.opacity = "0"
   el.content.style.transform = "translateY(6px)"
   el.content.innerHTML = sanitizeHtml(o.article.c)
   el.titleLink.href = o.article.l
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right

   currentPublished = o.article.p
   el.date.textContent = timeAgo(currentPublished)
   el.date.title = formatDate(currentPublished)

   el.source.textContent = o.sub?.title || "[DELETED]"
   el.source.classList.toggle("srr-filtered", o.filtered)
   el.floorBtn.classList.toggle("srr-floor-active", o.floor)
   el.counter.textContent = String(o.countLeft)

   document.title = "SRR - " + o.article.t
   window.scrollTo(0, 0)
   el.title.focus()

   // Double rAF: first ensures the browser has painted with opacity:0,
   // second re-enables transitions so the fade-in animates
   requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

   try {
      localStorage.setItem("srr-hash", location.hash)
   } catch {}
}

function createLink(value: string, text: string, className?: string): HTMLAnchorElement {
   const a = document.createElement("a")
   a.href = "#"
   a.dataset.value = value
   a.textContent = text
   if (className) a.className = className
   return a
}

function toggleDropdown(
   id: string,
   buildContent: (frag: DocumentFragment) => void,
   onClick: (value: string) => Promise<void>,
) {
   const dd = document.getElementById(id)!
   const btn = dd.previousElementSibling as HTMLElement
   const opened = dd.classList.toggle("srr-open")
   if (opened) dropdownOpen = true
   btn?.setAttribute("aria-expanded", String(opened))
   if (!opened) return
   dd.replaceChildren()
   const frag = document.createDocumentFragment()
   buildContent(frag)
   frag.querySelectorAll("a").forEach((a) => a.setAttribute("role", "menuitem"))
   dd.onclick = (e) => {
      const a = (e.target as HTMLElement).closest("a[data-value]") as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      onClick(a.dataset.value!)
   }
   dd.appendChild(frag)
}

function showSubs() {
   const { tagged, sortedTags, untagged } = data.groupSubsByTag()

   toggleDropdown(
      "srr-source-menu",
      (frag) => {
         frag.appendChild(createLink("", "[ALL]"))
         for (const tag of sortedTags) {
            const group = tagged.get(tag)!
            const div = document.createElement("div")
            div.className = "srr-tag-group srr-tag-collapsed"
            const header = createLink(tag, tag, "srr-tag-header")
            const toggle = document.createElement("span")
            toggle.className = "srr-tag-toggle"
            toggle.addEventListener("click", (e) => {
               e.preventDefault()
               e.stopPropagation()
               div.classList.toggle("srr-tag-collapsed")
            })
            header.appendChild(toggle)
            div.appendChild(header)
            for (const sub of group) div.appendChild(createLink(String(sub.id), sub.title, "srr-tag-item"))
            frag.appendChild(div)
         }
         if (sortedTags.length > 0 && untagged.length > 0) {
            const sep = document.createElement("div")
            sep.className = "srr-tag-sep"
            frag.appendChild(sep)
         }
         for (const sub of untagged) frag.appendChild(createLink(String(sub.id), sub.title))
      },
      (value) => guard(() => nav.last(value)),
   )
}

function showFloor() {
   toggleDropdown(
      "srr-floor-menu",
      (frag) => {
         frag.appendChild(createLink("here", "Set here"))
         frag.appendChild(createLink("21600", "6 hours"))
         frag.appendChild(createLink("86400", "1 day"))
         frag.appendChild(createLink("604800", "7 days"))
         frag.appendChild(createLink("2592000", "1 month"))
         if (nav.floorChron > 0) frag.appendChild(createLink("clear", "Clear"))
      },
      (value) => {
         if (value === "here") {
            render(nav.setFloorHere())
            return Promise.resolve()
         }
         if (value === "clear") {
            render(nav.clearFloor())
            return Promise.resolve()
         }
         return guard(async () => {
            const ts = Math.floor(Date.now() / 1000) - Number(value)
            const chron = data.findChronForTimestamp(ts)
            if (chron === 0) throw new Notice("All articles are within that time range")
            return nav.setFloorAt(chron)
         })
      },
   )
}

const KEY_ACTIONS: Record<string, () => void> = {
   " ": () => render(nav.floorChron > 0 ? nav.clearFloor() : nav.setFloorHere()),
   ArrowLeft: () => !el.prev.disabled && guard(() => nav.left()),
   a: () => !el.prev.disabled && guard(() => nav.left()),
   ArrowRight: () => !el.next.disabled && guard(() => nav.right()),
   d: () => !el.next.disabled && guard(() => nav.right()),
   ArrowUp: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(-1)),
   w: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(-1)),
   ArrowDown: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(1)),
   s: () => nav.getFilterEntries().length > 1 && guard(() => nav.cycleFilter(1)),
   q: () => guard(() => nav.first()),
   e: () => guard(() => nav.last()),
}

async function init() {
   if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(new URL("../sw.ts", import.meta.url), { type: "module" })
   }
   try {
      await data.init()
   } catch (e) {
      showError(e, () => location.reload())
      return
   }

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   el.next.addEventListener("click", () => guard(() => nav.right()))
   el.last.addEventListener("click", () => guard(() => nav.last()))
   el.source.addEventListener("click", () => showSubs())
   el.floorBtn.addEventListener("click", () => showFloor())
   el.popup.querySelector(".srr-popup-close")!.addEventListener("click", closePopup)
   el.popupRetry.addEventListener("click", () => {
      closePopup()
      if (retryFn) retryFn()
   })
   window.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).matches(".srr-dropdown-btn")) closeAllDropdowns()
   })
   window.addEventListener("mousedown", (e) => {
      if (el.popup.classList.contains("srr-open") && !el.popup.contains(e.target as Node)) closePopup()
   })

   window.addEventListener("hashchange", () => guard(() => nav.fromHash(location.hash.substring(1))))
   document.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && el.popup.classList.contains("srr-open")) {
         const focusable = el.popup.querySelectorAll<HTMLElement>("button:not(.srr-hidden)")
         const first = focusable[0]
         const last = focusable[focusable.length - 1]
         if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
         } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
         }
         return
      }
      if (e.key === "Escape") {
         if (el.popup.classList.contains("srr-open")) {
            closePopup()
            return
         }
         closeAllDropdowns()
         return
      }
      if (el.popup.classList.contains("srr-open")) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      const action = KEY_ACTIONS[e.key]
      if (action) {
         e.preventDefault()
         action()
      }
   })

   let touchStartX = 0
   let touchStartY = 0
   document.addEventListener(
      "touchstart",
      (e) => {
         touchStartX = e.touches[0].clientX
         touchStartY = e.touches[0].clientY
      },
      { passive: true },
   )
   document.addEventListener(
      "touchend",
      (e) => {
         const dx = e.changedTouches[0].clientX - touchStartX
         const dy = e.changedTouches[0].clientY - touchStartY
         if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return
         if (dx > 0 && !el.prev.disabled) guard(() => nav.left())
         if (dx < 0 && !el.next.disabled) guard(() => nav.right())
      },
      { passive: true },
   )

   let lastScrollY = 0
   let toolbarHidden = false
   window.addEventListener(
      "scroll",
      () => {
         const y = window.scrollY
         const hide = y > 50 && y > lastScrollY
         if (hide !== toolbarHidden) {
            el.toolbar.classList.toggle("srr-toolbar-slide", hide)
            toolbarHidden = hide
         }
         if (hide) closeAllDropdowns()
         lastScrollY = y
      },
      { passive: true },
   )

   setInterval(() => {
      if (!currentPublished) return
      const next = timeAgo(currentPublished)
      if (el.date.textContent !== next) el.date.textContent = next
   }, 60000)

   let hash = location.hash.substring(1)
   if (!hash)
      try {
         hash = localStorage.getItem("srr-hash")?.substring(1) || ""
      } catch {}
   await guard(() => nav.fromHash(hash))
}

init().catch(showError)
