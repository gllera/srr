import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// lightbox.ts is the reader's image viewer (RDR7): ONE delegated click listener
// on the content host claims bare content images and opens a focus-trapped
// modal over the page. These tests drive it exactly as app.ts wires it — a
// .srr-content host with handleContentClick registered on it — and assert the
// contract that matters: what it claims, what it deliberately does NOT claim
// (linked images), that Escape closes it, that focus goes back to the
// originating <img>, and that no key reaches the surfaces underneath.

type Lightbox = typeof import("./lightbox")

const HOST = `<div class="srr-content"></div>`

const $overlay = () => document.querySelector<HTMLElement>(".srr-lightbox")
const $stage = () => document.querySelector<HTMLButtonElement>(".srr-lightbox-stage")!
const $img = () => document.querySelector<HTMLImageElement>(".srr-lightbox-img")!
const $close = () => document.querySelector<HTMLButtonElement>(".srr-lightbox-close")!
const isOpen = () => $overlay()?.classList.contains("srr-open") === true

// A keydown as the browser delivers it: dispatched at the focused element and
// bubbling up to the document handlers both app.ts and lightbox.ts register.
const key = (k: string, target: EventTarget = document.activeElement ?? document.body) =>
   target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))

const clickAt = (el: Element, x = 0, y = 0, detail = 1) =>
   el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail, clientX: x, clientY: y }))

// jsdom lays nothing out, so the natural/painted sizes the zoom decision reads
// are both 0 (⇒ "not zoomable"). Stub them to describe a picture that IS bigger
// than the box it is painted in.
function stubSizes(natural: number, shown: number): void {
   Object.defineProperty($img(), "naturalWidth", { value: natural, configurable: true })
   Object.defineProperty($img(), "clientWidth", { value: shown, configurable: true })
   Object.defineProperty($img(), "clientHeight", { value: shown, configurable: true })
   const box = () => ({ left: 0, top: 0, width: shown, height: shown }) as DOMRect
   $img().getBoundingClientRect = box
   // The pinch math anchors on the STAGE's box: the stage hugs the image and
   // never carries the transform, so its rect stays the fitted geometry even
   // while the image is scaled.
   $stage().getBoundingClientRect = box
}

describe("image lightbox", () => {
   let lightbox: Lightbox
   let host: HTMLElement

   // Build the article content the delegated handler sits over. Returns the
   // bare <img> the tests click.
   function seed(html: string): HTMLImageElement {
      host.innerHTML = html
      return host.querySelector("img")!
   }

   beforeEach(async () => {
      document.body.innerHTML = HOST
      vi.resetModules()
      lightbox = await import("./lightbox")
      host = document.querySelector<HTMLElement>(".srr-content")!
      host.addEventListener("click", lightbox.handleContentClick)
   })

   afterEach(() => {
      lightbox.close() // never leak an open viewer's document keydown listener
   })

   describe("what the delegated listener claims", () => {
      it("opens on a bare content image and mirrors its src + alt", () => {
         const img = seed(`<p>text</p><img src="http://cdn.test/pic.png" alt="a chart">`)
         img.click()
         expect(lightbox.isOpen()).toBe(true)
         expect(isOpen()).toBe(true)
         expect($img().getAttribute("src")).toBe("http://cdn.test/pic.png")
         expect($img().alt).toBe("a chart")
         // The dialog names itself with the picture's own description.
         expect($overlay()!.getAttribute("aria-label")).toBe("Image: a chart")
         expect($overlay()!.getAttribute("role")).toBe("dialog")
         expect($overlay()!.getAttribute("aria-modal")).toBe("true")
      })

      it("falls back to a generic dialog name when the image has no alt", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         expect($overlay()!.getAttribute("aria-label")).toBe("Image viewer")
      })

      it("leaves an <img> wrapped in a link alone — the author made it a control", () => {
         const img = seed(`<a href="http://example.com/full"><img src="http://cdn.test/pic.png"></a>`)
         // Swallow the navigation jsdom can't perform. Document-level and
         // BUBBLE phase, so it runs strictly after the host's handleContentClick
         // — the exemption under test must not be a defaultPrevented bail-out.
         const swallow = (e: Event) => e.preventDefault()
         document.addEventListener("click", swallow)
         try {
            img.click()
         } finally {
            document.removeEventListener("click", swallow)
         }
         expect(lightbox.isOpen()).toBe(false)
         expect($overlay()).toBeNull() // not even built
      })

      it("claims an <img> inside an <a> that has no href (no link behavior to keep)", () => {
         seed(`<a name="x"><img src="http://cdn.test/pic.png"></a>`).click()
         expect(lightbox.isOpen()).toBe(true)
      })

      it("ignores clicks that aren't on an image", () => {
         seed(`<p>text</p><img src="http://cdn.test/pic.png">`)
         host.querySelector("p")!.click()
         expect(lightbox.isOpen()).toBe(false)
      })

      it("ignores modified clicks and non-primary buttons", () => {
         const img = seed(`<img src="http://cdn.test/pic.png">`)
         for (const init of [
            { metaKey: true },
            { ctrlKey: true },
            { shiftKey: true },
            { altKey: true },
            { button: 1 },
         ]) {
            img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }))
            expect(lightbox.isOpen()).toBe(false)
         }
      })

      it("ignores a click an earlier handler already claimed", () => {
         const img = seed(`<img src="http://cdn.test/pic.png">`)
         // fmt.ts handleFragmentClick shares this host and runs first.
         host.addEventListener("click", (e) => e.preventDefault(), true)
         img.click()
         expect(lightbox.isOpen()).toBe(false)
      })

      it("ignores an image whose bytes failed to load", () => {
         const img = seed(`<img src="http://cdn.test/gone.png" class="srr-broken">`)
         img.click()
         expect(lightbox.isOpen()).toBe(false)
      })

      it("ignores a srcless image", () => {
         const img = seed(`<img alt="nothing">`)
         img.click()
         expect(lightbox.isOpen()).toBe(false)
      })
   })

   describe("closing", () => {
      it("Escape closes it and returns focus to the originating <img>", () => {
         const img = seed(`<img src="http://cdn.test/pic.png" alt="a chart">`)
         img.click()
         expect(document.activeElement).toBe($close())
         key("Escape")
         expect(lightbox.isOpen()).toBe(false)
         expect(isOpen()).toBe(false)
         expect(document.activeElement).toBe(img)
      })

      it("the ✕ closes it and returns focus to the originating <img>", () => {
         const img = seed(`<img src="http://cdn.test/pic.png">`)
         img.click()
         $close().click()
         expect(lightbox.isOpen()).toBe(false)
         expect(document.activeElement).toBe(img)
      })

      it("a press on the backdrop closes it; one on the image does not go through it", () => {
         const img = seed(`<img src="http://cdn.test/pic.png">`)
         img.click()
         clickAt($stage()) // the card, not the backdrop
         // Un-zoomable in jsdom (no layout) ⇒ the stage press reads as dismiss…
         expect(lightbox.isOpen()).toBe(false)
         img.click()
         clickAt($overlay()!)
         expect(lightbox.isOpen()).toBe(false)
      })

      it("close() on a closed viewer is a no-op (routing calls it unconditionally)", () => {
         const before = document.activeElement
         lightbox.close()
         expect(lightbox.isOpen()).toBe(false)
         expect(document.activeElement).toBe(before)
      })

      it("survives the article being re-rendered underneath it", () => {
         const img = seed(`<img src="http://cdn.test/pic.png">`)
         img.click()
         host.replaceChildren() // a navigation replaced the content host's children
         key("Escape")
         expect(lightbox.isOpen()).toBe(false) // focus-restore on a detached node is inert
      })

      it("never stacks two viewers", () => {
         const img = seed(`<img src="http://cdn.test/a.png"><img src="http://cdn.test/b.png">`)
         img.click()
         host.querySelectorAll("img")[1].click()
         expect(document.querySelectorAll(".srr-lightbox")).toHaveLength(1)
         expect($img().getAttribute("src")).toBe("http://cdn.test/b.png")
      })
   })

   describe("the modal owns the keyboard", () => {
      it("swallows every key so nothing reaches the surfaces underneath", () => {
         // app.ts's keymap is a document-level BUBBLE listener; the viewer's trap
         // is capture-phase, which is what stops the reader walking articles
         // behind an enlarged image.
         const underneath = vi.fn()
         document.addEventListener("keydown", underneath)
         try {
            seed(`<img src="http://cdn.test/pic.png">`).click()
            for (const k of ["ArrowRight", "ArrowLeft", "w", "s", "b", "u", "/"]) key(k, $close())
            expect(underneath).not.toHaveBeenCalled()
            // …including the Escape that dismisses it: app.ts's Escape toggles
            // reader ⇄ list, and closing the viewer must not also do that.
            key("Escape", $close())
            expect(underneath).not.toHaveBeenCalled()
            expect(lightbox.isOpen()).toBe(false)
         } finally {
            document.removeEventListener("keydown", underneath)
         }
      })

      it("stops swallowing once closed", () => {
         const underneath = vi.fn()
         document.addEventListener("keydown", underneath)
         try {
            const img = seed(`<img src="http://cdn.test/pic.png">`)
            img.click()
            key("Escape")
            key("ArrowRight", img)
            expect(underneath).toHaveBeenCalledTimes(1)
         } finally {
            document.removeEventListener("keydown", underneath)
         }
      })

      it("traps Tab between the stage and the ✕", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         // Focus opens on the ✕ (the last focusable) — Tab wraps to the stage.
         expect(document.activeElement).toBe($close())
         key("Tab", $close())
         expect(document.activeElement).toBe($stage())
      })
   })

   describe("zoom toggle", () => {
      it("enlarges toward the pressed point, then restores", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         stubSizes(1200, 400) // 3x available
         clickAt($stage(), 100, 300)
         // Tap at 25%/75% of a 400px box, 3x: the pressed point stays put, which
         // in the shared translate+scale model (center origin — pan and pinch
         // ride the same coordinates) is t = (center − point) · (k − 1).
         expect($img().style.transform).toBe("translate(200px, -200px) scale(3)")
         expect($overlay()!.classList.contains("srr-lightbox-zoomed")).toBe(true)
         expect($stage().getAttribute("aria-label")).toBe("shrink image")

         clickAt($stage(), 100, 300)
         expect($img().style.transform).toBe("")
         expect($overlay()!.classList.contains("srr-lightbox-zoomed")).toBe(false)
         expect($stage().getAttribute("aria-label")).toBe("enlarge image")
         expect(lightbox.isOpen()).toBe(true) // a zoom toggle is not a dismiss
      })

      it("centers the zoom for a keyboard activation (no pointer position)", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         stubSizes(1200, 400)
         clickAt($stage(), 0, 0, 0) // detail 0 = Enter/Space on the stage button
         expect($img().style.transform).toBe("translate(0px, 0px) scale(3)")
      })

      it("caps the enlargement", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         stubSizes(9000, 300) // 30x asked for
         clickAt($stage(), 0, 0)
         // Corner tap at the 4x cap: the pan clamps exactly at the picture's
         // edge — 300 · (4 − 1) / 2 = 450 — so no scrim shows through.
         expect($img().style.transform).toBe("translate(450px, 450px) scale(4)")
      })

      it("dismisses instead of zooming when the image is already shown full size", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         stubSizes(400, 400)
         clickAt($stage(), 0, 0)
         expect(lightbox.isOpen()).toBe(false)
      })

      it("reopens un-zoomed after a zoomed viewer is closed", () => {
         const img = seed(`<img src="http://cdn.test/pic.png">`)
         img.click()
         stubSizes(1200, 400)
         clickAt($stage(), 0, 0)
         key("Escape")
         img.click()
         expect($img().style.transform).toBe("")
         expect($overlay()!.classList.contains("srr-lightbox-zoomed")).toBe(false)
      })
   })

   describe("touch gestures (pinch zoom + pan)", () => {
      type Pt = { clientX: number; clientY: number }
      // gestures.test.ts's idiom: jsdom has no Touch/TouchEvent constructors,
      // but the handlers only read `.length` and `clientX`/`clientY` off
      // `touches`/`changedTouches`, so a plain Event with those defined drives
      // them exactly as the browser would.
      function touch(type: string, touches: Pt[], changed: Pt[] = touches): Event {
         const e = new Event(type, { bubbles: true, cancelable: true })
         Object.defineProperty(e, "touches", { value: touches, configurable: true })
         Object.defineProperty(e, "changedTouches", { value: changed, configurable: true })
         $stage().dispatchEvent(e)
         return e
      }
      const pt = (clientX: number, clientY: number): Pt => ({ clientX, clientY })

      // Open the viewer over a 400px box (stage rect 0,0→400,400) with 3x
      // natural headroom, unless a case says otherwise.
      function openAt(natural = 1200, shown = 400): void {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         stubSizes(natural, shown)
      }
      // A symmetric spread about (200,200): dist 100 → 200, so 2x with the
      // midpoint (= the stage center) unmoved.
      function pinchTo2x(): void {
         touch("touchstart", [pt(150, 200), pt(250, 200)])
         touch("touchmove", [pt(100, 200), pt(300, 200)])
         touch("touchend", [], [pt(100, 200), pt(300, 200)])
      }

      it("a pinch zooms about the finger midpoint and holds after the lift", () => {
         openAt()
         touch("touchstart", [pt(150, 200), pt(250, 200)])
         const move = touch("touchmove", [pt(100, 200), pt(300, 200)])
         // Ours, not the browser's page zoom — native zoom would scale the
         // scrim and the ✕ too, and leave the PAGE zoomed after close.
         expect(move.defaultPrevented).toBe(true)
         expect($img().style.transform).toBe("translate(0px, 0px) scale(2)")
         expect($overlay()!.classList.contains("srr-lightbox-zoomed")).toBe(true)
         touch("touchend", [], [pt(100, 200), pt(300, 200)])
         expect($img().style.transform).toBe("translate(0px, 0px) scale(2)")
      })

      it("the image point under the pinch follows the midpoint — zoom and pan in one gesture", () => {
         openAt()
         touch("touchstart", [pt(150, 200), pt(250, 200)])
         // Same 2x spread, but the midpoint drifted 50px right: the picture
         // follows the fingers instead of zooming about a fixed center.
         touch("touchmove", [pt(150, 200), pt(350, 200)])
         expect($img().style.transform).toBe("translate(50px, 0px) scale(2)")
         touch("touchend", [], [pt(150, 200), pt(350, 200)])
      })

      it("caps the pinch at 4x and clamps a pan to the picture's edges", () => {
         openAt()
         touch("touchstart", [pt(190, 200), pt(210, 200)]) // dist 20
         touch("touchmove", [pt(0, 200), pt(400, 200)]) // dist 400 → 20x asked
         expect($img().style.transform).toBe("translate(0px, 0px) scale(4)")
         touch("touchend", [], [pt(0, 200), pt(400, 200)])
         // Drag far past the edge: clamped at 400 · (4 − 1) / 2 = 600, so the
         // scrim never shows through a gap.
         touch("touchstart", [pt(200, 200)])
         touch("touchmove", [pt(-800, 200)])
         expect($img().style.transform).toBe("translate(-600px, 0px) scale(4)")
         touch("touchend", [], [pt(-800, 200)])
      })

      it("a one-finger drag pans a zoomed image and owns the touch", () => {
         openAt()
         pinchTo2x()
         touch("touchstart", [pt(200, 200)])
         const move = touch("touchmove", [pt(150, 180)])
         // The article behind the scrim must not scroll under the pan.
         expect(move.defaultPrevented).toBe(true)
         expect($img().style.transform).toBe("translate(-50px, -20px) scale(2)")
         touch("touchend", [], [pt(150, 180)])
      })

      it("a pinch released a hair above fitted snaps back", () => {
         openAt()
         touch("touchstart", [pt(150, 200), pt(250, 200)])
         touch("touchmove", [pt(149.5, 200), pt(250.5, 200)]) // 1.01x — under ZOOM_EPS
         expect($img().style.transform).toBe("translate(0px, 0px) scale(1.01)")
         touch("touchend", [], [pt(149.5, 200), pt(250.5, 200)])
         expect($img().style.transform).toBe("")
         expect($overlay()!.classList.contains("srr-lightbox-zoomed")).toBe(false)
      })

      it("a pinch that loses one finger continues as a pan", () => {
         openAt()
         touch("touchstart", [pt(150, 200), pt(250, 200)])
         touch("touchmove", [pt(100, 200), pt(300, 200)]) // 2x
         touch("touchend", [pt(300, 200)], [pt(100, 200)]) // left finger lifted
         touch("touchmove", [pt(250, 180)])
         expect($img().style.transform).toBe("translate(-50px, -20px) scale(2)")
         touch("touchend", [], [pt(250, 180)])
      })

      it("the drag's finger-lift click is swallowed — a pan is not a tap", () => {
         openAt()
         pinchTo2x()
         touch("touchstart", [pt(200, 200)])
         touch("touchmove", [pt(150, 180)])
         touch("touchend", [], [pt(150, 180)])
         clickAt($stage(), 150, 180) // the click the lift synthesizes
         expect(lightbox.isOpen()).toBe(true)
         expect($img().style.transform).toBe("translate(-50px, -20px) scale(2)") // not un-zoomed
         clickAt($stage(), 200, 200) // a clean tap afterwards still toggles
         expect($img().style.transform).toBe("")
      })

      it("a drag at fitted size still owns the touch but leaves tap semantics alone", () => {
         openAt()
         touch("touchstart", [pt(200, 200)])
         const move = touch("touchmove", [pt(200, 260)])
         expect(move.defaultPrevented).toBe(true) // no scroll-behind through the scrim
         expect($img().style.transform).toBe("") // nothing to pan at 1x
         touch("touchend", [], [pt(200, 260)])
         clickAt($stage(), 200, 200) // the drag's own click is swallowed…
         expect(lightbox.isOpen()).toBe(true)
         expect($img().style.transform).toBe("")
         touch("touchstart", [pt(200, 200)])
         touch("touchend", [], [pt(200, 200)])
         clickAt($stage(), 200, 200) // …a clean tap still zooms
         expect($img().style.transform).toBe("translate(0px, 0px) scale(3)")
      })

      it("touches inside the viewer never reach the document's gesture machine", () => {
         const seen = vi.fn()
         const types = ["touchstart", "touchmove", "touchend"]
         for (const t of types) document.addEventListener(t, seen)
         try {
            openAt()
            touch("touchstart", [pt(150, 200), pt(250, 200)])
            touch("touchmove", [pt(100, 200), pt(300, 200)])
            touch("touchend", [], [pt(100, 200), pt(300, 200)])
            expect(seen).not.toHaveBeenCalled()
         } finally {
            for (const t of types) document.removeEventListener(t, seen)
         }
      })
   })
})
