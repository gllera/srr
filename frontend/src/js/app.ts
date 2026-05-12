import * as data from "./data"
import { formatDate, getPreloadUrls, sanitizeHtml, timeAgo, URL_DENY } from "./fmt"
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
let dropdownOpen = false
const ddMenus = document.querySelectorAll<HTMLElement>(".srr-dropdown-menu")
const ddBtns = document.querySelectorAll<HTMLElement>(".srr-dropdown-btn")

function showError(e: unknown, retry?: () => void) {
   el.popupText.textContent = e instanceof Error ? e.message : String(e)
   retryFn = retry ?? null
   el.popupRetry.classList.toggle("srr-hidden", !retry)
   previousFocus = document.activeElement as HTMLElement
   el.popup.classList.add("srr-open")
   ;(retry ? el.popupRetry : el.popupClose).focus()
}

function closeAllDropdowns() {
   if (!dropdownOpen) return
   ddMenus.forEach((m) => m.classList.remove("srr-open"))
   ddBtns.forEach((b) => b.setAttribute("aria-expanded", "false"))
   dropdownOpen = false
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
   data.abortPending()
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

   preloadAdjacent()
}

// Keep refs alive so the browser doesn't GC an Image whose load is still
// in flight (MDN: preload via `new Image()` requires holding the reference).
// Bounded FIFO — Map preserves insertion order, so deleting the first key
// evicts the oldest preload.
const preloadedImages = new Map<string, HTMLImageElement>()
const PRELOAD_CAP = 64

function preloadImages(html: string) {
   for (const url of getPreloadUrls(html)) {
      if (preloadedImages.has(url)) continue
      const img = new Image()
      img.src = url
      preloadedImages.set(url, img)
   }
   while (preloadedImages.size > PRELOAD_CAP) {
      const oldest = preloadedImages.keys().next().value
      if (oldest === undefined) break
      preloadedImages.delete(oldest)
   }
}

async function preloadOne(idx: number) {
   try {
      const article = data.getArticleSync(idx) ?? (await data.loadArticle(idx))
      preloadImages(article.c)
   } catch {
      // Preload is best-effort: aborts and stale-pack errors are expected
      // (abortPending() on the next render cancels in-flight pack fetches).
   }
}

function preloadAdjacent() {
   const { left, right } = nav.peekAdjacent()
   if (right !== -1) preloadOne(right)
   if (left !== -1) preloadOne(left)
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

function createLink(value: string, text: string, className?: string): HTMLAnchorElement {
   const a = document.createElement("a")
   a.href = "#"
   a.dataset.value = value
   a.textContent = text
   a.setAttribute("role", "menuitem")
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
   dd.onclick = (e) => {
      const a = (e.target as HTMLElement).closest("a[data-value]") as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      onClick(a.dataset.value!)
   }
   dd.appendChild(frag)
}

function divEl(className: string): HTMLDivElement {
   const d = document.createElement("div")
   d.className = className
   return d
}

function showMenu() {
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
            const expanded = tag === current || tag === currentSource.tag
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
   if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(new URL("../sw.ts", import.meta.url), { type: "module" })
   }
   try {
      await data.init()
   } catch (e) {
      showError(e, () => location.reload())
      return
   }
   nav.pruneSeen()

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   el.next.addEventListener("click", () => guard(() => nav.right()))
   el.source.addEventListener("click", () => showMenu())
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

   let touchStartX = 0
   let touchStartY = 0
   let twoFingerStartY = 0
   let twoFingerDy = 0
   let twoFinger = false
   document.addEventListener(
      "touchstart",
      (e) => {
         if (e.touches.length === 2) {
            twoFinger = true
            twoFingerStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2
            twoFingerDy = 0
         } else if (e.touches.length === 1) {
            twoFinger = false
            touchStartX = e.touches[0].clientX
            touchStartY = e.touches[0].clientY
         }
      },
      { passive: true },
   )
   document.addEventListener(
      "touchmove",
      (e) => {
         if (twoFinger && e.touches.length === 2) {
            e.preventDefault()
            twoFingerDy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - twoFingerStartY
         }
      },
      { passive: false },
   )
   document.addEventListener(
      "touchend",
      (e) => {
         if (twoFinger) {
            if (e.touches.length === 0) {
               twoFinger = false
               if (Math.abs(twoFingerDy) >= 50 && nav.getFilterEntries().length > 1)
                  guard(() => nav.cycleFilter(twoFingerDy < 0 ? -1 : 1))
            }
            return
         }
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
