import * as data from "./data"
import { closeAllDropdowns, showSourceMenu } from "./dropdown"
import { formatDate, sanitizeHtml, timeAgo, URL_DENY } from "./fmt"
import { setupGestures } from "./gestures"
import * as nav from "./nav"

const el = {
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleLink: document.querySelector(".srr-title-link") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   source: document.querySelector(".srr-source") as HTMLButtonElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   counter: document.querySelector(".srr-counter") as HTMLElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
}

let busy = false
let retryFn: (() => void) | null = null
let currentPublished = 0
let currentSource = { id: 0, title: "", tag: "" }
let lastSourceLabel = ""
let previousFocus: HTMLElement | null = null

function showError(e: unknown, retry?: () => void) {
   el.popupText.textContent = e instanceof Error ? e.message : String(e)
   retryFn = retry ?? null
   el.popupRetry.classList.toggle("srr-hidden", !retry)
   previousFocus = document.activeElement as HTMLElement
   el.popup.classList.add("srr-open")
   ;(retry ? el.popupRetry : el.popupClose).focus()
}

function closePopup() {
   el.popup.classList.remove("srr-open")
   previousFocus?.focus()
}

async function guard(fn: () => Promise<IShowFeed>) {
   if (busy) return
   busy = true
   document.body.classList.add("srr-loading")
   try {
      render(await fn())
   } catch (e) {
      showError(e, () => guard(fn))
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
   el.title.textContent = o.article.t
   el.content.style.transition = "none"
   el.content.style.opacity = "0"
   el.content.style.transform = "translateY(6px)"
   el.content.innerHTML = sanitizeHtml(o.article.c)
   // Reject javascript:/data:/vbscript:/file: in case the writer pipeline let one through
   if (o.article.l && !URL_DENY.test(o.article.l)) el.titleLink.href = o.article.l
   else el.titleLink.removeAttribute("href")
   el.prev.disabled = !o.has_left
   el.next.disabled = !o.has_right

   // p is omitted (=> undefined) when the writer couldn't parse a date
   currentPublished = o.article.p ?? 0
   el.date.textContent = currentPublished ? timeAgo(currentPublished) : ""
   el.date.title = currentPublished ? formatDate(currentPublished) : ""

   currentSource = {
      id: o.sub?.id ?? 0,
      title: o.sub?.title || "[DELETED]",
      tag: o.sub?.tag || "",
   }
   refreshSourceLabel()
   el.counter.textContent = String(o.countRight)

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

function refreshSourceLabel() {
   const tagFiltered = nav.isSingleFilter(currentSource.tag)
   const subFiltered = nav.isSingleFilter(String(currentSource.id))

   const key = `${currentSource.tag}|${currentSource.title}|${tagFiltered}|${subFiltered}`
   if (key === lastSourceLabel) return
   lastSourceLabel = key

   const parts: HTMLSpanElement[] = []
   const aria: string[] = []
   const push = (text: string, on: boolean, label: string) => {
      const s = document.createElement("span")
      s.textContent = text
      if (on) s.className = "srr-filter-on"
      parts.push(s)
      aria.push(label)
   }

   if (currentSource.tag) {
      const tag = currentSource.tag
      push((tag[0] + tag[tag.length - 1]).toUpperCase(), tagFiltered, `tag ${tag}${tagFiltered ? " active" : ""}`)
   }
   push(currentSource.title, subFiltered, `source ${currentSource.title}${subFiltered ? " active" : ""}`)

   const children: (HTMLSpanElement | string)[] = []
   parts.forEach((p, i) => {
      if (i > 0) children.push(" · ")
      children.push(p)
   })
   el.source.replaceChildren(...children)
   el.source.title = currentSource.tag ? `Tag: ${currentSource.tag}` : ""
   el.source.setAttribute("aria-label", `Filter: ${aria.join(", ")}`)
}

const KEY_ACTIONS: Record<string, () => void> = {
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
   f: () => {
      if (!el.titleLink.getAttribute("href")) return
      el.titleLink.dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }),
      )
   },
}

async function init() {
   try {
      await data.init()
   } catch (e) {
      showError(e, () => location.reload())
      return
   }
   nav.pruneSeen()

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   el.next.addEventListener("click", () => guard(() => nav.right()))
   el.source.addEventListener("click", () => showSourceMenu(currentSource.tag, guard))
   el.popupClose.addEventListener("click", closePopup)
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

   setupGestures({ prev: el.prev, next: el.next, toolbar: el.toolbar, guard })

   setInterval(() => {
      if (currentPublished) {
         const next = timeAgo(currentPublished)
         if (el.date.textContent !== next) el.date.textContent = next
      }
   }, 60000)

   let hash = location.hash.substring(1)
   if (!hash)
      try {
         hash = localStorage.getItem("srr-hash")?.substring(1) || ""
      } catch {}
   await guard(() => nav.fromHash(hash))
}

init().catch(showError)
