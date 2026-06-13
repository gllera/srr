import * as data from "./data"
import { closeAllDropdowns, showChannelMenu, showPeekMenu, showSearchMenu, type ChannelMenuHost } from "./dropdown"
import { collapseBrokenMedia, formatDate, sanitizeHtml, timeAgo, URL_DENY } from "./fmt"
import { setupGestures } from "./gestures"
import * as list from "./list"
import * as nav from "./nav"

const el = {
   article: document.querySelector(".srr-reader") as HTMLElement,
   listView: document.querySelector(".srr-list") as HTMLElement,
   back: document.querySelector(".srr-back") as HTMLButtonElement,
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleLink: document.querySelector(".srr-title-link") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   channel: document.querySelector(".srr-channel") as HTMLButtonElement,
   source: document.querySelector(".srr-source") as HTMLElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   counter: document.querySelector(".srr-counter") as HTMLButtonElement,
   search: document.querySelector(".srr-search") as HTMLButtonElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
}

// Which surface is showing. The list is home; the reader is the drill-down.
let view: "list" | "reader" = "list"
let busy = false
let retryFn: (() => void) | null = null
let currentPublished = 0
let currentChannel = { id: 0, title: "", tag: "" }
let lastChannelLabel: string | null = null
let previousFocus: HTMLElement | null = null

function showReader() {
   view = "reader"
   document.body.classList.remove("srr-view-list")
   el.listView.hidden = true
   el.article.hidden = false
}

function showList() {
   view = "list"
   document.body.classList.add("srr-view-list")
   el.article.hidden = true
   el.listView.hidden = false
   // Disable the reader-only nav so a one-finger swipe / arrow key is a no-op
   // while the list scrolls natively (the buttons are also hidden via CSS).
   el.prev.disabled = true
   el.next.disabled = true
}

function persistHash(hash: string) {
   try {
      localStorage.setItem("srr-hash", hash)
   } catch {}
}

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
   showReader()
   // t/l are omitempty on the wire — an untitled article must not render "undefined"
   el.title.textContent = o.article.t ?? ""
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
   // Hide the date (and its leading "·" separator) in the kicker when undated,
   // so the source name doesn't trail a dangling middot.
   el.date.hidden = !currentPublished

   currentChannel = {
      id: o.channel?.id ?? 0,
      title: data.channelTitle(o.article.s),
      tag: o.channel?.tag || "",
   }
   el.source.textContent = currentChannel.title
   refreshChannelLabel()
   el.counter.textContent = String(o.countRight)

   document.title = "SRR - " + (o.article.t ?? "")
   window.scrollTo(0, 0)
   // Don't steal focus to the title while a dropdown menu is open — the only
   // render() with a menu still open is the unseen-only eye-chip toggle, which
   // keeps the menu open and restores focus to the chip. Stealing it here would
   // strand the keyboard user behind the open menu (next Arrow finds
   // activeElement outside the menu items). Every navigation selection closes
   // the menu before its render(), so this is a no-op on all other paths.
   if (!document.querySelector(".srr-dropdown-menu.srr-open")) el.title.focus()

   // Double rAF: first ensures the browser has painted with opacity:0,
   // second re-enables transitions so the fade-in animates
   requestAnimationFrame(() => requestAnimationFrame(clearContentTransition))

   try {
      localStorage.setItem("srr-hash", location.hash)
   } catch {}
}

function refreshChannelLabel() {
   // The article's source now lives in the header kicker, so the toolbar button
   // is a pure active-filter indicator: "All", a tag name, or a single channel.
   const key = nav.getCurrentFilterKey() // "" (all/multi) | tag name | numeric channel id
   if (key === lastChannelLabel) return
   lastChannelLabel = key

   const label = key === "" ? "All" : /^\d+$/.test(key) ? data.channelTitle(Number(key)) : key
   el.channel.textContent = label
   el.channel.classList.toggle("srr-filter-on", key !== "")
   el.channel.title = key === "" ? "All channels" : `Filtered: ${label}`
   el.channel.setAttribute("aria-label", `Filter: ${label}`)
}

function listTitle(): string {
   const key = nav.getCurrentFilterKey()
   if (key === "") return "SRR"
   return "SRR · " + (/^\d+$/.test(key) ? data.channelTitle(Number(key)) : key)
}

// Show the list surface and (re)render it under the current filter. Shares the
// guard() busy flag so it can't overlap an in-flight article load; on error,
// the popup's Retry re-runs it.
async function renderListSurface() {
   if (busy) return
   busy = true
   showList()
   refreshChannelLabel()
   document.title = listTitle()
   document.body.classList.add("srr-loading")
   try {
      await list.show()
   } catch (e) {
      showError(e, () => void renderListSurface())
   } finally {
      document.body.classList.remove("srr-loading")
      busy = false
   }
}

// Hash → surface. A numeric position routes to the reader (deep-link or restored
// reading position); anything else (empty, or just `!tokens`) is the list at
// that filter.
async function route(hash: string) {
   const bang = hash.indexOf("!")
   const posStr = bang === -1 ? hash : hash.substring(0, bang)
   if (posStr !== "" && /^-?\d+$/.test(posStr)) {
      await guard(() => nav.fromHash(hash))
      return
   }
   const tokens =
      bang === -1
         ? []
         : hash
              .substring(bang + 1)
              .split("+")
              .filter((t) => t.length > 0)
              .map((t) => {
                 try {
                    return decodeURIComponent(t)
                 } catch {
                    return t
                 }
              })
   nav.applyFilter(tokens)
   // Canonicalize the URL (boot may restore an empty location.hash from
   // localStorage) without growing history.
   const h = "#" + nav.tokensSuffix()
   history.replaceState(null, "", h)
   persistHash(h)
   await renderListSurface()
}

// Return to the list from the reader (back button / two-finger cycle / filter
// pick). pushState so browser-back from the reader still works; the list
// restores its saved scroll for the active filter.
async function goToList(push: boolean) {
   const h = "#" + nav.tokensSuffix()
   history[push ? "pushState" : "replaceState"](null, "", h)
   persistHash(h)
   await renderListSurface()
}

async function selectFilter(token: string) {
   nav.applyFilter(token === "" ? [] : [token])
   closeAllDropdowns()
   await goToList(true)
}

const dropdownHost: ChannelMenuHost = {
   viewIsList: () => view === "list",
   selectFilter: (token) => void selectFilter(token),
   reapplyFilter: () => {
      nav.applyFilter(nav.currentTokens())
      void list.rerender()
   },
}

// Two-finger vertical swipe = step the filter. In the reader, cycle to the next
// filter's article; on the list, re-filter the list to the next entry.
function onCycle(dir: number) {
   const entries = nav.getFilterEntries()
   if (entries.length <= 1) return
   if (view === "list") {
      let idx = entries.indexOf(nav.getCurrentFilterKey())
      if (idx === -1) idx = 0
      void selectFilter(entries[(idx + dir + entries.length) % entries.length])
   } else {
      guard(() => nav.cycleFilter(dir))
   }
}

function channelMenuTag(): string {
   // Which tag group to auto-expand in the menu. In the reader, the shown
   // article's tag; on the list, the active tag filter (if any).
   if (view === "list") {
      const key = nav.getCurrentFilterKey()
      return key !== "" && !/^\d+$/.test(key) ? key : ""
   }
   return currentChannel.tag
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
   l: () => showPeekMenu(guard),
   "/": () => showSearchMenu(guard),
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

   // The list opens an article in the reader through the same guard mutex as
   // every other navigation.
   list.setup(el.listView, (chron) => guard(() => nav.goTo(chron)))

   el.prev.addEventListener("click", () => guard(() => nav.left()))
   el.next.addEventListener("click", () => guard(() => nav.right()))
   el.back.addEventListener("click", () => void goToList(true))
   // capture: error events don't bubble (see collapseBrokenMedia)
   el.content.addEventListener("error", collapseBrokenMedia, true)
   el.channel.addEventListener("click", () => showChannelMenu(channelMenuTag(), guard, dropdownHost))
   el.counter.addEventListener("click", () => showPeekMenu(guard))
   el.search.addEventListener("click", () => showSearchMenu(guard))
   el.popupClose.addEventListener("click", closePopup)
   el.popupRetry.addEventListener("click", () => {
      closePopup()
      if (retryFn) retryFn()
   })
   window.addEventListener("click", (e) => {
      // closest(), not matches(): a dropdown button may be clicked on an inner
      // icon span (e.g. .srr-search-icon), so the event target is the child, not
      // the button. matches() missed that and closed the menu the button's own
      // handler had just opened — leaving the search button dead to taps/clicks
      // (only the `/` shortcut worked; on mobile there is no `/` key).
      if (!(e.target as HTMLElement).closest(".srr-dropdown-btn")) closeAllDropdowns()
   })
   window.addEventListener("mousedown", (e) => {
      if (el.popup.classList.contains("srr-open") && !el.popup.contains(e.target as Node)) closePopup()
   })

   window.addEventListener("hashchange", () => void route(location.hash.substring(1)))
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
      // On the list, arrows/letters scroll and rove rows natively; only `/`
      // (search) is a global shortcut. The reader keymap stays reader-only.
      if (view === "list") {
         if (e.key === "/") {
            e.preventDefault()
            showSearchMenu(guard)
         }
         return
      }
      const action = KEY_ACTIONS[e.key]
      if (action) {
         e.preventDefault()
         action()
      }
   })

   setupGestures({ prev: el.prev, next: el.next, toolbar: el.toolbar, guard, onCycle })

   setInterval(() => {
      if (currentPublished) {
         const next = timeAgo(currentPublished)
         if (el.date.textContent !== next) el.date.textContent = next
      }
   }, 60000)

   let hash = location.hash.substring(1)
   // Reject foreign hashes (e.g., OAuth implicit-flow tokens injected by an
   // auth provider in front of the app — Cloudflare Access JWT-in-fragment,
   // OIDC, etc.) so the page lands on the user's last position instead of
   // the latest article. SRR hashes are `[integer][!tokens]` or `!tokens`.
   const bang = hash.indexOf("!")
   const posPart = bang === -1 ? hash : hash.substring(0, bang)
   if (posPart && !/^-?\d+$/.test(posPart)) {
      history.replaceState(null, "", location.pathname + location.search)
      hash = ""
   }
   if (!hash)
      try {
         hash = localStorage.getItem("srr-hash")?.substring(1) || ""
      } catch {}
   await route(hash)
}

init().catch(showError)

// Cache immutable self-hosted assets via a service worker (scope = this
// deployment's directory, e.g. /srr/ or /srr.tmp/). Best-effort: any failure
// (unsupported, insecure context, registration error) leaves the app working
// straight off the network.
if ("serviceWorker" in navigator) {
   // sw.ts lives at src/ root (not src/js/) so Parcel emits it at the deployment
   // root — its default scope then covers the whole env (incl. packs/assets/).
   // type:module lets sw.ts import the generated contract (format.gen.ts); the
   // SW already requires DecompressionStream, which is the newer feature, so
   // module-worker support is never the limiting factor.
   navigator.serviceWorker.register(new URL("../sw.ts", import.meta.url), { type: "module" }).catch(() => {})
}
