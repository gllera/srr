import { wrapTabFocus } from "./dropdown"

// ── Image lightbox (RDR7) ─────────────────────────────────────────────────────
// Content images used to be inert: a phone could pinch the whole page, and the
// desktop had no enlargement path at all — a chart or a screenshot capped at the
// prose column was simply unreadable. This is the minimal viewer that fixes it,
// and it is deliberately a MODAL in the same idiom as dropdown.ts's openModal:
// a dimmed full-viewport backdrop, focus trapped inside (wrapTabFocus, the one
// shared trap the modal shell / error popup / info dialog already use), Escape
// and a backdrop press both cancel, and focus returns to whatever opened it —
// here the originating <img> itself, which is made programmatically focusable
// for exactly that purpose.
//
// Entry is ONE delegated click listener the render host registers (app.ts,
// beside handleFragmentClick): article content is replaced on every navigation,
// so per-image handlers would be re-attached thousands of times a session and
// leak with every re-render.
//
// The viewer is built lazily and reused, NOT declared in index.html — like the
// mounts dialog, that keeps it out of the design.html skeleton drift guard.
//
// Motion: the fade/zoom transitions are plain CSS, so the global
// prefers-reduced-motion rule in styles.css already flattens them; nothing here
// animates from JS.

// Cap on the enlargement. A 6000px panorama scaled to its natural size inside a
// viewport-sized box is unusable — past ~4x the user wants a download, not a
// lightbox.
const MAX_ZOOM = 4
// Below this ratio "enlarged" is indistinguishable from the fitted view, so the
// image counts as un-zoomable and a press just closes (the tap-to-dismiss the
// common case — an inline photo already shown near full size — wants).
const ZOOM_EPS = 1.02

let overlay: HTMLElement | null = null
let stage: HTMLButtonElement | null = null
let viewImg: HTMLImageElement | null = null
let closeBtn: HTMLButtonElement | null = null

// The content <img> the viewer was opened from — focus goes back to it on close.
let origin: HTMLImageElement | null = null
let opened = false
let zoom = 1

// Is the viewer up? The gating predicate app.ts needs, the exact counterpart of
// picker.isOpen(): the reader's swipe/step handlers consult it so a gesture over
// the open viewer can't walk articles behind it. (Keyboard input is handled by
// the capture-phase trap below, not by this flag.)
export function isOpen(): boolean {
   return opened
}

function ensureOverlay(): HTMLElement {
   if (overlay) return overlay
   const d = document.createElement("div")
   d.className = "srr-lightbox"
   d.setAttribute("role", "dialog")
   d.setAttribute("aria-modal", "true")

   // The stage is a real <button> wrapping the image rather than a click-handled
   // <div>: it makes the zoom toggle keyboard-operable (Tab to it, Enter/Space
   // activates) for free, instead of inventing a bespoke key for it.
   const s = document.createElement("button")
   s.type = "button"
   s.className = "srr-lightbox-stage"
   const img = document.createElement("img")
   img.className = "srr-lightbox-img"
   img.alt = ""
   s.appendChild(img)

   const x = document.createElement("button")
   x.type = "button"
   x.className = "srr-lightbox-close"
   x.setAttribute("aria-label", "close image viewer")
   x.textContent = "✕"

   d.append(s, x)
   // Wired once, at build time — the viewer is hidden (display:none) whenever it
   // is closed, so these can never fire between opens.
   d.addEventListener("click", (e) => {
      if (e.target === d) close() // the backdrop itself, never the card
   })
   s.addEventListener("click", onStage)
   x.addEventListener("click", () => close())

   document.body.appendChild(d)
   overlay = d
   stage = s
   viewImg = img
   closeBtn = x
   return d
}

// How far this image COULD be enlarged: its natural width over the width the
// fitted view is actually painting, clamped to [1, MAX_ZOOM].
function zoomFactor(): number {
   const natural = viewImg?.naturalWidth ?? 0
   const shown = viewImg?.clientWidth ?? 0
   if (!natural || !shown) return 1
   return Math.min(Math.max(natural / shown, 1), MAX_ZOOM)
}

const pct = (v: number) => Math.max(0, Math.min(100, v))

// Apply a zoom level with its origin (percentages within the image). Origin
// matters: zooming a wide diagram always about its centre hides whichever half
// the reader was pointing at.
function setZoom(k: number, ox = 50, oy = 50): void {
   if (!viewImg || !overlay || !stage) return
   zoom = k
   viewImg.style.transformOrigin = `${ox}% ${oy}%`
   viewImg.style.transform = k === 1 ? "" : `scale(${k})`
   overlay.classList.toggle("srr-lightbox-zoomed", k !== 1)
   stage.setAttribute("aria-label", k === 1 ? "enlarge image" : "shrink image")
}

function onStage(e: MouseEvent): void {
   if (zoom !== 1) {
      setZoom(1)
      return
   }
   const k = zoomFactor()
   // Nothing left to reveal — the press reads as "dismiss", which is what a tap
   // on an already-full-size image means on a phone.
   if (k <= ZOOM_EPS) {
      close()
      return
   }
   // detail 0 = a keyboard activation of the stage button: no pointer position
   // to anchor on, so centre it.
   const r = viewImg?.getBoundingClientRect()
   const point = e.detail > 0 && r && r.width > 0 && r.height > 0
   setZoom(
      k,
      point ? pct(((e.clientX - r.left) / r.width) * 100) : 50,
      point ? pct(((e.clientY - r.top) / r.height) * 100) : 50,
   )
}

// Capture phase + stopPropagation, the dialog discipline dropdown.ts's modal
// shell established: app.ts's document-level keydown is bubble-phase, so
// stopping here is precisely what keeps Escape from ALSO toggling the surface
// underneath and the arrow keys from walking articles behind the image. A modal
// owns the keyboard for as long as it is up, so every key is swallowed, not just
// the ones handled here.
function onKey(e: KeyboardEvent): void {
   e.stopPropagation()
   if (e.key === "Escape") {
      e.preventDefault()
      close()
   } else if (e.key === "Tab" && overlay) {
      wrapTabFocus(e, overlay, "button")
   }
}

// open shows `img` in the viewer. Exported for tests and any future caller (a
// gallery affordance); the reader reaches it through handleContentClick.
export function open(img: HTMLImageElement): void {
   // currentSrc is what the browser actually resolved and painted — srcset is
   // stripped by the sanitizer, but a proxied/pack-relative src has already been
   // rewritten to an absolute URL on the element, so read it off the element
   // rather than re-deriving anything.
   const src = img.currentSrc || img.getAttribute("src") || ""
   if (!src) return
   if (opened) close() // never stack two viewers

   const d = ensureOverlay()
   origin = img
   // An <img> is not focusable by default; tabIndex -1 makes it a programmatic
   // focus target without adding it to the page's Tab order — the same trick
   // app.ts uses to focus the content host.
   img.tabIndex = -1

   viewImg!.src = src
   const alt = img.getAttribute("alt")?.trim() ?? ""
   viewImg!.alt = alt
   d.setAttribute("aria-label", alt ? `Image: ${alt}` : "Image viewer")
   setZoom(1)

   d.classList.add("srr-open")
   opened = true
   document.addEventListener("keydown", onKey, true)
   // Focus the ✕ rather than the stage: it is the escape hatch, and a ring drawn
   // around the whole picture on open reads as a rendering artifact.
   closeBtn!.focus()
}

export function close(): void {
   if (!opened) return
   document.removeEventListener("keydown", onKey, true)
   overlay?.classList.remove("srr-open")
   setZoom(1)
   opened = false
   const back = origin
   origin = null
   // preventScroll: the article may have been scrolled far past the image while
   // the viewer covered it; handing focus back must not yank the page.
   // A re-render while the viewer was up leaves `back` detached — focus() is
   // then a harmless no-op.
   back?.focus({ preventScroll: true })
}

// handleContentClick is the ONE delegated listener app.ts registers on the
// content host. It claims bare content images and nothing else.
export function handleContentClick(e: MouseEvent): void {
   // Modified clicks (new tab/window, download) and anything an earlier handler
   // already claimed are the browser's / that handler's — same gate as
   // fmt.ts handleFragmentClick, which shares this host.
   if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
   const t = e.target as Element | null
   if (!t || t.tagName !== "IMG") return
   const host = e.currentTarget as Element | null
   if (host && !host.contains(t)) return
   // An <img> wrapped in a link is a navigation control the author built; a
   // lightbox that swallowed it would silently break the article. Bare images —
   // the common case — are the ones with nothing else to do.
   if (t.closest("a[href]")) return
   // A dead image has no bytes to enlarge (fmt.ts collapseBrokenMedia marks it;
   // CSS hides it, so this is belt and braces).
   if (t.classList.contains("srr-broken")) return
   e.preventDefault()
   open(t as HTMLImageElement)
}
