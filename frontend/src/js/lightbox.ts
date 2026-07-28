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
//
// Touch: the viewer owns its touches the way it owns the keyboard. Its
// handlers stopPropagation so the document-level gesture machine (gestures.ts:
// filter cycle, pager, pull) never tracks a touch that belongs to the picture,
// and preventDefault (plus touch-action:none in styles.css) keeps the
// browser's native page zoom out of it — native zoom scales the scrim and the
// ✕ along with the image and leaves the PAGE zoomed after close; it is also
// not actually reachable here, since gestures.ts cancels the early two-finger
// touchmoves before its pinch heuristic can release them, which suppresses the
// native action for the rest of the gesture. So the viewer implements the
// gestures a phone expects of an image viewer itself: pinch zooms about the
// finger midpoint, a one-finger drag pans a zoomed image, and both share the
// tap toggle's translate+scale model below.

// Cap on the enlargement. A 6000px panorama scaled to its natural size inside a
// viewport-sized box is unusable — past ~4x the user wants a download, not a
// lightbox.
const MAX_ZOOM = 4
// Below this ratio "enlarged" is indistinguishable from the fitted view, so the
// image counts as un-zoomable and a press just closes (the tap-to-dismiss the
// common case — an inline photo already shown near full size — wants). A pinch
// released at or under it snaps back to fitted for the same reason.
const ZOOM_EPS = 1.02
// Finger travel past which a touch stops being a tap. Its one job is the
// synthesized click a drag's finger-lift fires: a pan must not also toggle the
// zoom (list.ts's swipeClickGuard is the same idea on the rows).
const TAP_SLOP = 8

let overlay: HTMLElement | null = null
let stage: HTMLButtonElement | null = null
let viewImg: HTMLImageElement | null = null
let closeBtn: HTMLButtonElement | null = null

// The content <img> the viewer was opened from — focus goes back to it on close.
let origin: HTMLImageElement | null = null
let opened = false
// The view state: one translate+scale about the CENTER (never transform-origin
// percentages — pan and pinch need every writer in the same coordinates, and
// an origin-anchored scale is just translate (center − point) · (zoom − 1)).
// pan is in screen pixels, applied after the scale.
let zoom = 1
let panX = 0
let panY = 0

// ── Touch gesture state ───────────────────────────────────────────────────────
let touchMode: "none" | "pan" | "pinch" = "none"
// This gesture dragged or pinched — swallow the click its finger-lift fires.
let touchMoved = false
let panStartX = 0
let panStartY = 0
let panBaseX = 0
let panBaseY = 0
let pinchDist = 0 // inter-finger distance at pinch start
let pinchZoom = 1 // zoom at pinch start
// The pinch anchor in image-plane (unscaled) coordinates from the center: the
// picture point under the fingers' midpoint, which must stay under it as the
// midpoint moves — that is what makes one gesture both zoom and pan.
let pinchRelX = 0
let pinchRelY = 0

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
   // Capture-phase, ahead of the stage/backdrop handlers: the click a drag's
   // finger-lift synthesizes must neither toggle the zoom nor dismiss.
   d.addEventListener(
      "click",
      (e) => {
         if (!touchMoved) return
         touchMoved = false
         e.preventDefault()
         e.stopPropagation()
      },
      true,
   )
   // Non-passive on purpose: preventDefault is what keeps the browser's own
   // scroll/zoom off a touch the viewer is handling (see the module docblock).
   d.addEventListener("touchstart", onTouchStart, { passive: false })
   d.addEventListener("touchmove", onTouchMove, { passive: false })
   d.addEventListener("touchend", onTouchEnd, { passive: true })
   d.addEventListener("touchcancel", onTouchCancel, { passive: true })

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

// The image's fitted (layout) size — client metrics never include the
// transform, so these stay the un-zoomed box while the picture is scaled.
function fitted(): { w: number; h: number } {
   return { w: viewImg?.clientWidth ?? 0, h: viewImg?.clientHeight ?? 0 }
}

// Keep the scaled image covering the clip WINDOW: the overhang per side is
// (scaled − window) / 2, and a pan past it would pull the picture's edge
// inside the window and show scrim through the gap. An image smaller than the
// window on an axis (a wide picture whose scaled height still fits) clamps to
// 0 — centered, nothing to pan.
function clampPan(v: number, size: number, win: number, k: number): number {
   const m = Math.max(0, (size * k - win) / 2)
   return Math.min(m, Math.max(-m, v))
}

// The stage center in client coordinates — the anchor every gesture measures
// from. The stage never carries the transform, so its rect is layout geometry
// even mid-pinch (the image's own rect is not) — and whether it hugs the
// fitted image (un-zoomed) or fills the overlay (zoomed), both boxes center on
// the same point.
function stageCenter(): { x: number; y: number } {
   const r = stage!.getBoundingClientRect()
   return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

// The ONE view writer: every gesture sets zoom + desired pan and lands here.
function applyView(): void {
   if (!viewImg || !overlay || !stage) return
   // Class first: styles.css grows the stage to the whole overlay while
   // zoomed (the clip window must enlarge with the picture — zooming through
   // the fitted box showed a 3x image through its own small window), so the
   // clamp below has to read the box AFTER the toggle takes effect.
   overlay.classList.toggle("srr-lightbox-zoomed", zoom !== 1)
   stage.setAttribute("aria-label", zoom === 1 ? "enlarge image" : "shrink image")
   const { w, h } = fitted()
   // `|| size` — a zero client box (jsdom without stubs, a mid-layout read)
   // degrades to the fitted box, the tight clamp.
   panX = clampPan(panX, w, stage.clientWidth || w, zoom)
   panY = clampPan(panY, h, stage.clientHeight || h, zoom)
   viewImg.style.transform = zoom === 1 ? "" : `translate(${panX}px, ${panY}px) scale(${zoom})`
}

// Apply a zoom level with its origin (percentages within the image). Origin
// matters: zooming a wide diagram always about its centre hides whichever half
// the reader was pointing at.
function setZoom(k: number, ox = 50, oy = 50): void {
   if (!viewImg || !overlay || !stage) return
   zoom = k
   const { w, h } = fitted()
   panX = k === 1 ? 0 : (0.5 - ox / 100) * w * (k - 1)
   panY = k === 1 ? 0 : (0.5 - oy / 100) * h * (k - 1)
   applyView()
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

// ── Touch: pinch zoom + pan ───────────────────────────────────────────────────
// All four handlers stopPropagation — the modal owns its touches exactly as
// onKey owns the keyboard, and the document-level machine in gestures.ts must
// not track (or preventDefault, or cycle the filter off) a gesture aimed at
// the picture. jsdom has no Touch constructor, so like gestures.ts these read
// only `.length` and `clientX`/`clientY` off the touch lists.

function onTouchStart(e: TouchEvent): void {
   e.stopPropagation()
   if (e.touches.length === 2) {
      // Claim the gesture from the browser NOW, at the start: releasing it
      // mid-gesture (the gestures.ts heuristic) is too late — once the first
      // touchmove is cancelled the native zoom stays suppressed anyway.
      e.preventDefault()
      const [a, b] = [e.touches[0], e.touches[1]]
      pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
      pinchZoom = zoom
      const c = stageCenter()
      pinchRelX = ((a.clientX + b.clientX) / 2 - c.x - panX) / zoom
      pinchRelY = ((a.clientY + b.clientY) / 2 - c.y - panY) / zoom
      touchMode = "pinch"
      touchMoved = true // a pinch is never a tap
      if (viewImg) viewImg.style.transition = "none" // track the fingers 1:1
   } else if (e.touches.length === 1) {
      touchMode = "pan"
      touchMoved = false
      panStartX = e.touches[0].clientX
      panStartY = e.touches[0].clientY
      panBaseX = panX
      panBaseY = panY
      if (viewImg) viewImg.style.transition = "none"
   } else {
      touchMode = "none"
   }
}

function onTouchMove(e: TouchEvent): void {
   e.stopPropagation()
   if (touchMode === "pinch" && e.touches.length === 2) {
      e.preventDefault()
      const [a, b] = [e.touches[0], e.touches[1]]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      zoom = Math.min(Math.max(pinchZoom * (dist / pinchDist), 1), MAX_ZOOM)
      // The picture point the fingers closed on stays under their midpoint, so
      // moving both fingers pans while spreading them zooms — one gesture.
      const c = stageCenter()
      panX = (a.clientX + b.clientX) / 2 - c.x - pinchRelX * zoom
      panY = (a.clientY + b.clientY) / 2 - c.y - pinchRelY * zoom
      applyView()
   } else if (touchMode === "pan" && e.touches.length === 1) {
      // Own the touch even at fitted size: the reader is still there behind the
      // scrim, and a drag over a modal must not scroll it.
      e.preventDefault()
      const dx = e.touches[0].clientX - panStartX
      const dy = e.touches[0].clientY - panStartY
      if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) touchMoved = true
      if (zoom === 1) return // nothing to pan
      panX = panBaseX + dx
      panY = panBaseY + dy
      applyView()
   }
}

function onTouchEnd(e: TouchEvent): void {
   e.stopPropagation()
   if (touchMode === "pinch" && e.touches.length < 2) {
      // A release a hair above fitted reads as "back to normal" — the same
      // indistinguishability call ZOOM_EPS makes for the tap toggle.
      if (zoom <= ZOOM_EPS) setZoom(1)
      if (e.touches.length === 1) {
         // One finger stayed down: the gesture continues as a pan from here.
         touchMode = "pan"
         panStartX = e.touches[0].clientX
         panStartY = e.touches[0].clientY
         panBaseX = panX
         panBaseY = panY
      }
   }
   if (e.touches.length === 0) {
      touchMode = "none"
      // Hand motion back to the stylesheet, so the NEXT tap-zoom eases again.
      viewImg?.style.removeProperty("transition")
   }
}

function onTouchCancel(e: TouchEvent): void {
   e.stopPropagation()
   if (zoom !== 1 && zoom <= ZOOM_EPS) setZoom(1)
   touchMode = "none"
   viewImg?.style.removeProperty("transition")
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
   // A gesture interrupted by the previous close must not leak into this open:
   // a stale touchMoved would swallow the first honest tap.
   touchMode = "none"
   touchMoved = false
   viewImg!.style.removeProperty("transition")
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
