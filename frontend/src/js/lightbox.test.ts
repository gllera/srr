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
   $img().getBoundingClientRect = () => ({ left: 0, top: 0, width: shown, height: shown }) as DOMRect
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
         expect($img().style.transform).toBe("scale(3)")
         expect($img().style.transformOrigin).toBe("25% 75%")
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
         expect($img().style.transformOrigin).toBe("50% 50%")
      })

      it("caps the enlargement", () => {
         seed(`<img src="http://cdn.test/pic.png">`).click()
         stubSizes(9000, 300) // 30x asked for
         clickAt($stage(), 0, 0)
         expect($img().style.transform).toBe("scale(4)")
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
})
